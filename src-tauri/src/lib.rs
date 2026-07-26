use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

mod mesh;
mod packs;
// Public so the pack builder (src/bin/build-pack.rs) can reuse it. Cutting a
// pack in CI and cutting one on the phone must be the same code — a separate
// implementation is how the two quietly stop producing identical archives.
pub mod pmtiles_extract;

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
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "_".into()
    } else {
        cleaned
    }
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

/// Delete the scratch files left beside a state pack.
///
/// `keep_resumable` protects a partly-downloaded pre-built pack, which is the
/// one piece of scratch that is worth something: the next attempt resumes from
/// it. The extractor's own `.part` is never worth keeping — `extract` always
/// writes it from scratch and only removes it when it fails, so a `.part` left
/// by an app that was killed mid-extract is dead weight nothing will ever read.
/// One was found in the wild at 323 MB.
fn sweep_scratch(final_path: &std::path::Path, keep_resumable: bool) {
    let _ = std::fs::remove_file(final_path.with_extension("pmtiles.part"));
    if !keep_resumable {
        let _ = std::fs::remove_file(final_path.with_extension("pmtiles.packpart"));
        let _ = std::fs::remove_file(final_path.with_extension("pmtiles.packpart.sha"));
    }
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
        // A file that exists but holds nothing is NOT a first run. A crash or a
        // dead battery just after the rename below can leave exactly that, and
        // reading it as "no marks yet" is the worst possible answer: the caller
        // renders an empty app, the user drops one pin, and the save that
        // follows copies the empty file straight over the .bak. Both copies of
        // the one thing that cannot be regenerated, gone, in two taps.
        Ok(s) if s.trim().is_empty() => match std::fs::read_to_string(p.with_extension("bak")) {
            Ok(b) if !b.trim().is_empty() => Ok(b),
            // No usable backup either. If the file is genuinely zero bytes we
            // cannot tell "never written" from "lost", so refuse rather than
            // guess — marksUnreadable() then blocks every write.
            _ => {
                if std::fs::metadata(&p).map(|m| m.len() == 0).unwrap_or(false) {
                    Err("your saved marks are empty and the backup is too — \
                         restart the app before adding anything, and restore a backup if you have one"
                        .into())
                } else {
                    Ok(s)
                }
            }
        },
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
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| {
        // Don't leave the scratch file behind for a write that never happened.
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;

    // Refresh the backup, but only from a file worth backing up, and only via a
    // rename. fs::copy truncates its destination first, so a copy interrupted
    // by a full disk or a kill used to leave marks.bak truncated or empty —
    // silently, since the result was discarded — and the next corruption of the
    // main file then had nothing to fall back to.
    if let Ok(prev) = std::fs::read_to_string(&p) {
        if !prev.trim().is_empty() {
            let bak_tmp = p.with_extension("bak.tmp");
            if std::fs::write(&bak_tmp, prev.as_bytes()).is_ok() {
                let _ = std::fs::rename(&bak_tmp, p.with_extension("bak"));
            } else {
                let _ = std::fs::remove_file(&bak_tmp);
            }
        }
    }

    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

/// Whether this build targets iOS.
///
/// A constant threaded into the two functions below as an argument, rather than
/// `cfg!` inside them, so both platforms' behaviour can be exercised from any
/// host. That is not a style preference: the iOS branch is dead code on a Linux
/// or Windows build, so a `cfg!` written inline is never compiled here and the
/// choice it makes cannot be tested until it reaches a phone — which is exactly
/// how the Downloads bug shipped.
const IS_IOS: bool = cfg!(target_os = "ios");

/// Pick which OS directory an export belongs in, given what the platform offers.
///
/// Desktop wants Downloads, falling back to the home directory. iOS wants
/// Documents and **must not** fall back: `download_dir()` there resolves to
/// `$HOME/Downloads`, and `$HOME` inside an app sandbox is the container root,
/// which iOS makes read-only — so `create_dir_all` failed with EPERM and every
/// export died with "Couldn't save griddown-backup.json: Operation not
/// permitted (os error 1)". Backup, GPX export and the PDF map all route
/// through here, so all three were broken on the phone.
///
/// Documents is the one directory the app may write to that the user can also
/// reach: paired with `UIFileSharingEnabled` in Info.ios.plist it shows up in
/// the Files app as "On My iPhone → GridDown". Returning `None` when it is
/// unavailable is deliberate — an error the user sees beats a silent write into
/// a folder they can never open.
fn pick_export_dir(
    is_ios: bool,
    document: Option<PathBuf>,
    download: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    if is_ios {
        document
    } else {
        download.or(home)
    }
}

/// How to describe a saved file's location to the user.
///
/// On iOS the real path is a container UUID —
/// `/var/mobile/Containers/Data/Application/8F3C…/Documents/x.json` — which
/// tells someone nothing and looks like a fault. The route through the Files
/// app is the part they can actually follow.
fn export_location(is_ios: bool, path: &std::path::Path) -> String {
    if is_ios {
        "Files → On My iPhone → GridDown".to_string()
    } else {
        path.to_string_lossy().to_string()
    }
}

/// The export directory for this platform, created if it isn't there yet.
fn export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let p = app.path();
    let dir = pick_export_dir(
        IS_IOS,
        p.document_dir().ok(),
        p.download_dir().ok(),
        p.home_dir().ok(),
    )
    .ok_or_else(|| "couldn't find a folder to save into".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A file written by `save_file`.
#[derive(serde::Serialize)]
struct SavedFile {
    /// The real path on disk.
    path: String,
    /// Where to tell the user it went — not always the path; see
    /// [`export_location`].
    location: String,
}

/// Save an exported file (PDF, GPX, backup JSON) where the user can find it,
/// and report where that was.
///
/// The webview's own `<a download>` is a dead end in WebKitGTK — nothing
/// handles the download, so files silently vanish. Exports go through here.
#[tauri::command]
fn save_file(app: AppHandle, name: String, b64: String) -> Result<SavedFile, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| e.to_string())?;

    // Only a plain file name — no path components, and no Windows drive
    // prefix, which PathBuf::push would treat as a new base (see safe_abbr).
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._- ".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    // A leading dot makes a dotfile, and on a desktop with no XDG Downloads
    // directory `export_dir` falls back to $HOME — so a name like ".bashrc"
    // would drop a login shell rc file straight into the user's home. Nothing
    // legitimate exported from here starts with a dot.
    let name = name.trim_start_matches('.').to_string();
    let name = if name.trim().is_empty() {
        "export".to_string()
    } else {
        name
    };
    let dir = export_dir(&app)?;

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
    Ok(SavedFile {
        location: export_location(IS_IOS, &path),
        path: path.to_string_lossy().to_string(),
    })
}

/// Copy an installed pack out to the exports folder, so it can be moved to
/// another device on a USB stick / SD card — no internet needed on either end.
///
/// `async` so Tauri runs it off the UI thread: a pack is 237 MB to 1.5 GB, and
/// a synchronous command body is executed inline in the IPC handler, freezing
/// the window for the whole copy (a watchdog kill on iOS).
#[tauri::command]
async fn export_pack(app: AppHandle, abbr: String) -> Result<String, String> {
    let abbr = safe_abbr(&abbr);
    let src = states_dir(&app)?.join(format!("{}.pmtiles", abbr));
    if !src.exists() {
        return Err("that state isn't downloaded".into());
    }
    let dir = export_dir(&app)?;
    let name = format!("griddown-{}.pmtiles", abbr);
    let mut dest = dir.join(&name);
    let mut n = 2;
    while dest.exists() {
        dest = dir.join(format!("griddown-{}-{}.pmtiles", abbr, n));
        n += 1;
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        Ok(export_location(IS_IOS, &dest))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import a .pmtiles file from disk as a state pack (the other half of
/// export_pack). Copies into app-data under the given abbreviation.
/// `async` for the same reason as `export_pack`: this copies a multi-gigabyte
/// file and must not run on the UI thread.
#[tauri::command]
async fn import_pack(app: AppHandle, abbr: String, path: String) -> Result<(), String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err("file not found".into());
    }
    // The only caller is the file dialog, but the command itself would take any
    // absolute path — so require the extension as well as the magic below,
    // rather than copying an arbitrary file into a directory the asset protocol
    // serves back out.
    if !src
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pmtiles"))
    {
        return Err("that file isn't a PMTiles map pack".into());
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
    // `with_extension("part")` *replaces* .pmtiles, giving "OR.part" — which
    // sweep_scratch (which looks for "OR.pmtiles.part") never cleaned up, so an
    // interrupted import orphaned a full-size copy forever.
    let tmp = dest.with_extension("pmtiles.part");
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if let Err(e) = std::fs::copy(&src, &tmp) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        if let Err(e) = std::fs::rename(&tmp, &dest) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
    /// Whether that DEM is a FINISHED pyramid rather than however far a killed
    /// download got. Bytes on disk were standing in for this, and the two are
    /// not the same thing — see `dem_done_marker`.
    dem_complete: bool,
    /// Size of this state's Motor Vehicle Use Map overlay; 0 = not downloaded.
    mvum_bytes: u64,
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

/// Marker written when a DEM download reaches the end of its queue.
///
/// "Is terrain installed?" was answered by `dem_bytes > 0`, and a download that
/// is KILLED rather than failed leaves bytes behind. The tile queue is popped
/// from the back, so the deepest zoom goes first: a run that dies partway leaves
/// a directory holding some of z12 and nothing else. Every consequence of that
/// pointed the wrong way — the state row stopped offering "Add terrain", so
/// there was no way left to finish it; `terrainAvailable` went true, so the
/// Terrain button lit up and toggled; and hillshade asked for tiles at the zoom
/// the map was actually on, found none, and drew nothing. Pressing Terrain did
/// visibly nothing, on a state the app said had terrain. Found in the wild with
/// 390 MB of Oregon z12 and no other zoom at all.
///
/// Records the maxzoom too, so raising it later invalidates the old pyramid
/// rather than passing it off as current.
fn dem_done_marker(dir: &std::path::Path) -> PathBuf {
    dir.join("complete.json")
}

/// Whether a state's DEM is a finished pyramid at `maxzoom` or better.
fn dem_is_complete(dir: &std::path::Path, want_maxzoom: u32) -> bool {
    let Ok(s) = std::fs::read_to_string(dem_done_marker(dir)) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&s)
        .ok()
        .and_then(|v| v.get("maxzoom").and_then(|z| z.as_u64()))
        .is_some_and(|z| z as u32 >= want_maxzoom)
}

/// The maxzoom every DEM download asks for. One place, so the writer and the
/// completeness check cannot drift.
const DEM_MAXZOOM: u32 = 12;

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

/// `async` because `dir_size` stats a whole per-state DEM pyramid — tens of
/// thousands of PNGs, ~1 GB — and this runs on every Map packs / Readiness
/// open. Inline on the IPC handler that is a visible freeze.
#[tauri::command]
async fn pack_info(app: AppHandle) -> Result<Vec<PackInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PackInfo>, String> {
    let dir = states_dir(&app)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
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
        let dem_path = dem_dir(&app, abbr);
        let dem_bytes = dem_path.as_ref().map(dir_size).unwrap_or(0);
        let dem_complete = dem_path
            .as_ref()
            .map(|d| dem_is_complete(d, DEM_MAXZOOM))
            .unwrap_or(false);
        let mvum_bytes = mvum_file(&app, abbr)
            .ok()
            .and_then(|p| p.metadata().ok())
            .map(|m| m.len())
            .unwrap_or(0);
        out.push(PackInfo {
            abbr: abbr.to_string(),
            bytes: md.len(),
            modified,
            dem_bytes,
            dem_complete,
            mvum_bytes,
        });
    }
    out.sort_by(|a, b| a.abbr.cmp(&b.abbr));
    Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
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
    // As does the Forest Service overlay.
    if let Ok(mvum) = mvum_file(&app, &abbr) {
        let _ = std::fs::remove_file(&mvum);
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
        (((1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0) * tiles_across)
            as i64
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
    // Drop any previous marker for the duration: if THIS run is killed the
    // directory must not still be claiming to be finished.
    let _ = std::fs::remove_file(dem_done_marker(&dir));
    let marker = dem_done_marker(&dir);

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
        // Reached the end of the queue with the stragglers within tolerance:
        // this pyramid is as complete as it is going to get, and saying so is
        // what stops a killed run from passing for a finished one.
        let _ = std::fs::write(
            &marker,
            serde_json::json!({ "maxzoom": maxzoom, "tiles": total, "failed": nfail }).to_string(),
        );
        Ok(dir_size(&dir))
    })
    .await
    .map_err(|e2| e2.to_string())?;

    out
}

// --- Motor Vehicle Use Map (USFS) -------------------------------------------
//
// The MVUM is the legally operative answer to "may I drive this road, in this
// vehicle, today" — it is what the printed Forest Service MVUM booklets are
// generated from. OpenStreetMap has the geometry of most forest roads, but not
// the legal designation, and the two disagree often enough to matter.
//
// Fetched from the Forest Service's own ArcGIS service rather than shipped as a
// prebuilt pack: it needs no hosting, and the data is theirs to update. Paged
// into one GeoJSON file per state, sitting beside that state's basemap.

const MVUM_SERVICE: &str = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_01/MapServer";

/// Roads is layer 1, trails layer 2 — with the tag each is stored under.
const MVUM_LAYERS: [(u32, &str); 2] = [(1, "road"), (2, "trail")];

/// Attributes worth keeping. Everything else is inventory bookkeeping that
/// would only inflate a file destined for a phone.
const MVUM_FIELDS_COMMON: &str = "id,name,symbol,mvum_symbol_name,jurisdiction,seasonal,\
forestname,districtname,passengervehicle,passengervehicle_datesopen,highclearancevehicle,\
highclearancevehicle_datesopen,motorhome,motorhome_datesopen,fourwd_gt50inches,\
fourwd_gt50_datesopen,twowd_gt50inches,twowd_gt50_datesopen,atv,atv_datesopen,motorcycle,\
motorcycle_datesopen,otherwheeled_ohv,otherwheeled_ohv_datesopen,other_ohv_lt50inches,\
other_ohv_lt50_datesopen";

/// Geometry tolerance in degrees (~11 m) applied server-side. Forest roads are
/// navigated at ten metres of GPS error anyway, and it cuts the download by
/// roughly two thirds.
const MVUM_TOLERANCE: &str = "0.0001";

const MVUM_PAGE: usize = 1000;

/// The manifest CI publishes for the per-state MVUM overlays.
///
/// A fixed tag, not `latest`: the basemap packs resolve through
/// `releases/latest/download/packs.json`, and an MVUM release published
/// normally would become that repo's "latest" and answer to that URL instead.
const MVUM_MANIFEST_URL: &str =
    "https://github.com/pl0xuee/griddown-packs/releases/download/mvum-latest/mvum.json";

#[derive(serde::Deserialize)]
struct MvumPack {
    bytes: u64,
    sha256: String,
    url: String,
}

#[derive(serde::Deserialize)]
struct MvumManifest {
    states: std::collections::HashMap<String, MvumPack>,
}

/// Fetch a state's forest roads as a pre-built pack.
///
/// Tried before the Forest Service's own service, and the reason is the whole
/// point of the packs: their ArcGIS host is the single point of failure for
/// this feature, and when it is down — as it is now, for its entire catalogue —
/// there is no other way to get forest roads at all. A pack is one request to a
/// host we control, already split by state and already generalised, so the work
/// their server does for us is work CI did last month instead.
///
/// Errors are ordinary here rather than fatal: every one of them falls back to
/// the live download, because a state nobody has cut a pack for still has to
/// work.
fn mvum_from_pack(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    abbr: &str,
    path: &Path,
) -> Result<u64, String> {
    // Cache-busted, and it has to be. A release download URL is a redirect, and
    // it is the REDIRECT that goes stale: GitHub caches it for around twenty
    // minutes and ignores Cache-Control, so for that long after a rebuild it
    // still points at the previous manifest. That matters because the manifest
    // is replaced wholesale each time — a stale one lists sha256s for packs
    // that no longer exist, so every download fails its integrity check and
    // falls back to the live Forest Service service, which is the thing these
    // packs exist to route around.
    //
    // The parameter never reaches the asset; it is stripped on the way through
    // and every request lands on the same signed object URL. It forces a fresh
    // redirect, which is the part that has to change. Measured, not assumed:
    // fetching a replaced manifest with and without it, at the same moment,
    // returned two different files.
    let bust = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let manifest: MvumManifest = client
        .get(format!("{MVUM_MANIFEST_URL}?t={bust}"))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))?;

    let key = abbr.to_uppercase();
    let pack = manifest
        .states
        .get(&key)
        .ok_or_else(|| format!("no pre-built pack for {key}"))?;

    let mut res = client
        .get(&pack.url)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;

    // Hashed on the way past rather than re-read afterwards: these run to tens
    // of megabytes and the file is about to be renamed into place regardless.
    //
    // The whole download runs inside a closure so that EVERY way out of it goes
    // through the cleanup below. Only the checksum mismatch used to remove the
    // .part; a dropped connection, a full disk or a failed rename left tens of
    // megabytes of dead file in app data, invisible to the user and to the pack
    // list, and a retry wrote a second one beside it.
    let tmp = path.with_extension("part");
    let downloaded = (|| -> Result<u64, String> {
        let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut got: u64 = 0;
        loop {
            let n = std::io::Read::read(&mut res, &mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            sha2::Digest::update(&mut hasher, &buf[..n]);
            std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| e.to_string())?;
            got += n as u64;
            let _ = app.emit(
                "mvum-progress",
                serde_json::json!({ "abbr": abbr, "done": got, "total": pack.bytes }),
            );
        }
        drop(out);

        // Verified before it is allowed to become the overlay. A truncated pack
        // still parses far enough to draw, and would show as forest roads that
        // simply stop — which is the one failure this data must never present,
        // since "no road here" is a thing people act on.
        let sum = format!("{:x}", <sha2::Sha256 as sha2::Digest>::finalize(hasher));
        if got != pack.bytes || sum != pack.sha256 {
            return Err(format!(
                "pack for {key} arrived damaged ({got} bytes, expected {})",
                pack.bytes
            ));
        }
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(got)
    })();

    if downloaded.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    downloaded
}

