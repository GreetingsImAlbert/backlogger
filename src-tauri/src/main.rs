#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{ErrorKind, Write},
    path::PathBuf,
};
use tauri::{AppHandle, Manager};

fn notebook_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("backlogger.json"))
}

fn read_valid_json(path: &PathBuf) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => {
            if serde_json::from_str::<serde_json::Value>(&contents).is_ok() {
                Ok(Some(contents))
            } else {
                Ok(None)
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn load_notebook(app: AppHandle) -> Result<Option<String>, String> {
    let path = notebook_path(&app)?;
    if let Some(contents) = read_valid_json(&path)? {
        return Ok(Some(contents));
    }
    read_valid_json(&path.with_extension("json.bak"))
}

#[tauri::command]
fn load_notebook_backup(app: AppHandle) -> Result<Option<String>, String> {
    let path = notebook_path(&app)?.with_extension("json.bak");
    read_valid_json(&path)
}

#[tauri::command]
fn save_notebook(app: AppHandle, document: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&document).map_err(|error| error.to_string())?;
    let path = notebook_path(&app)?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(document.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    if path.exists() && read_valid_json(&path)?.is_some() {
        fs::copy(&path, &backup).map_err(|error| error.to_string())?;
    }
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_app_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    let theme = match theme.as_str() {
        "dark" => tauri::Theme::Dark,
        "light" => tauri::Theme::Light,
        _ => return Err("Invalid theme".into()),
    };
    window
        .set_theme(Some(theme))
        .map_err(|error| error.to_string())
}

fn main() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .invoke_handler(tauri::generate_handler![
            load_notebook,
            load_notebook_backup,
            save_notebook,
            set_app_theme
        ])
        .run(tauri::generate_context!())
        .expect("error while running Backlogger");
}
