use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// A state abbreviation that is safe to paste into a path.
///
/// Every command below builds a filename from a caller-supplied abbreviation.
/// Real ones are two letters, but nothing enforces that at the boundary, and a
/// value containing `/`, `\` or `.` would escape the app-data directory — so
/// `delete_state("../../x")` could remove a file outside it. Sanitize in one
/// place rather than per call site: this was previously applied in
/// import_pack/dem_dir but NOT in state_path/delete_state/download_state.
fn safe_abbr(abbr: &str) -> String {
    // Allow-list rather than strip-list. Stripping separators still lets a
    // Windows drive-relative prefix ("C:evil") through, and PathBuf::push with
    // a prefixed-but-rootless argument REPLACES the base path — so the write
    // would land relative to that drive's CWD instead of app-data.
    let cleaned: String = abbr
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if cleaned.is_empty() { "_".into() } else { cleaned }
}

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
        Err(e) => match std::fs::read_to_string(p.with_extension("bak")) {
            Ok(s) => Ok(s),
            // Only "there is no file yet" may report as empty. Any other error
            // (permissions, IO, bad UTF-8) must NOT look like a first run: the
            // caller would render "no waypoints" and then save that emptiness
            // straight over the user's real, irreplaceable marks.
            Err(be) => {
                if e.kind() == std::io::ErrorKind::NotFound
                    && be.kind() == std::io::ErrorKind::NotFound
                {
                    Ok(String::new())
                } else {
                    Err(format!("couldn't read your saved marks: {e}"))
                }
            }
        },
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

/// Save an exported file (PDF, GPX, backup JSON) to the user's Downloads
/// folder and return the full path, so the UI can say where it went.
///
/// The webview's own `<a download>` is a dead end in WebKitGTK — nothing
/// handles the download, so files silently vanish. Exports go through here.
#[tauri::command]
fn save_file(app: AppHandle, name: String, b64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| e.to_string())?;

    // Only a plain file name — no path components, and no Windows drive
    // prefix, which PathBuf::push would treat as a new base (see safe_abbr).
    let name: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._- ".contains(c) { c } else { '_' })
        .collect();
    let name = if name.trim().is_empty() { "export".to_string() } else { name };
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Don't clobber an earlier export: name.pdf, name-2.pdf, name-3.pdf…
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    let mut path = dir.join(&name);
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }

    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Copy an installed pack out to the Downloads folder, so it can be moved to
/// another device on a USB stick / SD card — no internet needed on either end.
#[tauri::command]
fn export_pack(app: AppHandle, abbr: String) -> Result<String, String> {
    let abbr = safe_abbr(&abbr);
    let src = states_dir(&app)?.join(format!("{}.pmtiles", abbr));
    if !src.exists() {
        return Err("that state isn't downloaded".into());
    }
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    let name = format!("griddown-{}.pmtiles", abbr);
    let mut dest = dir.join(&name);
    let mut n = 2;
    while dest.exists() {
        dest = dir.join(format!("griddown-{}-{}.pmtiles", abbr, n));
        n += 1;
    }
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

/// Import a .pmtiles file from disk as a state pack (the other half of
/// export_pack). Copies into app-data under the given abbreviation.
#[tauri::command]
fn import_pack(app: AppHandle, abbr: String, path: String) -> Result<(), String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err("file not found".into());
    }
    // Cheap sanity check: PMTiles archives start with the magic "PMTiles".
    let mut head = [0u8; 7];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(&src).map_err(|e| e.to_string())?;
        f.read_exact(&mut head).map_err(|e| e.to_string())?;
    }
    if &head != b"PMTiles" {
        return Err("that file isn't a PMTiles map pack".into());
    }
    let abbr = safe_abbr(&abbr);
    let dest = states_dir(&app)?.join(format!("{}.pmtiles", abbr));
    let tmp = dest.with_extension("part");
    std::fs::copy(&src, &tmp).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Size and age of each installed state pack, for the readiness check.
