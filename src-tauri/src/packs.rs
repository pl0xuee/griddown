//! Pre-built state packs.
//!
//! Downloading a state used to mean reconstructing it from Protomaps' shared
//! planet archive: Oregon is 65,160 range requests averaging 8.2 KB, which is
//! twenty-odd minutes of round trips before any map appears. That work now
//! happens once in CI (pl0xuee/griddown-packs) and the app fetches a single
//! file — 472 MB for Oregon, one request.
//!
//! Live extraction stays as the fallback in `download_state`, because the
//! manifest only covers states someone has actually cut, and the app has to
//! keep working for the ones nobody has.

use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The manifest CI publishes alongside the packs.
///
/// `latest` rather than a dated tag: packs are re-cut when the planet build
/// moves, under a new `packs-YYYYMMDD` tag each time. Pinning a tag here would
/// freeze the app on whichever build happened to be current when it shipped.
const MANIFEST_URL: &str =
    "https://github.com/pl0xuee/griddown-packs/releases/latest/download/packs.json";

/// The zoom CI cuts state packs at, for manifests that don't say.
///
/// Older manifests carry no `maxzoom`. Every pack cut so far is z15, which is
/// also what the app asks for, so assuming 15 is right for existing data — but
/// it is an assumption, and `maxzoom` in the manifest overrides it.
const ASSUMED_PACK_MAXZOOM: u8 = 15;

/// Retry budget for the file download.
///
/// Generous on purpose, and cheap here in a way it isn't elsewhere: because the
/// download resumes from the bytes already on disk, a retry re-sends only what
/// was lost, not the 472 MB before it. The case this is really for is iOS
/// freezing a backgrounded app — it comes back with every socket dead, halfway
/// through a pack.
const MAX_ATTEMPTS: u32 = 6;

/// Cap on exponential backoff, so late attempts don't stall for minutes.
const MAX_BACKOFF_SECS: u64 = 30;

/// Read/write chunk. Big enough that progress reporting isn't the bottleneck,
/// small enough that a dropped connection loses very little.
const CHUNK: usize = 64 * 1024;

#[derive(Deserialize, Clone, Debug)]
pub struct Pack {
    pub bytes: u64,
    pub sha256: String,
    pub url: String,
    /// Absent on manifests cut before this field existed — see
    /// [`ASSUMED_PACK_MAXZOOM`].
    #[serde(default)]
    pub maxzoom: Option<u8>,
}

impl Pack {
    pub fn maxzoom(&self) -> u8 {
        self.maxzoom.unwrap_or(ASSUMED_PACK_MAXZOOM)
    }
}

#[derive(Deserialize, Debug)]
pub struct Manifest {
    #[serde(default)]
    pub packs: HashMap<String, Pack>,
    /// Which planet build these were cut from, and when. Parsed and never read
    /// in anger: the decision was explicitly that a stale pack still gets used
    /// (see [`Manifest::pack_for`]), so these exist to be visible when
    /// diagnosing "why does this map not have the new road" — not to gate on.
    #[serde(rename = "planetBuild", default)]
    #[allow(dead_code)]
    pub planet_build: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub generated: Option<String>,
}

impl Manifest {
    /// The pack for a state, if one exists and covers the zoom being asked for.
    ///
    /// Deliberately does NOT check how old the pack is. A pack cut from last
    /// month's planet build is still a working map of ground that does not move
    /// much; refusing it would mean falling back to a twenty-minute extraction
    /// to avoid a map that is slightly stale. For an app whose whole premise is
    /// working when nothing else does, having the map wins.
    ///
    /// Zoom is different, and is enforced: a pack cut at z15 genuinely lacks the
    /// tiles a z16 request wants, and quietly handing back less detail than was
    /// asked for would look like corrupt data rather than a missing pack.
    pub fn pack_for(&self, abbr: &str, want_maxzoom: u8) -> Option<&Pack> {
        let pack = self
            .packs
            .get(abbr)
            .or_else(|| self.packs.get(&abbr.to_uppercase()))?;
        (pack.maxzoom() >= want_maxzoom).then_some(pack)
    }
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(concat!("GridDown/", env!("CARGO_PKG_VERSION")))
        // `None` is load-bearing: the blocking client defaults to a 30-second
        // total timeout covering the body, which would abort every pack
        // download — they all take minutes. This is one request streaming up to
        // 1.5 GB, so there is no sensible whole-request deadline.
        .timeout(None)
        .connect_timeout(std::time::Duration::from_secs(20))
        // What catches a dead transfer instead, since the blocking builder has
        // no read timeout: a peer that has gone away stops answering keepalives
        // and the socket fails, rather than the read blocking forever. The retry
        // loop then resumes from the bytes already on disk.
        .tcp_keepalive(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("could not create HTTP client: {e}"))
}