/// Path of a state's MVUM overlay file.
fn mvum_file(app: &AppHandle, abbr: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mvum");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{}.geojson", safe_abbr(abbr))))
}


/// Whether the in-app self-updater exists on this platform.
///
/// Desktop only. iOS and Android update through their stores, and the updater
/// and process plugins are compiled out of mobile builds entirely (see
/// Cargo.toml), so the button would fire IPC at a plugin that isn't there.
///
/// Compile-time (`cfg!(desktop)`) rather than a runtime guess, on purpose: the
/// button used to be hidden by sniffing the user agent for "iPad", and iPadOS
/// reports a *desktop* Safari user agent — so the button stayed on iPad, which
/// is the whole bug this replaces.
#[tauri::command]
fn updates_supported() -> bool {
    // Must match the plugin registration below exactly. Reporting plain
    // `desktop` unhid the button in dev builds, where the updater and process
    // plugins are never registered, so pressing it fired IPC at nothing.
    cfg!(all(desktop, not(debug_assertions)))
}

/// Whether this is a mobile build (iOS/Android). The frontend uses it to pick
/// native geolocation over the web API — see the note on the geolocation plugin
/// in Cargo.toml. Compile-time, like `updates_supported`.
#[tauri::command]
fn is_mobile() -> bool {
    cfg!(mobile)
}

