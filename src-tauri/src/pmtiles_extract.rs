//! Reading a remote PMTiles v3 archive, well enough to cut a bbox out of it.
//!
//! # Why this file exists
//!
//! State packs used to be produced by shelling out to the `go-pmtiles` CLI
//! (`pmtiles extract --bbox=…`). iOS forbids spawning subprocesses outright, so
//! that had to become in-process Rust.
//!
//! The obvious move — lean on the `pmtiles` crate's reader — doesn't work. Its
//! reader hands back decoded tiles but keeps each tile's byte offset and length
//! private (`DirEntry`'s fields are `pub(crate)`), so the only available shape
//! is one HTTP range request per tile. A state extract is on the order of
//! 40,000–160,000 tiles. Issuing that many requests against Protomaps' free
//! public build server every time someone downloads a state is both slow over a
//! phone connection and rude; `go-pmtiles` merges them into a few thousand.
//!
//! So we parse the archive's directories ourselves — which is what gives us the
//! byte offsets needed to coalesce adjacent tiles into shared requests — and use
//! the `pmtiles` crate only for *writing* the result. The writer is genuinely
//! good: it dedupes identical tiles by content hash and emits run-length
//! directory entries, so we don't reimplement any of that.
//!
//! Format reference: <https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md>

use std::io::Read;

/// A PMTiles v3 header is a fixed 127 bytes at the very start of the archive.
pub const HEADER_LEN: usize = 127;

const MAGIC: &[u8; 7] = b"PMTiles";

/// How a block of bytes in the archive is compressed. The numeric values are
/// fixed by the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compression {
    Unknown,
    None,
    Gzip,
    Brotli,
    Zstd,
}

impl Compression {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Compression::None,
            2 => Compression::Gzip,
            3 => Compression::Brotli,
            4 => Compression::Zstd,
            _ => Compression::Unknown,
        }
    }
}

/// The parts of the header we actually use. The spec defines more fields
/// (tile type, centre, the addressed/entries/contents counts); they're parsed
/// where cheap and ignored where not.
/// Some fields aren't read by the extract path (leaf_length, clustered, the
/// zoom range) but are parsed anyway: they're cheap, they're part of the format,
/// and having them decoded is what makes the header assertions in the tests
/// meaningful.
#[derive(Debug, Clone)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct Header {
    pub root_offset: u64,
    pub root_length: u64,
    pub metadata_offset: u64,
    pub metadata_length: u64,
    pub leaf_offset: u64,
    pub leaf_length: u64,
    pub tile_data_offset: u64,
    pub tile_data_length: u64,
    /// Whether tile blobs are laid out in tile-id order. Protomaps' builds are,
    /// which is what makes a batch of consecutive tile ids also consecutive on
    /// disk — and therefore cheap to fetch in one range request.
    pub clustered: bool,
    /// Compression of the directory blocks and metadata — *not* of tiles.
    pub internal_compression: Compression,
    /// Compression of tile payloads. We copy tiles across verbatim, so we never
    /// decompress them; we only need this to stamp the output header correctly.
    pub tile_compression: Compression,
    pub tile_type: u8,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// Bounds in degrees. Stored in the file as int32 in units of 1e-7 degrees.
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
}

fn u64_at(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(b[off..off + 8].try_into().expect("slice is 8 bytes"))
}

fn i32_at(b: &[u8], off: usize) -> i32 {
    i32::from_le_bytes(b[off..off + 4].try_into().expect("slice is 4 bytes"))
}

impl Header {
    pub fn parse(b: &[u8]) -> Result<Header, String> {
        if b.len() < HEADER_LEN {
            return Err(format!(
                "PMTiles header truncated: got {} bytes, need {HEADER_LEN}",
                b.len()
            ));
        }
        if &b[0..7] != MAGIC {
            return Err("not a PMTiles archive (bad magic)".into());
        }
        // Version 3 is the only one this code understands. v2 has an entirely
        // different directory layout, so failing loudly beats misreading it.
        if b[7] != 3 {
            return Err(format!("unsupported PMTiles version {} (need 3)", b[7]));
        }
        Ok(Header {
            root_offset: u64_at(b, 8),
            root_length: u64_at(b, 16),
            metadata_offset: u64_at(b, 24),
            metadata_length: u64_at(b, 32),
            leaf_offset: u64_at(b, 40),
            leaf_length: u64_at(b, 48),
            tile_data_offset: u64_at(b, 56),
            tile_data_length: u64_at(b, 64),
            // 72..96 are the addressed/entries/contents tile counts; unused.
            clustered: b[96] == 1,
            internal_compression: Compression::from_u8(b[97]),
            tile_compression: Compression::from_u8(b[98]),
            tile_type: b[99],
            min_zoom: b[100],
            max_zoom: b[101],
            min_lon: i32_at(b, 102) as f64 / 1e7,
            min_lat: i32_at(b, 106) as f64 / 1e7,
            max_lon: i32_at(b, 110) as f64 / 1e7,
            max_lat: i32_at(b, 114) as f64 / 1e7,
        })
    }
}

/// Undo the compression applied to a directory or metadata block.
pub fn decompress(data: &[u8], how: Compression) -> Result<Vec<u8>, String> {
    match how {
        Compression::None => Ok(data.to_vec()),
        Compression::Gzip => {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(data)
                .read_to_end(&mut out)
                .map_err(|e| format!("directory gunzip failed: {e}"))?;
            Ok(out)
        }
        // Protomaps' planet builds use gzip internally. Brotli and zstd are
        // legal per spec but would each pull another dependency (and zstd pulls
        // C, which we're avoiding for the iOS build), so they're unimplemented
        // until something actually produces one.
        other => Err(format!(
            "unsupported internal compression {other:?} — this archive can't be read"
        )),
    }
}

/// Reads the LEB128 varints that directory blocks are encoded with.
struct VarintReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> VarintReader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        VarintReader { buf, pos: 0 }
    }

    fn next(&mut self) -> Result<u64, String> {
        let mut value: u64 = 0;
        let mut shift = 0;
        loop {
            let byte = *self
                .buf
                .get(self.pos)
                .ok_or("directory ended mid-varint (corrupt archive)")?;
            self.pos += 1;
            // 10 groups of 7 bits is the most a u64 can hold; more than that
            // means the data is garbage and we'd otherwise shift into overflow.
            if shift > 63 {
                return Err("varint overflows u64 (corrupt archive)".into());
            }
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
        }
    }
}

/// One directory entry: either a tile, or a pointer to a leaf directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub tile_id: u64,
    pub offset: u64,
    pub length: u32,
    /// How many consecutive tile IDs starting at `tile_id` share this blob.
    /// Zero is the sentinel meaning "this entry points at a leaf directory".
    pub run_length: u32,
}

impl Entry {
    pub fn is_leaf(&self) -> bool {
        self.run_length == 0
    }

    /// Whether this entry covers `id` (accounting for run-length encoding).
    pub fn covers(&self, id: u64) -> bool {
        !self.is_leaf() && id >= self.tile_id && id < self.tile_id + u64::from(self.run_length)
    }
}

/// Parse a decompressed directory block.
///
/// The encoding is column-oriented and delta-compressed: all the tile IDs
/// first (as deltas), then all the run lengths, then all the lengths, then all
/// the offsets. An offset of 0 is a back-reference meaning "immediately after
/// the previous entry", which is how runs of contiguous tiles stay compact.
pub fn parse_directory(buf: &[u8]) -> Result<Vec<Entry>, String> {
    let mut r = VarintReader::new(buf);
    let count = r.next()? as usize;

    // A malformed length prefix shouldn't make us allocate gigabytes. Every
    // entry costs at least 4 varint bytes, so the buffer bounds the count.
    if count > buf.len() {
        return Err("directory entry count exceeds block size (corrupt archive)".into());
    }

    let mut entries = vec![
        Entry {
            tile_id: 0,
            offset: 0,
            length: 0,
            run_length: 0,
        };
        count
    ];

    let mut last_id = 0u64;
    for e in entries.iter_mut() {
        last_id = last_id
            .checked_add(r.next()?)
            .ok_or("tile id delta overflows (corrupt archive)")?;
        e.tile_id = last_id;
    }
    for e in entries.iter_mut() {
        e.run_length = r.next()? as u32;
    }
    for e in entries.iter_mut() {
        e.length = r.next()? as u32;
    }
    for i in 0..count {
        let raw = r.next()?;
        entries[i].offset = if raw == 0 {
            // "Directly after the previous entry." The first entry may not use
            // this form, since there is no previous entry to follow.
            let prev = i
                .checked_sub(1)
                .ok_or("first directory entry uses a back-reference offset")?;
            entries[prev]
                .offset
                .checked_add(u64::from(entries[prev].length))
                .ok_or("offset overflows (corrupt archive)")?
        } else {
            raw - 1
        };
    }

    Ok(entries)
}