/// Fetch and parse the pack manifest.
pub fn fetch_manifest() -> Result<Manifest, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("GridDown/", env!("CARGO_PKG_VERSION")))
        // Short: this runs before the download starts, and every second here is
        // a second the user stares at a button that did nothing. If the network
        // is bad enough to miss this, the fallback is what they want anyway.
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("could not create HTTP client: {e}"))?;

    let resp = client
        .get(MANIFEST_URL)
        .send()
        .map_err(|e| format!("could not reach the pack index: {e}"))?
        .error_for_status()
        .map_err(|e| format!("pack index unavailable: {e}"))?;

    let body = resp
        .text()
        .map_err(|e| format!("could not read the pack index: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("pack index is not valid JSON: {e}"))
}

/// Where a partly-downloaded pack lives, and the sidecar naming its sha256.
///
/// A suffix of its own, not the `.part` the live extractor uses: the two write
/// completely different things, and resuming a pack download on top of an
/// abandoned extraction would append to bytes that were never part of the pack.
fn part_paths(final_path: &Path) -> (PathBuf, PathBuf) {
    let part = final_path.with_extension("pmtiles.packpart");
    let meta = final_path.with_extension("pmtiles.packpart.sha");
    (part, meta)
}

/// sha256 of a file, read back in chunks.
///
/// Hashed after the fact rather than while writing, because a resumed download
/// only ever sees its own tail — the bytes from earlier attempts were written by
/// an earlier process. Re-reading also catches anything the disk mangled in
/// between, which hashing on the way past would not.
fn file_sha256(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// How many bytes of this pack are already on disk and safe to resume from.
///
/// Zero unless the sidecar says the partial file belongs to *this* pack. Without
/// that check a pack re-cut from a newer planet build would append new bytes to
/// old ones and only be caught by the hash — after downloading the whole thing.
fn resume_from(part: &Path, meta: &Path, pack: &Pack) -> u64 {
    let Ok(have) = part.metadata().map(|m| m.len()) else {
        return 0;
    };
    let belongs = std::fs::read_to_string(meta)
        .map(|s| s.trim() == pack.sha256)
        .unwrap_or(false);
    // Longer than the finished pack means the file is not what the sidecar
    // claims, whatever it says.
    if !belongs || have > pack.bytes {
        let _ = std::fs::remove_file(part);
        let _ = std::fs::remove_file(meta);
        return 0;
    }
    have
}

/// What to do after a failed attempt.
enum Recover {
    /// Retrying cannot help.
    Stop,
    /// Retry, keeping the bytes already on disk — they are still a valid prefix.
    Retry,
    /// Retry, but throw the partial away first: it is itself the problem.
    ///
    /// Without this a bad partial is immortal. `resume_from` only rejects a file
    /// *longer* than the pack, so a short-but-wrong one is offered up again on
    /// every future attempt, and the state can never be downloaded again.
    Reset,
}

/// Where the server says this body starts, and how long the whole file is.
/// `bytes 1000-1999/2000` -> `(Some(1000), Some(2000))`. Either may be absent:
/// the total is `*` when the server does not know it, and anything malformed
/// yields `None` rather than a guess — the caller treats not-knowing as a
/// reason to start over, never as agreement.
fn parse_content_range(v: &str) -> (Option<u64>, Option<u64>) {
    // The unit is required, not assumed. Without this check a header in some
    // other unit still yields a plausible-looking total, and that total is
    // compared against the manifest — so a malformed header would abort a
    // perfectly healthy download as "the index is out of date".
    let Some(rest) = v.trim().strip_prefix("bytes ") else {
        return (None, None);
    };
    let rest = rest.trim();
    let (range, total) = rest.split_once('/').unwrap_or((rest, "*"));
    let start = range.split('-').next().and_then(|s| s.trim().parse().ok());
    (start, total.trim().parse().ok())
}

fn content_range(resp: &reqwest::blocking::Response) -> (Option<u64>, Option<u64>) {
    resp.headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(parse_content_range)
        .unwrap_or((None, None))
}

/// One download attempt, resuming from whatever is already on disk.
fn attempt(
    client: &reqwest::blocking::Client,
    pack: &Pack,
    part: &Path,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), (String, Recover)> {
    let have = part.metadata().map(|m| m.len()).unwrap_or(0);
    if have == pack.bytes {
        return Ok(());
    }

    let mut req = client.get(&pack.url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let resp = req.send().map_err(|e| (format!("{e}"), Recover::Retry))?;

    let status = resp.status();
    // A 200 to a ranged request means the server sent the whole file from the
    // start. Honest, just not what was asked: the body is the whole pack, so
    // start the file over rather than appending it to what is already there.
    let restart = have > 0 && status == reqwest::StatusCode::OK;
    if !status.is_success() {
        // 416 means we asked to start past the end of the file — so what is on
        // disk is longer than the file actually is, and resuming from it can
        // only ask the same impossible question again. The partial has to go.
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            return Err((
                "the pack on the server is smaller than the partial download".into(),
                Recover::Reset,
            ));
        }
        let how = if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            Recover::Retry
        } else {
            Recover::Stop
        };
        return Err((format!("server returned {status}"), how));
    }

    // What the server says about the file, checked against what the manifest
    // claims. They disagree while a pack is being re-cut: the asset is replaced
    // before the manifest that describes it. Downloading anyway would fail the
    // hash after a full transfer, so stop now and let the caller fall back.
    let (start, total) = content_range(&resp);
    let served_total = total.or_else(|| if restart { resp.content_length() } else { None });
    if let Some(t) = served_total {
        if t != pack.bytes {
            let _ = std::fs::remove_file(part);
            return Err((
                format!(
                    "pack index is out of date (server has {t} bytes, index says {})",
                    pack.bytes
                ),
                Recover::Stop,
            ));
        }
    }
    // A 206 that does not begin where we asked would be appended blind,
    // producing a file of the right length and the wrong content — caught only
    // by the hash, after paying for the whole transfer.
    if have > 0 && !restart {
        match start {
            Some(s) if s == have => {}
            _ => {
                return Err((
                    format!("server resumed at {start:?}, not {have}"),
                    Recover::Reset,
                ))
            }
        }
    }

    let mut written = if restart { 0 } else { have };
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(restart)
        .append(!restart)
        .open(part)
        .map_err(|e| {
            (
                format!("could not open {}: {e}", part.display()),
                Recover::Stop,
            )
        })?;
    let mut out = std::io::BufWriter::new(file);

    let mut body = resp;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = match body.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            // Mid-stream failure. Whatever was written stays: that is the point
            // of resuming, and the next attempt picks up from it.
            Err(e) => {
                let _ = out.flush();
                return Err((format!("{e}"), Recover::Retry));
            }
        };
        out.write_all(&buf[..n]).map_err(|e| {
            (
                format!("could not write to {}: {e}", part.display()),
                Recover::Stop,
            )
        })?;
        written += n as u64;
        // Clamped: a server that sends more than it should would otherwise
        // drive the progress bar past 100%.
        progress(written.min(pack.bytes), pack.bytes);
    }
    out.flush().map_err(|e| {
        (
            format!("could not write to {}: {e}", part.display()),
            Recover::Stop,
        )
    })?;
    drop(out);

    // From the file, not from the running count: the count tracks bytes handed
    // to the writer, and the flush above is the last thing that can lose them.
    let got = part.metadata().map(|m| m.len()).unwrap_or(0);
    progress(got.min(pack.bytes), pack.bytes);
    if got != pack.bytes {
        // Too long means the body did not line up with what was already there,
        // so the file is wrong rather than merely incomplete.
        let how = if got > pack.bytes {
            Recover::Reset
        } else {
            Recover::Retry
        };
        return Err((format!("expected {} bytes, have {got}", pack.bytes), how));
    }
    Ok(())
}