/// Absolute path to the bundled starter pack (the whole US at low zoom).
///
/// It has to be read through the asset protocol, not fetched from the frontend
/// like any other file in `public/`. PMTiles is read with HTTP range requests,
/// and the protocol serving the bundled frontend implements none — it answers a
/// range request with the whole 11 MB file and a 200, which the PMTiles reader
/// rejects outright ("Check that your storage backend supports HTTP Byte
/// Serving"). The map then never draws: a grey screen on a fresh install, on
/// every packaged build. The asset protocol does implement ranges, which is why
/// downloaded packs always worked; this puts the bundled one on the same path.
///
/// Ships as a bundled resource so it exists as a real file to point at. Under
/// `tauri dev` the frontend's own copy is served by Vite, which does support
/// ranges — which is exactly why this never showed up in development.
#[tauri::command]
fn starter_path(app: AppHandle) -> Result<String, String> {
    app.path()
        .resolve(
            "mapdata/starter.pmtiles",
            tauri::path::BaseDirectory::Resource,
        )
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("could not locate the bundled starter map: {e}"))
}

/// Absolute path to a state's MVUM file (for convertFileSrc).
#[tauri::command]
fn mvum_path(app: AppHandle, abbr: String) -> Result<String, String> {
    Ok(mvum_file(&app, &abbr)?.to_string_lossy().to_string())
}

