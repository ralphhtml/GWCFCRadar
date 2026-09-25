#!/usr/bin/env python3
"""Vaisala IRIS (Sigmet) RAW volumes, turned into Archive II for the map.

Two of the MRRL radars (CABO, Los Cabos, and SABA, Sabancuy, both Mexico)
publish IRIS RAW ingest files rather than the Archive II every other site
sends. The browser's radar decoder only reads Archive II, so the parsing
server converts: every sweep, every ray, every moment it has an Archive II
name for, written as Message 31 radials exactly the way a NEXRAD would send
them. Everything built on the decoder (the products, the loop, the Inspector,
cross sections, 3D) then works on these radars unchanged.

The IRIS layout, from the IRIS Programmer's Manual:
  * the file is 6144-byte records;
  * record 0 is the product_hdr, record 1 the ingest_header (site position,
    task configuration: range bins, wavelength, PRF);
  * every later record starts with a 12-byte raw_prod_bhdr; the first record
    of a sweep then carries one 76-byte ingest_data_header per data type;
  * after that the rays, compressed as 16-bit words: a word with the top bit
    set is followed by that many literal words, 1 ends the ray, any other
    value stands for that many zero words. Each ray is a 6-word header
    (azimuth and elevation at start and end, bin count, time offset) then
    the bins; one ray per data type, in data type order.

Checked against xradar's reader on a real CABO volume (tools/test-mrrl-iris.py).

    python mrrl_iris.py IN.RAW OUT.ar2v CODE
"""

import bz2
import struct
import sys

import numpy as np

REC = 6144
RECORD_MAX = 850_000      # bytes of messages per Archive II record

# IRIS data type -> (Archive II moment name, bytes per bin, decode)
# decode(n) turns the stored integers into physical values; 0 is no data.
def _d2(n):            # 2-byte: (N - 32768) / 100
    return (n.astype(np.float64) - 32768.0) / 100.0


def _w2(n):            # 2-byte width: N / 100
    return n.astype(np.float64) / 100.0


def _phi2(n):          # 2-byte PHIDP: 360 * (N - 1) / 65534
    return 360.0 * (n.astype(np.float64) - 1.0) / 65534.0


def _rho2(n):          # 2-byte RHOHV: (N - 1) / 65533
    return (n.astype(np.float64) - 1.0) / 65533.0


def _d1(n):            # 1-byte dBZ: (N - 64) / 2
    return (n.astype(np.float64) - 64.0) / 2.0


def _zdr1(n):          # 1-byte ZDR: (N - 128) / 16
    return (n.astype(np.float64) - 128.0) / 16.0


def _rho1(n):          # 1-byte RHOHV: sqrt((N - 1) / 253)
    return np.sqrt(np.clip((n.astype(np.float64) - 1.0) / 253.0, 0, None))


def _phi1(n):          # 1-byte PHIDP: 180 * (N - 1) / 254
    return 180.0 * (n.astype(np.float64) - 1.0) / 254.0


def _vel1(n, h):        # 1-byte velocity: (N - 128) / 127 * Nyquist
    return (n.astype(np.float64) - 128.0) / 127.0 * h["nyquist"]


def _sw1(n, h):         # 1-byte width: N / 256 * Nyquist (single PRF)
    return n.astype(np.float64) / 256.0 * h["nyquist_single"]


# The ones that need the radar's own Nyquist velocity take the header too.
NEEDS_HDR = {3, 4}

IRIS_TYPES = {
    3:  ("VEL", 1, _vel1),   # DB_VEL
    4:  ("SW", 1, _sw1),     # DB_WIDTH
    2:  ("REF", 1, _d1),     # DB_DBZ
    1:  ("REF_T", 1, _d1),   # DB_DBT (used only when there is no DBZ)
    9:  ("REF", 2, _d2),     # DB_DBZ2
    8:  ("REF_T", 2, _d2),   # DB_DBT2
    10: ("VEL", 2, _d2),     # DB_VEL2 (m/s)
    11: ("SW", 2, _w2),      # DB_WIDTH2 (m/s)
    5:  ("ZDR", 1, _zdr1),   # DB_ZDR
    12: ("ZDR", 2, _d2),     # DB_ZDR2
    16: ("PHI", 1, _phi1),   # DB_PHIDP
    24: ("PHI", 2, _phi2),   # DB_PHIDP2
    19: ("RHO", 1, _rho1),   # DB_RHOHV
    20: ("RHO", 2, _rho2),   # DB_RHOHV2
}

