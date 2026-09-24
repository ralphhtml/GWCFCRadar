#!/usr/bin/env python3
"""
Every member of the ensembles, field by field, for the site's Ensemble tools.

    python3 pi/ens_fields_pipeline.py                    # every ensemble, newest runs
    python3 pi/ens_fields_pipeline.py --model gefs       # just one
    python3 pi/ens_fields_pipeline.py --check            # what is published, no work
    python3 pi/ens_fields_pipeline.py --list             # what is built

The Ensemble Models tools on the site (the member picker and stepping, the
postage stamps, mean, median and spread, chance of exceeding a threshold,
joint probabilities with AND and OR, and the NBM-style meteogram) all need
the same thing: every member's value of a field at every point, not a
picture of the mean. This builds that, for the lower 48 and around it, on a
half degree grid:

    t2m     2 m temperature              F
    td2m    2 m dew point                F
    wind10  10 m wind speed              mph
    gust    surface wind gust            mph
    mslp    sea level pressure           hPa
    h500    500 mb height                dam
    t850    850 mb temperature           C
    qpf     precipitation since the run  in   (running total)
    cape    CAPE                         J/kg
    ptype   precipitation type           0 none, 1 rain, 2 snow, 3 freezing rain, 4 sleet

The browser does the statistics. Sending members rather than a finished mean
is what lets any threshold, any AND/OR combination and any member be asked
for without the parsing server building a picture of each in advance.

Where each ensemble comes from, and what it costs a run:

  gefs      NOAA GEFS, 31 members, NOMADS filter cut to the box. About 200 MB.
  geps      Canadian GEPS (CMCE on NOMADS, half of NAEFS), 21 members. About 130 MB.
  sref      NCEP SREF, 26 members (ARW and NMMB cores), 40 km, to 84 h. About 90 MB.
  ecmwfens  ECMWF ENS, 51 members, from the open data by byte range. The
            open data has no way to ask for a box, so every record is the
            whole globe: this is by far the heaviest, so it takes fewer
            fields (2 m temperature, wind, pressure, 500 mb, rain, type),
            12-hourly, once a day (00z). About 5 GB a run, measured: 4.8 MB
            per member per hour. Leave it out of GWCFC_ENS_MODELS on a
            metered connection.

HREF is not here on purpose: NOMADS publishes its mean, spread and
probabilities (already in Ensemble Charts), not its members.

Output, under ~/wxdata/ens/:

    index.json                       every model's newest run and what it holds
    {model}/{run}/manifest.json      the grid, the members, the fields and their scaling
    {model}/{run}/{field}_f{hhh}.bin.gz
        gzip of little-endian uint16, members x rows x columns, rows from the
        south, 65535 where a member has nothing. value = code * scale + offset.

Set GWCFC_ENS_MODELS (e.g. "gefs,geps") to choose which ensembles the timer builds.
"""

import argparse
import datetime as dt
import gzip
import json
import os
import shutil
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import numpy as np
except ImportError:                                   # pragma: no cover
    np = None
try:
    import eccodes
except ImportError:                                   # pragma: no cover
    eccodes = None

OUT_DIR = os.path.join(os.environ.get("GWCFC_DATA", os.path.expanduser("~/wxdata")), "ens")
KEEP_RUNS = 1                      # finished runs kept per model, besides the one building

# The box: the lower 48 with room around it for systems coming in.
GRID = {"s": 20.0, "n": 55.0, "w": -130.0, "e": -60.0, "d": 0.5}
MISSING = 65535