// ---------------------------------------------------------------------------
// Tile addressing
// ---------------------------------------------------------------------------

/// Convert z/x/y to a PMTiles tile ID.
///
/// Tiles are numbered along a Hilbert curve, level by level: all of zoom 0,
/// then all of zoom 1, and so on. The Hilbert ordering is the whole reason
/// coalescing works — tiles that are near each other on the map get nearby IDs,
/// and therefore land in nearby byte ranges.
pub fn zxy_to_tile_id(z: u8, x: u32, y: u32) -> Result<u64, String> {
    if z > 31 {
        return Err(format!("zoom {z} out of range"));
    }
    let n = 1u64 << z;
    if u64::from(x) >= n || u64::from(y) >= n {
        return Err(format!("tile {z}/{x}/{y} is outside the zoom level"));
    }

    // Number of tiles in every level below this one: (4^z - 1) / 3.
    let acc = ((1u64 << (2 * z as u64)) - 1) / 3;

    let mut rx: u64;
    let mut ry: u64;
    let mut d: u64 = 0;
    let mut xx = u64::from(x);
    let mut yy = u64::from(y);

    let mut s = n / 2;
    while s > 0 {
        rx = u64::from((xx & s) > 0);
        ry = u64::from((yy & s) > 0);
        d += s * s * ((3 * rx) ^ ry);
        // Rotate the quadrant so the curve stays continuous.
        if ry == 0 {
            if rx == 1 {
                xx = s.wrapping_sub(1).wrapping_sub(xx);
                yy = s.wrapping_sub(1).wrapping_sub(yy);
            }
            std::mem::swap(&mut xx, &mut yy);
        }
        s /= 2;
    }

    Ok(acc + d)
}

/// The inclusive x/y tile range covering a lon/lat bbox at one zoom level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileRange {
    pub min_x: u32,
    pub max_x: u32,
    pub min_y: u32,
    pub max_y: u32,
}

impl TileRange {
    /// Only the tests need this today; it stays because it's the natural way to
    /// sanity-check a bbox before committing to a download.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn count(&self) -> u64 {
        u64::from(self.max_x - self.min_x + 1) * u64::from(self.max_y - self.min_y + 1)
    }
}

/// Web-Mercator bbox to tile range. Latitude is clamped to the Mercator limit
/// (~85.051°), beyond which the projection diverges — Alaska's bbox reaches
/// 71°N so this stays comfortably in range, but a planet-wide bbox would not.
pub fn bbox_to_tile_range(
    z: u8,
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
) -> Result<TileRange, String> {
    if z > 31 {
        return Err(format!("zoom {z} out of range"));
    }
    if !(min_lon.is_finite() && min_lat.is_finite() && max_lon.is_finite() && max_lat.is_finite()) {
        return Err("bbox contains a non-finite coordinate".into());
    }
    if min_lon > max_lon || min_lat > max_lat {
        return Err("bbox is inside out (min greater than max)".into());
    }

    const MERC_MAX_LAT: f64 = 85.051_128_779_806_59;
    let n = f64::from(1u32 << z);
    let last = (1u32 << z) - 1;

    let lon_to_x = |lon: f64| -> u32 {
        let lon = lon.clamp(-180.0, 180.0);
        let x = ((lon + 180.0) / 360.0 * n).floor();
        (x.max(0.0) as u32).min(last)
    };
    let lat_to_y = |lat: f64| -> u32 {
        let lat = lat.clamp(-MERC_MAX_LAT, MERC_MAX_LAT);
        let rad = lat.to_radians();
        let y =
            ((1.0 - (rad.tan() + 1.0 / rad.cos()).ln() / std::f64::consts::PI) / 2.0 * n).floor();
        (y.max(0.0) as u32).min(last)
    };

    Ok(TileRange {
        min_x: lon_to_x(min_lon),
        max_x: lon_to_x(max_lon),
        // y grows southward, so the northern edge gives the smaller index.
        min_y: lat_to_y(max_lat),
        max_y: lat_to_y(min_lat),
    })
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/// Somewhere bytes can be read from by absolute offset.
///
/// The point of this indirection is that the entire extract pipeline can then
/// be exercised against a local file in tests — no network, no fixtures to
/// invent — and the only untested-by-unit-test part is the HTTP transport
/// itself.
pub trait TileSource {
    fn read_range(&self, offset: u64, len: u64) -> Result<Vec<u8>, String>;

    /// Read several ranges at once, returned in the order they were asked for.
    ///
    /// The default is a plain sequential loop, which is what a local file wants
    /// — there is no latency to hide, and threads would only add contention on
    /// the one file handle. `HttpSource` overrides it.
    ///
    /// Callers must keep the slice short: every result is held in memory at
    /// once, so the batch size is what bounds peak memory.
    fn read_ranges(&self, ranges: &[(u64, u64)]) -> Result<Vec<Vec<u8>>, String> {
        ranges.iter().map(|&(o, l)| self.read_range(o, l)).collect()
    }
}

/// Run `read` over `ranges` on up to `workers` threads, reassembling the
/// results into the requested order.
///
/// Split out from `HttpSource` so the reassembly can be tested without a
/// server: the ordering guarantee is the part worth proving, and it only means
/// anything when requests finish out of order.
fn read_ranges_parallel(
    ranges: &[(u64, u64)],
    workers: usize,
    read: &(dyn Fn(u64, u64) -> Result<Vec<u8>, String> + Sync),
) -> Result<Vec<Vec<u8>>, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let next = AtomicUsize::new(0);
    let (tx, rx) = std::sync::mpsc::channel();
    let workers = workers.max(1).min(ranges.len());

    std::thread::scope(|s| {
        for _ in 0..workers {
            let tx = tx.clone();
            let next = &next;
            // Workers pull the next index rather than taking a fixed slice:
            // batches differ in size and the network is uneven, so a static
            // split would leave threads idle behind one slow request.
            s.spawn(move || loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(&(offset, len)) = ranges.get(i) else {
                    break;
                };
                if tx.send((i, read(offset, len))).is_err() {
                    break;
                }
            });
        }
    });
    // Every worker has finished by here, so the only sender left is ours;
    // dropping it is what ends the receive loop below.
    drop(tx);

    let mut slots: Vec<Option<Vec<u8>>> = (0..ranges.len()).map(|_| None).collect();
    for (i, res) in rx {
        slots[i] = Some(res?);
    }
    slots
        .into_iter()
        .enumerate()
        .map(|(i, s)| s.ok_or_else(|| format!("range {i} was never fetched")))
        .collect()
}

/// A local archive. Used by tests, and by `export`-style flows that re-cut an
/// already-downloaded pack.
pub struct FileSource {
    file: std::sync::Mutex<std::fs::File>,
}

impl FileSource {
    /// Currently used only by tests — it's the seam that lets the whole extract
    /// pipeline be exercised without a network. Kept public because re-cutting
    /// an already-downloaded pack is the obvious next use.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(FileSource {
            file: std::sync::Mutex::new(file),
        })
    }
}

