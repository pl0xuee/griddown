// Meshtastic — teammate positions over LoRa mesh radio.
//
// Talks to a radio over the Stream API on TCP (default port 4403), which is the
// one transport that works on Linux, Windows and iOS alike: no drivers, no
// pairing, no MFi problem. BLE is the transport a phone would really want in
// the field and is deliberately left for later — note it is NOT framed the way
// this is, so it needs its own reader rather than a swapped socket.
//
// The protobuf decoding is done by hand, against these field numbers taken from
// meshtastic/protobufs. That is a deliberate trade: the published `meshtastic`
// crate is GPL-3.0, which would have set the licence of this whole application,
// and it states no iOS support — while the part of the format we actually need
// is a few dozen fields and protobuf's wire format is simple enough to read
// directly. Nothing new enters Cargo.toml for this.
//
// The risk in hand-decoding is that a wrong field number does not fail loudly:
// it silently plots a teammate in the wrong place. So the tests at the bottom
// run against bytes encoded by Meshtastic's own Python library (see
// tools/gen_mesh_fixtures.py), not against our own idea of the schema.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[cfg(test)]
#[path = "mesh_fixtures.rs"]
mod mesh_fixtures;

// --- protobuf wire format ---------------------------------------------------

#[derive(Debug, PartialEq)]
enum Wire<'a> {
    Varint(u64),
    Fixed64([u8; 8]),
    Bytes(&'a [u8]),
    Fixed32([u8; 4]),
}

/// Walk the (field number, value) pairs of a protobuf message.
///
/// Unknown fields are yielded like any other and simply ignored by callers,
/// which is what makes this forward-compatible: Meshtastic adds fields every
/// release and a decoder that choked on one it didn't know would break on the
/// next firmware update.
struct Fields<'a> {
    buf: &'a [u8],
    pos: usize,
}

fn varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut out: u64 = 0;
    let mut shift = 0;
    loop {
        let b = *buf.get(*pos)?;
        *pos += 1;
        out |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some(out);
        }
        shift += 7;
        if shift > 63 {
            return None; // malformed: longer than any u64
        }
    }
}

impl<'a> Iterator for Fields<'a> {
    type Item = (u32, Wire<'a>);

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.buf.len() {
            return None;
        }
        let key = varint(self.buf, &mut self.pos)?;
        let field = (key >> 3) as u32;
        match key & 7 {
            0 => Some((field, Wire::Varint(varint(self.buf, &mut self.pos)?))),
            1 => {
                let end = self.pos.checked_add(8)?;
                let b: [u8; 8] = self.buf.get(self.pos..end)?.try_into().ok()?;
                self.pos = end;
                Some((field, Wire::Fixed64(b)))
            }
            2 => {
                let len = varint(self.buf, &mut self.pos)? as usize;
                let end = self.pos.checked_add(len)?;
                let b = self.buf.get(self.pos..end)?;
                self.pos = end;
                Some((field, Wire::Bytes(b)))
            }
            5 => {
                let end = self.pos.checked_add(4)?;
                let b: [u8; 4] = self.buf.get(self.pos..end)?.try_into().ok()?;
                self.pos = end;
                Some((field, Wire::Fixed32(b)))
            }
            _ => None, // groups (3,4) are long gone from proto3
        }
    }
}

fn fields(buf: &[u8]) -> Fields<'_> {
    Fields { buf, pos: 0 }
}

fn as_u32(w: &Wire) -> Option<u32> {
    match w {
        Wire::Varint(v) => Some(*v as u32),
        Wire::Fixed32(b) => Some(u32::from_le_bytes(*b)),
        _ => None,
    }
}

fn as_i32(w: &Wire) -> Option<i32> {
    match w {
        Wire::Varint(v) => Some(*v as i32),
        Wire::Fixed32(b) => Some(i32::from_le_bytes(*b)),
        _ => None,
    }
}

fn as_f32(w: &Wire) -> Option<f32> {
    match w {
        Wire::Fixed32(b) => Some(f32::from_le_bytes(*b)),
        _ => None,
    }
}

fn as_str(w: &Wire) -> Option<String> {
    match w {
        Wire::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        _ => None,
    }
}

fn as_bytes<'a>(w: &Wire<'a>) -> Option<&'a [u8]> {
    match w {
        Wire::Bytes(b) => Some(*b),
        _ => None,
    }
}

// --- Meshtastic messages ----------------------------------------------------