/// Why an HTTP request failed, in words someone can act on.
///
/// reqwest's own Display is `error sending request for url (…)` followed by the
/// whole URL — for an ArcGIS query that is three hundred characters of geometry
/// and field names in a toast, and not one word about what actually went wrong,
/// because the cause lives in the error's SOURCE chain rather than its Display.
/// Surfacing it raw is how "the Forest Service closed the connection on us" and
/// "this laptop has no network" arrived looking identical, and neither of them
/// arrived legibly.
///
/// Reads as the reason after "Forest roads download failed: ", which is how
/// states.ts presents it.
fn http_why(e: &reqwest::Error) -> String {
    // The chain, lowercased, is only ever MATCHED against — never shown. It
    // contains the URL, which is the thing this function exists to keep out of
    // the message.
    let mut chain = String::new();
    let mut src: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(s) = src {
        chain.push_str(&s.to_string().to_lowercase());
        chain.push(' ');
        src = s.source();
    }
    if e.is_timeout() || chain.contains("timed out") {
        return "the Forest Service server took too long to answer. Try again later.".into();
    }
    if chain.contains("dns error") || chain.contains("failed to lookup") {
        return "couldn't find the Forest Service server. Check your internet connection.".into();
    }
    if chain.contains("reset") || chain.contains("closed") || chain.contains("broken pipe") {
        return "the Forest Service server closed the connection. Their service is having \
                trouble, not this app — try again later."
            .into();
    }
    if e.is_connect() {
        return "couldn't reach the Forest Service server. Check your internet connection, \
                then try again later."
            .into();
    }
    if let Some(code) = e.status() {
        return format!("the Forest Service server answered {code}. Try again later.");
    }
    "the Forest Service server didn't answer. Try again later.".into()
}

