use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, Child};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

struct PtyState {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

static BASE64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(input: &[u8]) -> String {
    let mut result = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(BASE64_CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(BASE64_CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(BASE64_CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(BASE64_CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[tauri::command]
fn create_pty(
    app: AppHandle,
    state: State<'_, PtyState>,
    rows: u16,
    cols: u16,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new_default_prog();
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    // Drop slave so we get EOF when the child exits
    drop(pair.slave);

    let master = pair.master;
    let writer = master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);

    // Spawn reader thread
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app_handle.emit("pty-exit", id);
                    break;
                }
                Ok(n) => {
                    let encoded = base64_encode(&buf[..n]);
                    let _ = app_handle.emit("pty-output", serde_json::json!({
                        "id": id,
                        "data": encoded
                    }));
                }
                Err(_) => {
                    let _ = app_handle.emit("pty-exit", id);
                    break;
                }
            }
        }
    });

    let session = PtySession {
        master,
        writer,
        child,
    };

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);

    Ok(id)
}

#[tauri::command]
fn write_pty(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("Session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_pty(state: State<'_, PtyState>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_font(family: String) -> Result<Option<String>, String> {
    let needle = family.replace(' ', "").to_lowercase();
    if needle.is_empty() {
        return Ok(None);
    }

    let home = std::env::var("HOME").unwrap_or_default();

    #[cfg(target_os = "macos")]
    let dirs = vec![
        format!("{}/Library/Fonts", home),
        "/Library/Fonts".to_string(),
        "/System/Library/Fonts".to_string(),
    ];
    #[cfg(target_os = "windows")]
    let dirs = vec![
        format!("{}\\Microsoft\\Windows\\Fonts", std::env::var("LOCALAPPDATA").unwrap_or_default()),
        "C:\\Windows\\Fonts".to_string(),
    ];
    #[cfg(target_os = "linux")]
    let dirs = vec![
        format!("{}/.local/share/fonts", home),
        "/usr/share/fonts".to_string(),
        "/usr/local/share/fonts".to_string(),
    ];

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    for dir in &dirs {
        collect_fonts(dir.as_ref(), &needle, &mut candidates);
    }

    // Prefer Regular weight
    candidates.sort_by(|a, b| {
        let a_reg = a.to_string_lossy().to_lowercase().contains("regular");
        let b_reg = b.to_string_lossy().to_lowercase().contains("regular");
        b_reg.cmp(&a_reg)
    });

    if let Some(path) = candidates.first() {
        let data = std::fs::read(path).map_err(|e| e.to_string())?;
        let b64 = base64_encode(&data);
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some("otf") => "opentype",
            _ => "truetype",
        };
        return Ok(Some(format!("data:font/{};base64,{}", ext, b64)));
    }

    Ok(None)
}

fn collect_fonts(dir: &std::path::Path, needle: &str, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_fonts(&path, needle, out);
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !(name.ends_with(".otf") || name.ends_with(".ttf") || name.ends_with(".ttc")) {
            continue;
        }
        // Strip extension, then check if filename starts with needle
        let stem = name.rsplitn(2, '.').last().unwrap_or(&name);
        let stem_clean = stem.replace(['-', '_'], "");
        if stem_clean.starts_with(needle) {
            out.push(path);
        }
    }
}

#[tauri::command]
fn close_pty(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        })
        .invoke_handler(tauri::generate_handler![
            create_pty,
            write_pty,
            resize_pty,
            close_pty,
            load_font,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