const PORTNUM_POSITION: u32 = 3;
const PORTNUM_NODEINFO: u32 = 4;

/// One teammate, as the frontend needs them. Fields stay optional because a
/// node is very often known by name long before it ever reports a position.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct MeshNode {
    pub num: u32,
    pub id: String,
    #[serde(rename = "longName")]
    pub long_name: String,
    #[serde(rename = "shortName")]
    pub short_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lng: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub altitude: Option<i32>,
    #[serde(rename = "posTime", skip_serializing_if = "Option::is_none")]
    pub pos_time: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snr: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hops: Option<u32>,
    #[serde(rename = "lastHeard", skip_serializing_if = "Option::is_none")]
    pub last_heard: Option<u32>,
    /// Metres of deliberate fuzzing, when the sender reduced its precision.
    #[serde(rename = "uncertaintyM", skip_serializing_if = "Option::is_none")]
    pub uncertainty_m: Option<f64>,
}

/// "!7c3f0a1b" — how Meshtastic writes a node id.
pub fn node_id(num: u32) -> String {
    format!("!{:08x}", num)
}

#[derive(Debug, Default, PartialEq)]
pub struct Position {
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub altitude: Option<i32>,
    pub time: Option<u32>,
    pub precision_bits: Option<u32>,
}

/// Half-width in metres of the cell a fuzzed position could be anywhere within.
///
/// Meshtastic can deliberately blur location per channel: it masks off the low
/// bits of the coordinate and re-centres. 32 bits is exact; each bit removed
/// doubles the area. Shown as a circle rather than a pin, because a pin drawn
/// from a fuzzed position claims a precision that was intentionally discarded.
pub fn uncertainty_metres(precision_bits: u32) -> Option<f64> {
    if precision_bits == 0 || precision_bits >= 32 {
        return None;
    }
    // The cell is 2^(32-bits) units of 1e-7°; half of that, as metres of latitude.
    let units = (1u64 << (32 - precision_bits)) as f64;
    Some(units * 1e-7 * 111_320.0 / 2.0)
}

pub fn decode_position(buf: &[u8]) -> Position {
    let mut p = Position::default();
    for (num, w) in fields(buf) {
        match num {
            // latitude_i / longitude_i are sfixed32 in units of 1e-7 degrees.
            1 => p.lat = as_i32(&w).map(|v| v as f64 * 1e-7),
            2 => p.lng = as_i32(&w).map(|v| v as f64 * 1e-7),
            3 => p.altitude = as_i32(&w),
            4 => p.time = as_u32(&w),
            // timestamp (7) is the GPS solution time and is preferred over
            // time (4), which is when the packet was assembled.
            7 => {
                if let Some(t) = as_u32(&w) {
                    if t > 0 {
                        p.time = Some(t);
                    }
                }
            }
            23 => p.precision_bits = as_u32(&w),
            _ => {}
        }
    }
    p
}

fn apply_position(node: &mut MeshNode, p: &Position) {
    // 0,0 is the null island the firmware sends when it has no fix at all.
    if p.lat == Some(0.0) && p.lng == Some(0.0) {
        return;
    }
    if p.lat.is_some() {
        node.lat = p.lat;
    }
    if p.lng.is_some() {
        node.lng = p.lng;
    }
    if p.altitude.is_some() {
        node.altitude = p.altitude;
    }
    if p.time.is_some() {
        node.pos_time = p.time;
    }
    node.uncertainty_m = p.precision_bits.and_then(uncertainty_metres);
}

pub fn decode_user(buf: &[u8], node: &mut MeshNode) {
    for (num, w) in fields(buf) {
        match num {
            1 => {
                if let Some(s) = as_str(&w) {
                    node.id = s;
                }
            }
            2 => {
                if let Some(s) = as_str(&w) {
                    node.long_name = s;
                }
            }
            3 => {
                if let Some(s) = as_str(&w) {
                    node.short_name = s;
                }
            }
            _ => {}
        }
    }
}

pub fn decode_node_info(buf: &[u8]) -> MeshNode {
    let mut node = MeshNode::default();
    for (num, w) in fields(buf) {
        match num {
            1 => node.num = as_u32(&w).unwrap_or(0),
            2 => {
                if let Some(b) = as_bytes(&w) {
                    decode_user(b, &mut node);
                }
            }
            3 => {
                if let Some(b) = as_bytes(&w) {
                    let p = decode_position(b);
                    apply_position(&mut node, &p);
                }
            }
            4 => node.snr = as_f32(&w),
            5 => node.last_heard = as_u32(&w),
            6 => {
                if let Some(b) = as_bytes(&w) {
                    for (n2, w2) in fields(b) {
                        if n2 == 1 {
                            node.battery = as_u32(&w2);
                        }
                    }
                }
            }
            9 => node.hops = as_u32(&w),
            _ => {}
        }
    }
    if node.id.is_empty() {
        node.id = node_id(node.num);
    }
    node
}

