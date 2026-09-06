#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
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

fn sync_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("backlogger.sync.json"))
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

fn write_temporary_file(path: &Path, document: &str) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(document.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(())
}

fn replace_file(temporary: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source: Vec<u16> = temporary
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let destination: Vec<u16> = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        fs::rename(temporary, target).map_err(|error| error.to_string())
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
    write_temporary_file(&temporary, &document)?;
    if path.exists() && read_valid_json(&path)?.is_some() {
        fs::copy(&path, &backup).map_err(|error| error.to_string())?;
    }
    replace_file(&temporary, &path)
}

#[tauri::command]
fn load_sync_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = sync_state_path(&app)?;
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_sync_state(app: AppHandle, state: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&state).map_err(|error| error.to_string())?;
    let path = sync_state_path(&app)?;
    let temporary = path.with_extension("json.tmp");
    write_temporary_file(&temporary, &state)?;
    replace_file(&temporary, &path)
}

#[tauri::command]
fn ensure_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_optional_file(path: String) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn list_directory_files(path: String) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            if let Some(name) = entry.file_name().to_str() {
                files.push(name.to_string());
            }
        }
    }
    files.sort();
    Ok(files)
}

#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn read_document_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_document_file(path: String, document: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&document).map_err(|error| error.to_string())?;
    let target = PathBuf::from(path);
    let temporary = target.with_extension("tmp");
    write_temporary_file(&temporary, &document)?;
    replace_file(&temporary, &target)
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
        builder = builder.plugin(tauri_plugin_dialog::init());
    }
    builder
        .invoke_handler(tauri::generate_handler![
            load_notebook,
            load_notebook_backup,
            save_notebook,
            load_sync_state,
            save_sync_state,
            ensure_directory,
            read_optional_file,
            list_directory_files,
            remove_file,
            set_app_theme,
            read_document_file,
            write_document_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Backlogger");
}