# How each moment is packed into Archive II, the way a NEXRAD packs it:
# (block name, word size, scale, offset, clip range). N = value*scale+offset,
# and 0 / 1 are left for "below threshold" / "range folded".
AR2_PACK = {
    "REF": (b"DREF", 8, 2.0, 66.0),
    "VEL": (b"DVEL", 8, 2.0, 129.0),
    "SW":  (b"DSW ", 8, 2.0, 129.0),
    "ZDR": (b"DZDR", 8, 16.0, 128.0),
    "PHI": (b"DPHI", 16, 2.8361, 2.0),
    "RHO": (b"DRHO", 8, 300.0, -60.5),
}


def _bin_angle(v, bits):
    return 360.0 * float(v) / float(2 ** bits)


def is_iris(raw):
    """A RAW product: product_hdr (structure id 27) opens record 0 and the
    ingest_header (structure id 23) opens record 1."""
    if len(raw) < 2 * REC:
        return False
    a = struct.unpack_from("<h", raw, 0)[0]
    b = struct.unpack_from("<h", raw, REC)[0]
    return a == 27 and b == 23


def header(raw):
    """Where the radar is, and the range and velocity set-up."""
    ic = REC + 12                       # ingest_configuration
    lat = _bin_angle(struct.unpack_from("<I", raw, ic + 168)[0], 32)
    lon = _bin_angle(struct.unpack_from("<I", raw, ic + 172)[0], 32)
    if lat > 180:
        lat -= 360
    if lon > 180:
        lon -= 360
    h_site, h_radar = struct.unpack_from("<hh", raw, ic + 176)
    tc = REC + 12 + 480                 # task_configuration
    rng = tc + 12 + 120 + 320 + 320     # task_range_info
    first_cm, last_cm = struct.unpack_from("<ii", raw, rng)
    step_out_cm = struct.unpack_from("<i", raw, rng + 16)[0]
    dsp = tc + 12 + 120                 # task_dsp_info
    prf = struct.unpack_from("<i", raw, dsp + 136)[0]
    multi = struct.unpack_from("<H", raw, dsp + 144)[0]
    misc = rng + 160 + 320              # task_misc_info
    wavelength = struct.unpack_from("<i", raw, misc)[0]      # 1/100 cm
    single = wavelength * prf / (10000.0 * 4.0) if prf > 0 else 0.0
    nyq = single * (multi + 1)
    return {
        "lat": round(lat, 5), "lon": round(lon, 5),
        "height_m": int(h_site) + int(h_radar),
        "first_m": first_cm / 100.0, "step_m": step_out_cm / 100.0,
        "nyquist": nyq, "nyquist_single": single,
    }


def _ymds(raw, off):
    secs, ms, y, mo, d = struct.unpack_from("<iHhhh", raw, off)
    import calendar
    return (calendar.timegm((y, mo, d, 0, 0, 0, 0, 0, 0)) + secs) * 1000 + ms


