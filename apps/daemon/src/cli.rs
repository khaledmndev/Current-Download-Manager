use anyhow::{bail, Result};
use current_core::ipc;
use serde_json::{json, Value};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "help" {
        println!("Current Download Manager\n\ncurrent-cli list\ncurrent-cli add URL [absolute-folder] [filename]\ncurrent-cli pause|resume|restart|cancel|remove JOB_ID\ncurrent-cli export\ncurrent-cli snapshot\n\nThe background engine starts automatically. CURRENT_DATA_DIR selects an isolated data directory.");
        return Ok(());
    }
    ipc::ensure_daemon().await?;
    let (op, payload) = match args[0].as_str() {
        "list" | "snapshot" => ("snapshot", Value::Null),
        "rpc" => {
            if args.len() != 3 {
                bail!("Use rpc OPERATION JSON_PAYLOAD.");
            }
            (args[1].as_str(), serde_json::from_str::<Value>(&args[2])?)
        }
        "export" => ("export", Value::Null),
        "add" => {
            if args.len() < 2 {
                bail!("Provide an HTTP or HTTPS URL.");
            }
            (
                "add",
                json!({"url":args[1],"folder":args.get(2),"filename":args.get(3)}),
            )
        }
        "pause" | "resume" | "restart" | "cancel" | "remove" => {
            if args.len() < 2 {
                bail!("Provide the job ID.");
            }
            ("action", json!({"id":args[1],"action":args[0]}))
        }
        "pause-all" => ("pause_all", Value::Null),
        "shutdown" => ("shutdown", Value::Null),
        "resume-all" => ("resume_all", Value::Null),
        _ => bail!("Unknown command. Use current-cli help."),
    };
    let result = ipc::call(op, payload).await?;
    if args[0] == "list" {
        for j in result["jobs"].as_array().unwrap_or(&vec![]) {
            println!(
                "{}  {:14}  {:>12}  {}",
                j["id"].as_str().unwrap_or(""),
                j["status"].as_str().unwrap_or(""),
                j["downloaded"],
                j["filename"].as_str().unwrap_or("")
            );
        }
    } else {
        println!("{}", serde_json::to_string_pretty(&result)?);
    }
    Ok(())
}