impl TileSource for FileSource {
    fn read_range(&self, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = self.file.lock().map_err(|_| "file lock poisoned")?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; len as usize];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

/// A remote archive, read over HTTP range requests.
pub struct HttpSource {
    client: reqwest::blocking::Client,
    url: String,
}

/// How many times to retry a failed range request before giving up, and how
/// long to wait between attempts.
///
/// The budget is deliberately generous — roughly a minute in total. Phone
/// networks drop connections routinely, but the case that really drove this is
/// iOS suspending a backgrounded app: the app is frozen rather than killed, so
/// it resumes mid-download, but every socket it held is dead. A short retry
/// budget turns "the user glanced at a message" into "the state download
/// failed", which for a 1.5 GB pack is a genuinely expensive way to lose.
const MAX_ATTEMPTS: u32 = 6;

/// Cap on exponential backoff, so the last attempts don't stall for minutes.
const MAX_BACKOFF_SECS: u64 = 30;

impl HttpSource {
    pub fn new(url: &str) -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            // Identify ourselves: this hits Protomaps' free public build server,
            // and unattributed traffic is how public services get locked down.
            .user_agent(concat!("GridDown/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(20))
            // Keep a connection per worker alive between requests.
            //
            // This single line is the difference between a state download
            // taking 14 seconds and 22. Measured on Rhode Island — 650
            // requests, 78 MB — with sixteen workers either way:
            //
            //   without: 24.8 s, and 19.0 s on a second run
            //   with:    13.3 s, and 14.0 s on a second run
            //
            // Raising the worker count on its own had barely helped, which is
            // what sent me looking. The workers were reconnecting rather than
            // reusing, so most of each "parallel" request went on a fresh TCP
            // and TLS handshake. curl over the same link and ranges scaled
            // cleanly to 114 requests a second, so the server was never it.
            .pool_max_idle_per_host(CONCURRENT_REQUESTS)
            // Does nothing today: http2 is not in this build's feature set, so
            // ALPN never offers it — checked with `cargo tree -e features`.
            // Kept because cargo features are additive and Tauri also depends
            // on reqwest, so something upstream could turn http2 on without us
            // noticing. Every worker would then collapse onto one multiplexed
            // connection, which is the worst case for many small range reads.
            .http1_only()
            .build()
            .map_err(|e| format!("could not create HTTP client: {e}"))?;
        Ok(HttpSource {
            client,
            url: url.to_string(),
        })
    }

    fn try_read(&self, offset: u64, len: u64) -> Result<Vec<u8>, (String, bool)> {
        let end = offset + len - 1;
        let resp = self
            .client
            .get(&self.url)
            .header(reqwest::header::RANGE, format!("bytes={offset}-{end}"))
            .send()
            // Transport-level failures are the retryable ones.
            .map_err(|e| (format!("{e}"), true))?;

        let status = resp.status();
        if status == reqwest::StatusCode::OK {
            // The server ignored the Range header and is about to stream the
            // whole planet archive — hundreds of gigabytes. Bail out before
            // touching the body, and never retry: it would do it again.
            return Err((
                "server does not support range requests (would download the entire planet)".into(),
                false,
            ));
        }
        if status != reqwest::StatusCode::PARTIAL_CONTENT {
            let retryable =
                status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS;
            return Err((format!("server returned {status}"), retryable));
        }

        let bytes = resp.bytes().map_err(|e| (format!("{e}"), true))?;
        if bytes.len() as u64 != len {
            return Err((
                format!("short read: asked for {len} bytes, got {}", bytes.len()),
                true,
            ));
        }
        Ok(bytes.to_vec())
    }
}

impl TileSource for HttpSource {
    fn read_range(&self, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        if len == 0 {
            return Ok(Vec::new());
        }
        let mut last = String::new();
        for attempt in 0..MAX_ATTEMPTS {
            match self.try_read(offset, len) {
                Ok(b) => return Ok(b),
                Err((msg, retryable)) => {
                    if !retryable {
                        return Err(msg);
                    }
                    last = msg;
                    // Back off before trying again: 1s, 2s, 4s, 8s, 16s (capped).
                    // A congested or rate-limited server recovers better if we
                    // don't hammer it, and the longer tail gives a suspended app
                    // time to come back to the foreground and get a route again.
                    if attempt + 1 < MAX_ATTEMPTS {
                        let secs = (1u64 << attempt).min(MAX_BACKOFF_SECS);
                        std::thread::sleep(std::time::Duration::from_secs(secs));
                    }
                }
            }
        }
        Err(format!(
            "could not read map data after {MAX_ATTEMPTS} attempts: {last}"
        ))
    }

    fn read_ranges(&self, ranges: &[(u64, u64)]) -> Result<Vec<Vec<u8>>, String> {
        // Each worker calls read_range, so every request keeps the full retry
        // and backoff budget above — including the long tail that carries a
        // download across the app being suspended.
        read_ranges_parallel(ranges, CONCURRENT_REQUESTS, &|o, l| self.read_range(o, l))
    }
}

/// Find the most recent Protomaps daily planet build.
///
/// Replaces shelling out to `pmtiles show`: we just range-read the first 127
/// bytes of each candidate URL and see whether a valid v3 header comes back.
/// That is one tiny request per probe instead of a subprocess.
pub fn latest_build_url(today_days: i64) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("GridDown/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("could not create HTTP client: {e}"))?;

    for i in 0..8 {
        let (y, m, d) = crate::civil_from_days(today_days - i);
        let url = format!("https://build.protomaps.com/{y:04}{m:02}{d:02}.pmtiles");
        let ok = client
            .get(&url)
            .header(
                reqwest::header::RANGE,
                format!("bytes=0-{}", HEADER_LEN - 1),
            )
            .send()
            .ok()
            .filter(|r| r.status() == reqwest::StatusCode::PARTIAL_CONTENT)
            .and_then(|r| r.bytes().ok())
            .is_some_and(|b| Header::parse(&b).is_ok());
        if ok {
            return Ok(url);
        }
    }
    Err("No recent map build found — check your internet connection.".into())
}

/// A tile we intend to copy: its address, and its id (kept alongside so we
/// never need the inverse Hilbert transform).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WantedTile {
    pub z: u8,
    pub x: u32,
    pub y: u32,
    pub id: u64,
}

/// Every tile covering `bbox` from `min_zoom` through `max_zoom`, sorted by id.
///
/// Sorting by id matters twice over: the writer wants tiles in ascending id
/// order to produce a well-clustered archive, and in a clustered source archive
/// ascending ids are also ascending byte offsets, which is what lets batches
/// coalesce into few requests.
pub fn wanted_tiles(
    min_zoom: u8,
    max_zoom: u8,
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
) -> Result<Vec<WantedTile>, String> {
    if min_zoom > max_zoom {
        return Err(format!("min zoom {min_zoom} exceeds max zoom {max_zoom}"));
    }
    let mut out = Vec::new();
    for z in min_zoom..=max_zoom {
        let r = bbox_to_tile_range(z, min_lon, min_lat, max_lon, max_lat)?;
        for x in r.min_x..=r.max_x {
            for y in r.min_y..=r.max_y {
                out.push(WantedTile {
                    z,
                    x,
                    y,
                    id: zxy_to_tile_id(z, x, y)?,
                });
            }
        }
    }
    out.sort_unstable_by_key(|t| t.id);
    Ok(out)
}

/// How deep a directory tree we'll follow. The spec allows root plus leaves;
/// more than a few levels means either a pathological archive or a cycle, and
/// recursing forever on hostile input is not acceptable.
const MAX_DIR_DEPTH: u32 = 4;

/// Resolve tile ids to byte ranges, descending into leaf directories as needed.
///
/// `wanted` must be sorted ascending. Ids with no entry in the archive are
/// silently dropped — a bbox is a rectangle but coverage is not, so asking for
/// ocean tiles that were never written is expected, not an error.
pub fn locate_tiles(
    src: &dyn TileSource,
    h: &Header,
    wanted: &[u64],
) -> Result<Vec<(u64, Entry)>, String> {
    let root_raw = src.read_range(h.root_offset, h.root_length)?;
    let root = parse_directory(&decompress(&root_raw, h.internal_compression)?)?;
    let mut found = Vec::new();
    descend(src, h, &root, wanted, &mut found, 0)?;
    Ok(found)
}

fn descend(
    src: &dyn TileSource,
    h: &Header,
    dir: &[Entry],
    wanted: &[u64],
    out: &mut Vec<(u64, Entry)>,
    depth: u32,
) -> Result<(), String> {
    if depth > MAX_DIR_DEPTH {
        return Err("directory nesting too deep (corrupt archive?)".into());
    }

    // Resolve the whole level before fetching anything. Descending the moment a
    // leaf is spotted means one round trip at a time, and a state touches
    // hundreds of leaves — that was the entire "working out which tiles to
    // fetch" wait, and it was pure latency.
    //
    // Both kinds of entry are recorded in one ordered list rather than handled
    // as they are found. A directory can hold tiles and leaf pointers at once —
    // the planet's root holds low zooms directly and points at leaves for the
    // rest — and appending the direct ones during this pass would put them all
    // ahead of everything the leaves contribute. `out` has to stay ascending:
    // coalescing and the writer both depend on it, and neither would complain,
    // they would just produce a wrong archive.
    enum Item {
        Tile(u64, Entry),
        /// Index into `leaves`, and the slice of `wanted` it covers.
        Leaf(usize, usize, usize),
    }
    let mut items: Vec<Item> = Vec::new();
    let mut leaves: Vec<Entry> = Vec::new();
    let mut i = 0usize;
    while i < wanted.len() {
        let id = wanted[i];

        // The entry governing `id` is the last one whose tile_id is <= id.
        let k = match dir.binary_search_by(|e| e.tile_id.cmp(&id)) {
            Ok(k) => k,
            Err(0) => {
                // Before the first entry: this id isn't in the archive.
                i += 1;
                continue;
            }
            Err(k) => k - 1,
        };
        let e = dir[k];

        if e.is_leaf() {
            // An entry governs ids up to the next entry's id. Take every wanted
            // id in that window in one go, so each leaf is fetched exactly once
            // however many tiles we want from it.
            let upper = dir.get(k + 1).map_or(u64::MAX, |n| n.tile_id);
            let j = i + wanted[i..].partition_point(|&w| w < upper);
            items.push(Item::Leaf(leaves.len(), i, j));
            leaves.push(e);
            i = j;
        } else {
            if e.covers(id) {
                items.push(Item::Tile(id, e));
            }
            i += 1;
        }
    }

    // Fetch this level's leaves together. Directories are a few KB each, so
    // holding a level's worth costs single-digit megabytes even for a large
    // state, and it is what lets the walk below stay in order.
    let mut blobs: Vec<Vec<u8>> = Vec::with_capacity(leaves.len());
    for window in leaves.chunks(LEAF_WINDOW) {
        let ranges: Vec<(u64, u64)> = window
            .iter()
            .map(|e| (h.leaf_offset + e.offset, u64::from(e.length)))
            .collect();
        let got = src.read_ranges(&ranges)?;
        if got.len() != window.len() {
            return Err(format!(
                "asked for {} leaf directories, got {}",
                window.len(),
                got.len()
            ));
        }
        blobs.extend(got);
    }

    // Now walk the level in tile-id order, so what lands in `out` is ascending
    // regardless of which entries were tiles and which were leaves.
    for item in &items {
        match item {
            Item::Tile(id, e) => out.push((*id, *e)),
            Item::Leaf(li, from, to) => {
                let leaf = parse_directory(&decompress(&blobs[*li], h.internal_compression)?)?;
                descend(src, h, &leaf, &wanted[*from..*to], out, depth + 1)?;
            }
        }
    }
    Ok(())
}

/// A set of tiles fetched together in a single range request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Batch {
    pub offset: u64,
    pub length: u64,
    /// Indices into the slice that was coalesced.
    pub members: Vec<usize>,
}