# Stored scale and offset: value = code * scale + offset.
FIELDS = {
    "t2m":    {"label": "2 m temperature", "unit": "F",    "scale": 0.05, "offset": -100.0},
    "td2m":   {"label": "2 m dew point",   "unit": "F",    "scale": 0.05, "offset": -100.0},
    "wind10": {"label": "10 m wind",       "unit": "mph",  "scale": 0.02, "offset": 0.0},
    "gust":   {"label": "Wind gust",       "unit": "mph",  "scale": 0.02, "offset": 0.0},
    "mslp":   {"label": "Sea level pressure", "unit": "hPa", "scale": 0.02, "offset": 900.0},
    "h500":   {"label": "500 mb height",   "unit": "dam",  "scale": 0.02, "offset": 450.0},
    "t850":   {"label": "850 mb temperature", "unit": "C", "scale": 0.02, "offset": -60.0},
    "qpf":    {"label": "Total precipitation", "unit": "in", "scale": 0.001, "offset": 0.0},
    "cape":   {"label": "CAPE",            "unit": "J/kg", "scale": 1.0,  "offset": 0.0},
    "ptype":  {"label": "Precipitation type", "unit": "",  "scale": 1.0,  "offset": 0.0},
}

# The records wanted from a NOAA file, as its index names them. The filter
# service refuses the whole request if asked for a variable or level the file
# does not carry, so each hour's index is read first and only what is there
# is asked for.
NOAA_WANT = [("TMP", "2 m above ground"), ("DPT", "2 m above ground"), ("RH", "2 m above ground"),
             ("UGRD", "10 m above ground"), ("VGRD", "10 m above ground"), ("GUST", "surface"),
             ("PRMSL", "mean sea level"), ("HGT", "500 mb"), ("TMP", "850 mb"), ("APCP", "surface"),
             ("CAPE", "surface"), ("CAPE", "180-0 mb above ground"), ("CRAIN", "surface"),
             ("CSNOW", "surface"), ("CFRZR", "surface"), ("CICEP", "surface")]

ENSEMBLES = {
    "gefs": {
        "label": "GEFS", "kind": "noaa", "cycle_h": 6, "lag_h": 6,
        "filter": "filter_gefs_atmos_0p50a.pl",
        "dir": "/gefs.{date}/{cyc}/atmos/pgrb2ap5",
        "file": "{mem}.t{cyc}z.pgrb2a.0p50.f{fhr:03d}",
        "raw": "gens/prod/gefs.{date}/{cyc}/atmos/pgrb2ap5/",
        "members": ["gec00"] + [f"gep{n:02d}" for n in range(1, 31)],
        "steps": list(range(6, 241, 6)),
    },
    "geps": {
        "label": "GEPS (Canadian)", "kind": "noaa", "cycle_h": 12, "lag_h": 8,
        "filter": "filter_cmcens.pl",
        "dir": "/cmce.{date}/{cyc}/pgrb2ap5",
        "file": "cmc_{mem}.t{cyc}z.pgrb2a.0p50.f{fhr:03d}",
        "raw": "naefs/prod/cmce.{date}/{cyc}/pgrb2ap5/",
        "members": ["gec00"] + [f"gep{n:02d}" for n in range(1, 21)],
        "steps": list(range(6, 241, 6)),
    },
    "sref": {
        # SREF runs at 03, 09, 15 and 21z. Its files are on the 40 km
        # Lambert grid 212, read by nearest point.
        "label": "SREF", "kind": "noaa", "cycle_h": 6, "cycle_offset": 3, "lag_h": 5,
        "filter": "filter_sref.pl",
        "dir": "/sref.{date}/{cyc}/pgrb",
        "file": "sref_{mem}.t{cyc}z.pgrb212.{m2}.f{fhr:02d}.grib2",
        "raw": "sref/prod/sref.{date}/{cyc}/pgrb/",
        "members": [f"{core}.{m}" for core in ("arw", "nmb")
                    for m in ["ctl"] + [f"n{i}" for i in range(1, 7)] + [f"p{i}" for i in range(1, 7)]],
        "steps": list(range(3, 85, 3)),
    },
    "ecmwfens": {
        "label": "ECMWF ENS", "kind": "ecmwf", "cycle_h": 24, "lag_h": 9,
        "members": list(range(0, 51)),
        "steps": list(range(12, 241, 12)),
        # ECMWF names, the level where it matters.
        "params": {"2t": None, "msl": None, "tp": None, "gh": "500", "ptype": None, "10u": None, "10v": None},
    },
}
ECMWF_BASES = ["https://data.ecmwf.int/forecasts",
               "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"]


