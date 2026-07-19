use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// Directory where downloaded state basemaps live (inside the app data dir).
fn states_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("states");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Path of the marks file (waypoints + tracks) inside the app data dir.
///
/// This is the user's own irreplaceable data — pins they dropped and tracks they
/// walked. It used to live in `localStorage`, which is a webview cache directory
/// that a reinstall or webview update can wipe. It lives in a real file now.
fn marks_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("marks.json"))
}

#[tauri::command]
fn read_marks(app: AppHandle) -> Result<String, String> {
    let p = marks_path(&app)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        // Fall back to the previous good copy if the main file is unreadable.
        Err(_) => Ok(std::fs::read_to_string(p.with_extension("bak")).unwrap_or_default()),
    }
}

#[tauri::command]
fn write_marks(app: AppHandle, json: String) -> Result<(), String> {
    let p = marks_path(&app)?;
    // Write to a temp file and rename over the target, so an interrupted write
    // (crash, dead battery) can't leave a half-written file behind. Keep the
    // previous version as .bak — cheap insurance for the one thing we can't
    // regenerate from the map packs.
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    if p.exists() {
        let _ = std::fs::copy(&p, p.with_extension("bak"));
    }
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

/// Locate the bundled go-pmtiles binary (dev: src-tauri/binaries; prod: next to exe).
fn pmtiles_bin() -> Option<PathBuf> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if let Ok(rd) = std::fs::read_dir(&dev) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("pmtiles") {
                return Some(e.path());
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Exact names, then any bundled "pmtiles*" (externalBin keeps the triple).
            for cand in ["pmtiles", "pmtiles.exe"] {
                let p = dir.join(cand);
                if p.exists() {
                    return Some(p);
                }
            }
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().starts_with("pmtiles") {
                        return Some(e.path());
                    }
                }
            }
        }
    }
    None
}

/// List installed state abbreviations (one .pmtiles file each).
#[tauri::command]
fn list_installed(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = states_dir(&app)?;
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("pmtiles") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    out.push(stem.to_string());
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Absolute path to an installed state's .pmtiles file (for convertFileSrc).
#[tauri::command]
fn state_path(app: AppHandle, abbr: String) -> Result<String, String> {
    Ok(states_dir(&app)?
        .join(format!("{}.pmtiles", abbr))
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn delete_state(app: AppHandle, abbr: String) -> Result<(), String> {
    let p = states_dir(&app)?.join(format!("{}.pmtiles", abbr));
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Convert days-since-Unix-epoch to a (year, month, day) civil date.
/// (Howard Hinnant's algorithm — avoids pulling in a date crate.)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// Find the most recent Protomaps daily planet build by probing back a few days.
/// (Done server-side; the build host sends no CORS headers for browsers.)
fn latest_build_url(bin: &std::path::Path) -> Result<String, String> {
    use std::process::Command;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let today = now / 86400;
    for i in 0..8 {
        let (y, m, d) = civil_from_days(today - i);
        let url = format!("https://build.protomaps.com/{:04}{:02}{:02}.pmtiles", y, m, d);
        if let Ok(o) = Command::new(bin).arg("show").arg(&url).output() {
            if String::from_utf8_lossy(&o.stdout).contains("spec version") {
                return Ok(url);
            }
        }
    }
    Err("No recent map build found — check your internet connection.".into())
}

/// Download a state basemap by extracting its bbox from a remote Protomaps planet
/// build using the go-pmtiles CLI. Emits `download-progress` events while running.
#[tauri::command]
async fn download_state(
    app: AppHandle,
    abbr: String,
    bbox: String,
    maxzoom: u32,
) -> Result<String, String> {
    let bin = pmtiles_bin().ok_or("go-pmtiles binary not found")?;
    let dir = states_dir(&app)?;
    let final_path = dir.join(format!("{}.pmtiles", abbr));
    let tmp_path = dir.join(format!("{}.pmtiles.part", abbr));

    let app2 = app.clone();
    let abbr2 = abbr.clone();
    let out = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        use std::io::Read;
        use std::process::{Command, Stdio};

        let _ = app2.emit(
            "download-progress",
            serde_json::json!({ "abbr": abbr2, "line": "Finding latest map build…" }),
        );
        let planet_url = latest_build_url(&bin)?;

        let mut child = Command::new(&bin)
            .arg("extract")
            .arg(&planet_url)
            .arg(&tmp_path)
            .arg(format!("--bbox={}", bbox))
            .arg(format!("--maxzoom={}", maxzoom))
            .arg("--download-threads=8")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

        // go-pmtiles may print progress to either stream; read both.
        let emit_stream = |mut stream: Box<dyn Read + Send>, app: AppHandle, abbr: String| {
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let line = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app.emit(
                                "download-progress",
                                serde_json::json!({ "abbr": abbr, "line": line }),
                            );
                        }
                    }
                }
            })
        };

        let mut handles = Vec::new();
        if let Some(out) = child.stdout.take() {
            handles.push(emit_stream(Box::new(out), app2.clone(), abbr2.clone()));
        }
        if let Some(err) = child.stderr.take() {
            handles.push(emit_stream(Box::new(err), app2.clone(), abbr2.clone()));
        }
        for h in handles {
            let _ = h.join();
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            std::fs::rename(&tmp_path, &final_path).map_err(|e| e.to_string())?;
            Ok(final_path.to_string_lossy().to_string())
        } else {
            let _ = std::fs::remove_file(&tmp_path);
            Err(format!("download failed (exit {:?})", status.code()))
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_installed,
            state_path,
            delete_state,
            download_state,
            read_marks,
            write_marks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
