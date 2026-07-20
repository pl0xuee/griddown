use std::path::PathBuf;
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
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._- ".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let name = if name.trim().is_empty() {
        "export".to_string()
    } else {
        name
    };
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
        let dem_bytes = dem_dir(&app, abbr).map(|d| dir_size(&d)).unwrap_or(0);
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
            mvum_bytes,
        });
    }
    out.sort_by(|a, b| a.abbr.cmp(&b.abbr));
    Ok(out)
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

/// Absolute path to a state's MVUM file (for convertFileSrc).
#[tauri::command]
fn mvum_path(app: AppHandle, abbr: String) -> Result<String, String> {
    Ok(mvum_file(&app, &abbr)?.to_string_lossy().to_string())
}

/// How many MVUM features a layer holds inside a bbox — for a progress total.
fn mvum_count(
    client: &reqwest::blocking::Client,
    layer: u32,
    envelope: &str,
) -> Result<usize, String> {
    let url = format!("{}/{}/query", MVUM_SERVICE, layer);
    let res = client
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
        .map_err(|e| e.to_string())?;
    // Parsed from text rather than via reqwest's `json` feature, which isn't
    // enabled here and would pull in serde machinery this crate already has.
    let body = res.text().map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(v.get("count").and_then(|c| c.as_u64()).unwrap_or(0) as usize)
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
                        .and_then(|r| r.error_for_status());
                    let parsed = res
                        .and_then(|r| r.text())
                        .ok()
                        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok());
                    match parsed {
                        Some(v) => {
                            page = Some(v);
                            break;
                        }
                        None => std::thread::sleep(std::time::Duration::from_millis(
                            500 * (attempt + 1),
                        )),
                    }
                }
                let Some(page) = page else {
                    return Err(
                        "The Forest Service map server didn't respond — try again later.".into(),
                    );
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