def log(msg):
    print(f"[{dt.datetime.now(dt.timezone.utc):%H:%M:%S}] {msg}", flush=True)


def _pipeline():
    import gfs_pipeline
    return gfs_pipeline


def target():
    g = GRID
    ny = int(round((g["n"] - g["s"]) / g["d"])) + 1
    nx = int(round((g["e"] - g["w"]) / g["d"])) + 1
    lats = np.array([g["s"] + j * g["d"] for j in range(ny)])
    lons = np.array([g["w"] + i * g["d"] for i in range(nx)])
    return lats, lons


def newest_cycle(ens, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    t = now - dt.timedelta(hours=ens["lag_h"])
    off = ens.get("cycle_offset", 0)
    hour = t.hour - off
    if hour < 0:
        t -= dt.timedelta(days=1)
        hour += 24
    cyc = (hour // ens["cycle_h"]) * ens["cycle_h"] + off
    return t.strftime("%Y%m%d"), f"{cyc:02d}"


# -- Regridding, vectorised -------------------------------------------------------
def regrid_regular(vals, lat1, lat2, lon1, lon2, tlats, tlons, nearest=False):
    """A regular latitude/longitude field onto the target grid.

    Bilinear for continuous fields, nearest for categories (precipitation
    type), so a rain/snow boundary is not averaged into sleet. Longitudes are
    compared modulo 360, and a global grid wraps.
    """
    nj, ni = vals.shape
    if lon2 < lon1:
        lon2 += 360.0
    dlon = (lon2 - lon1) / max(1, ni - 1)
    dlat = (lat2 - lat1) / max(1, nj - 1)
    wraps = abs(dlon * ni - 360.0) < dlon * 1.5
    TL, TN = np.meshgrid(tlats, tlons, indexing="ij")
    fj = (TL - lat1) / dlat
    fi = ((TN - lon1) % 360.0) / dlon
    if not wraps:
        fi = np.where(fi > ni - 0.5, fi - 360.0 / dlon, fi)
    out_ok = (fj >= -0.5) & (fj <= nj - 0.5)
    if not wraps:
        out_ok &= (fi >= -0.5) & (fi <= ni - 0.5)
    fj = np.clip(fj, 0, nj - 1)
    if not wraps:
        fi = np.clip(fi, 0, ni - 1)
    if nearest:
        j = np.clip(np.rint(fj).astype(int), 0, nj - 1)
        i = np.rint(fi).astype(int) % ni if wraps else np.clip(np.rint(fi).astype(int), 0, ni - 1)
        res = vals[j, i]
    else:
        j0 = np.clip(np.floor(fj).astype(int), 0, max(0, nj - 2))
        i0f = np.floor(fi).astype(int)
        tj = fj - j0
        ti = fi - i0f
        if wraps:
            i0 = i0f % ni
            i1 = (i0 + 1) % ni
        else:
            i0 = np.clip(i0f, 0, ni - 1)
            i1 = np.clip(i0 + 1, 0, ni - 1)
        j1 = np.clip(j0 + 1, 0, nj - 1)
        res = ((vals[j0, i0] * (1 - ti) + vals[j0, i1] * ti) * (1 - tj)
               + (vals[j1, i0] * (1 - ti) + vals[j1, i1] * ti) * tj)
    return np.where(out_ok, res, np.nan)


_near_cache = {}


def regrid_any(gid, vals, tlats, tlons, nearest=False):
    grid = str(eccodes.codes_get(gid, "gridType"))
    ni = int(eccodes.codes_get(gid, "Ni") or 0)
    nj = int(eccodes.codes_get(gid, "Nj") or 0)
    if grid == "regular_ll" and ni > 0 and nj > 0:
        return regrid_regular(
            vals.reshape(nj, ni),
            float(eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")),
            float(eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees")),
            float(eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")),
            float(eccodes.codes_get(gid, "longitudeOfLastGridPointInDegrees")),
            tlats, tlons, nearest)
    # Lambert (SREF): the nearest model point, worked out once per grid.
    key = (grid, len(vals))
    if key not in _near_cache:
        import model_volume
        _near_cache[key] = model_volume.nearest_index(
            eccodes.codes_get_array(gid, "latitudes"), eccodes.codes_get_array(gid, "longitudes"),
            list(tlats), list(tlons))
    idx, ok = _near_cache[key]
    return np.where(ok, vals[idx], np.nan)


# -- Reading one member's records -----------------------------------------------------
PTYPE_ECMWF = {1: 1, 3: 3, 5: 2, 6: 2, 7: 1, 8: 4, 12: 3}


def decode(path_or_msgs, tlats, tlons):
    """{name: 2-D array on the target grid} out of one member at one hour,
    in the units the site reads, plus 'tp_mm' and 'tp_start' for the rain."""
    raw, meta = {}, {}

    def one(gid):
        short = _short(gid)
        tol = str(eccodes.codes_get(gid, "typeOfLevel"))
        try:
            lev = int(round(float(eccodes.codes_get(gid, "level"))))
        except Exception:
            lev = 0
        name = None
        if short in ("2t",) or (short == "t" and tol == "heightAboveGround" and lev == 2):
            name = "t2m"
        elif short in ("2d",) or (short in ("dpt", "2d") and tol == "heightAboveGround"):
            name = "td2m"
        elif short in ("2r",) or (short == "r" and tol == "heightAboveGround" and lev == 2):
            name = "rh2m"
        elif short in ("10u",) or (short == "u" and tol == "heightAboveGround" and lev == 10):
            name = "u10"
        elif short in ("10v",) or (short == "v" and tol == "heightAboveGround" and lev == 10):
            name = "v10"
        elif short in ("gust", "10fg", "i10fg"):
            name = "gust"
        elif short in ("prmsl", "msl"):
            name = "mslp"
        elif short in ("gh", "z") and tol == "isobaricInhPa" and lev == 500:
            name = "h500"
        elif short == "t" and tol == "isobaricInhPa" and lev == 850:
            name = "t850"
        elif short == "tp":
            name = "tp"
        elif short in ("cape", "mucape"):
            name = "cape"
        elif short in ("crain", "csnow", "cfrzr", "cicep", "ptype"):
            name = short
        if name is None or name in raw:
            return
        eccodes.codes_set(gid, "missingValue", 9.999e20)
        vals = np.asarray(eccodes.codes_get_values(gid), dtype="float64")
        vals[vals > 9e20] = np.nan
        if short == "z":
            vals = vals / 9.80665
        cat = name in ("crain", "csnow", "cfrzr", "cicep", "ptype")
        raw[name] = regrid_any(gid, vals, tlats, tlons, nearest=cat)
        if name == "tp":
            try:
                meta["tp_start"] = int(str(eccodes.codes_get(gid, "stepRange")).split("-")[0])
            except Exception:
                meta["tp_start"] = 0
            try:
                meta["tp_units_m"] = str(eccodes.codes_get(gid, "units")).strip() == "m"
            except Exception:
                meta["tp_units_m"] = False

    if isinstance(path_or_msgs, (list, tuple)):
        for msg in path_or_msgs:
            gid = eccodes.codes_new_from_message(msg)
            try:
                one(gid)
            finally:
                eccodes.codes_release(gid)
    else:
        with open(path_or_msgs, "rb") as fh:
            while True:
                gid = eccodes.codes_grib_new_from_file(fh)
                if gid is None:
                    break
                try:
                    one(gid)
                finally:
                    eccodes.codes_release(gid)
    return raw, meta


def to_fields(raw, meta):
    """The site's units. tp comes back separately for the running total."""
    out = {}
    k2f = lambda k: (k - 273.15) * 9 / 5 + 32          # noqa: E731
    if "t2m" in raw:
        out["t2m"] = k2f(raw["t2m"])
    if "td2m" in raw:
        out["td2m"] = k2f(raw["td2m"])
    elif "rh2m" in raw and "t2m" in raw:
        tc = raw["t2m"] - 273.15
        rh = np.clip(raw["rh2m"], 1, 100)
        g = np.log(rh / 100.0) + 17.625 * tc / (243.04 + tc)
        out["td2m"] = (243.04 * g / (17.625 - g)) * 9 / 5 + 32
    if "u10" in raw and "v10" in raw:
        out["wind10"] = np.hypot(raw["u10"], raw["v10"]) * 2.23694
    if "gust" in raw:
        out["gust"] = raw["gust"] * 2.23694
    if "mslp" in raw:
        out["mslp"] = raw["mslp"] / 100.0
    if "h500" in raw:
        out["h500"] = raw["h500"] / 10.0
    if "t850" in raw:
        out["t850"] = raw["t850"] - 273.15
    if "cape" in raw:
        out["cape"] = raw["cape"]
    if "ptype" in raw:
        pt = np.nan_to_num(raw["ptype"], nan=0).astype(int)
        out["ptype"] = np.vectorize(lambda c: PTYPE_ECMWF.get(int(c), 0))(pt).astype(float)
    elif any(k in raw for k in ("crain", "csnow", "cfrzr", "cicep")):
        z = np.zeros_like(next(raw[k] for k in ("crain", "csnow", "cfrzr", "cicep") if k in raw))
        code = z.copy()
        # Worst first: freezing rain outranks sleet outranks snow outranks rain.
        for name, c in (("crain", 1), ("csnow", 2), ("cicep", 4), ("cfrzr", 3)):
            if name in raw:
                code = np.where(np.nan_to_num(raw[name]) >= 0.5, c, code)
        out["ptype"] = code
    tp = None
    if "tp" in raw:
        tp = raw["tp"] * (1000.0 if meta.get("tp_units_m") else 1.0) / 25.4     # to inches
    return out, tp


def pack(values, spec):
    """members x ny x nx floats -> gzip of uint16 codes."""
    a = np.asarray(values, dtype="float64")
    code = np.rint((a - spec["offset"]) / spec["scale"])
    code = np.where(np.isfinite(code), np.clip(code, 0, MISSING - 1), MISSING).astype("<u2")
    return gzip.compress(code.tobytes(), compresslevel=6)


def unpack(blob, spec, shape):
    code = np.frombuffer(gzip.decompress(blob), dtype="<u2").reshape(shape).astype("float64")
    return np.where(code == MISSING, np.nan, code * spec["scale"] + spec["offset"])


# -- Fetching -------------------------------------------------------------------------
_inv_cache = {}
_inv_lock = threading.Lock()


def noaa_file(ens, mem, cyc, fhr):
    core, _, m2 = mem.partition(".")
    return ens["file"].format(mem=core if m2 else mem, m2=m2, cyc=cyc, fhr=fhr)


def noaa_ask(gp, ens, date_str, cyc, mem, fhr):
    """(vars, levels) to ask for, from the file's own index. Every member of
    an ensemble carries the same records, so one index per hour answers for
    all of them. None when the index is not there (not published yet)."""
    key = (ens["label"], date_str, cyc, fhr)
    with _inv_lock:
        if key in _inv_cache:
            return _inv_cache[key]
    url = f"{gp.RAW_BASE}/" + ens["raw"].format(date=date_str, cyc=cyc) + noaa_file(ens, mem, cyc, fhr) + ".idx"
    try:
        r = gp.http_get(url, timeout=30)
        text = r.text if r.status_code == 200 and "<" not in r.text[:40] else ""
    except Exception:
        text = ""
    have = set()
    rows = []
    for line in text.splitlines():
        f = line.split(":")
        if len(f) > 5:
            have.add((f[3], f[4]))
            try:
                rows.append((int(f[1]), f[3], f[4]))
            except ValueError:
                pass
    # Where the precipitation record sits in the file, for when the filter
    # service leaves it out (it does for the Canadian ensemble).
    apcp = None
    for i, (start, var, lev) in enumerate(rows):
        if var == "APCP" and lev == "surface":
            apcp = (start, rows[i + 1][0] - 1 if i + 1 < len(rows) else None)
            break
    pairs = [p for p in NOAA_WANT if p in have]
    ans = (sorted({v for v, _l in pairs}), sorted({l for _v, l in pairs}), apcp) if pairs else None
    with _inv_lock:
        _inv_cache[key] = ans
    return ans


def fetch_noaa(gp, ens, date_str, cyc, mem, fhr):
    """One member at one hour through the NOMADS filter, cut to the box.
    Returns a temp file path or None if that hour is not out yet."""
    ask = noaa_ask(gp, ens, date_str, cyc, mem, fhr)
    if not ask:
        return None
    params = {
        "file": noaa_file(ens, mem, cyc, fhr),
        "dir": ens["dir"].format(date=date_str, cyc=cyc),
        "subregion": "",
        "toplat": GRID["n"] + 1, "bottomlat": GRID["s"] - 1,
        "leftlon": (GRID["w"] - 1) % 360.0, "rightlon": (GRID["e"] + 1) % 360.0,
    }
    for v in ask[0]:
        params["var_" + v] = "on"
    for lv in ask[1]:
        params[gp.lev_flag(lv)] = "on"
    r = gp.http_get(f"{gp.FILTER_BASE}/{ens['filter']}", params=params, timeout=120)
    if r.status_code != 200 or r.content[:4] != b"GRIB":
        return None
    body = r.content
    if ask[2] and b"APCP" not in body and not _has_tp(body):
        a, b = ask[2]
        url = f"{gp.RAW_BASE}/" + ens["raw"].format(date=date_str, cyc=cyc) + noaa_file(ens, mem, cyc, fhr)
        try:
            rr = gp.http_get(url, timeout=120, headers={"Range": f"bytes={a}-" + ("" if b is None else str(b))})
            if rr.status_code == 206 and rr.content[:4] == b"GRIB":
                body += rr.content
        except Exception:
            pass
    fd, path = tempfile.mkstemp(suffix=".grib2", prefix="gwcfc_ensf_")
    with os.fdopen(fd, "wb") as fh:
        fh.write(body)
    return path


def _short(gid):
    """eccodes' short name, or 'tp' for a precipitation record it cannot name
    (the Canadian ensemble's, whose template eccodes has no name for):
    WMO discipline 0, category 1, number 8 is total precipitation."""
    short = str(eccodes.codes_get(gid, "shortName")).lower()
    if short == "unknown":
        try:
            if (int(eccodes.codes_get(gid, "discipline")) == 0
                    and int(eccodes.codes_get(gid, "parameterCategory")) == 1
                    and int(eccodes.codes_get(gid, "parameterNumber")) == 8):
                return "tp"
        except Exception:
            pass
    return short


def _has_tp(body):
    """Whether a GRIB blob already holds a precipitation record."""
    try:
        pos = 0
        while True:
            k = body.find(b"GRIB", pos)
            if k < 0:
                return False
            n = int.from_bytes(body[k + 8:k + 16], "big")
            gid = eccodes.codes_new_from_message(body[k:k + n])
            try:
                if _short(gid) == "tp":
                    return True
            finally:
                eccodes.codes_release(gid)
            pos = k + max(n, 4)
    except Exception:
        return False


def ecmwf_rows(gp, ens, date_str, cyc, fhr):
    """{member: [(offset, length)]} of the wanted records, from the index."""
    for base in ECMWF_BASES:
        url = (f"{base}/{date_str}/{cyc}z/ifs/0p25/enfo/{date_str}{cyc}0000-{fhr}h-enfo-ef")
        try:
            r = gp.http_get(url + ".index", timeout=60)
        except Exception:
            continue
        if r.status_code != 200:
            continue
        rows = {}
        for line in r.text.splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            p = rec.get("param")
            if p not in ens["params"]:
                continue
            want_lev = ens["params"][p]
            if want_lev is not None and str(rec.get("levelist", "")) != want_lev:
                continue
            m = 0 if rec.get("type") == "cf" else int(rec.get("number", 0) or 0)
            rows.setdefault(m, []).append((int(rec["_offset"]), int(rec["_length"])))
        if rows:
            return url + ".grib2", rows
    return None, {}


def fetch_ecmwf_member(gp, url, ranges):
    msgs = []
    for off, ln in sorted(ranges):
        r = gp.http_get(url, timeout=120, headers={"Range": f"bytes={off}-{off + ln - 1}"})
        if r.status_code != 206:
            return None
        msgs.append(r.content)
    return msgs


# -- A run ----------------------------------------------------------------------------
def write_json(path, obj):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    os.replace(tmp, path)


_index_lock = threading.Lock()


def update_index(model, entry, out_dir=None):
    out_dir = out_dir or OUT_DIR
    path = os.path.join(out_dir, "index.json")
    with _index_lock:
        try:
            with open(path) as fh:
                idx = json.load(fh)
        except (OSError, ValueError):
            idx = {"models": {}}
        idx.setdefault("models", {})[model] = entry
        idx["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        write_json(path, idx)


def build(model, date_str, cyc, fetch=None, out_dir=None, steps=None, members=None, workers=4):
    """Fetch, regrid and pack one run. fetch(member, fhr) -> (raw, meta) or None
    replaces the download (the tests use it)."""
    out_dir = out_dir or OUT_DIR
    ens = ENSEMBLES[model]
    steps = steps or ens["steps"]
    mems = members or ens["members"]
    tlats, tlons = target()
    run = f"{date_str}_{cyc}"
    run_dir = os.path.join(out_dir, model, run)
    os.makedirs(run_dir, exist_ok=True)
    gp = None
    if fetch is None:
        gp = _pipeline()

        def fetch(mem, fhr, _cache={}):
            if ens["kind"] == "noaa":
                path = fetch_noaa(gp, ens, date_str, cyc, mem, fhr)
                if not path:
                    return None
                try:
                    return decode(path, tlats, tlons)
                finally:
                    os.unlink(path)
            key = fhr
            if key not in _cache:
                _cache.clear()
                _cache[key] = ecmwf_rows(gp, ens, date_str, cyc, fhr)
            url, rows = _cache[key]
            if not url or mem not in rows:
                return None
            msgs = fetch_ecmwf_member(gp, url, rows[mem])
            return decode(msgs, tlats, tlons) if msgs else None

    base = dt.datetime.strptime(date_str + cyc, "%Y%m%d%H").replace(tzinfo=dt.timezone.utc)
    manifest = {"model": model, "label": ens["label"], "run": run,
                "base": base.strftime("%Y-%m-%dT%H:00:00Z"),
                "members": [str(m) for m in mems], "grid": dict(GRID, ny=len(tlats), nx=len(tlons)),
                "fields": {}, "hours": [], "complete": False}
    totals = {}                         # member -> running precipitation (in)
    last_tp = {}                        # member -> (hour, value as published)
    for fhr in steps:
        got = [None] * len(mems)

        def job(k):
            try:
                return k, fetch(mems[k], fhr)
            except Exception as e:                    # one member, not the run
                log(f"  {model} {mems[k]} f{fhr:03d}: {e}")
                return k, None

        with ThreadPoolExecutor(max_workers=workers) as ex:
            for k, res in ex.map(job, range(len(mems))):
                got[k] = res
        have = sum(1 for g in got if g)
        if not have:
            log(f"  {model} f{fhr:03d}: not published yet; stopping here")
            break
        per_field = {}
        for k, res in enumerate(got):
            if not res:
                continue
            raw, meta = res
            vals, tp = to_fields(raw, meta)
            if tp is not None:
                # A bucket that starts at the run's beginning is already a total;
                # one that starts later adds to the total so far.
                start = meta.get("tp_start", 0)
                prev = totals.get(k, np.zeros_like(tp))
                total = tp if start == 0 else np.nan_to_num(prev) + np.nan_to_num(tp)
                totals[k] = total
                vals["qpf"] = total
                last_tp[k] = (fhr, tp)
            for name, arr in vals.items():
                per_field.setdefault(name, [None] * len(mems))[k] = arr
        shape = (len(mems), len(tlats), len(tlons))
        for name, arrs in per_field.items():
            stack = np.full(shape, np.nan)
            for k, a in enumerate(arrs):
                if a is not None:
                    stack[k] = a
            with open(os.path.join(run_dir, f"{name}_f{fhr:03d}.bin.gz"), "wb") as fh:
                fh.write(pack(stack, FIELDS[name]))
            manifest["fields"].setdefault(name, dict(FIELDS[name]))
        manifest["hours"].append(fhr)
        manifest["membersPerHour"] = manifest.get("membersPerHour", {})
        manifest["membersPerHour"][str(fhr)] = have
        write_json(os.path.join(run_dir, "manifest.json"), manifest)
        update_index(model, {"label": ens["label"], "run": run, "base": manifest["base"],
                             "hours": manifest["hours"], "fields": sorted(manifest["fields"]),
                             "members": len(mems), "complete": False}, out_dir)
        log(f"  {model} f{fhr:03d}: {have}/{len(mems)} members, {len(per_field)} fields")
    manifest["complete"] = bool(manifest["hours"])
    write_json(os.path.join(run_dir, "manifest.json"), manifest)
    if manifest["hours"]:
        update_index(model, {"label": ens["label"], "run": run, "base": manifest["base"],
                             "hours": manifest["hours"], "fields": sorted(manifest["fields"]),
                             "members": len(mems), "complete": True}, out_dir)
        prune(model, keep=run, out_dir=out_dir)
    return manifest


def prune(model, keep, out_dir=None):
    d = os.path.join(out_dir or OUT_DIR, model)
    try:
        runs = sorted(x for x in os.listdir(d) if x != keep)
    except OSError:
        return
    for x in runs[:max(0, len(runs) - (KEEP_RUNS - 1))]:
        shutil.rmtree(os.path.join(d, x), ignore_errors=True)


def already_built(model, run, out_dir=None):
    try:
        with open(os.path.join(out_dir or OUT_DIR, "index.json")) as fh:
            e = json.load(fh).get("models", {}).get(model, {})
        return e.get("run") == run and e.get("complete")
    except (OSError, ValueError):
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", choices=list(ENSEMBLES))
    ap.add_argument("--date")
    ap.add_argument("--cyc")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args(argv)
    if a.list:
        try:
            with open(os.path.join(OUT_DIR, "index.json")) as fh:
                idx = json.load(fh)
        except (OSError, ValueError):
            print("nothing built yet")
            return 0
        for k, v in idx.get("models", {}).items():
            print(f"  {k:10s} {v.get('run')}  {len(v.get('hours', []))} hours  "
                  f"{'complete' if v.get('complete') else 'building'}  {', '.join(v.get('fields', []))}")
        return 0
    if np is None or eccodes is None:
        log("numpy and eccodes are needed")
        return 1
    wanted = [a.model] if a.model else [m.strip() for m in os.environ.get(
        "GWCFC_ENS_MODELS", ",".join(ENSEMBLES)).split(",") if m.strip() in ENSEMBLES]
    os.makedirs(OUT_DIR, exist_ok=True)
    for model in wanted:
        ens = ENSEMBLES[model]
        date_str, cyc = newest_cycle(ens)
        date_str, cyc = a.date or date_str, a.cyc or cyc
        if a.check:
            gp = _pipeline()
            if ens["kind"] == "noaa":
                path = fetch_noaa(gp, ens, date_str, cyc, ens["members"][0], ens["steps"][0])
                log(f"{model} {date_str} {cyc}z: first member, first hour "
                    + ("published" if path else "not published"))
                if path:
                    os.unlink(path)
            else:
                url, rows = ecmwf_rows(gp, ens, date_str, cyc, ens["steps"][0])
                log(f"{model} {date_str} {cyc}z: " + (f"{len(rows)} members in the index" if url else "no index"))
            continue
        if not a.force and already_built(model, f"{date_str}_{cyc}"):
            log(f"{model} {date_str}_{cyc} already built")
            continue
        log(f"{model} {date_str} {cyc}z: building")
        build(model, date_str, cyc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