///
/// Age matters off-grid: OSM changes constantly, and a pack you downloaded two
/// years ago is the map you'll be living with. Surfacing it is the only way the
/// user finds out while they still have a connection to do something about it.
#[derive(serde::Serialize)]
struct PackInfo {
    abbr: String,
    bytes: u64,
    /// Seconds since the Unix epoch; 0 if the filesystem won't say.
    modified: u64,
    /// Total size of this state's downloaded DEM tiles; 0 = no terrain.
    dem_bytes: u64,
}

/// Directory holding a state's DEM tile pyramid ({z}/{x}/{y}.png).
/// Per-state (not shared) so deleting a state cleanly deletes its terrain.
fn dem_dir(app: &AppHandle, abbr: &str) -> Result<PathBuf, String> {
    let abbr = safe_abbr(abbr);
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("dem")
        .join(abbr))
}

fn dir_size(dir: &PathBuf) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            total += dir_size(&p);
        } else if let Ok(md) = e.metadata() {
            total += md.len();
        }
    }
    total
}

#[tauri::command]
fn pack_info(app: AppHandle) -> Result<Vec<PackInfo>, String> {
    let dir = states_dir(&app)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("pmtiles") {
            continue;
        }
        let Some(abbr) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let md = match e.metadata() {
            Ok(md) => md,
            Err(_) => continue,
        };
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let dem_bytes = dem_dir(&app, abbr).map(|d| dir_size(&d)).unwrap_or(0);
        out.push(PackInfo {
            abbr: abbr.to_string(),
            bytes: md.len(),
            modified,
            dem_bytes,
        });
    }
    out.sort_by(|a, b| a.abbr.cmp(&b.abbr));
    Ok(out)
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
        .join(format!("{}.pmtiles", safe_abbr(&abbr)))
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn delete_state(app: AppHandle, abbr: String) -> Result<(), String> {
    let p = states_dir(&app)?.join(format!("{}.pmtiles", safe_abbr(&abbr)));
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    // Terrain belongs to the state — remove it too.
    let dem = dem_dir(&app, &abbr)?;
    if dem.exists() {
        let _ = std::fs::remove_dir_all(&dem);
    }
    Ok(())
}

/// Absolute path of a state's DEM directory (for convertFileSrc tile URLs).
#[tauri::command]
fn dem_path(app: AppHandle, abbr: String) -> Result<String, String> {
    Ok(dem_dir(&app, &abbr)?.to_string_lossy().to_string())
}