/// How many MVUM features a layer holds inside a bbox — for a progress total.
fn mvum_count(
    client: &reqwest::blocking::Client,
    layer: u32,
    envelope: &str,
) -> Result<usize, String> {
    let url = format!("{}/{}/query", MVUM_SERVICE, layer);
    // Retried, like the pages below. This runs FIRST and used to be the one step
    // of the download with no second chance: a single dropped connection here
    // ended the whole thing before a byte of road had been asked for, while the
    // very same blip three pages in would have been ridden out. Same three
    // attempts, same backoff.
    let mut last: Option<reqwest::Error> = None;
    let mut body = None;
    for attempt in 0..3 {
        match client
            .get(&url)
            .query(&[
                ("geometry", envelope),
                ("geometryType", "esriGeometryEnvelope"),
                ("inSR", "4326"),
                ("spatialRel", "esriSpatialRelIntersects"),
                ("where", "1=1"),
                ("returnCountOnly", "true"),
                ("f", "json"),
            ])
            .send()
            .and_then(|r| r.error_for_status())
            // Parsed from text rather than via reqwest's `json` feature, which
            // isn't enabled here and would pull in serde machinery this crate
            // already has.
            .and_then(|r| r.text())
        {
            Ok(b) => {
                body = Some(b);
                break;
            }
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(500 * (attempt + 1)));
            }
        }
    }
    let body = match body {
        Some(b) => b,
        // Every attempt failed the same way, so the last one's cause is the story.
        None => return Err(last.map(|e| http_why(&e)).unwrap_or_else(|| {
            "the Forest Service server didn't answer. Try again later.".into()
        })),
    };
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    // ArcGIS reports faults as HTTP 200 with an `error` member, so
    // `error_for_status` above lets them through. Defaulting a fault to 0 made
    // the caller announce "No Forest Service roads or trails in this area." —
    // presenting a service outage as a legal fact about where you may drive.
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Forest Service map service error: {msg}"));
    }
    match v.get("count").and_then(|c| c.as_u64()) {
        Some(n) => Ok(n as usize),
        None => Err("Forest Service map service returned no count.".into()),
    }
}

/// Drop null and blank attributes.
///
/// The MVUM carries 40-odd vehicle-class columns and most are null on any given
/// road; the allow-flags use `null`, `""` and `" "` interchangeably for "not
/// designated", so blanks carry no information either. Stripping them here
/// keeps a state file to a size worth putting on a phone.
fn mvum_strip(feature: &mut serde_json::Value) {
    let Some(props) = feature
        .get_mut("properties")
        .and_then(|p| p.as_object_mut())
    else {
        return;
    };
    props.retain(|_, v| match v {
        serde_json::Value::Null => false,
        serde_json::Value::String(s) => !s.trim().is_empty(),
        _ => true,
    });
}