def read(raw):
    """Every sweep: its angle, start time and rays, each ray's moments as
    physical values (NaN where there is no data)."""
    hdr = header(raw)
    nrec = len(raw) // REC
    # The data words of each sweep, with the record headers taken out.
    sweeps = []
    cur = None
    for r in range(2, nrec):
        base = r * REC
        rec_no, sweep_no, first_off, ray_no, flags = struct.unpack_from("<hhhhH", raw, base)
        if sweep_no <= 0:
            continue
        if cur is None or sweep_no != cur["n"]:
            # A new sweep: its ingest_data_headers follow the record header,
            # one per data type, each opening with structure id 24.
            p = base + 12
            types, angle, start = [], None, None
            while p + 76 <= base + REC and struct.unpack_from("<h", raw, p)[0] == 24:
                start = _ymds(raw, p + 12)
                nrays_exp = struct.unpack_from("<h", raw, p + 30)[0]
                angle = _bin_angle(struct.unpack_from("<H", raw, p + 34)[0], 16)
                dtype = struct.unpack_from("<H", raw, p + 38)[0]
                types.append(dtype)
                p += 76
            cur = {"n": sweep_no, "types": types, "angle": angle, "start": start,
                   "nrays": nrays_exp, "chunks": [raw[p:base + REC]]}
            sweeps.append(cur)
        else:
            cur["chunks"].append(raw[base + 12:base + REC])
    out = []
    for sw in sweeps:
        words = np.frombuffer(b"".join(sw["chunks"]), dtype="<u2")
        types = [t for t in sw["types"] if t != 0]      # 0: extended header
        has_x = 0 in sw["types"]
        pos = 0
        rays = []
        n = len(words)
        for _ in range(sw["nrays"]):
            ray = {}
            for t in ([0] if has_x else []) + types:
                buf = []
                got = 0
                while pos < n:
                    c = int(words[pos]); pos += 1
                    if c & 0x8000:
                        k = c & 0x7FFF
                        buf.append(words[pos:pos + k]); pos += k; got += k
                    elif c == 1:
                        break
                    else:
                        buf.append(np.zeros(c, dtype="<u2")); got += c
                if not got or t == 0:
                    continue
                w = np.concatenate(buf)
                if len(w) < 6:
                    continue
                az0, el0, az1, el1, nb, dt = (int(x) for x in w[:6])
                spec = IRIS_TYPES.get(t)
                if not spec or nb <= 0:
                    ray.setdefault("_hdr", (az0, el0, az1, el1, nb, dt))
                    continue
                name, width, dec = spec
                body = w[6:].tobytes()
                vals = np.frombuffer(body, dtype="<u2" if width == 2 else "u1")[:nb]
                phys = dec(vals, hdr) if t in NEEDS_HDR else dec(vals)
                phys[vals == 0] = np.nan
                ray["_hdr"] = (az0, el0, az1, el1, nb, dt)
                ray[name] = phys
            if "_hdr" in ray:
                rays.append(ray)
        if rays:
            out.append({"angle": sw["angle"], "start": sw["start"], "rays": rays})
    return hdr, out


def _ar2_moment(name, vals, first_m, step_m):
    block, bits, scale, offset = AR2_PACK[name]
    n = np.where(np.isnan(vals), 0, np.round(vals * scale + offset))
    lo, hi = 2, (2 ** bits) - 1
    n = np.where(np.isnan(vals), 0, np.clip(n, lo, hi)).astype(">u2" if bits == 16 else "u1")
    data = n.tobytes()
    head = (block + b"\x00" * 4 + struct.pack(">Hhhhh", len(vals), int(round(first_m)),
                                              int(round(step_m)), 0, 0)
            + struct.pack(">BB", 0, bits) + struct.pack(">ff", scale, offset))
    blk = head + data
    return blk + (b"\x00" if len(blk) % 2 else b"")