/// Slippy-map tile coordinates covering a bbox at one zoom level.
fn tiles_at(z: u32, w: f64, s: f64, e: f64, n: f64) -> Vec<(u32, u32, u32)> {
    let tiles_across = (1u64 << z) as f64;
    let lon2x = |lon: f64| ((lon + 180.0) / 360.0 * tiles_across) as i64;
    let lat2y = |lat: f64| {
        let r = lat.to_radians();
        (((1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0) * tiles_across) as i64
    };
    let (x0, x1) = (lon2x(w), lon2x(e));
    let (y0, y1) = (lat2y(n), lat2y(s)); // north = smaller y
    let max = (1i64 << z) - 1;
    let mut out = Vec::new();
    for x in x0.min(x1).max(0)..=x1.max(x0).min(max) {
        for y in y0.min(y1).max(0)..=y1.max(y0).min(max) {
            out.push((z, x as u32, y as u32));
        }
    }
    out
}

/// Download the Terrarium DEM pyramid (z0..maxzoom) for a state's bbox from
/// the AWS Open Data terrain tiles into app-data. Resumable: existing tiles
/// are skipped, so an interrupted download just continues next time.
#[tauri::command]
async fn download_dem(
    app: AppHandle,
    abbr: String,
    bbox: String,
    maxzoom: u32,
) -> Result<u64, String> {
    let parts: Vec<f64> = bbox
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    let [w, s, e, n] = parts[..] else {
        return Err("bad bbox".into());
    };
    let dir = dem_dir(&app, &abbr)?;
    std::fs::create_dir_all(&dir).map_err(|e2| e2.to_string())?;

    let mut todo: Vec<(u32, u32, u32)> = Vec::new();
    for z in 0..=maxzoom.min(14) {
        todo.extend(tiles_at(z, w, s, e, n));
    }
    let total = todo.len();

    let out = tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("griddown-dem/1.0")
            .build()
            .map_err(|e2| e2.to_string())?;

        let queue = Arc::new(Mutex::new(todo));
        let done = Arc::new(AtomicUsize::new(0));
        let failed = Arc::new(AtomicUsize::new(0));

        let workers: Vec<_> = (0..12)
            .map(|_| {
                let queue = Arc::clone(&queue);
                let done = Arc::clone(&done);
                let failed = Arc::clone(&failed);
                let client = client.clone();
                let dir = dir.clone();
                let app = app.clone();
                let abbr = abbr.clone();
                std::thread::spawn(move || {
                    loop {
                        let Some((z, x, y)) = queue.lock().unwrap().pop() else {
                            break;
                        };
                        let path = dir.join(z.to_string()).join(x.to_string()).join(format!("{y}.png"));
                        let mut ok = path.metadata().map(|m| m.len() > 0).unwrap_or(false);
                        if !ok {
                            let url = format!(
                                "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
                            );
                            // A couple of retries, then count it as failed.
                            for attempt in 0..3 {
                                let res = client.get(&url).send().and_then(|r| {
                                    r.error_for_status().map(|r| r.bytes())
                                });
                                if let Ok(Ok(bytes)) = res.map(|b| b) {
                                    let _ = std::fs::create_dir_all(path.parent().unwrap());
                                    // Write-then-rename. A plain write isn't atomic, so an
                                    // interrupted download leaves a truncated PNG with a
                                    // non-zero length — which the resume check above treats
                                    // as "already have it", making the corrupt tile permanent
                                    // and surfacing forever as a hole in the terrain.
                                    let tmp = path.with_extension("part");
                                    if std::fs::write(&tmp, &bytes).is_ok()
                                        && std::fs::rename(&tmp, &path).is_ok()
                                    {
                                        ok = true;
                                        break;
                                    }
                                }
                                std::thread::sleep(std::time::Duration::from_millis(300 * (attempt + 1)));
                            }
                        }
                        if !ok {
                            failed.fetch_add(1, Ordering::Relaxed);
                        }
                        let n2 = done.fetch_add(1, Ordering::Relaxed) + 1;
                        if n2 % 100 == 0 || n2 == total {
                            let _ = app.emit(
                                "dem-progress",
                                serde_json::json!({ "abbr": abbr, "done": n2, "total": total }),
                            );
                        }
                    }
                })
            })
            .collect();
        for wkr in workers {
            let _ = wkr.join();
        }

        let nfail = failed.load(Ordering::Relaxed);
        // Tolerate stragglers (they'll be retried on the next run), but a big
        // failure count means no/poor connection — say so instead of lying.
        if nfail * 50 > total.max(1) {
            return Err(format!("{} of {} tiles failed — check your connection and try again", nfail, total));
        }
        Ok(dir_size(&dir))
    })
    .await
    .map_err(|e2| e2.to_string())?;

    out
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
    let final_path = dir.join(format!("{}.pmtiles", safe_abbr(&abbr)));
    let tmp_path = dir.join(format!("{}.pmtiles.part", safe_abbr(&abbr)));

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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init());

    // Release builds only. Under `tauri dev` the updater's config deserializes
    // to null and the plugin fails to initialise, taking the whole app down at
    // startup — which is what forced this feature to be reverted last time.
    #[cfg(not(debug_assertions))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .invoke_handler(tauri::generate_handler![
            list_installed,
            state_path,
            delete_state,
            download_state,
            read_marks,
            write_marks,
            pack_info,
            save_file,
            download_dem,
            dem_path,
            export_pack,
            import_pack
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