/// Bridge across gaps up to this size rather than issuing a second request.
/// Re-reading a little dead space is far cheaper than another HTTPS round trip.
pub const MAX_GAP: u64 = 128 * 1024;

/// Never let a single request grow past this. Bounds peak memory — which is the
/// binding constraint on a phone, not bandwidth.
pub const MAX_BATCH: u64 = 4 * 1024 * 1024;

/// How many range requests to keep in flight against a remote archive.
///
/// This download is latency-bound, not bandwidth-bound: each batch is a full
/// round trip, and the next one does not start until the last byte of the
/// previous arrives. A phone's round trip is several times a wired desktop's,
/// which is why the identical code felt markedly slower on iOS than on the
/// machine it was written on. Overlapping requests hides most of that.
///
/// Sixteen because that is where it stops helping. Measured on Rhode Island —
/// 650 requests, 78 MB — against the live planet build:
///
/// | in flight | time |
/// |-----------|------|
/// | 6         | 21.4 s |
/// | 16        | 14.0 s |
/// | 32        | 18.9 s |
///
/// Past sixteen it gets worse, not better, so this is not a number to raise
/// hopefully. Rerun `measure_live_state_download` before changing it.
///
/// The request count itself is not worth attacking: a rectangular bbox maps
/// onto the archive's Hilbert ordering as hundreds of disjoint id ranges, so
/// ~650 requests is the shape of the problem rather than a coalescing failure.
/// Raising MAX_GAP to bridge them was tried and fetched 10 MB of other people's
/// tiles to save 25 requests, which was slower.
///
/// Peak memory stays bounded by WINDOW_BYTES below.
pub const CONCURRENT_REQUESTS: usize = 16;

/// How much tile data to have outstanding at once.
///
/// Deliberately a byte budget rather than a batch count. Fetching exactly
/// CONCURRENT_REQUESTS batches per round makes every round wait for its slowest
/// request while the other five sit idle — with uneven batch sizes and an uneven
/// network that gave away much of what the concurrency bought. Measuring the
/// window in bytes instead means small batches queue up deep enough to keep
/// every worker busy, while a run of large ones still caps memory here rather
/// than at six times the largest batch.
const WINDOW_BYTES: u64 = 24 * 1024 * 1024;

/// Leaf directories per round when resolving tile locations. These are a few KB
/// each, so this is about queue depth, not memory.
const LEAF_WINDOW: usize = 64;

/// Split batches into windows of roughly WINDOW_BYTES, never fewer than one.
fn windows_by_bytes(batches: &[Batch]) -> Vec<&[Batch]> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut bytes = 0u64;

    for (i, b) in batches.iter().enumerate() {
        // Always keep at least one batch, or a single oversized one would
        // produce an empty window and never make progress.
        if i > start && bytes + b.length > WINDOW_BYTES {
            out.push(&batches[start..i]);
            start = i;
            bytes = 0;
        }
        bytes += b.length;
    }
    if start < batches.len() {
        out.push(&batches[start..]);
    }
    out
}

