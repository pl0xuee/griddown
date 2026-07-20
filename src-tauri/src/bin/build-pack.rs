//! Cut one state pack from the Protomaps planet build.
//!
//! This is the work the app used to do on the phone, moved to CI so it happens
//! once instead of once per user. A state is on the order of 65,000 small range
//! requests against Protomaps' shared planet archive — over twenty minutes of
//! request overhead on a phone connection, and rude to a free public server
//! when every install repeats it.
//!
//! Deliberately the *same* extractor the app ships, not a reimplementation:
//! two implementations is how CI-built and app-built archives quietly stop
//! matching.
//!
//! Usage:
//!   build-pack <ABBR> <states.json> <out.pmtiles> [maxzoom]

use griddown_lib::pmtiles_extract as px;
use px::TileSource as _;

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        return Err(format!(
            "usage: {} <ABBR> <states.json> <out.pmtiles> [maxzoom]",
            args[0]
        ));
    }
    let abbr = args[1].to_uppercase();
    let states_path = &args[2];
    let out = std::path::Path::new(&args[3]);
    let max_zoom: u8 = args
        .get(4)
        .map(|s| s.parse())
        .transpose()
        .map_err(|e| format!("bad maxzoom: {e}"))?
        // 15 is what the app asks for, and the packs have to match what the app
        // would have produced or switching source changes the map.
        .unwrap_or(15);

    // A bare bounding box instead of a state code, for packs that are not a
    // state — the low-zoom whole-country starter pack in particular.
    let bbox = if abbr.contains(',') {
        let n: Vec<f64> = abbr
            .split(',')
            .map(|s| s.trim().parse::<f64>().map_err(|e| format!("bad bbox: {e}")))
            .collect::<Result<_, _>>()?;
        if n.len() != 4 {
            return Err(format!("a bbox needs 4 numbers, got {}", n.len()));
        }
        (n[0], n[1], n[2], n[3])
    } else {
        bbox_for(&abbr, states_path)?
    };
    eprintln!("{abbr}: bbox {bbox:?}, zoom 0..{max_zoom}");

    let today = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs()
        / 86400) as i64;
    let url = px::latest_build_url(today)?;
    eprintln!("{abbr}: planet build {url}");

    let src = px::HttpSource::new(&url)?;
    let head = src.read_range(0, px::HEADER_LEN as u64)?;
    let header = px::Header::parse(&head)?;

    // CI logs are the only progress indicator here, and a job that prints
    // nothing for twenty minutes looks hung. One line per 5% is enough to see
    // it moving without burying the log.
    let mut last_bucket = u64::MAX;
    let started = std::time::Instant::now();
    let written = px::extract(
        &src,
        &header,
        out,
        0,
        max_zoom,
        bbox,
        &mut |done, total| {
            let bucket = done * 20 / total.max(1);
            if bucket != last_bucket {
                last_bucket = bucket;
                eprintln!(
                    "{abbr}: {}% ({done}/{total} tiles, {:.0}s)",
                    bucket * 5,
                    started.elapsed().as_secs_f64()
                );
            }
        },
    )?;

    let bytes = std::fs::metadata(out).map_err(|e| e.to_string())?.len();
    eprintln!(
        "{abbr}: done — {written} tiles, {:.0} MB in {:.0}s",
        bytes as f64 / 1e6,
        started.elapsed().as_secs_f64()
    );

    // The workflow reads these to assemble the manifest. Printed as plain
    // key=value on stdout so the shell does not have to parse the log.
    println!("abbr={abbr}");
    println!("bytes={bytes}");
    println!("tiles={written}");
    println!("planet={url}");
    Ok(())
}

/// Look up a state's bounding box in the same states.json the app ships, so a
/// pack covers exactly what the app would have asked for.
fn bbox_for(abbr: &str, path: &str) -> Result<(f64, f64, f64, f64), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("{path}: {e}"))?;
    let rows = json
        .as_array()
        .or_else(|| json.get("states").and_then(|s| s.as_array()))
        .ok_or_else(|| format!("{path}: expected an array of states"))?;

    for s in rows {
        if s.get("abbr").and_then(|a| a.as_str()) != Some(abbr) {
            continue;
        }
        let b = s
            .get("bbox")
            .and_then(|b| b.as_array())
            .ok_or_else(|| format!("{abbr}: no bbox"))?;
        if b.len() != 4 {
            return Err(format!("{abbr}: bbox needs 4 numbers, got {}", b.len()));
        }
        let n: Vec<f64> = b
            .iter()
            .map(|v| v.as_f64().ok_or_else(|| format!("{abbr}: non-numeric bbox")))
            .collect::<Result<_, _>>()?;
        return Ok((n[0], n[1], n[2], n[3]));
    }
    Err(format!("{abbr}: not found in {path}"))
}
