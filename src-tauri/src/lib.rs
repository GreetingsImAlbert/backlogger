#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{ErrorKind, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Manager};

const OAUTH_CALLBACK_ADDRESS: &str = "127.0.0.1:17428";
const OAUTH_CALLBACK_URL: &str = "http://127.0.0.1:17428/auth/callback";
static OAUTH_LISTENER_STARTED: AtomicBool = AtomicBool::new(false);

fn oauth_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn handle_oauth_request(app: &AppHandle, mut stream: TcpStream) {
    use std::io::Read;

    let mut request = [0_u8; 8192];
    let Ok(length) = stream.read(&mut request) else {
        return;
    };
    let first_line = String::from_utf8_lossy(&request[..length])
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let target = first_line
        .strip_prefix("GET ")
        .and_then(|line| line.split_once(' ').map(|(target, _)| target));
    let query = target.and_then(|target| target.strip_prefix("/auth/callback?"));
    if let Some(query) = query {
        let callback = format!("backlogger://auth/callback?{query}");
        let _ = app.emit("backlogger-auth-callback", vec![callback]);
        oauth_response(
            &mut stream,
            "200 OK",
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Backlogger sign-in</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center}main{width:min(28rem,calc(100% - 3rem));text-align:center}</style></head><body><main><h1>Sign-in complete</h1><p>You may close this tab and return to Backlogger.</p></main></body></html>",
        );
    } else {
        oauth_response(
            &mut stream,
            "400 Bad Request",
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>Backlogger sign-in</title></head><body><h1>Invalid sign-in callback</h1><p>Return to Backlogger and try again.</p></body></html>",
        );
    }
}

#[tauri::command]
fn start_oauth_callback_listener(app: AppHandle) -> Result<String, String> {
    if OAUTH_LISTENER_STARTED.load(Ordering::Acquire) {
        return Ok(OAUTH_CALLBACK_URL.to_string());
    }
    let listener = TcpListener::bind(OAUTH_CALLBACK_ADDRESS)
        .map_err(|_| "Backlogger could not start its local sign-in callback. Close other Backlogger instances and try again.".to_string())?;
    OAUTH_LISTENER_STARTED.store(true, Ordering::Release);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle_oauth_request(&app, stream);
        }
        OAUTH_LISTENER_STARTED.store(false, Ordering::Release);
    });
    Ok(OAUTH_CALLBACK_URL.to_string())
}

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
fn backup_sync_state(app: AppHandle) -> Result<(), String> {
    let path = sync_state_path(&app)?;
    if path.exists() {
        fs::copy(&path, path.with_extension("json.bak")).map_err(|error| error.to_string())?;
    }
    Ok(())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    let mut builder = tauri::Builder::default();
    #[cfg(not(desktop))]
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let auth_urls: Vec<String> = args
                .into_iter()
                .filter(|arg| arg.starts_with("backlogger://auth/callback"))
                .collect();
            if !auth_urls.is_empty() {
                let _ = app.emit("backlogger-auth-callback", auth_urls);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
        builder = builder.plugin(tauri_plugin_deep_link::init());
        builder = builder.plugin(tauri_plugin_opener::init());
        builder = builder.plugin(tauri_plugin_dialog::init());
        builder = builder.setup(|_app| {
            #[cfg(all(debug_assertions, windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                _app.deep_link().register_all()?;
            }
            Ok(())
        });
    }
    builder
        .invoke_handler(tauri::generate_handler![
            load_notebook,
            load_notebook_backup,
            save_notebook,
            load_sync_state,
            save_sync_state,
            backup_sync_state,
            set_app_theme,
            read_document_file,
            write_document_file,
            start_oauth_callback_listener
        ])
        .run(tauri::generate_context!())
        .expect("error while running Backlogger");
}