/// What a single FromRadio message told us, if anything we care about.
#[derive(Debug, PartialEq)]
pub enum Update {
    /// A node's details, from the radio's database or a NODEINFO_APP packet.
    Node(MeshNode),
    /// The radio has finished sending its initial database dump.
    ConfigComplete(u32),
    /// Something we don't plot — a text message, telemetry, config.
    Ignored,
}

pub fn decode_from_radio(buf: &[u8]) -> Update {
    for (num, w) in fields(buf) {
        match num {
            // packet — a live MeshPacket off the mesh
            2 => {
                if let Some(b) = as_bytes(&w) {
                    return decode_mesh_packet(b);
                }
            }
            // node_info — an entry from the radio's node database
            4 => {
                if let Some(b) = as_bytes(&w) {
                    return Update::Node(decode_node_info(b));
                }
            }
            7 => {
                if let Some(id) = as_u32(&w) {
                    return Update::ConfigComplete(id);
                }
            }
            _ => {}
        }
    }
    Update::Ignored
}

fn decode_mesh_packet(buf: &[u8]) -> Update {
    let mut node = MeshNode::default();
    let mut payload: Option<&[u8]> = None;
    let mut portnum = 0u32;

    for (num, w) in fields(buf) {
        match num {
            1 => node.num = as_u32(&w).unwrap_or(0), // from (fixed32)
            4 => {
                // decoded: Data
                if let Some(b) = as_bytes(&w) {
                    for (n2, w2) in fields(b) {
                        match n2 {
                            1 => portnum = as_u32(&w2).unwrap_or(0),
                            2 => payload = as_bytes(&w2),
                            _ => {}
                        }
                    }
                }
            }
            7 => node.last_heard = as_u32(&w), // rx_time
            8 => node.snr = as_f32(&w),        // rx_snr
            _ => {}
        }
    }

    // An encrypted packet (field 5) has no `decoded` at all — we simply can't
    // read it, which is the channel key doing its job, not an error.
    let Some(payload) = payload else {
        return Update::Ignored;
    };
    if node.num == 0 {
        return Update::Ignored;
    }
    node.id = node_id(node.num);

    match portnum {
        PORTNUM_POSITION => {
            let p = decode_position(payload);
            if p.lat.is_none() && p.lng.is_none() {
                return Update::Ignored;
            }
            apply_position(&mut node, &p);
            // A position packet carries no fix time of its own if the sender
            // has no RTC; fall back to when we received it.
            if node.pos_time.is_none() {
                node.pos_time = node.last_heard;
            }
            Update::Node(node)
        }
        PORTNUM_NODEINFO => {
            decode_user(payload, &mut node);
            Update::Node(node)
        }
        _ => Update::Ignored,
    }
}

// --- Stream API framing -----------------------------------------------------

const START1: u8 = 0x94;
const START2: u8 = 0xc3;
/// The protocol's hard maximum. A length above it means we are not looking at
/// a real header, so the safe move is to resynchronise rather than to trust it
/// and wait forever for bytes that will never come.
const MAX_FRAME: usize = 512;

/// Pulls whole protobuf messages out of a byte stream.
///
/// The radio interleaves plain-text debug logging with framed protobufs on the
/// same connection, so anything that isn't a valid header is skipped rather
/// than treated as corruption.
#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Next complete message, or None when more bytes are needed.
    pub fn next_frame(&mut self) -> Option<Vec<u8>> {
        loop {
            // Find a plausible header.
            let start = self
                .buf
                .windows(2)
                .position(|w| w[0] == START1 && w[1] == START2)?;
            if start > 0 {
                self.buf.drain(..start); // debug chatter before the frame
            }
            if self.buf.len() < 4 {
                return None;
            }
            let len = u16::from_be_bytes([self.buf[2], self.buf[3]]) as usize;
            if len > MAX_FRAME {
                // Not really a header. Step over this 0x94 and look again,
                // otherwise a stray byte pair wedges the stream permanently.
                self.buf.drain(..1);
                continue;
            }
            if self.buf.len() < 4 + len {
                return None; // frame split across reads
            }
            let frame = self.buf[4..4 + len].to_vec();
            self.buf.drain(..4 + len);
            return Some(frame);
        }
    }
}

