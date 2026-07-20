#!/usr/bin/env python3
"""A fake Meshtastic radio, speaking the real Stream API over TCP.

There is no radio on this machine and no way to buy one before the code needs
writing, so this stands in for one: it listens on 4403, performs the real
handshake, and streams genuine protobuf-encoded node and position messages that
move over time. It is the only way the TCP path — connect, handshake, framing,
decode, event, map — gets exercised end to end before hardware exists.

It also logs what the client sent, which is the part worth checking: if our
want_config frame is malformed, a real radio would simply never answer, and
that failure is indistinguishable from a network problem.

    python3 tools/fake_meshtastic.py            # listens on 127.0.0.1:4403
    python3 tools/fake_meshtastic.py --port 4404

Then in the app: Team mesh → address "localhost" → Connect.

Needs the official library for encoding, so the bytes are real:
    pip install meshtastic
"""

import argparse
import math
import socket
import sys
import threading
import time

try:
    from meshtastic.protobuf import mesh_pb2, portnums_pb2, telemetry_pb2
except ImportError:
    sys.exit("pip install meshtastic first")

START = b"\x94\xc3"

# Around Mt Hood, so it lands on the map packs actually installed here.
BASE_LAT, BASE_LON = 45.3736, -121.6960

NODES = [
    # (num, long name, short name, dlat, dlon, battery, hops, moving, precision)
    (0x7C3F0A1B, "Dad's truck", "DAD", 0.030, 0.020, 84, 0, False, 32),
    (0x51BA22C9, "Camp", "CAMP", -0.045, 0.012, 101, 0, False, 32),
    (0x2F9D4471, "Scout", "SCT", 0.010, -0.040, 37, 1, True, 32),
    (0x9A10EE02, "Ridge relay", "RDG", -0.020, -0.030, 62, 2, False, 16),
]


def frame(payload: bytes) -> bytes:
    return START + len(payload).to_bytes(2, "big") + payload


def position_for(node, tick):
    num, long_name, short_name, dlat, dlon, batt, hops, moving, precision = node
    p = mesh_pb2.Position()
    # The scout walks a slow circle; everyone else stays put.
    wobble = 0.004 * math.sin(tick / 6) if moving else 0.0
    p.latitude_i = int(round((BASE_LAT + dlat + wobble) * 1e7))
    p.longitude_i = int(round((BASE_LON + dlon + wobble * 0.7) * 1e7))
    p.altitude = 900 + (num % 700)
    p.time = int(time.time())
    p.precision_bits = precision
    p.sats_in_view = 9
    return p


def node_info_msg(node, tick):
    num, long_name, short_name, dlat, dlon, batt, hops, moving, precision = node
    f = mesh_pb2.FromRadio()
    n = f.node_info
    n.num = num
    n.user.id = f"!{num:08x}"
    n.user.long_name = long_name
    n.user.short_name = short_name
    n.position.CopyFrom(position_for(node, tick))
    n.snr = 6.25 - hops * 3
    n.last_heard = int(time.time())
    n.hops_away = hops
    m = telemetry_pb2.DeviceMetrics()
    m.battery_level = batt
    n.device_metrics.CopyFrom(m)
    return f.SerializeToString()


def position_packet(node, tick):
    num = node[0]
    f = mesh_pb2.FromRadio()
    pkt = f.packet
    pkt.__setattr__("from", num)
    pkt.to = 0xFFFFFFFF
    pkt.id = (int(time.time()) + num) & 0xFFFFFFFF
    pkt.rx_time = int(time.time())
    pkt.rx_snr = 6.25 - node[6] * 3
    pkt.hop_limit = 3
    pkt.decoded.portnum = portnums_pb2.PortNum.POSITION_APP
    pkt.decoded.payload = position_for(node, tick).SerializeToString()
    return f.SerializeToString()


def config_complete(want_id):
    f = mesh_pb2.FromRadio()
    f.config_complete_id = want_id
    return f.SerializeToString()


def read_want_config(conn) -> int:
    """Read the client's handshake and report exactly what it sent.

    Scans for the frame header rather than demanding it at byte zero, because
    that is what a real radio does: the official client opens with a run of
    0xC3 wake bytes to rouse a sleeping serial port, and anything stricter
    rejects the reference implementation itself. (Observed, not assumed — the
    first version of this script refused `meshtastic --info` for exactly that.)
    """
    buf = b""
    conn.settimeout(10)
    while True:
        start = buf.find(START)
        if start >= 0 and len(buf) >= start + 4:
            break
        chunk = conn.recv(1024)
        if not chunk:
            raise ConnectionError("client hung up before the handshake")
        buf += chunk
    if start > 0:
        print(f"  (skipped {start} B of wake/debug bytes: {buf[:start][:8].hex()}…)")
    buf = buf[start:]
    length = int.from_bytes(buf[2:4], "big")
    while len(buf) < 4 + length:
        buf += conn.recv(1024)
    payload = buf[4 : 4 + length]
    t = mesh_pb2.ToRadio()
    t.ParseFromString(payload)  # raises if our client encoded it wrongly
    which = t.WhichOneof("payload_variant")
    print(f"  client sent {len(payload)} B: {payload.hex()}  →  {which}={getattr(t, which, None)}")
    if which != "want_config_id":
        raise ValueError(f"expected want_config_id, got {which}")
    return t.want_config_id


def serve(conn, addr):
    print(f"[+] client connected from {addr}")
    try:
        want_id = read_want_config(conn)
        print(f"  handshake OK (want_config_id=0x{want_id:08x}) — sending node database")

        # The real sequence: every known node, then config_complete_id.
        for node in NODES:
            conn.sendall(frame(node_info_msg(node, 0)))
            time.sleep(0.05)
        conn.sendall(frame(config_complete(want_id)))
        print(f"  sent {len(NODES)} nodes + config_complete")

        # Then live position packets, as a real mesh would trickle them in.
        tick = 0
        while True:
            time.sleep(5)
            tick += 1
            # The ridge relay goes quiet after a while, so its fix visibly ages.
            for node in NODES:
                if node[2] == "RDG" and tick > 4:
                    continue
                conn.sendall(frame(position_packet(node, tick)))
            print(f"  tick {tick}: sent positions")
    except (ConnectionError, BrokenPipeError, OSError) as e:
        print(f"[-] client gone: {e}")
    except Exception as e:  # noqa: BLE001 — this is a dev tool; say what broke
        print(f"[!] {type(e).__name__}: {e}")
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=4403)
    args = ap.parse_args()

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(4)
    print(f"fake Meshtastic radio listening on {args.host}:{args.port}")
    print(f"connect the app to: {args.host}")
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=serve, args=(conn, addr), daemon=True).start()


if __name__ == "__main__":
    main()
