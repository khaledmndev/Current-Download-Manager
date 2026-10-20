use anyhow::{bail, Result};
use current_core::ipc;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> Result<()> {
    // Chrome supplies the calling extension origin. Registration is user-controlled
    // and disabled until the user registers this host with their own extension ID.
    let origin = std::env::args().nth(1).unwrap_or_default();
    let mut allowed: Vec<String> = std::env::var("CURRENT_EXTENSION_ORIGIN")
        .ok()
        .into_iter()
        .collect();
    if let Some(folder) = std::env::current_exe()?.parent() {
        if let Ok(raw) = std::fs::read_to_string(folder.join("current-browser.json")) {
            if let Ok(config) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) {
                if let Some(origins) = config["allowed_origins"].as_array() {
                    allowed.extend(
                        origins
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_string)),
                    );
                }
            }
        }
    }
    if !allowed.contains(&origin) {
        bail!("Native host is not configured for this extension origin.");
    }
    ipc::ensure_daemon().await?;
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    loop {
        let len = match input.read_u32_le().await {
            Ok(n) => n as usize,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if len == 0 || len > 256 * 1024 {
            bail!("Invalid native message size.");
        }
        let mut data = vec![0; len];
        input.read_exact(&mut data).await?;
        let request: Value = serde_json::from_slice(&data)?;
        let operation = request["operation"].as_str().unwrap_or("");
        let result = match operation {
            "add" => ipc::call("add", request["payload"].clone()).await,
            "youtube_formats" => ipc::call("youtube_formats", request["payload"].clone()).await,
            "youtube" => ipc::call("youtube", request["payload"].clone()).await,
            "add_many"
                if request["payload"]
                    .as_array()
                    .is_some_and(|a| a.len() <= 100) =>
            {
                ipc::call("add_many", request["payload"].clone()).await
            }
            "ping" => ipc::call("ping", Value::Null).await,
            "status" | "job" => match ipc::call("snapshot", Value::Null).await {
                Ok(snapshot) => {
                    let jobs = snapshot["jobs"].as_array().cloned().unwrap_or_default();
                    let summarize = |j: &Value| json!({"id":j["id"],"filename":j["filename"],"status":j["status"],"downloaded":j["downloaded"],"total":j["total"],"speed":j["speed"],"error":j["error"],"sha256":j["sha256"]});
                    if operation == "job" {
                        match jobs
                            .iter()
                            .find(|j| j["id"] == request["payload"]["id"] && j["id"].is_string())
                        {
                            Some(job) => Ok(summarize(job)),
                            None => Err(anyhow::anyhow!("Download was not found.")),
                        }
                    } else {
                        Ok(
                            json!({"version":snapshot["version"],"plan":snapshot["plan"],"media":snapshot["media"],"count":jobs.len(),"jobs":jobs.iter().take(30).map(summarize).collect::<Vec<_>>()}),
                        )
                    }
                }
                Err(e) => Err(e),
            },
            "action" => {
                if matches!(
                    request["payload"]["action"].as_str(),
                    Some("pause" | "resume")
                ) {
                    ipc::call("action", request["payload"].clone()).await
                } else {
                    Err(anyhow::anyhow!(
                        "Only pause and resume are available from the browser."
                    ))
                }
            }
            "open" => ipc::start_desktop().map(|_| Value::Null),
            _ => Err(anyhow::anyhow!("Unsupported native operation.")),
        };
        let reply = match result {
            Ok(data) if matches!(operation, "add" | "youtube") => json!({"ok":true,"job":data}),
            Ok(data) => json!({"ok":true,"data":data}),
            Err(e) => json!({"ok":false,"error":e.to_string()}),
        };
        let bytes = serde_json::to_vec(&reply)?;
        output.write_u32_le(bytes.len() as u32).await?;
        output.write_all(&bytes).await?;
        output.flush().await?;
    }
}