/// Merge tiles that sit near each other in the archive into shared requests.
///
/// This is the entire reason this module parses directories by hand instead of
/// using the `pmtiles` crate's reader: without byte offsets there is nothing to
/// coalesce, and a state extract degrades into ~10^5 individual HTTP requests
/// against someone else's free server.
/// `tiles` must be in ascending tile-id order, and each batch's members come
/// back in that same order. That ordering constraint is deliberate: the writer
/// needs tiles in id order, and we cannot buffer a whole state in memory to
/// reorder them afterwards, so fetch order and write order have to agree.
///
/// In a clustered archive — which Protomaps' builds are — ascending ids are
/// also ascending offsets, so walking in id order costs nothing. In a
/// hypothetical unclustered archive this still produces correct output, just
/// with more requests.
pub fn coalesce(tiles: &[(u64, Entry)]) -> Vec<Batch> {
    let mut batches: Vec<Batch> = Vec::new();

    for (i, (_, e)) in tiles.iter().enumerate() {
        let start = e.offset;
        let end = e.offset + u64::from(e.length);

        if let Some(last) = batches.last_mut() {
            let cur_start = last.offset;
            let cur_end = last.offset + last.length;

            // Deduplication lets a later tile id reuse an earlier blob, so
            // offsets are not necessarily monotonic even in a clustered
            // archive. Measure the gap on whichever side the tile falls, and
            // treat an overlap as no gap at all.
            let gap = if start >= cur_end {
                start - cur_end
            } else if end <= cur_start {
                cur_start - end
            } else {
                0
            };
            let span = end.max(cur_end) - start.min(cur_start);

            if gap <= MAX_GAP && span <= MAX_BATCH {
                last.offset = start.min(cur_start);
                last.length = span;
                last.members.push(i);
                continue;
            }
        }
        batches.push(Batch {
            offset: start,
            length: u64::from(e.length),
            members: vec![i],
        });
    }
    batches
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

fn tile_type(raw: u8) -> Result<pmtiles::TileType, String> {
    Ok(match raw {
        1 => pmtiles::TileType::Mvt,
        2 => pmtiles::TileType::Png,
        3 => pmtiles::TileType::Jpeg,
        4 => pmtiles::TileType::Webp,
        5 => pmtiles::TileType::Avif,
        other => return Err(format!("unknown tile type {other} in source archive")),
    })
}

fn writer_compression(c: Compression) -> Result<pmtiles::Compression, String> {
    Ok(match c {
        Compression::None => pmtiles::Compression::None,
        Compression::Gzip => pmtiles::Compression::Gzip,
        Compression::Brotli => pmtiles::Compression::Brotli,
        Compression::Zstd => pmtiles::Compression::Zstd,
        Compression::Unknown => return Err("source archive has unknown tile compression".into()),
    })
}

/// Cut `bbox` out of `src` and write it to `dest` as a standalone archive.
///
/// This is the in-process replacement for `go-pmtiles extract --bbox=…`.
/// Returns the number of tiles written.
///
/// `on_progress(done, total)` is called as batches complete, so the caller can
/// surface real progress rather than scraping percentages out of a subprocess's
/// stdout.
pub fn extract(
    src: &dyn TileSource,
    h: &Header,
    dest: &std::path::Path,
    min_zoom: u8,
    max_zoom: u8,
    (min_lon, min_lat, max_lon, max_lat): (f64, f64, f64, f64),
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<u64, String> {
    // Asking for detail the source doesn't have would silently produce an empty
    // pack, so clamp rather than pretend.
    let max_zoom = max_zoom.min(h.max_zoom);
    let min_zoom = min_zoom.max(h.min_zoom);

    let want = wanted_tiles(min_zoom, max_zoom, min_lon, min_lat, max_lon, max_lat)?;
    let ids: Vec<u64> = want.iter().map(|t| t.id).collect();
    let found = locate_tiles(src, h, &ids)?;
    if found.is_empty() {
        return Err("no map data covers that area — check the bounding box".into());
    }
    let batches = coalesce(&found);

    // Carry the source's metadata across verbatim: it holds the vector-tile
    // layer schema, without which the map style has nothing to bind to.
    let meta_raw = src.read_range(h.metadata_offset, h.metadata_length)?;
    let meta = String::from_utf8(decompress(&meta_raw, h.internal_compression)?)
        .map_err(|e| format!("archive metadata is not valid UTF-8: {e}"))?;

    let file = std::fs::File::create(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut w = pmtiles::PmTilesWriter::new(tile_type(h.tile_type)?)
        .tile_compression(writer_compression(h.tile_compression)?)
        .min_zoom(min_zoom)
        .max_zoom(max_zoom)
        .bounds(min_lon, min_lat, max_lon, max_lat)
        .center((min_lon + max_lon) / 2.0, (min_lat + max_lat) / 2.0)
        .metadata(&meta)
        .create(std::io::BufWriter::new(file))
        .map_err(|e| format!("creating {}: {e}", dest.display()))?;

    let total = found.len() as u64;
    let mut done = 0u64;

    // Fetch a window of batches at once, then write them in order. The window
    // is what bounds memory; the ordering is not negotiable, because the writer
    // needs ascending tile ids and a whole state cannot be buffered to sort
    // afterwards. Fetch order is free to be chaotic, write order is not.
    for window in windows_by_bytes(&batches) {
        let ranges: Vec<(u64, u64)> = window
            .iter()
            .map(|b| (h.tile_data_offset + b.offset, b.length))
            .collect();
        let blobs = src.read_ranges(&ranges)?;
        // zip() stops at the shorter side, so a source returning fewer blobs
        // than it was asked for would drop tiles from the pack without a word.
        // Neither implementation here does that; this is so a future one
        // cannot.
        if blobs.len() != window.len() {
            return Err(format!(
                "asked for {} tile batches, got {}",
                window.len(),
                blobs.len()
            ));
        }

        for (batch, blob) in window.iter().zip(&blobs) {
            for &i in &batch.members {
                let (id, e) = found[i];
                // Where this tile sits inside the blob we just fetched.
                let start = (e.offset - batch.offset) as usize;
                let end = start + e.length as usize;
                let data = blob
                    .get(start..end)
                    .ok_or_else(|| format!("tile {id} falls outside its own batch"))?;

                // `want` is sorted by id and `found` preserves that order, so the
                // z/x/y is a binary search away — no inverse Hilbert transform.
                let t = want[want
                    .binary_search_by_key(&id, |t| t.id)
                    .map_err(|_| format!("located tile {id} was never requested"))?];

                let coord = pmtiles::TileCoord::new(t.z, t.x, t.y)
                    .map_err(|e| format!("bad tile coord {}/{}/{}: {e}", t.z, t.x, t.y))?;
                // Raw: source and destination share a tile compression, so there is
                // no reason to decompress and recompress every tile.
                w.add_raw_tile(coord, data)
                    .map_err(|e| format!("writing tile {}/{}/{}: {e}", t.z, t.x, t.y))?;
                done += 1;
            }
            on_progress(done, total);
        }
    }

    w.finalize()
        .map_err(|e| format!("finalising {}: {e}", dest.display()))?;
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reference values from the PMTiles v3 spec's tile-id examples.
    #[test]
    fn tile_id_matches_spec_examples() {
        assert_eq!(zxy_to_tile_id(0, 0, 0).unwrap(), 0);
        assert_eq!(zxy_to_tile_id(1, 0, 0).unwrap(), 1);
        assert_eq!(zxy_to_tile_id(1, 0, 1).unwrap(), 2);
        assert_eq!(zxy_to_tile_id(1, 1, 1).unwrap(), 3);
        assert_eq!(zxy_to_tile_id(1, 1, 0).unwrap(), 4);
        assert_eq!(zxy_to_tile_id(2, 0, 0).unwrap(), 5);
    }

    #[test]
    fn tile_ids_are_unique_and_dense_within_a_level() {
        // Zoom 3 has 64 tiles, occupying IDs 21..85 with no gaps or repeats.
        let mut ids: Vec<u64> = Vec::new();
        for x in 0..8 {
            for y in 0..8 {
                ids.push(zxy_to_tile_id(3, x, y).unwrap());
            }
        }
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 64, "ids collided");
        assert_eq!(*ids.first().unwrap(), 21);
        assert_eq!(*ids.last().unwrap(), 84);
    }

    #[test]
    fn tile_id_rejects_out_of_range() {
        assert!(zxy_to_tile_id(1, 2, 0).is_err());
        assert!(zxy_to_tile_id(0, 0, 1).is_err());
        assert!(zxy_to_tile_id(32, 0, 0).is_err());
    }

    #[test]
    fn bbox_covers_whole_world_at_zoom_zero() {
        let r = bbox_to_tile_range(0, -180.0, -85.0, 180.0, 85.0).unwrap();
        assert_eq!(r.min_x, 0);
        assert_eq!(r.max_x, 0);
        assert_eq!(r.count(), 1);
    }

    #[test]
    fn bbox_splits_the_world_in_four_at_zoom_one() {
        let r = bbox_to_tile_range(1, -180.0, -85.0, 180.0, 85.0).unwrap();
        assert_eq!(r.count(), 4);
    }

    #[test]
    fn bbox_maps_oregon_to_the_pacific_northwest() {
        // Oregon, from public/states.json.
        let r = bbox_to_tile_range(8, -124.566, 41.992, -116.463, 46.292).unwrap();
        // Northwest quadrant of the map: west of the meridian, north of equator.
        assert!(r.max_x < 128, "should be in the western hemisphere");
        assert!(r.max_y < 128, "should be in the northern hemisphere");
        assert!(r.min_x <= r.max_x && r.min_y <= r.max_y);
        // A state at z8 is a handful of tiles across, not hundreds.
        assert!(r.count() < 100, "unexpectedly large: {}", r.count());
    }

    #[test]
    fn bbox_rejects_inside_out_and_nonfinite() {
        assert!(bbox_to_tile_range(4, 10.0, 0.0, -10.0, 5.0).is_err());
        assert!(bbox_to_tile_range(4, 0.0, 0.0, f64::NAN, 5.0).is_err());
    }

    #[test]
    fn bbox_clamps_beyond_mercator_limit() {
        // 89°N is past where Mercator is defined; it must clamp, not produce
        // an out-of-range tile index.
        let r = bbox_to_tile_range(4, -180.0, -89.0, 180.0, 89.0).unwrap();
        assert!(r.min_y <= 15 && r.max_y <= 15);
    }

    #[test]
    fn header_rejects_junk() {
        assert!(Header::parse(&[0u8; 10]).is_err(), "too short");
        assert!(Header::parse(&[0u8; HEADER_LEN]).is_err(), "bad magic");

        let mut wrong_version = [0u8; HEADER_LEN];
        wrong_version[0..7].copy_from_slice(MAGIC);
        wrong_version[7] = 2;
        assert!(Header::parse(&wrong_version).is_err(), "v2 must be refused");
    }

    #[test]
    fn varint_roundtrips_known_values() {
        // 0x7f = 127 in one byte; 0x80 0x01 = 128 in two.
        let mut r = VarintReader::new(&[0x00, 0x7f, 0x80, 0x01, 0xff, 0xff, 0x03]);
        assert_eq!(r.next().unwrap(), 0);
        assert_eq!(r.next().unwrap(), 127);
        assert_eq!(r.next().unwrap(), 128);
        assert_eq!(r.next().unwrap(), 65535);
    }

    #[test]
    fn varint_refuses_truncated_and_overlong() {
        // Continuation bit set but no following byte.
        assert!(VarintReader::new(&[0x80]).next().is_err());
        // Eleven continuation bytes cannot fit in a u64.
        assert!(VarintReader::new(&[0x80; 12]).next().is_err());
    }

    #[test]
    fn directory_decodes_deltas_and_back_references() {
        // Two entries: ids 1 and 3 (delta-encoded as 1, 2), run lengths 1 and 1,
        // lengths 10 and 20, offsets 0 (explicit, encoded as 1) and
        // back-reference (encoded as 0, so it means 0 + 10 = 10).
        let buf = [
            2, // count
            1, 2, // id deltas
            1, 1, // run lengths
            10, 20, // lengths
            1, 0, // offsets
        ];
        let d = parse_directory(&buf).unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].tile_id, 1);
        assert_eq!(d[0].offset, 0);
        assert_eq!(d[1].tile_id, 3);
        assert_eq!(d[1].offset, 10, "back-reference should follow entry 0");
        assert_eq!(d[1].length, 20);
    }

    #[test]
    fn directory_run_length_zero_means_leaf() {
        let buf = [1u8, 5, 0, 99, 1];
        let d = parse_directory(&buf).unwrap();
        assert!(d[0].is_leaf());
        assert!(!d[0].covers(5), "a leaf pointer holds no tile");
    }

    #[test]
    fn entry_covers_its_whole_run() {
        let e = Entry {
            tile_id: 100,
            offset: 0,
            length: 1,
            run_length: 3,
        };
        assert!(!e.covers(99));
        assert!(e.covers(100) && e.covers(101) && e.covers(102));
        assert!(!e.covers(103));
    }

    #[test]
    fn directory_rejects_absurd_count() {
        // A huge count prefix must not trigger a huge allocation.
        assert!(parse_directory(&[0xff, 0xff, 0xff, 0x7f]).is_err());
    }

    fn entry(tile_id: u64, offset: u64, length: u32) -> (u64, Entry) {
        (
            tile_id,
            Entry {
                tile_id,
                offset,
                length,
                run_length: 1,
            },
        )
    }

    #[test]
    fn coalesce_merges_contiguous_tiles() {
        let tiles = [entry(1, 0, 100), entry(2, 100, 100), entry(3, 200, 100)];
        let b = coalesce(&tiles);
        assert_eq!(b.len(), 1, "contiguous tiles should be one request");
        assert_eq!(b[0].offset, 0);
        assert_eq!(b[0].length, 300);
        assert_eq!(b[0].members.len(), 3);
    }

    #[test]
    fn coalesce_bridges_small_gaps_but_not_large_ones() {
        // A 1 KB hole is cheaper to read through than to make a second request.
        let near = [entry(1, 0, 100), entry(2, 1100, 100)];
        assert_eq!(coalesce(&near).len(), 1);

        // A gap past MAX_GAP is not worth bridging.
        let far = [entry(1, 0, 100), entry(2, MAX_GAP + 5000, 100)];
        assert_eq!(coalesce(&far).len(), 2);
    }

    #[test]
    fn coalesce_caps_batch_size() {
        // Contiguous tiles totalling more than MAX_BATCH must still split, so
        // peak memory stays bounded on a phone.
        let big = u32::try_from(MAX_BATCH / 2 + 1).unwrap();
        let tiles = [
            entry(1, 0, big),
            entry(2, u64::from(big), big),
            entry(3, u64::from(big) * 2, big),
        ];
        let b = coalesce(&tiles);
        assert!(b.len() >= 2, "oversized run should split");
        for batch in &b {
            assert!(batch.length <= MAX_BATCH, "batch exceeded cap");
        }
    }

    #[test]
    fn coalesce_handles_dedup_backreferences() {
        // Deduplication lets a later tile id reuse an earlier blob, so offsets
        // are not monotonic with tile id. This must not underflow or explode.
        let tiles = [entry(1, 5000, 100), entry(2, 0, 100), entry(3, 5000, 100)];
        let b = coalesce(&tiles);
        let covered: usize = b.iter().map(|x| x.members.len()).sum();
        assert_eq!(covered, 3, "every tile must land in exactly one batch");
        for batch in &b {
            assert!(batch.length <= MAX_BATCH);
        }
    }

    #[test]
    fn wanted_tiles_are_sorted_and_cover_every_zoom() {
        let t = wanted_tiles(0, 4, -124.5, 42.0, -116.5, 46.0).unwrap();
        assert!(!t.is_empty());
        assert!(t.windows(2).all(|w| w[0].id <= w[1].id), "must be sorted");
        for z in 0..=4u8 {
            assert!(t.iter().any(|w| w.z == z), "zoom {z} missing");
        }
    }

    #[test]
    fn wanted_tiles_rejects_inverted_zoom_range() {
        assert!(wanted_tiles(8, 4, -124.0, 42.0, -116.0, 46.0).is_err());
    }

    /// The end-to-end claim, measured rather than asserted in a comment:
    /// walking a real archive's directories and coalescing genuinely collapses
    /// tens of thousands of tiles into a manageable number of requests.
    #[test]
    fn locates_and_coalesces_real_oregon_tiles() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../mapdata/oregon.pmtiles");
        let Ok(src) = FileSource::open(std::path::Path::new(path)) else {
            eprintln!("skipping: {path} not present");
            return;
        };

        let head = src.read_range(0, HEADER_LEN as u64).expect("read header");
        let h = Header::parse(&head).expect("parse header");

        // Portland and its surroundings, through zoom 12.
        let want = wanted_tiles(0, 12, -123.2, 45.2, -122.2, 45.8).unwrap();
        let ids: Vec<u64> = want.iter().map(|t| t.id).collect();

        let found = locate_tiles(&src, &h, &ids).expect("locate tiles");
        assert!(
            !found.is_empty(),
            "found no tiles for Portland in an Oregon archive"
        );

        // Leaf traversal must not invent tiles, and every located byte range
        // must land inside the archive's tile data section.
        assert!(
            found.len() <= ids.len(),
            "located more tiles than requested"
        );
        assert!(
            found.windows(2).all(|w| w[0].0 <= w[1].0),
            "lost id ordering"
        );
        for (id, e) in &found {
            assert!(e.covers(*id), "entry doesn't actually cover tile {id}");
            assert!(
                e.offset + u64::from(e.length) <= h.tile_data_length,
                "tile {id} points past the end of the tile data"
            );
        }

        let batches = coalesce(&found);
        let bytes: u64 = batches.iter().map(|b| b.length).sum();
        eprintln!(
            "portland z0-12: {} of {} ids present, {} requests after coalescing ({:.1}x fewer), {:.1} MB",
            found.len(),
            ids.len(),
            batches.len(),
            found.len() as f64 / batches.len() as f64,
            bytes as f64 / 1e6,
        );

        assert!(
            batches.len() < found.len(),
            "coalescing achieved nothing — the whole reason this module parses \
             directories by hand"
        );

        // Reading a coalesced batch must actually yield bytes.
        let first = &batches[0];
        let blob = src
            .read_range(h.tile_data_offset + first.offset, first.length)
            .unwrap();
        assert_eq!(blob.len() as u64, first.length);
        assert!(
            blob.iter().any(|&b| b != 0),
            "batch read back as all zeroes"
        );
    }

    /// The whole pipeline, end to end, against real data: cut a bbox out of the
    /// Oregon archive, then reopen the result with the same parser and check
    /// the tiles survived the round trip byte for byte.
    ///
    /// This is what actually replaces the sidecar, so it's worth proving rather
    /// than assuming — a pack that parses but contains the wrong tiles would
    /// look like a working download and a broken map.
    #[test]
    fn extracts_a_real_bbox_and_reads_it_back() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../mapdata/oregon.pmtiles");
        let Ok(src) = FileSource::open(std::path::Path::new(path)) else {
            eprintln!("skipping: {path} not present");
            return;
        };
        let h = Header::parse(&src.read_range(0, HEADER_LEN as u64).unwrap()).unwrap();

        let dest = std::env::temp_dir().join("griddown-extract-test.pmtiles");
        let _ = std::fs::remove_file(&dest);

        // Portland, through zoom 11.
        let bbox = (-123.2, 45.2, -122.2, 45.8);
        let mut seen: Vec<(u64, u64)> = Vec::new();
        let written = extract(&src, &h, &dest, 0, 11, bbox, &mut |done, total| {
            seen.push((done, total));
        })
        .expect("extract failed");

        assert!(written > 0, "wrote no tiles");
        assert!(!seen.is_empty(), "progress was never reported");
        let (last_done, last_total) = *seen.last().unwrap();
        assert_eq!(
            last_done, written,
            "final progress disagrees with return value"
        );
        assert_eq!(last_done, last_total, "progress never reached 100%");
        assert!(
            seen.windows(2).all(|w| w[0].0 <= w[1].0),
            "progress went backwards"
        );

        // Reopen the pack we just wrote, using the same reader.
        let out = FileSource::open(&dest).expect("reopen extract");
        let oh = Header::parse(&out.read_range(0, HEADER_LEN as u64).unwrap())
            .expect("output is not a valid PMTiles archive");

        assert_eq!(oh.max_zoom, 11);
        assert_eq!(oh.tile_type, h.tile_type, "tile type must carry across");
        assert_eq!(
            oh.tile_compression, h.tile_compression,
            "tiles are copied raw, so compression must match the source"
        );
        assert!(
            oh.metadata_length > 0,
            "metadata (the layer schema) was lost"
        );

        // Every tile in the new pack must be byte-identical to the source's.
        let want = wanted_tiles(0, 11, bbox.0, bbox.1, bbox.2, bbox.3).unwrap();
        let ids: Vec<u64> = want.iter().map(|t| t.id).collect();
        let from_src = locate_tiles(&src, &h, &ids).unwrap();
        let from_out = locate_tiles(&out, &oh, &ids).unwrap();

        assert_eq!(
            from_out.len(),
            from_src.len(),
            "extract lost tiles: {} in source, {} in output",
            from_src.len(),
            from_out.len()
        );

        let mut compared = 0;
        for ((sid, se), (oid, oe)) in from_src.iter().zip(from_out.iter()) {
            assert_eq!(sid, oid, "tile ids diverged");
            let a = src
                .read_range(h.tile_data_offset + se.offset, u64::from(se.length))
                .unwrap();
            let b = out
                .read_range(oh.tile_data_offset + oe.offset, u64::from(oe.length))
                .unwrap();
            assert_eq!(a, b, "tile {sid} changed during extract");
            compared += 1;
        }

        let size = std::fs::metadata(&dest).unwrap().len();
        eprintln!(
            "extracted {written} tiles ({compared} verified byte-identical) into {:.1} MB",
            size as f64 / 1e6
        );

        let _ = std::fs::remove_file(&dest);
    }

    /// The real thing: pull a small bbox straight off Protomaps' live planet
    /// build over HTTP. Everything else in this file is tested against a local
    /// file, so this is the only check that the range requests, the build-date
    /// probe, and the remote archive's actual layout all behave.
    ///
    /// Ignored by default — it needs internet and hits someone else's server,
    /// so it stays deliberately tiny. Run with
    /// `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore = "requires internet; hits Protomaps' public server"]
    fn extracts_from_the_live_planet_build() {
        let today = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            / 86400) as i64;

        let url = latest_build_url(today).expect("no recent planet build found");
        eprintln!("planet build: {url}");

        let src = HttpSource::new(&url).unwrap();
        let h = Header::parse(&src.read_range(0, HEADER_LEN as u64).unwrap())
            .expect("live archive header did not parse");
        eprintln!(
            "remote: zoom {}..{}, clustered={}, {:.1} GB of tile data",
            h.min_zoom,
            h.max_zoom,
            h.clustered,
            h.tile_data_length as f64 / 1e9
        );

        // Deliberately tiny: central Portland, low zoom. A handful of requests.
        let dest = std::env::temp_dir().join("griddown-live-test.pmtiles");
        let _ = std::fs::remove_file(&dest);
        let mut batches = 0;
        let written = extract(
            &src,
            &h,
            &dest,
            0,
            7,
            (-122.75, 45.45, -122.55, 45.6),
            &mut |_, _| batches += 1,
        )
        .expect("live extract failed");

        assert!(written > 0, "live extract produced no tiles");

        // What we wrote must be readable by our own parser.
        let out = FileSource::open(&dest).unwrap();
        let oh = Header::parse(&out.read_range(0, HEADER_LEN as u64).unwrap())
            .expect("live extract output is not a valid archive");
        assert_eq!(oh.tile_type, h.tile_type);

        let size = std::fs::metadata(&dest).unwrap().len();
        eprintln!(
            "live extract: {written} tiles in {batches} requests, {:.0} KB",
            size as f64 / 1e3
        );
        let _ = std::fs::remove_file(&dest);
    }

    /// Where does the time in a real state download actually go?
    ///
    /// Splits a live extract into its two network phases and reports each, so
    /// tuning is driven by measurement rather than by which part looks slow.
    /// Rhode Island because it is the smallest state — enough to be
    /// representative without pulling a gigabyte off someone's free server.
    ///
    /// `cargo test --release measure_live -- --ignored --nocapture`
    #[test]
    #[ignore = "requires internet; downloads ~70 MB from Protomaps"]
    fn measure_live_state_download() {
        use std::time::Instant;

        let today = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            / 86400) as i64;
        let url = latest_build_url(today).expect("no recent planet build");
        let src = HttpSource::new(&url).unwrap();
        let h = Header::parse(&src.read_range(0, HEADER_LEN as u64).unwrap()).unwrap();

        // Rhode Island.
        let bbox = (-71.91, 41.14, -71.12, 42.02);
        let (min_lon, min_lat, max_lon, max_lat) = bbox;

        let t0 = Instant::now();
        let want = wanted_tiles(0, 15, min_lon, min_lat, max_lon, max_lat).unwrap();
        let plan_ms = t0.elapsed().as_millis();

        let t1 = Instant::now();
        let ids: Vec<u64> = want.iter().map(|t| t.id).collect();
        let found = locate_tiles(&src, &h, &ids).unwrap();
        let locate_s = t1.elapsed().as_secs_f64();

        let batches = coalesce(&found);
        let total: u64 = batches.iter().map(|b| b.length).sum();
        let windows = windows_by_bytes(&batches).len();

        let t2 = Instant::now();
        let dest = std::env::temp_dir().join("griddown-measure.pmtiles");
        let _ = std::fs::remove_file(&dest);
        let written = extract(&src, &h, &dest, 0, 15, bbox, &mut |_, _| {}).unwrap();
        let fetch_s = t2.elapsed().as_secs_f64();
        let _ = std::fs::remove_file(&dest);

        eprintln!("\n--- Rhode Island, zoom 0..15 ---");
        eprintln!("planning        {plan_ms} ms (no network)");
        eprintln!(
            "locate tiles    {locate_s:.1} s  -> {} tiles found",
            found.len()
        );
        eprintln!(
            "fetch + write   {fetch_s:.1} s  -> {written} tiles, {:.0} MB at {:.1} MB/s",
            total as f64 / 1e6,
            total as f64 / 1e6 / fetch_s
        );
        eprintln!(
            "requests        {} batches in {windows} windows, mean {:.2} MB each",
            batches.len(),
            total as f64 / batches.len() as f64 / 1e6
        );
        eprintln!(
            "concurrency     {CONCURRENT_REQUESTS} in flight, window budget {} MB",
            WINDOW_BYTES / (1 << 20)
        );
        eprintln!(
            "shape           locate is {:.0}% of the {:.1} s total\n",
            100.0 * locate_s / (locate_s + fetch_s),
            locate_s + fetch_s
        );
    }

    #[test]
    fn http_source_rejects_a_zero_length_read_without_a_request() {
        // Guards the early return: a zero-length range header is malformed, and
        // constructing one would mean `bytes=N-(N-1)`.
        let src = HttpSource::new("https://example.invalid/x.pmtiles").unwrap();
        assert_eq!(src.read_range(0, 0).unwrap(), Vec::<u8>::new());
    }

    /// Measure a full-state extract at realistic zoom, to check the request
    /// count stays sane at scale rather than only on a city-sized bbox.
    ///
    /// Ignored by default: it walks every leaf directory in the archive, which
    /// is slow enough to be annoying in a normal test run. Run explicitly with
    /// `cargo test -- --ignored --nocapture` when changing the coalescing rules.
    #[test]
    #[ignore = "slow; run explicitly to sanity-check request counts"]
    fn measures_a_full_state_extract() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../mapdata/oregon.pmtiles");
        let Ok(src) = FileSource::open(std::path::Path::new(path)) else {
            eprintln!("skipping: {path} not present");
            return;
        };
        let head = src.read_range(0, HEADER_LEN as u64).unwrap();
        let h = Header::parse(&head).unwrap();

        // Oregon's full bbox, from public/states.json.
        for maxz in [12u8, 14] {
            let want = wanted_tiles(0, maxz, -124.566, 41.992, -116.463, 46.292).unwrap();
            let ids: Vec<u64> = want.iter().map(|t| t.id).collect();
            let found = locate_tiles(&src, &h, &ids).unwrap();
            let batches = coalesce(&found);
            let bytes: u64 = batches.iter().map(|b| b.length).sum();
            eprintln!(
                "oregon z0-{maxz}: {} requested, {} present, {} requests ({:.0}x fewer), {:.0} MB",
                ids.len(),
                found.len(),
                batches.len(),
                found.len() as f64 / batches.len().max(1) as f64,
                bytes as f64 / 1e6,
            );
        }
    }

    /// An archive held in memory, so directory shapes that are awkward to find
    /// in a real file can be built exactly.
    struct MemSource(Vec<u8>);
    impl TileSource for MemSource {
        fn read_range(&self, offset: u64, len: u64) -> Result<Vec<u8>, String> {
            let start = offset as usize;
            let end = start + len as usize;
            self.0
                .get(start..end)
                .map(<[u8]>::to_vec)
                .ok_or_else(|| format!("read {start}..{end} past end of archive"))
        }
    }

    /// A directory holding tiles *and* leaf pointers must still come back in
    /// ascending tile-id order.
    ///
    /// This is the shape the planet's root actually has — low zooms stored
    /// directly, higher ones behind leaves — and it is the one case where
    /// resolving a level before fetching it can silently reorder the result.
    /// Nothing downstream would report it: coalescing would merge the wrong
    /// tiles and the writer would encode a wrong archive without complaint.
    #[test]
    fn a_mixed_directory_still_resolves_in_id_order() {
        // Leaf directory: one tile, id 2. Lives at the very start of the blob.
        let leaf_dir = [1u8, 2, 1, 30, 51];
        // Root: tile id 1, then a leaf pointer for id 2, then tile id 3.
        // Fields are grouped: count, id deltas, run lengths, lengths, offsets.
        // A run length of 0 is what marks the middle entry as a leaf.
        let root_dir = [3u8, 1, 1, 1, 1, 0, 1, 10, 5, 20, 41, 1, 61];

        let mut blob = leaf_dir.to_vec();
        blob.extend_from_slice(&root_dir);
        let src = MemSource(blob);

        let h = Header {
            root_offset: leaf_dir.len() as u64,
            root_length: root_dir.len() as u64,
            metadata_offset: 0,
            metadata_length: 0,
            leaf_offset: 0,
            leaf_length: leaf_dir.len() as u64,
            tile_data_offset: 0,
            tile_data_length: 0,
            clustered: true,
            internal_compression: Compression::None,
            tile_compression: Compression::Gzip,
            tile_type: 1,
            min_zoom: 0,
            max_zoom: 15,
            min_lon: -180.0,
            min_lat: -85.0,
            max_lon: 180.0,
            max_lat: 85.0,
        };

        let found = locate_tiles(&src, &h, &[1, 2, 3]).expect("locates every tile");
        let ids: Vec<u64> = found.iter().map(|(id, _)| *id).collect();
        assert_eq!(
            ids,
            vec![1, 2, 3],
            "the leaf's tile must sort between the two direct entries, not after them"
        );
    }

    fn batch_of(len: u64) -> Batch {
        Batch {
            offset: 0,
            length: len,
            members: vec![],
        }
    }

    /// Windowing must not lose, duplicate or reorder a batch. Any of those
    /// would produce a pack that is wrong rather than one that fails.
    #[test]
    fn windows_cover_every_batch_once_in_order() {
        let sizes = [1u64, 5 << 20, 9 << 20, 3 << 20, 12 << 20, 2 << 20, 7 << 20];
        let batches: Vec<Batch> = sizes.iter().map(|&s| batch_of(s)).collect();

        let seen: Vec<u64> = windows_by_bytes(&batches)
            .iter()
            .flat_map(|w| w.iter().map(|b| b.length))
            .collect();
        assert_eq!(
            seen, sizes,
            "batches must come back in the same order, once"
        );
    }

    /// The budget is what keeps peak memory bounded on a phone.
    #[test]
    fn windows_respect_the_byte_budget() {
        let batches: Vec<Batch> = (0..40).map(|_| batch_of(4 << 20)).collect();
        for w in windows_by_bytes(&batches) {
            assert!(!w.is_empty(), "an empty window would stall progress");
            let total: u64 = w.iter().map(|b| b.length).sum();
            assert!(
                total <= WINDOW_BYTES,
                "window of {total} exceeds the budget"
            );
        }
    }

    /// A batch bigger than the whole budget still has to go somewhere. It gets a
    /// window to itself rather than an empty one that never advances.
    #[test]
    fn an_oversized_batch_gets_its_own_window() {
        let batches = vec![
            batch_of(1 << 20),
            batch_of(WINDOW_BYTES * 3),
            batch_of(1 << 20),
        ];
        let w = windows_by_bytes(&batches);
        assert!(w.iter().all(|x| !x.is_empty()));
        assert_eq!(w.iter().map(|x| x.len()).sum::<usize>(), 3);
        assert!(
            w.iter()
                .any(|x| x.len() == 1 && x[0].length == WINDOW_BYTES * 3),
            "the oversized batch should stand alone"
        );
    }

    #[test]
    fn no_batches_means_no_windows() {
        assert!(windows_by_bytes(&[]).is_empty());
    }

    /// Results must land in the order they were asked for, not the order they
    /// arrived in.
    ///
    /// This is the whole risk of fetching in parallel: the writer needs tiles in
    /// ascending id order, so a batch that reassembles wrongly would produce a
    /// silently corrupt pack rather than an error. Reads here finish in
    /// deliberately reversed order — the first range is the slowest — so a naive
    /// "push as they complete" would fail this.
    #[test]
    fn parallel_reads_reassemble_in_request_order() {
        let ranges: Vec<(u64, u64)> = (0..12u64).map(|i| (i * 100, 4)).collect();
        let n = ranges.len();

        let out = read_ranges_parallel(&ranges, 6, &|offset, _len| {
            let i = (offset / 100) as usize;
            std::thread::sleep(std::time::Duration::from_millis((n - i) as u64 * 4));
            Ok(vec![i as u8; 4])
        })
        .expect("all reads succeed");

        assert_eq!(out.len(), n);
        for (i, chunk) in out.iter().enumerate() {
            assert_eq!(
                chunk,
                &vec![i as u8; 4],
                "range {i} landed in the wrong slot"
            );
        }
    }

    /// One bad range fails the batch. Returning a short or gap-filled Vec would
    /// hand the writer tiles it would happily encode as a valid, wrong archive.
    #[test]
    fn a_failed_range_fails_the_whole_batch() {
        let ranges = [(0u64, 4u64), (100, 4), (200, 4)];
        let err = read_ranges_parallel(&ranges, 3, &|offset, _len| {
            if offset == 100 {
                Err("server said no".into())
            } else {
                Ok(vec![0u8; 4])
            }
        })
        .expect_err("must not succeed");
        assert!(err.contains("server said no"), "unexpected error: {err}");
    }

    /// Degenerate inputs: no work is not a failure, and one range must not need
    /// a thread pool to come back.
    #[test]
    fn empty_and_single_ranges_are_fine() {
        assert!(read_ranges_parallel(&[], 6, &|_, _| Ok(vec![]))
            .expect("empty is ok")
            .is_empty());

        let one = read_ranges_parallel(&[(7, 3)], 6, &|o, l| Ok(vec![o as u8; l as usize]))
            .expect("single is ok");
        assert_eq!(one, vec![vec![7u8; 3]]);
    }

    /// Parse a real Protomaps-produced archive, not just bytes we made up.
    ///
    /// Synthetic fixtures only prove the parser is self-consistent; this proves
    /// it agrees with what `go-pmtiles` actually writes. Skipped when the file
    /// isn't present, since it's a 477 MB local artifact that isn't in git.
    #[test]
    fn reads_a_real_archive() {
        use std::io::{Read, Seek, SeekFrom};

        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../mapdata/oregon.pmtiles");
        let Ok(mut f) = std::fs::File::open(path) else {
            eprintln!("skipping: {path} not present");
            return;
        };

        let mut head = [0u8; HEADER_LEN];
        f.read_exact(&mut head).expect("read header");
        let h = Header::parse(&head).expect("parse header");

        // Oregon, cross-checked against public/states.json.
        assert!(
            h.min_lon > -125.0 && h.max_lon < -116.0,
            "longitude looks wrong: {}..{}",
            h.min_lon,
            h.max_lon
        );
        assert!(
            h.min_lat > 41.0 && h.max_lat < 47.0,
            "latitude looks wrong: {}..{}",
            h.min_lat,
            h.max_lat
        );
        assert!(h.max_zoom >= h.min_zoom && h.max_zoom <= 20);
        assert!(h.root_length > 0 && h.tile_data_length > 0);

        // The root directory must decompress and parse, and its entries must be
        // strictly ascending — that ordering is what makes coalescing sound.
        f.seek(SeekFrom::Start(h.root_offset)).expect("seek root");
        let mut raw = vec![0u8; h.root_length as usize];
        f.read_exact(&mut raw).expect("read root");
        let dir = parse_directory(&decompress(&raw, h.internal_compression).expect("gunzip"))
            .expect("parse root directory");

        assert!(!dir.is_empty(), "root directory is empty");
        for w in dir.windows(2) {
            assert!(
                w[1].tile_id > w[0].tile_id,
                "tile ids out of order: {} then {}",
                w[0].tile_id,
                w[1].tile_id
            );
        }

        // Every tile in the archive must fall inside the declared bbox. This is
        // the real end-to-end check: it exercises the header, the directory
        // decode, and the tile-id maths together, and would fail if our Hilbert
        // curve disagreed with the one go-pmtiles used to write the file.
        let leaves = dir.iter().filter(|e| e.is_leaf()).count();
        let tiles: Vec<&Entry> = dir.iter().filter(|e| !e.is_leaf()).collect();
        eprintln!(
            "oregon.pmtiles: zoom {}..{}, {} root entries ({leaves} leaf pointers, {} tile runs)",
            h.min_zoom,
            h.max_zoom,
            dir.len(),
            tiles.len()
        );

        for e in &tiles {
            assert!(
                e.offset + u64::from(e.length) <= h.tile_data_length,
                "tile run at id {} runs past the end of the tile data",
                e.tile_id
            );
        }
    }
}
