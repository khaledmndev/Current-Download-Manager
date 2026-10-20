#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use current_core::ipc;
use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn rpc(operation: String, payload: Value) -> Result<Value, String> {
    ipc::call(&operation, payload)
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn reconnect() -> Result<(), String> {
    ipc::ensure_daemon().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn choose_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_library(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name("current-library.json")
            .add_filter("Current library", &["json"])
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = path else {
        return Ok(None);
    };
    let data = ipc::call("export", Value::Null)
        .await
        .map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into()))
}

#[tauri::command]
async fn import_library(app: tauri::AppHandle) -> Result<(), String> {
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Current library", &["json"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = path else {
        return Ok(());
    };
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?;
    if metadata.len() > 256 * 1024 {
        return Err(
            "Import file is too large. Use an export with at most 500 entries and under 256 KB."
                .into(),
        );
    }
    let raw = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    ipc::call("import", data).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            rpc,
            reconnect,
            choose_folder,
            export_library,
            import_library
        ])
        .setup(|app| {
            tauri::async_runtime::spawn(async {
                let _ = ipc::ensure_daemon().await;
            });
            let show = MenuItem::with_id(app, "show", "Open Current", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause all downloads", true, None::<&str>)?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "Quit window (downloads continue)",
                true,
                None::<&str>,
            )?;
            let stop = MenuItem::with_id(
                app,
                "stop",
                "Pause downloads and quit Current",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show, &pause, &quit, &stop])?;
            TrayIconBuilder::new()
                .icon(tauri::image::Image::new_owned(
                    include_bytes!("../icons/tray.rgba").to_vec(),
                    32,
                    32,
                ))
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "pause" => {
                        tauri::async_runtime::spawn(async {
                            let _ = ipc::call("pause_all", Value::Null).await;
                        });
                    }
                    "quit" => app.exit(0),
                    "stop" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = ipc::call("shutdown", Value::Null).await;
                            app.exit(0);
                        });
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Current could not start its desktop window");
}