def to_ar2v(raw, code, bz=True):
    """The IRIS volume as Archive II bytes."""
    hdr, sweeps = read(raw)
    if not sweeps:
        raise ValueError("no sweeps in the IRIS volume")
    code = (code + "____")[:4]
    t0 = sweeps[0]["start"]
    jul0, ms0 = int(t0 // 86400000) + 1, int(t0 % 86400000)
    # Bins are given from the first bin's start; Archive II names the centre.
    first_m = hdr["first_m"] + hdr["step_m"] / 2.0
    step_m = hdr["step_m"] or 250.0
    records = []
    for e_i, sw in enumerate(sweeps, start=1):
        msgs = []
        nr = len(sw["rays"])
        for r_i, ray in enumerate(sw["rays"]):
            az0, el0, az1, el1, nb, dt = ray["_hdr"]
            a0, a1 = _bin_angle(az0, 16), _bin_angle(az1, 16)
            if a1 < a0:
                a1 += 360
            az = ((a0 + a1) / 2.0) % 360
            el = _bin_angle(el0, 16)
            if el > 180:
                el -= 360
            t = sw["start"] + dt * 1000
            jul, ms = int(t // 86400000) + 1, int(t % 86400000)
            names = [k for k in ("REF", "VEL", "SW", "ZDR", "PHI", "RHO") if k in ray]
            if "REF" not in ray and "REF_T" in ray:
                ray["REF"] = ray["REF_T"]; names.insert(0, "REF")
            vol = (b"RVOL" + struct.pack(">HBB", 44, 1, 0) + struct.pack(">ff", hdr["lat"], hdr["lon"])
                   + struct.pack(">hH", hdr["height_m"], 20) + struct.pack(">fffff", 0, 0, 0, 0, 0)
                   + struct.pack(">HH", 212, 0))
            vol = vol + b"\x00" * (44 - len(vol))
            elv = b"RELV" + struct.pack(">Hhf", 12, 0, 0)
            rad = b"RRAD" + struct.pack(">Hhffhhff", 28, int(first_m + nb * step_m) // 100, 0, 0,
                                        int(round(hdr["nyquist"] * 100)), 0, 0, 0)
            blocks = [vol, elv, rad] + [_ar2_moment(k, ray[k], first_m, step_m) for k in names]
            ptrs, off = [], 32 + 9 * 4
            for b in blocks:
                ptrs.append(off)
                off += len(b)
            status = 0 if r_i == 0 else (2 if r_i == nr - 1 else 1)
            if e_i == 1 and r_i == 0:
                status = 3
            if e_i == len(sweeps) and r_i == nr - 1:
                status = 4
            head = (code.encode()[:4] + struct.pack(">IHH", ms, jul, r_i + 1)
                    + struct.pack(">f", az) + struct.pack(">BBHBBBB", 0, 0, nb, 1, status, e_i, 1)
                    + struct.pack(">f", el) + struct.pack(">BBH", 0, 0, len(blocks))
                    + b"".join(struct.pack(">I", p) for p in ptrs) + b"\x00" * (4 * (9 - len(ptrs))))
            body = head + b"".join(blocks)
            size_hw = (16 + len(body)) // 2
            mh = struct.pack(">HBBHHIHH", size_hw, 0, 31, 0, jul, ms, 1, 1)
            msgs.append(b"\x00" * 12 + mh + body)
        # Records small enough to be ONE bzip2 block each (under 900 KB
        # before compression), as a real radar writes them: the browser's
        # decoder unpacks one block per record, and a sweep in a single
        # record came back as its first 900 KB and nothing after.
        cur, size = [], 0
        for m in msgs:
            if cur and size + len(m) > RECORD_MAX:
                records.append(b"".join(cur)); cur, size = [], 0
            cur.append(m); size += len(m)
        if cur:
            records.append(b"".join(cur))
    out = [b"AR2V0006.001" + struct.pack(">II", jul0, ms0) + code.encode()[:4]]
    for rec in records:
        if bz:
            c = bz2.compress(rec)
            out.append(struct.pack(">i", len(c)) + c)
        else:
            out.append(rec)
    return b"".join(out)


def location(raw):
    """(lat, lon, height_m) from the ingest header, or None."""
    if not is_iris(raw):
        return None
    h = header(raw)
    if abs(h["lat"]) < 0.01 and abs(h["lon"]) < 0.01:
        return None
    return h["lat"], h["lon"], h["height_m"]


if __name__ == "__main__":
    src, dst, code = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(src, "rb") as f:
        data = f.read()
    with open(dst, "wb") as f:
        f.write(to_ar2v(data, code))
