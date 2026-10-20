use crate::{data_dir, AddRequest, Engine, Settings, Status};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAX_REQUEST: usize = 256 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;

pub fn pipe_name() -> String {
    let path = data_dir().to_string_lossy().to_string();
    format!(
        r"\\.\pipe\Current.Downloads.{}",
        &hex::encode(Sha256::digest(path.to_ascii_lowercase().as_bytes()))[..24]
    )
}

async fn read_frame<S: AsyncRead + Unpin>(stream: &mut S, max: usize) -> Result<Value> {
    let length = stream.read_u32_le().await? as usize;
    if length == 0 || length > max {
        bail!("IPC message exceeds its size limit.");
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
async fn write_frame<S: AsyncWrite + Unpin>(
    stream: &mut S,
    value: &Value,
    max: usize,
) -> Result<()> {
    let data = serde_json::to_vec(value)?;
    if data.len() > max {
        bail!("IPC response exceeds its size limit.");
    }
    stream.write_u32_le(data.len() as u32).await?;
    stream.write_all(&data).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(windows)]
pub async fn call(operation: &str, payload: Value) -> Result<Value> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let mut attempts = 0;
    let mut pipe = loop {
        match ClientOptions::new().open(pipe_name()) {
            Ok(p) => break p,
            Err(e) => {
                attempts += 1;
                if attempts >= 30 {
                    return Err(e).context("Current's background engine is not running.");
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    };
    let timeout = if operation == "youtube_formats" {
        75
    } else {
        15
    };
    let result = tokio::time::timeout(Duration::from_secs(timeout), async {
        write_frame(
            &mut pipe,
            &json!({"version":1,"operation":operation,"payload":payload}),
            MAX_REQUEST,
        )
        .await?;
        read_frame(&mut pipe, MAX_RESPONSE).await
    })
    .await??;
    if result["ok"] == true {
        Ok(result["data"].clone())
    } else {
        bail!(
            "{}",
            result["error"].as_str().unwrap_or("Engine request failed.")
        )
    }
}

#[cfg(not(windows))]
pub async fn call(_operation: &str, _payload: Value) -> Result<Value> {
    bail!("This build currently supports Windows named pipes only.")
}

pub fn start_daemon() -> Result<()> {
    let current = std::env::current_exe()?;
    let candidate = current
        .parent()
        .context("Cannot locate application directory")?
        .join("current-daemon.exe");
    if !candidate.exists() {
        bail!(
            "The background executable is missing: {}",
            candidate.display()
        );
    }
    spawn_detached(candidate)
}

pub fn start_desktop() -> Result<()> {
    let executable = std::env::current_exe()?;
    let folder = executable
        .parent()
        .context("Cannot locate application directory")?;
    let candidate = [
        folder.join("Current.exe"),
        folder.join("current-desktop.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .context("The desktop application is missing beside the native host.")?;
    spawn_detached(candidate)
}

fn spawn_detached(candidate: PathBuf) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                CreateProcessW, CREATE_NO_WINDOW, PROCESS_INFORMATION, STARTUPINFOW,
            },
        };
        let executable: Vec<u16> = candidate.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut command: Vec<u16> = format!("\"{}\"", candidate.display())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // Explicitly disable handle inheritance: a detached engine must not keep
        // the CLI's or browser native host's capture pipes open after they exit.
        unsafe {
            let mut startup: STARTUPINFOW = std::mem::zeroed();
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut process: PROCESS_INFORMATION = std::mem::zeroed();
            if CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_NO_WINDOW,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut process,
            ) == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
    }
    #[cfg(not(windows))]
    std::process::Command::new(candidate)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

pub async fn ensure_daemon() -> Result<()> {
    if tokio::time::timeout(Duration::from_millis(250), call("ping", Value::Null))
        .await
        .is_ok_and(|r| r.is_ok())
    {
        return Ok(());
    }
    start_daemon()?;
    call("ping", Value::Null).await?;
    Ok(())
}

pub async fn dispatch(engine: &Arc<Engine>, operation: &str, payload: Value) -> Result<Value> {
    match operation {
        "ping" => Ok(json!({"version":crate::VERSION,"process_id":std::process::id()})),
        "shutdown" => {
            engine.request_shutdown()?;
            let engine = engine.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                engine.wait_stopped().await;
                std::process::exit(0);
            });
            Ok(Value::Null)
        }
        "snapshot" => engine.snapshot(),
        "youtube_formats" => {
            if !engine.plan.paid_features {
                bail!("YouTube downloads require Pro.");
            }
            crate::media::formats(payload["url"].as_str().context("Provide a video URL.")?).await
        }
        "youtube" => {
            let mut request: AddRequest = serde_json::from_value(payload)?;
            crate::media::youtube_id(&crate::validate_url(&request.url)?)
                .context("Use a single YouTube video link.")?;
            if request.media.is_none() {
                request.media = Some(crate::media::MediaOptions::default());
            }
            Ok(serde_json::to_value(engine.add(request)?)?)
        }
        "add" => Ok(serde_json::to_value(
            engine.add(serde_json::from_value::<AddRequest>(payload)?)?,
        )?),
        "add_many" => {
            if !engine.plan.paid_features {
                bail!("Batch downloads require Pro. Billing is not enabled in this build.");
            }
            let requests: Vec<AddRequest> = serde_json::from_value(payload)?;
            if requests.len() > 500 {
                bail!("Add at most 500 links at a time.");
            }
            let mut added = vec![];
            let mut errors = vec![];
            for (index, request) in requests.into_iter().enumerate() {
                match engine.add(request) {
                    Ok(j) => added.push(j),
                    Err(e) => errors.push(json!({"index":index,"error":e.to_string()})),
                }
            }
            Ok(json!({"added":added,"errors":errors}))
        }
        "action" => {
            engine.action(
                payload["id"].as_str().context("Missing job ID")?,
                payload["action"].as_str().context("Missing action")?,
            )?;
            Ok(Value::Null)
        }
        "pause_all" => {
            for job in engine.store.list()? {
                if job.status.active() || job.status == Status::Queued {
                    let _ = engine.action(&job.id, "pause");
                }
            }
            Ok(Value::Null)
        }
        "resume_all" => {
            for job in engine.store.list()? {
                if matches!(job.status, Status::Paused | Status::Failed) {
                    let _ = engine.action(&job.id, "resume");
                }
            }
            Ok(Value::Null)
        }
        "settings" => Ok(serde_json::to_value(
            engine.save_settings(serde_json::from_value::<Settings>(payload)?)?,
        )?),
        "export" => {
            Ok(json!({"format":"current-downloads","version":1,"jobs":engine.store.list()?}))
        }
        "import" => {
            let jobs = payload["jobs"]
                .as_array()
                .context("Choose a Current JSON export with a jobs array.")?;
            if jobs.len() > 500 {
                bail!("Import at most 500 jobs at a time.");
            }
            let mut added = 0;
            for j in jobs {
                engine.add(AddRequest {
                    media: j
                        .get("media")
                        .filter(|v| !v.is_null())
                        .map(|v| serde_json::from_value(v.clone()))
                        .transpose()?,
                    url: j["url"]
                        .as_str()
                        .context("An imported job has no URL.")?
                        .into(),
                    filename: j["filename"].as_str().map(str::to_string),
                    folder: None,
                    later: Some(true),
                    queue: None,
                    description: j["description"].as_str().map(str::to_string),
                    referer: None,
                    expected_sha256: None,
                    start_at: None,
                })?;
                added += 1;
            }
            Ok(json!({"added":added}))
        }
        "open_folder" => {
            let job = engine
                .store
                .get(payload["id"].as_str().context("Missing job ID")?)?;
            open_folder(PathBuf::from(job.folder))?;
            Ok(Value::Null)
        }
        _ => bail!("Unknown operation or unsupported protocol version."),
    }
}

fn open_folder(path: PathBuf) -> Result<()> {
    if !path.is_dir() {
        bail!("The destination folder does not exist yet.");
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()?;
    }
    Ok(())
}

#[cfg(windows)]
fn create_server(first: bool) -> Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use tokio::net::windows::named_pipe::ServerOptions;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SECURITY_ATTRIBUTES,
        },
    };
    let mut descriptor = std::ptr::null_mut();
    // An owner-only protected DACL. Other users and remote clients cannot connect.
    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)(A;;GA;;;SY)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let result = ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                pipe_name(),
                &mut attributes as *mut _ as *mut std::ffi::c_void,
            );
        LocalFree(descriptor);
        Ok(result?)
    }
}