/// Download the Motor Vehicle Use Map for a state's bbox into app-data as one
/// GeoJSON file. Emits `mvum-progress` while running.
#[tauri::command]
async fn download_mvum(app: AppHandle, abbr: String, bbox: String) -> Result<u64, String> {
    let parts: Vec<f64> = bbox
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    let [w, s, e, n] = parts[..] else {
        return Err("bad bbox".into());
    };
    let envelope = format!("{},{},{},{}", w, s, e, n);
    let path = mvum_file(&app, &abbr)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .user_agent("griddown-mvum/1.0")
            .build()
            .map_err(|e| e.to_string())?;

        // The pack first. Anything at all going wrong with it — no manifest, no
        // pack for this state, a damaged download — falls through to the live
        // service below, which is still the only way to get a state nobody has
        // cut a pack for.
        match mvum_from_pack(&app, &client, &abbr, &path) {
            Ok(bytes) => return Ok(bytes),
            Err(why) => eprintln!("[griddown] mvum pack unavailable ({why}); asking the Forest Service"),
        }

        let mut total = 0usize;
        for (layer, _) in MVUM_LAYERS {
            total += mvum_count(&client, layer, &envelope)?;
        }
        if total == 0 {
            return Err("No Forest Service roads or trails in this area.".into());
        }

        let mut features: Vec<serde_json::Value> = Vec::with_capacity(total);
        for (layer, kind) in MVUM_LAYERS {
            let fields = match kind {
                "road" => format!("{},operationalmaintlevel,surfacetype", MVUM_FIELDS_COMMON),
                _ => format!("{},trailclass", MVUM_FIELDS_COMMON),
            };
            let url = format!("{}/{}/query", MVUM_SERVICE, layer);
            let mut offset = 0usize;
            loop {
                let offset_s = offset.to_string();
                let page_s = MVUM_PAGE.to_string();
                // Each page gets its own retries: one flaky response should not
                // discard a download that may already be twenty pages deep.
                let mut page: Option<serde_json::Value> = None;
                // Kept so the failure can say WHICH failure it was. Discarding
                // it meant a download that died because the wifi dropped read
                // exactly like one the Forest Service refused.
                let mut last: Option<reqwest::Error> = None;
                for attempt in 0..3 {
                    let res = client
                        .get(&url)
                        .query(&[
                            ("geometry", envelope.as_str()),
                            ("geometryType", "esriGeometryEnvelope"),
                            ("inSR", "4326"),
                            ("outSR", "4326"),
                            ("spatialRel", "esriSpatialRelIntersects"),
                            ("where", "1=1"),
                            ("outFields", fields.as_str()),
                            ("resultOffset", offset_s.as_str()),
                            ("resultRecordCount", page_s.as_str()),
                            ("geometryPrecision", "5"),
                            ("maxAllowableOffset", MVUM_TOLERANCE),
                            ("f", "geojson"),
                        ])
                        .send()
                        .and_then(|r| r.error_for_status())
                        .and_then(|r| r.text());
                    match res {
                        Ok(b) => {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&b) {
                                page = Some(v);
                                break;
                            }
                            // A body that is not JSON is not a transport fault,
                            // so there is no reqwest error to keep — retry it
                            // anyway, which is what the old `.ok()` chain did.
                        }
                        Err(e) => last = Some(e),
                    }
                    // No point sleeping after the attempt that gives up.
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(500 * (attempt + 1)));
                    }
                }
                let Some(page) = page else {
                    return Err(match last {
                        Some(e) => http_why(&e),
                        None => "the Forest Service server sent something that wasn't a map. \
                                 Try again later."
                            .into(),
                    });
                };
                let Some(batch) = page.get("features").and_then(|f| f.as_array()) else {
                    break;
                };
                let got = batch.len();
                for f in batch {
                    let mut f = f.clone();
                    mvum_strip(&mut f);
                    if let Some(props) = f.get_mut("properties").and_then(|p| p.as_object_mut()) {
                        props.insert("gd_kind".into(), serde_json::json!(kind));
                    }
                    features.push(f);
                }
                let _ = app.emit(
                    "mvum-progress",
                    serde_json::json!({ "abbr": abbr, "done": features.len(), "total": total }),
                );
                // Trust the server's own "there is more" flag over a short page.
                // The service caps pages at its maxRecordCount, which is 2000
                // today but is theirs to change: if it ever dropped below the
                // page size we ask for, a `got < MVUM_PAGE` test would end the
                // download early and call a truncated map complete.
                let exceeded = page
                    .get("exceededTransferLimit")
                    .and_then(|v| v.as_bool())
                    .or_else(|| {
                        page.pointer("/properties/exceededTransferLimit")
                            .and_then(|v| v.as_bool())
                    })
                    .unwrap_or(false);
                if got == 0 || (!exceeded && got < MVUM_PAGE) {
                    break;
                }
                offset += got;
            }
        }

        let doc = serde_json::json!({
            "type": "FeatureCollection",
            // Stamped so the panel can say how old this is, and so a refetch
            // has something to compare against.
            "gd_downloaded": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            "gd_source": "USDA Forest Service Motor Vehicle Use Map",
            "features": features,
        });
        // Write-then-rename: a half-written overlay that still parses would be
        // worse than none, since it would look like the roads simply end.
        let tmp = path.with_extension("part");
        let bytes = serde_json::to_vec(&doc).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        Ok(bytes.len() as u64)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Convert days-since-Unix-epoch to a (year, month, day) civil date.
/// (Howard Hinnant's algorithm — avoids pulling in a date crate.)
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
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