/// Download a pre-built pack to `final_path`, resuming and verifying it.
///
/// `progress` is called with (bytes on disk, total bytes).
pub fn download(
    pack: &Pack,
    final_path: &Path,
    status: &dyn Fn(&str),
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    let (part, meta) = part_paths(final_path);
    if let Some(dir) = final_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let have = resume_from(&part, &meta, pack);
    // Written before the first byte, so an interrupted download can tell on the
    // next run which pack the leftover bytes belong to.
    std::fs::write(&meta, &pack.sha256).map_err(|e| e.to_string())?;
    if have > 0 {
        status(&format!(
            "Resuming at {} of {}…",
            human_bytes(have),
            human_bytes(pack.bytes)
        ));
    }
    progress(have, pack.bytes);

    let client = client()?;
    let mut last_err = String::from("download failed");
    let mut ok = false;
    for n in 0..MAX_ATTEMPTS {
        match attempt(&client, pack, &part, progress) {
            Ok(()) => {
                ok = true;
                break;
            }
            Err((e, how)) => {
                last_err = e;
                if matches!(how, Recover::Reset) {
                    // The bytes on disk are the problem, so keeping them would
                    // just reproduce this failure on every future attempt.
                    let _ = std::fs::remove_file(&part);
                    progress(0, pack.bytes);
                }
                if matches!(how, Recover::Stop) || n + 1 == MAX_ATTEMPTS {
                    break;
                }
                let wait = (1u64 << n).min(MAX_BACKOFF_SECS);
                status(&format!(
                    "Download interrupted ({last_err}) — retrying in {wait}s…"
                ));
                std::thread::sleep(std::time::Duration::from_secs(wait));
            }
        }
    }
    if !ok {
        // Whatever survived is left alone: it is a valid prefix, and the next
        // attempt resumes from it rather than starting over. Anything that was
        // NOT a valid prefix has already been deleted above.
        return Err(last_err);
    }

    status("Verifying…");
    let got = file_sha256(&part)?;
    // Case-insensitively: we emit lowercase, but nothing stops the manifest
    // carrying uppercase, and a false mismatch here deletes a perfectly good
    // 1.4 GB download and looks exactly like real corruption.
    if !got.eq_ignore_ascii_case(&pack.sha256) {
        // Not resumable: we cannot tell which bytes are wrong, so keeping the
        // file would make every future resume inherit the corruption.
        let _ = std::fs::remove_file(&part);
        let _ = std::fs::remove_file(&meta);
        return Err(format!(
            "downloaded pack is corrupt (sha256 {got}, expected {})",
            pack.sha256
        ));
    }

    // Rename only once verified, so a half-written file is never mistaken for
    // an installed pack.
    std::fs::rename(&part, final_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&meta);
    Ok(())
}

