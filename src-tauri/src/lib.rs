// Kerros native shell.
//
// The Rust side does two things and no more: it hosts the window, and it writes
// a text file where the person said to put it.
//
// Writing is an own command rather than the fs plugin on purpose. The plugin
// would need filesystem scopes declared in the capabilities file, and getting
// those subtly wrong is the kind of mistake that shows up as a silent refusal
// at the worst moment. An application's own commands do not go through that ACL
// at all, so there is less to get wrong and the result is identical. The dialog
// plugin stays, because asking the operating system where to save is exactly
// what a plugin should be for.

use std::path::PathBuf;

/// Write UTF-8 text to a file, returning the path actually written.
///
/// `directory` is set when a whole batch is going into one folder the person
/// chose once; joining happens here with `PathBuf` so the separator is right on
/// every platform rather than assumed.
#[tauri::command]
fn write_text_file(
    directory: Option<String>,
    name: String,
    contents: String,
) -> Result<String, String> {
    let path: PathBuf = match directory {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir).join(&name),
        _ => PathBuf::from(&name),
    };

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
    }

    std::fs::write(&path, contents).map_err(|e| format!("could not write {}: {e}", path.display()))?;

    Ok(path.display().to_string())
}

/// Read UTF-8 text from a file the person picked.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("could not read {path}: {e}"))
}

/// Read a file as raw bytes, for meshes.
///
/// Returns a raw IPC response rather than a `Vec<u8>`, which would be
/// serialised as a JSON array of numbers — several times the size, for a file
/// that can easily be megabytes.
#[tauri::command]
fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![write_text_file, read_text_file, read_binary_file])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