/// Wrap a payload in the Stream API framing.
pub fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    out.push(START1);
    out.push(START2);
    out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// ToRadio{ want_config_id } — the handshake that makes the radio talk.
pub fn want_config(id: u32) -> Vec<u8> {
    let mut out = Vec::new();
    put_varint(&mut out, (3 << 3) | 0); // field 3, varint
    put_varint(&mut out, id as u64);
    out
}

/// ToRadio{ heartbeat } — keeps the connection from being dropped.
pub fn heartbeat() -> Vec<u8> {
    let mut out = Vec::new();
    put_varint(&mut out, (7 << 3) | 2); // field 7, length-delimited
    put_varint(&mut out, 0); // empty Heartbeat message
    out
}

// --- connection -------------------------------------------------------------

/// Bumped on every connect/disconnect so an old reader thread knows to stop.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static SOCKET: Mutex<Option<Arc<TcpStream>>> = Mutex::new(None);

fn now_secs() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as u32)
        .unwrap_or(0)
}

/// Connect to a Meshtastic radio over TCP and stream teammate positions.
///
/// Emits `mesh-nodes` with the full node list on every change, and
/// `mesh-status` with human-readable connection state.
#[tauri::command]
pub async fn mesh_connect(app: AppHandle, host: String, port: u16) -> Result<(), String> {
    mesh_disconnect()?;
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let addr = format!("{}:{}", host, port);
    let stream = TcpStream::connect(&addr).map_err(|e| format!("Couldn't reach {addr}: {e}"))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(90)))
        .map_err(|e| e.to_string())?;
    let stream = Arc::new(stream);
    *SOCKET.lock().unwrap() = Some(Arc::clone(&stream));

    // Ask the radio to dump its database and then stream live packets.
    let config_id: u32 = (now_secs() as u32).rotate_left(7) | 1;
    (&*stream)
        .write_all(&frame(&want_config(config_id)))
        .map_err(|e| format!("Radio didn't accept the handshake: {e}"))?;

    let _ = app.emit("mesh-status", format!("Connected to {addr} — syncing…"));

    std::thread::spawn(move || {
        let mut reader = FrameReader::default();
        let mut nodes: HashMap<u32, MeshNode> = HashMap::new();
        let mut buf = [0u8; 4096];
        let mut last_beat = std::time::Instant::now();

        loop {
            if GENERATION.load(Ordering::SeqCst) != generation {
                return; // superseded by a newer connection
            }
            match (&*stream).read(&mut buf) {
                Ok(0) => {
                    let _ = app.emit("mesh-status", "Radio closed the connection".to_string());
                    return;
                }
                Ok(n) => reader.push(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    // Quiet mesh, not a dead one — nudge it and keep waiting.
                }
                Err(_) => {
                    if GENERATION.load(Ordering::SeqCst) == generation {
                        let _ = app.emit("mesh-status", "Lost the radio connection".to_string());
                    }
                    return;
                }
            }

            let mut changed = false;
            while let Some(msg) = reader.next_frame() {
                match decode_from_radio(&msg) {
                    Update::Node(n) => {
                        let e = nodes.entry(n.num).or_default();
                        merge(e, n);
                        changed = true;
                    }
                    Update::ConfigComplete(_) => {
                        let _ = app.emit(
                            "mesh-status",
                            format!("Connected to {addr} — {} nodes", nodes.len()),
                        );
                    }
                    Update::Ignored => {}
                }
            }
            if changed {
                let mut list: Vec<&MeshNode> = nodes.values().collect();
                list.sort_by_key(|n| n.num);
                let _ = app.emit("mesh-nodes", &list);
            }

            if last_beat.elapsed() > std::time::Duration::from_secs(60) {
                last_beat = std::time::Instant::now();
                if (&*stream).write_all(&frame(&heartbeat())).is_err() {
                    let _ = app.emit("mesh-status", "Lost the radio connection".to_string());
                    return;
                }
            }
        }
    });

    Ok(())
}

