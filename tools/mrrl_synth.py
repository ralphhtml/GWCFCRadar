#!/usr/bin/env python3
"""A small, real-format Archive II volume for the MRRL tests.

One 0.5 degree sweep of 360 Message 31 radials with the volume, elevation,
radial and reflectivity blocks a real radar sends, a ring of 35 dBZ between
30 and 60 km, named like an MRRL radar (BOO_, SP41, 1852...). Either
uncompressed, or with the messages in bzip2 records the way most radars
send them. Built here so the tests need neither the network nor anyone
else's radar data checked in.

    python tools/mrrl_synth.py OUT CODE LAT LON [bz]
"""

import bz2
import struct
import sys

JULIAN = 20720          # 2026-09-24, days since 1969-12-31
MSEC = 15 * 3600 * 1000


def _msg(mtype, body):
    if len(body) % 2:
        body += b"\x00"
    size_hw = (16 + len(body)) // 2
    head = struct.pack(">HBBHHIHH", size_hw, 0, mtype, 0, JULIAN, MSEC, 1, 1)
    return b"\x00" * 12 + head + body


def _radial(code, az_i, lat, lon, gates=400):
    vol = (b"RVOL" + struct.pack(">HBB", 44, 1, 0) + struct.pack(">ff", lat, lon)
           + struct.pack(">hH", 100, 20) + struct.pack(">fffff", 0, 0, 0, 0, 0)
           + struct.pack(">HH", 212, 0))
    vol = vol + b"\x00" * (44 - len(vol))
    elv = b"RELV" + struct.pack(">Hhf", 12, 0, 0)
    rad = b"RRAD" + struct.pack(">Hhffhhff", 28, 4600, 0, 0, 2700, 0, 0, 0)
    data = bytearray()
    for g in range(gates):
        km = 2.125 + g * 0.25
        dbz = 35 if 30 <= km <= 60 else None
        data.append(0 if dbz is None else int(dbz * 2 + 66))
    ref = (b"DREF" + b"\x00" * 4 + struct.pack(">Hhhhh", gates, 2125, 250, 0, 0)
           + struct.pack(">BB", 0, 8) + struct.pack(">ff", 2.0, 66.0) + bytes(data))
    blocks = [vol, elv, rad, ref]
    head_len = 32 + 9 * 4
    ptrs, off = [], head_len
    for b in blocks:
        ptrs.append(off)
        off += len(b)
    status = 3 if az_i == 0 else (4 if az_i == 359 else 1)
    head = (code.encode()[:4] + struct.pack(">IHH", MSEC + az_i * 30, JULIAN, az_i + 1)
            + struct.pack(">f", az_i + 0.5) + struct.pack(">BBHBBBB", 0, 0, 2 * gates, 1, status, 1, 1)
            + struct.pack(">f", 0.5) + struct.pack(">BBH", 0, 0, len(blocks))
            + b"".join(struct.pack(">I", p) for p in ptrs) + b"\x00" * (4 * (9 - len(ptrs))))
    return _msg(31, head + b"".join(blocks))


def volume(code, lat, lon, bz=False):
    header = b"AR2V0006.001" + struct.pack(">II", JULIAN, MSEC) + code.encode()[:4]
    msgs = b"".join(_radial(code, i, lat, lon) for i in range(360))
    if not bz:
        return header + msgs
    rec = bz2.compress(msgs)
    return header + struct.pack(">i", -len(rec)) + rec


if __name__ == "__main__":
    out, code, lat, lon = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
    with open(out, "wb") as f:
        f.write(volume(code, lat, lon, bz=len(sys.argv) > 5 and sys.argv[5] == "bz"))
