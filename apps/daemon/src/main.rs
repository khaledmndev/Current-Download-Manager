use anyhow::Result;
use current_core::{data_dir, ipc, Engine, Store};

#[tokio::main]
async fn main() -> Result<()> {
    // A successful probe means another daemon already owns the private endpoint.
    // Do not open the database/recover jobs before this check.
    if tokio::time::timeout(
        std::time::Duration::from_millis(250),
        ipc::call("ping", serde_json::Value::Null),
    )
    .await
    .is_ok_and(|r| r.is_ok())
    {
        return Ok(());
    }
    let root = data_dir();
    std::fs::create_dir_all(&root)?;
    let _lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("engine.lock"))?;
    if _lock.try_lock().is_err() {
        return Ok(());
    }
    let engine = Engine::new(Store::open(&root)?)?;
    ipc::serve(engine).await
}