/// Download a state basemap by extracting its bbox from a remote Protomaps
/// planet build. Emits `download-progress` events while running.
///
/// This used to shell out to the go-pmtiles CLI. iOS forbids spawning
/// subprocesses, so the extract is now done in-process — see pmtiles_extract.rs,
/// which also explains why it parses the archive's directories by hand rather
/// than using the `pmtiles` crate's reader.
#[tauri::command]
async fn download_state(
    app: AppHandle,
    abbr: String,
    bbox: String,
    maxzoom: u32,
) -> Result<String, String> {
    let dir = states_dir(&app)?;
    let final_path = dir.join(format!("{}.pmtiles", safe_abbr(&abbr)));
    let tmp_path = dir.join(format!("{}.pmtiles.part", safe_abbr(&abbr)));

    // Parse the bbox before touching the network, so a malformed one fails
    // instantly instead of after a build probe.
    let nums: Vec<f64> = bbox
        .split(',')
        .map(|s| {
            s.trim()
                .parse::<f64>()
                .map_err(|e| format!("bad bbox value {s:?}: {e}"))
        })
        .collect::<Result<_, _>>()?;
    let [min_lon, min_lat, max_lon, max_lat] = nums[..] else {
        return Err(format!(
            "bbox needs 4 comma-separated numbers, got {}",
            nums.len()
        ));
    };
    let maxzoom = u8::try_from(maxzoom).map_err(|_| format!("zoom {maxzoom} out of range"))?;

    let app2 = app.clone();
    let abbr2 = abbr.clone();
    let out = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let status = |line: &str| {
            let _ = app2.emit(
                "download-progress",
                serde_json::json!({ "abbr": abbr2, "line": line }),
            );
        };

        // A pre-built pack first: one file instead of tens of thousands of range
        // requests. Anything that goes wrong here — no network, no manifest, no
        // pack for this state, a corrupt download — falls through to extracting
        // it live, which is slow but needs nothing but the planet archive.
        // Reclaim any dead extractor scratch before writing half a gigabyte
        // next to it, rather than after. A resumable pack part is left alone.
        sweep_scratch(&final_path, true);

        status("Looking for a pre-built pack…");
        match packs::fetch_manifest() {
            Ok(manifest) => match manifest.pack_for(&abbr2, maxzoom) {
                Some(pack) => {
                    status(&format!(
                        "Downloading {} pack ({})…",
                        abbr2,
                        packs::human_bytes(pack.bytes)
                    ));
                    let mut last_pct = u64::MAX;
                    let result = packs::download(pack, &final_path, &status, &mut |done, total| {
                        let pct = done * 100 / total.max(1);
                        if pct != last_pct {
                            last_pct = pct;
                            let _ = app2.emit(
                                "download-progress",
                                serde_json::json!({
                                    "abbr": abbr2, "done": done, "total": total, "pct": pct
                                }),
                            );
                        }
                    });
                    match result {
                        Ok(()) => {
                            sweep_scratch(&final_path, false);
                            return Ok(final_path.to_string_lossy().to_string());
                        }
                        Err(e) => {
                            status(&format!("Pack download failed ({e}) — building it here…"))
                        }
                    }
                }
                None => status("No pre-built pack for this state — building it here…"),
            },
            Err(e) => status(&format!("Pack index unavailable ({e}) — building it here…")),
        }

        status("Finding latest map build…");
        let today = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs()
            / 86400) as i64;
        let planet_url = pmtiles_extract::latest_build_url(today)?;

        use pmtiles_extract::TileSource as _;
        let src = pmtiles_extract::HttpSource::new(&planet_url)?;
        let head = src.read_range(0, pmtiles_extract::HEADER_LEN as u64)?;
        let header = pmtiles_extract::Header::parse(&head)?;

        status("Working out which tiles to fetch…");

        // Emit only when the whole-number percentage changes: a state extract
        // completes tens of batches, and one IPC message per batch is plenty.
        let mut last_pct = u64::MAX;
        let result = pmtiles_extract::extract(
            &src,
            &header,
            &tmp_path,
            0,
            maxzoom,
            (min_lon, min_lat, max_lon, max_lat),
            &mut |done, total| {
                let pct = done * 100 / total.max(1);
                if pct != last_pct {
                    last_pct = pct;
                    let _ = app2.emit(
                        "download-progress",
                        serde_json::json!({
                            "abbr": abbr2, "done": done, "total": total, "pct": pct
                        }),
                    );
                }
            },
        );

        match result {
            Ok(_) => {
                // Rename only on success: a half-written .part must never be
                // mistaken for an installed pack.
                std::fs::rename(&tmp_path, &final_path).map_err(|e| e.to_string())?;
                sweep_scratch(&final_path, false);
                Ok(final_path.to_string_lossy().to_string())
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_path);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // Desktop release builds only.
    //
    // Release-only: under `tauri dev` the updater's config deserializes to null
    // and the plugin fails to initialise, taking the whole app down at startup —
    // which is what forced this feature to be reverted last time.
    //
    // Desktop-only: Cargo excludes both plugins on iOS/Android (see Cargo.toml),
    // so gating on `debug_assertions` alone would leave this block referencing
    // crates that don't exist and break every release mobile build.
    #[cfg(all(desktop, not(debug_assertions)))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Native geolocation, mobile only (the crate is not built for desktop —
    // see Cargo.toml). Lets the app reach CoreLocation directly on iOS so there
    // is only the system permission prompt, not WKWebView's extra website one.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_geolocation::init());

    builder
        .invoke_handler(tauri::generate_handler![
            list_installed,
            state_path,
            starter_path,
            updates_supported,
            is_mobile,
            delete_state,
            download_state,
            read_marks,
            write_marks,
            pack_info,
            save_file,
            download_dem,
            dem_path,
            download_mvum,
            mvum_path,
            mesh::mesh_connect,
            mesh::mesh_disconnect,
            export_pack,
            import_pack
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Option<PathBuf> {
        Some(PathBuf::from(s))
    }

    /// Bytes on disk are not the question. A DEM download that is KILLED rather
    /// than failed leaves tiles behind — the queue pops from the back, so it is
    /// some of the deepest zoom and nothing else — and every consequence of
    /// calling that "installed" pointed the wrong way: the state row stopped
    /// offering to finish it, the Terrain button lit up, and hillshade drew
    /// nothing because it asks for the zoom the map is actually on.
    #[test]
    fn dem_completeness_is_marked_not_inferred() {
        let dir = std::env::temp_dir().join(format!("gd-dem-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("12").join("600")).unwrap();

        // A partial pyramid: real tiles, no marker.
        std::fs::write(dir.join("12").join("600").join("1400.png"), b"notempty").unwrap();
        assert!(
            !dem_is_complete(&dir, DEM_MAXZOOM),
            "tiles on disk must not pass for a finished download"
        );

        // Finished at the zoom we ask for.
        std::fs::write(
            dem_done_marker(&dir),
            serde_json::json!({ "maxzoom": DEM_MAXZOOM, "tiles": 1, "failed": 0 }).to_string(),
        )
        .unwrap();
        assert!(dem_is_complete(&dir, DEM_MAXZOOM));

        // Deeper than asked for still counts; shallower does not — raising
        // DEM_MAXZOOM has to invalidate a pyramid built to the old one rather
        // than pass it off as current.
        assert!(dem_is_complete(&dir, DEM_MAXZOOM - 1));
        assert!(!dem_is_complete(&dir, DEM_MAXZOOM + 1));

        // Garbage is not a completion certificate.
        std::fs::write(dem_done_marker(&dir), "{ this is not json").unwrap();
        assert!(!dem_is_complete(&dir, DEM_MAXZOOM));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The bug this whole pair of functions exists to prevent. iOS has no
    /// Downloads folder, and the fallback chain desktop uses is actively
    /// harmful there: `$HOME/Downloads` is the app container root, which the
    /// sandbox makes read-only, so the write fails with EPERM.
    #[test]
    fn ios_exports_go_to_documents_and_never_to_downloads_or_home() {
        let got = pick_export_dir(
            true,
            p("/container/Documents"),
            p("/container/Downloads"),
            p("/container"),
        );
        assert_eq!(got, p("/container/Documents"));
    }

    /// Falling back on iOS is worse than failing: the fallbacks are precisely
    /// the unwritable paths. An error the user can see beats a silent EPERM.
    #[test]
    fn ios_refuses_to_fall_back_when_documents_is_missing() {
        let got = pick_export_dir(true, None, p("/container/Downloads"), p("/container"));
        assert_eq!(got, None, "no Documents means no export, not a bad guess");
    }

    /// Desktop is unchanged by the iOS fix — Downloads still wins.
    #[test]
    fn desktop_exports_go_to_downloads() {
        let got = pick_export_dir(false, p("/home/u/Documents"), p("/home/u/Downloads"), p("/home/u"));
        assert_eq!(got, p("/home/u/Downloads"));
    }

    /// Some Linux setups have no XDG Downloads directory at all.
    #[test]
    fn desktop_falls_back_to_home_without_a_downloads_folder() {
        let got = pick_export_dir(false, p("/home/u/Documents"), None, p("/home/u"));
        assert_eq!(got, p("/home/u"));
    }

    /// The toast text. An iOS container path is a UUID the user can neither
    /// read nor act on, so it must never be what they are shown; on desktop the
    /// real path is exactly what they want.
    #[test]
    fn the_user_is_told_a_place_they_can_actually_find() {
        let container = "/var/mobile/Containers/Data/Application/8F3C-DEAD-BEEF/Documents/b.json";
        let ios = export_location(true, std::path::Path::new(container));
        assert!(!ios.contains('/'), "showed a raw container path: {ios}");
        assert!(ios.contains("Files"), "should name the Files app: {ios}");

        let desktop = export_location(false, std::path::Path::new("/home/u/Downloads/x.json"));
        assert_eq!(desktop, "/home/u/Downloads/x.json");
    }

    /// `with_extension` on a path that already ends in `.pmtiles` replaces that
    /// extension rather than appending to it, so these names are easy to get
    /// subtly wrong — and wrong here means either sweeping nothing or sweeping
    /// the installed pack.
    #[test]
    fn sweeping_removes_the_scratch_and_never_the_pack() {
        let dir = std::env::temp_dir().join(format!("gd-sweep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pack = dir.join("OR.pmtiles");

        let write_all = || {
            for f in [
                "OR.pmtiles",
                "OR.pmtiles.part",
                "OR.pmtiles.packpart",
                "OR.pmtiles.packpart.sha",
            ] {
                std::fs::write(dir.join(f), b"x").unwrap();
            }
        };

        // Mid-download: the resumable pack part survives, dead extractor
        // scratch does not.
        write_all();
        sweep_scratch(&pack, true);
        assert!(pack.exists(), "the installed pack is never swept");
        assert!(!dir.join("OR.pmtiles.part").exists());
        assert!(dir.join("OR.pmtiles.packpart").exists());
        assert!(dir.join("OR.pmtiles.packpart.sha").exists());

        // Finished: everything but the pack goes.
        write_all();
        sweep_scratch(&pack, false);
        assert!(pack.exists(), "the installed pack is never swept");
        assert!(!dir.join("OR.pmtiles.part").exists());
        assert!(!dir.join("OR.pmtiles.packpart").exists());
        assert!(!dir.join("OR.pmtiles.packpart.sha").exists());

        // Missing files are not an error — this runs on every download.
        sweep_scratch(&pack, false);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