/// Later news about a node must not erase what we already knew: a position
/// packet carries no name, and a NodeInfo may carry no position.
fn merge(into: &mut MeshNode, from: MeshNode) {
    into.num = from.num;
    if !from.id.is_empty() {
        into.id = from.id;
    }
    if !from.long_name.is_empty() {
        into.long_name = from.long_name;
    }
    if !from.short_name.is_empty() {
        into.short_name = from.short_name;
    }
    if from.lat.is_some() {
        into.lat = from.lat;
        into.lng = from.lng;
        into.pos_time = from.pos_time;
        into.uncertainty_m = from.uncertainty_m;
    }
    if from.altitude.is_some() {
        into.altitude = from.altitude;
    }
    if from.battery.is_some() {
        into.battery = from.battery;
    }
    if from.snr.is_some() {
        into.snr = from.snr;
    }
    if from.hops.is_some() {
        into.hops = from.hops;
    }
    if from.last_heard.is_some() {
        into.last_heard = from.last_heard;
    }
}

#[tauri::command]
pub fn mesh_disconnect() -> Result<(), String> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(s) = SOCKET.lock().unwrap().take() {
        // Unblocks the reader thread sitting in read().
        let _ = s.shutdown(std::net::Shutdown::Both);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::mesh_fixtures as fx;
    use super::*;

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    // Every assertion below is against bytes produced by Meshtastic's own
    // protobuf library, so these test the real schema and not our reading of it.

    #[test]
    fn decodes_a_node_info_record() {
        let Update::Node(n) = decode_from_radio(&bytes(fx::FROM_RADIO_NODE_INFO)) else {
            panic!("expected a node");
        };
        assert_eq!(n.num, fx::NODE_NUM);
        assert_eq!(n.id, "!7c3f0a1b");
        assert_eq!(n.long_name, "Dad's truck");
        assert_eq!(n.short_name, "DAD");
        assert_eq!(n.battery, Some(84));
        assert_eq!(n.hops, Some(2));
        assert_eq!(n.snr, Some(6.25));
        assert_eq!(n.altitude, Some(1823));
        assert_eq!(n.last_heard, Some(fx::FIX_TIME + 5));
        // The position rides along inside NodeInfo.
        assert!((n.lat.unwrap() - fx::LAT_I as f64 * 1e-7).abs() < 1e-9);
        assert!((n.lng.unwrap() - fx::LON_I as f64 * 1e-7).abs() < 1e-9);
        assert_eq!(n.pos_time, Some(fx::FIX_TIME));
    }

    #[test]
    fn decodes_a_live_position_packet() {
        let Update::Node(n) = decode_from_radio(&bytes(fx::FROM_RADIO_POSITION)) else {
            panic!("expected a node");
        };
        assert_eq!(n.num, fx::NODE_NUM);
        assert_eq!(n.id, "!7c3f0a1b");
        assert!((n.lat.unwrap() - 45.3736).abs() < 1e-6);
        assert!((n.lng.unwrap() - -121.6960).abs() < 1e-6);
        assert_eq!(n.snr, Some(-2.5));
        // Full precision: no uncertainty circle.
        assert_eq!(n.uncertainty_m, None);
    }

    #[test]
    fn negative_longitude_survives_the_sfixed32_decoding() {
        // The western US is all negative longitude. Reading sfixed32 as an
        // unsigned varint would put every one of these in Asia.
        let Update::Node(n) = decode_from_radio(&bytes(fx::FROM_RADIO_POSITION)) else {
            panic!()
        };
        assert!(n.lng.unwrap() < 0.0, "longitude must stay negative");
    }

    #[test]
    fn a_fuzzed_position_reports_its_uncertainty() {
        let Update::Node(n) = decode_from_radio(&bytes(fx::FROM_RADIO_FUZZED)) else {
            panic!("expected a node");
        };
        // 16 bits of precision is a published ±364.8 m.
        let u = n.uncertainty_m.expect("should carry uncertainty");
        assert!((u - 364.8).abs() < 5.0, "got {u} m, expected about 364.8");
    }

    #[test]
    fn uncertainty_doubles_for_each_bit_dropped() {
        let a = uncertainty_metres(16).unwrap();
        let b = uncertainty_metres(15).unwrap();
        assert!((b / a - 2.0).abs() < 0.01);
        assert_eq!(uncertainty_metres(32), None); // exact
        assert_eq!(uncertainty_metres(0), None); // unknown, not "infinitely fuzzed"
    }

    #[test]
    fn skips_a_text_message_rather_than_misreading_it() {
        assert_eq!(decode_from_radio(&bytes(fx::FROM_RADIO_TEXT)), Update::Ignored);
    }

    #[test]
    fn recognises_the_end_of_the_initial_sync() {
        assert_eq!(
            decode_from_radio(&bytes(fx::FROM_RADIO_CONFIG_COMPLETE)),
            Update::ConfigComplete(0xdeadbeef)
        );
    }

    #[test]
    fn encodes_the_handshake_the_radio_expects() {
        // Compared against ToRadio{want_config_id} encoded by the real library.
        assert_eq!(want_config(0xdeadbeef), bytes(fx::TO_RADIO_WANT_CONFIG));
    }

    #[test]
    fn encodes_a_heartbeat() {
        assert_eq!(heartbeat(), bytes(fx::TO_RADIO_HEARTBEAT));
    }

    #[test]
    fn reads_frames_out_of_a_noisy_stream() {
        let mut r = FrameReader::default();
        r.push(&bytes(fx::STREAM_WITH_NOISE));
        let mut seen = 0;
        while let Some(f) = r.next_frame() {
            seen += 1;
            assert!(!matches!(decode_from_radio(&f), Update::Ignored) || seen == 0);
        }
        assert_eq!(seen, 3, "debug chatter must not swallow the frames");
    }

    #[test]
    fn waits_for_a_frame_split_across_reads() {
        let whole = frame(&bytes(fx::FROM_RADIO_NODE_INFO));
        let (head, tail) = whole.split_at(20);
        let mut r = FrameReader::default();
        r.push(head);
        assert_eq!(r.next_frame(), None, "must not emit a partial frame");
        r.push(tail);
        assert!(r.next_frame().is_some(), "completes once the rest arrives");
    }

    #[test]
    fn resynchronises_after_a_bogus_length() {
        // A stray 0x94 0xc3 with an impossible length must not wedge the
        // stream — a jammed reader looks exactly like a silent mesh.
        let mut r = FrameReader::default();
        r.push(&[0x94, 0xc3, 0xff, 0xff]);
        r.push(&frame(&bytes(fx::FROM_RADIO_CONFIG_COMPLETE)));
        let f = r.next_frame().expect("should recover and find the real frame");
        assert_eq!(decode_from_radio(&f), Update::ConfigComplete(0xdeadbeef));
    }

    #[test]
    fn rejects_a_frame_larger_than_the_protocol_allows() {
        let mut r = FrameReader::default();
        r.push(&[0x94, 0xc3, 0x02, 0x01]); // 513 > MAX_FRAME
        assert_eq!(r.next_frame(), None);
    }

    #[test]
    fn merging_keeps_a_name_when_a_position_packet_arrives() {
        // Position packets carry no name. Overwriting wholesale would rename
        // every teammate to their node id the moment they moved.
        let mut node = decode_node_info(&bytes(fx::FROM_RADIO_NODE_INFO)[2..]);
        node.long_name = "Dad's truck".into();
        let Update::Node(pos) = decode_from_radio(&bytes(fx::FROM_RADIO_POSITION)) else {
            panic!()
        };
        merge(&mut node, pos);
        assert_eq!(node.long_name, "Dad's truck");
        assert!(node.lat.is_some());
    }

    #[test]
    fn ignores_a_position_at_null_island() {
        // 0,0 is what the firmware sends with no fix; plotting it would put a
        // teammate in the Atlantic.
        let mut node = MeshNode::default();
        apply_position(
            &mut node,
            &Position {
                lat: Some(0.0),
                lng: Some(0.0),
                ..Default::default()
            },
        );
        assert_eq!(node.lat, None);
    }

    #[test]
    fn node_ids_are_eight_lowercase_hex_digits() {
        assert_eq!(node_id(0x7c3f0a1b), "!7c3f0a1b");
        assert_eq!(node_id(1), "!00000001");
        assert_eq!(node_id(0xffffffff), "!ffffffff");
    }

    #[test]
    fn truncated_input_returns_ignored_rather_than_panicking() {
        // A half-received message must never take the app down.
        let full = bytes(fx::FROM_RADIO_NODE_INFO);
        for cut in 1..full.len() {
            let _ = decode_from_radio(&full[..cut]);
        }
    }

    #[test]
    fn garbage_input_does_not_panic() {
        for seed in 0u8..=255 {
            let junk: Vec<u8> = (0..64).map(|i| seed.wrapping_mul(i as u8 + 7)).collect();
            let _ = decode_from_radio(&junk);
        }
    }
}