#[cfg(windows)]
pub async fn serve(engine: Arc<Engine>) -> Result<()> {
    // Reserve the first pipe before launching any scheduler to prevent a second writer.
    let mut server = create_server(true)?;
    tokio::spawn(engine.clone().scheduler());
    loop {
        server.connect().await?;
        let mut connected = server;
        server = create_server(false)?;
        let engine = engine.clone();
        tokio::spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(90), async {
                let request = tokio::time::timeout(
                    Duration::from_secs(20),
                    read_frame(&mut connected, MAX_REQUEST),
                )
                .await??;
                if request["version"] != 1 {
                    bail!("Unsupported IPC protocol.");
                }
                let result = dispatch(
                    &engine,
                    request["operation"].as_str().unwrap_or(""),
                    request["payload"].clone(),
                )
                .await;
                let response = match result {
                    Ok(data) => json!({"ok":true,"data":data}),
                    Err(e) => json!({"ok":false,"error":format!("{e:#}")}),
                };
                write_frame(&mut connected, &response, MAX_RESPONSE).await
            })
            .await;
            if let Ok(Err(_)) = result { /* The peer gets a closed connection; never log sensitive payloads. */
            }
        });
    }
}

#[cfg(not(windows))]
pub async fn serve(_engine: Arc<Engine>) -> Result<()> {
    bail!("The desktop daemon currently targets Windows.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn oversized_frames_are_rejected_before_allocation() {
        let (mut a, mut b) = tokio::io::duplex(32);
        a.write_u32_le(300_000).await.unwrap();
        assert!(read_frame(&mut b, MAX_REQUEST).await.is_err());
    }
}