pub fn human_bytes(n: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if n as f64 >= 1024.0 * MB {
        format!("{:.1} GB", n as f64 / (1024.0 * MB))
    } else {
        format!("{:.0} MB", n as f64 / MB)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(sha: &str, bytes: u64) -> Pack {
        Pack {
            bytes,
            sha256: sha.into(),
            url: "https://example.invalid/x.pmtiles".into(),
            maxzoom: None,
        }
    }

    #[test]
    fn parses_the_manifest_ci_actually_publishes() {
        // Copied from the real packs-20260720 release.
        let m: Manifest = serde_json::from_str(
            r#"{
              "generated": "2026-07-20T13:59:11Z",
              "packs": {
                "DC": {"bytes": 28135011, "sha256": "02a8", "url": "https://example/DC.pmtiles"},
                "OR": {"bytes": 494861102, "sha256": "71ec", "url": "https://example/OR.pmtiles"}
              },
              "planetBuild": "https://build.protomaps.com/20260720.pmtiles"
            }"#,
        )
        .unwrap();
        assert_eq!(m.packs.len(), 2);
        assert_eq!(m.packs["OR"].bytes, 494861102);
        assert_eq!(
            m.planet_build.as_deref(),
            Some("https://build.protomaps.com/20260720.pmtiles")
        );
        // No maxzoom in this manifest: it has to fall back, not vanish.
        assert_eq!(m.packs["OR"].maxzoom(), ASSUMED_PACK_MAXZOOM);
    }

    #[test]
    fn a_pack_is_offered_only_when_it_covers_the_zoom_asked_for() {
        let mut packs = HashMap::new();
        packs.insert("OR".to_string(), pack("abc", 10));
        let m = Manifest {
            packs,
            planet_build: None,
            generated: None,
        };

        assert!(m.pack_for("OR", 15).is_some());
        assert!(
            m.pack_for("OR", 12).is_some(),
            "a deeper pack covers a shallower ask"
        );
        assert!(
            m.pack_for("OR", 16).is_none(),
            "z15 pack cannot answer a z16 request"
        );
        assert!(m.pack_for("WA", 15).is_none());
        assert!(
            m.pack_for("or", 15).is_some(),
            "state codes arrive in both cases"
        );
    }

    #[test]
    fn a_partial_file_resumes_only_when_the_sidecar_matches() {
        let dir = std::env::temp_dir().join(format!("gd-packs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("t.packpart");
        let meta = dir.join("t.packpart.sha");
        let p = pack("abc", 100);

        std::fs::write(&part, vec![0u8; 40]).unwrap();

        // No sidecar at all — cannot prove these bytes are ours.
        assert_eq!(resume_from(&part, &meta, &p), 0);
        assert!(
            !part.exists(),
            "unusable partial is cleared, not left to grow"
        );

        // Sidecar from a different pack (a re-cut planet build).
        std::fs::write(&part, vec![0u8; 40]).unwrap();
        std::fs::write(&meta, "different-sha").unwrap();
        assert_eq!(resume_from(&part, &meta, &p), 0);

        // Ours: resume.
        std::fs::write(&part, vec![0u8; 40]).unwrap();
        std::fs::write(&meta, "abc").unwrap();
        assert_eq!(resume_from(&part, &meta, &p), 40);

        // Longer than the finished pack, whatever the sidecar claims.
        std::fs::write(&part, vec![0u8; 140]).unwrap();
        std::fs::write(&meta, "abc").unwrap();
        assert_eq!(resume_from(&part, &meta, &p), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole path against the real release, using DC because it is the
    /// smallest pack CI cuts (27 MB). Ignored: needs the network.
    ///     cargo test --lib packs::tests::live -- --ignored --nocapture
    #[test]
    #[ignore = "hits the network"]
    fn live_downloads_and_verifies_a_real_pack() {
        let m = fetch_manifest().expect("manifest");
        let p = m.pack_for("DC", 15).expect("DC pack in the live manifest");
        let dir = std::env::temp_dir().join("gd-live-pack");
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("DC.pmtiles");
        let _ = std::fs::remove_file(&out);

        download(p, &out, &|s| println!("  {s}"), &mut |d, t| {
            if d == t {
                println!("  {d}/{t}");
            }
        })
        .expect("download");

        assert_eq!(out.metadata().unwrap().len(), p.bytes);
        assert_eq!(file_sha256(&out).unwrap(), p.sha256);
        // A real archive, not an error page that happened to hash.
        let mut magic = [0u8; 7];
        use std::io::Read as _;
        std::fs::File::open(&out)
            .unwrap()
            .read_exact(&mut magic)
            .unwrap();
        assert_eq!(&magic, b"PMTiles");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Alaska is cut shallower than every other state, and a mismatch between
    /// the zoom CI cut and the zoom the app asks for fails *silently*: the pack
    /// is refused and the app quietly falls back to a live extraction that
    /// takes twenty minutes. Nothing errors, so only a test catches it.
    #[test]
    #[ignore = "hits the network"]
    fn live_offers_alaska_at_the_zoom_the_app_asks_for() {
        let m = fetch_manifest().expect("manifest");
        let ak = m.packs.get("AK").expect("AK in the live manifest");
        assert_eq!(ak.maxzoom(), 14, "CI cut AK at an unexpected zoom");

        // states.json gives AK maxzoom 14, and states.ts sends `maxzoom ?? 15`.
        assert!(
            m.pack_for("AK", 14).is_some(),
            "AK must be offered at its own zoom"
        );
        // The strict rule still holds — this is why the request has to be 14.
        assert!(
            m.pack_for("AK", 15).is_none(),
            "a z14 pack must not answer z15"
        );
        // Everything else is still cut deep.
        assert!(m.pack_for("CA", 15).is_some());
    }

    /// The case this whole module exists for: a download that died partway.
    /// Fakes an interrupted attempt by leaving a truncated prefix on disk, then
    /// checks the resume actually range-requests the rest and verifies.
    #[test]
    #[ignore = "hits the network"]
    fn live_resumes_an_interrupted_download() {
        let m = fetch_manifest().expect("manifest");
        let p = m.pack_for("DC", 15).expect("DC pack in the live manifest");
        let dir = std::env::temp_dir().join("gd-live-resume");
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("DC.pmtiles");
        let (part, meta) = part_paths(&out);
        let _ = std::fs::remove_file(&out);

        // Grab a genuine prefix, so the resumed bytes have to line up exactly:
        // a wrong offset by even one byte fails the hash at the end.
        let head = reqwest::blocking::Client::new()
            .get(&p.url)
            .header(reqwest::header::RANGE, "bytes=0-999999")
            .send()
            .unwrap()
            .bytes()
            .unwrap();
        assert_eq!(head.len(), 1_000_000);
        std::fs::write(&part, &head).unwrap();
        std::fs::write(&meta, &p.sha256).unwrap();

        let mut first_report = None;
        download(p, &out, &|s| println!("  {s}"), &mut |d, _| {
            first_report.get_or_insert(d);
        })
        .expect("resumed download");

        assert_eq!(
            first_report,
            Some(1_000_000),
            "resume must start from the bytes on disk, not from zero"
        );
        assert_eq!(file_sha256(&out).unwrap(), p.sha256);
        assert!(!part.exists() && !meta.exists(), "scratch files cleaned up");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_where_the_server_says_the_body_starts() {
        assert_eq!(
            parse_content_range("bytes 1000-1999/2000"),
            (Some(1000), Some(2000))
        );
        // Total unknown is legal, and must not read as "0 bytes" — that would
        // look like the manifest disagreeing and abort a healthy download.
        assert_eq!(parse_content_range("bytes 1000-1999/*"), (Some(1000), None));
        assert_eq!(
            parse_content_range("  bytes 0-99/100  "),
            (Some(0), Some(100))
        );
        // Junk yields None, never a guess: the caller restarts rather than
        // appending a body it cannot place.
        assert_eq!(parse_content_range("pages 1-2/3"), (None, None));
        assert_eq!(parse_content_range(""), (None, None));
        assert_eq!(parse_content_range("bytes */1234"), (None, Some(1234)));
    }

    #[test]
    fn sizes_read_the_way_a_person_would_say_them() {
        assert_eq!(human_bytes(28_135_011), "27 MB");
        assert_eq!(human_bytes(494_861_102), "472 MB");
        assert_eq!(human_bytes(1_610_612_736), "1.5 GB");
    }
}
