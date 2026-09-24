#!/usr/bin/env python3
"""
A 3D box of a real model run, for the site's Model 3D panel.

    python3 pi/model_volume.py --model gfs --lat 38 --lon -95 --km 1200 --fhr 12
    python3 pi/model_volume.py --list

model_sounding.py cuts one COLUMN out of a model run. This cuts a whole box:
temperature, humidity, height, both wind components and vertical velocity
(omega) at ten pressure levels from 1000 to 200 mb, over a latitude and
longitude box, resampled onto a small regular grid the browser can draw in
3D. The same runs the models panel draws, from the same files:

  * NOAA models (GFS, NAM, RAP, HRRR, GEFS and the rest the catalogue
    serves through NOMADS) through the filter service with a subregion, so
    only the box comes down, a few hundred KB to a few MB.
  * ECMWF from its open data, by byte range off the index, the way
    gfs_pipeline fetches it. Those messages are global, so one forecast hour
    is kept on disk and every box after the first is cut from it.

Units out: temperature C, humidity %, winds m/s, height m, omega Pa/s
(negative is rising, as in the model).
"""

import json
import math
import os
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200]
# NOAA index names, and eccodes short names for the same fields.
WANT_NOAA = ("TMP", "RH", "HGT", "UGRD", "VGRD", "VVEL")
WANT_ECMWF = {"t", "r", "gh", "u", "v", "w"}
SHORT = {"t": "t", "tmp": "t", "r": "rh", "rh": "rh", "gh": "gh", "hgt": "gh", "z": "gh",
         "u": "u", "ugrd": "u", "v": "v", "vgrd": "v", "w": "omega", "vvel": "omega"}
FIELDS = ("t", "rh", "gh", "u", "v", "omega")
GRID_N = 13                 # points along each side of the box sent to the page
MAX_SPAN_DEG = 40.0         # the biggest box answered, in latitude or longitude
PAD_DEG = 0.6               # asked for a little past the box so the edges interpolate

CACHE_DIR = os.path.join(os.environ.get("GWCFC_DATA", os.path.expanduser("~/wxdata")),
                         "model3d")
ECMWF_KEEP = 3              # forecast hours of ECMWF kept on disk
_mem = {}                   # box answers, newest last
_MEM_KEEP = 24
_mem_lock = threading.Lock()
_ecmwf_lock = threading.Lock()


def _pipeline():
    import gfs_pipeline
    return gfs_pipeline


def models():
    """Which models a box can be cut from, for the panel's menu."""
    out = {}
    try:
        import model_sounding
        for k, v in model_sounding.models().items():
            out[k] = dict(v)
    except Exception:
        pass
    try:
        gp = _pipeline()
        for key in ("ecmwf", "ecmwfaifs"):
            m = gp.MODELS.get(key)
            if not m or m.get("source") != "ecmwf":
                continue
            try:
                date_str, cyc = gp.cycle_for(m)
            except Exception:
                date_str, cyc = None, None
            out[key] = {"label": m.get("label", key), "res": m.get("res", ""),
                        "cycle_h": m.get("cycle_h"), "run": f"{date_str}/{cyc}" if date_str else None,
                        "out": 240 if key == "ecmwf" else int(m.get("out") or 144),
                        "step": 6 if key == "ecmwf" else int(m.get("step") or 6), "upper": True}
    except Exception:
        pass
    return out


def target_grid(s, n, w, e, nx=GRID_N):
    lats = [s + j / (nx - 1) * (n - s) for j in range(nx)]
    lons = [w + i / (nx - 1) * (e - w) for i in range(nx)]
    return lats, lons


# -- Resampling -----------------------------------------------------------------
def sample_regular(vals, lat1, lat2, lon1, lon2, tlats, tlons):
    """Bilinear from a regular latitude/longitude grid onto the target points.

    vals is (nj, ni) from the first grid point, whichever way the rows run.
    Longitudes are handled modulo 360 so a 0..360 grid, a -180..180 grid and a
    box across the date line all read the same way. A global grid wraps in
    longitude; a cropped one clamps.
    """
    import numpy as np
    nj, ni = vals.shape
    if lon2 < lon1:
        lon2 += 360.0
    dlon = (lon2 - lon1) / max(1, ni - 1)
    dlat = (lat2 - lat1) / max(1, nj - 1)
    wraps = abs(dlon * ni - 360.0) < dlon * 1.5
    out = np.full((len(tlats), len(tlons)), np.nan)
    for a, la in enumerate(tlats):
        fj = (la - lat1) / dlat if dlat else 0.0
        if fj < -0.5 or fj > nj - 0.5:
            continue
        fj = min(max(fj, 0.0), nj - 1.0)
        j0 = min(int(math.floor(fj)), nj - 2) if nj > 1 else 0
        tj = fj - j0
        for b, lo in enumerate(tlons):
            fi = ((lo - lon1) % 360.0) / dlon if dlon else 0.0
            if not wraps:
                if fi > ni - 0.5 and fi - 360.0 / dlon >= -0.5:
                    fi -= 360.0 / dlon
                if fi < -0.5 or fi > ni - 0.5:
                    continue
                fi = min(max(fi, 0.0), ni - 1.0)
            i0 = int(math.floor(fi))
            ti = fi - i0
            i1 = (i0 + 1) % ni if wraps else min(i0 + 1, ni - 1)
            i0 = i0 % ni if wraps else min(i0, ni - 1)
            j1 = min(j0 + 1, nj - 1)
            v = ((vals[j0, i0] * (1 - ti) + vals[j0, i1] * ti) * (1 - tj)
                 + (vals[j1, i0] * (1 - ti) + vals[j1, i1] * ti) * tj)
            out[a, b] = v
    return out


def nearest_index(glats, glons, tlats, tlons):
    """For a grid that is not latitude/longitude (HRRR and NAM are Lambert
    conformal), the nearest model point to each target point, once per grid
    shape. Distances are measured on the sphere's tangent plane, which is
    plenty for finding the closest of points a few km apart."""
    import numpy as np
    glats = np.asarray(glats, dtype="float64").ravel()
    glons = (np.asarray(glons, dtype="float64").ravel() + 180.0) % 360.0 - 180.0
    idx = np.zeros((len(tlats), len(tlons)), dtype="int64")
    ok = np.zeros((len(tlats), len(tlons)), dtype=bool)
    spacing = None
    for a, la in enumerate(tlats):
        c = math.cos(math.radians(la))
        for b, lo in enumerate(tlons):
            lo = (lo + 180.0) % 360.0 - 180.0
            dl = (glons - lo + 180.0) % 360.0 - 180.0
            d2 = (glats - la) ** 2 + (dl * c) ** 2
            k = int(np.argmin(d2))
            idx[a, b] = k
            if spacing is None and len(glats) > 1:
                # How far apart the model's own points are, to tell "nearest"
                # from "outside the file".
                spacing = float(np.sqrt(np.partition(d2, 1)[1]))
            ok[a, b] = d2[k] <= max(0.01, ((spacing or 0.1) * 3) ** 2)
    return idx, ok


def read_volume(path, tlats, tlons):
    """{field: {level: 2-D array on the target grid}} from one GRIB file."""
    import eccodes
    import numpy as np
    out = {}
    near = {}
    with open(path, "rb") as fh:
        while True:
            gid = eccodes.codes_grib_new_from_file(fh)
            if gid is None:
                break
            try:
                if str(eccodes.codes_get(gid, "typeOfLevel")) != "isobaricInhPa":
                    continue
                name = SHORT.get(str(eccodes.codes_get(gid, "shortName")).lower())
                level = int(round(float(eccodes.codes_get(gid, "level"))))
                if name is None or level not in LEVELS:
                    continue
                eccodes.codes_set(gid, "missingValue", 9.999e20)
                vals = np.asarray(eccodes.codes_get_values(gid), dtype="float64")
                vals[vals > 9e20] = np.nan
                grid = str(eccodes.codes_get(gid, "gridType"))
                ni = int(eccodes.codes_get(gid, "Ni") or 0)
                nj = int(eccodes.codes_get(gid, "Nj") or 0)
                if grid == "regular_ll" and ni > 0 and nj > 0:
                    g = sample_regular(
                        vals.reshape(nj, ni),
                        float(eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")),
                        float(eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees")),
                        float(eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")),
                        float(eccodes.codes_get(gid, "longitudeOfLastGridPointInDegrees")),
                        tlats, tlons)
                else:
                    key = (grid, len(vals))
                    if key not in near:
                        near[key] = nearest_index(eccodes.codes_get_array(gid, "latitudes"),
                                                  eccodes.codes_get_array(gid, "longitudes"),
                                                  tlats, tlons)
                    idx, ok = near[key]
                    g = np.where(ok, vals[idx], np.nan)
                out.setdefault(name, {})[level] = g
            finally:
                eccodes.codes_release(gid)
    return out


def pack(vol, tlats, tlons, meta):
    """The JSON the page reads. Each field is one flat list, level by level
    from 1000 mb up, each level row by row from the south, NaN as null."""
    nx = len(tlons)
    fields = {}
    have = []
    for f in FIELDS:
        flat = []
        any_ = False
        for lev in LEVELS:
            g = vol.get(f, {}).get(lev)
            for a in range(len(tlats)):
                for b in range(nx):
                    v = None if g is None else float(g[a, b])
                    if v is None or v != v:
                        flat.append(None)
                        continue
                    if f == "t" and v > 150:
                        v -= 273.15                      # K in the file
                    any_ = True
                    flat.append(round(v, 4 if f == "omega" else 2))
        fields[f] = flat
        if any_:
            have.append(f)
    if "t" not in have or "gh" not in have:
        raise RuntimeError("the model file came back without temperature or "
                           "heights on pressure levels, so there is no volume in it")
    return dict(meta, levels=LEVELS, nx=nx, ny=len(tlats), lats=[round(x, 4) for x in tlats],
                lons=[round(x, 4) for x in tlons], fields=fields, have=have)


# -- NOAA -------------------------------------------------------------------------
def _ask_noaa(gp, m, date_str, cyc, fhr, box, levels, want):
    s, n, w, e = box
    params = {
        "file": m["file"].format(cyc=cyc, fhr=fhr),
        "dir": m["dir"].format(date=date_str, cyc=cyc),
        "subregion": "",
        "toplat": round(min(90.0, n + PAD_DEG), 2),
        "bottomlat": round(max(-90.0, s - PAD_DEG), 2),
        "leftlon": round((w - PAD_DEG) % 360.0, 2),
        "rightlon": round((e + PAD_DEG) % 360.0, 2),
    }
    for v in want:
        params["var_" + v] = "on"
    for lv in levels:
        params[gp.lev_flag(lv)] = "on"
    r = gp.http_get(f"{gp.FILTER_BASE}/{m['filter']}", params=params, timeout=120)
    if r.status_code != 200 or r.content[:4] != b"GRIB":
        raise RuntimeError(f"the filter service answered HTTP {r.status_code} with "
                           f"{len(r.content)} bytes for {m.get('label', '?')} f{fhr:03d}")
    fd, path = tempfile.mkstemp(suffix=".grib2", prefix="gwcfc_vol_")
    with os.fdopen(fd, "wb") as fh:
        fh.write(r.content)
    return path


def _noaa_file(gp, key, date_str, cyc, fhr, box):
    import model_sounding as ms
    m = gp.MODELS[key]
    m, _over = ms.column_spec(m, key)
    pairs = gp.inventory(m, date_str, cyc, fhr)
    if not pairs:
        raise RuntimeError(f"no index for {m.get('label', key)} {date_str} {cyc}z "
                           f"f{fhr:03d}: that hour has not published yet")
    levels, want = set(), set()
    for var, lev in pairs:
        mb = ms.MB_LEVEL_RE.match(lev or "")
        if not mb or int(round(float(mb.group(1)))) not in LEVELS:
            continue
        if (var or "").upper() in WANT_NOAA:
            levels.add(lev)
            want.add(var.upper())
    if "TMP" not in want or "HGT" not in want:
        raise RuntimeError(f"{m.get('label', key)} publishes no temperature and "
                           "heights on pressure levels in this file")
    return _ask_noaa(gp, m, date_str, cyc, fhr, box, sorted(levels), sorted(want)), False


# -- ECMWF ------------------------------------------------------------------------
def _ecmwf_file(gp, key, date_str, cyc, fhr):
    """One forecast hour of the wanted pressure level fields, global, kept on
    disk. Returns (path, keep) where keep says not to delete it after."""
    m = gp.MODELS[key]
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{key}_{date_str}{cyc}_f{fhr:03d}.grib2")
    with _ecmwf_lock:
        if os.path.exists(path) and os.path.getsize(path) > 0:
            os.utime(path, None)
            return path, True
        _url, text, codes, host = gp.ecmwf_index(m, date_str, cyc, fhr)
        if not text:
            raise RuntimeError(f"no ECMWF index for {date_str} {cyc}z f{fhr:03d}: "
                               "that hour has not published yet")
        grib_url = gp.ecmwf_paths(m, date_str, cyc, fhr, host)[0]
        want = []
        for line in text.splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            try:
                lev = int(rec.get("levelist", 0) or 0)
            except (TypeError, ValueError):
                continue
            if rec.get("levtype") == "pl" and rec.get("param") in WANT_ECMWF and lev in LEVELS:
                try:
                    want.append((int(rec["_offset"]), int(rec["_length"])))
                except (KeyError, TypeError, ValueError):
                    continue
        if not want:
            raise RuntimeError("the ECMWF index lists none of the pressure level fields")
        want.sort()
        merged = []
        for off, ln in want:
            if merged and off - (merged[-1][0] + merged[-1][1]) <= 65536:
                merged[-1] = (merged[-1][0], off + ln - merged[-1][0])
            else:
                merged.append((off, ln))
        tmp = path + ".part"
        with open(tmp, "wb") as fh:
            for off, ln in merged:
                r = gp.http_get(grib_url, timeout=120,
                                headers={"Range": f"bytes={off}-{off + ln - 1}"})
                if r.status_code != 206:
                    raise RuntimeError(f"ECMWF answered HTTP {r.status_code} to a byte range")
                fh.write(r.content)
        os.replace(tmp, path)
        # Only the newest few hours stay.
        olds = sorted((os.path.getmtime(os.path.join(CACHE_DIR, f)), f)
                      for f in os.listdir(CACHE_DIR) if f.endswith(".grib2"))
        for _t, f in olds[:-ECMWF_KEEP]:
            try:
                os.unlink(os.path.join(CACHE_DIR, f))
            except OSError:
                pass
    return path, True


# -- A box ------------------------------------------------------------------------
def volume(model_key, s, n, w, e, fhr=0, run=None, nx=GRID_N):
    if not (n > s) or n - s > MAX_SPAN_DEG or not (0 < (e - w) <= MAX_SPAN_DEG):
        raise ValueError(f"the box must be at most {MAX_SPAN_DEG:g} degrees each way")
    gp = _pipeline()
    if model_key not in gp.MODELS:
        raise RuntimeError(f"there is no model called {model_key} on this parsing server")
    m = gp.MODELS[model_key]
    fhr = int(fhr or 0)
    if run:
        date_str, cyc = str(run).split("/")
    else:
        date_str, cyc = gp.cycle_for(m)
    key = (model_key, date_str, cyc, fhr, round(s, 2), round(n, 2), round(w, 2), round(e, 2), nx)
    with _mem_lock:
        hit = _mem.get(key)
    if hit:
        return dict(hit, cached=True)
    tlats, tlons = target_grid(s, n, w, e, nx)
    if m.get("source") == "ecmwf":
        path, keep = _ecmwf_file(gp, model_key, date_str, cyc, fhr)
    else:
        if not m.get("filter") or not m.get("file"):
            raise RuntimeError(f"{m.get('label', model_key)} has no pressure level "
                               "files this parsing server can cut a box from")
        path, keep = _noaa_file(gp, model_key, date_str, cyc, fhr, (s, n, w, e))
    try:
        vol = read_volume(path, tlats, tlons)
    finally:
        if not keep:
            try:
                os.unlink(path)
            except OSError:
                pass
    valid = (datetime.strptime(date_str + cyc, "%Y%m%d%H").replace(tzinfo=timezone.utc)
             + timedelta(hours=fhr)).strftime("%Y-%m-%dT%H:00:00Z")
    out = pack(vol, tlats, tlons, {
        "model": model_key, "label": m.get("label", model_key), "res": m.get("res", ""),
        "run": f"{date_str}/{cyc}", "fhr": fhr, "valid": valid,
        "box": {"s": s, "n": n, "w": w, "e": e}})
    with _mem_lock:
        _mem[key] = out
        while len(_mem) > _MEM_KEEP:
            _mem.pop(next(iter(_mem)))
    return out


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default="gfs")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--km", type=float, default=1200)
    ap.add_argument("--fhr", type=int, default=0)
    ap.add_argument("--run", default=None)
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args(argv)
    if a.list:
        for k, v in sorted(models().items()):
            print(f"  {k:12s} {v['label']:22s} run {v.get('run')}  f000 to f{v.get('out', 0):03d}")
        return 0
    if a.lat is None or a.lon is None:
        print("--lat and --lon are needed. --list shows the models.")
        return 2
    dlat = a.km / 2 / 110.54
    dlon = a.km / 2 / (111.32 * max(0.1, math.cos(math.radians(a.lat))))
    try:
        out = volume(a.model, a.lat - dlat, a.lat + dlat, a.lon - dlon, a.lon + dlon, a.fhr, a.run)
    except Exception as e:
        print(f"could not build it: {e}")
        return 1
    print(json.dumps({k: v for k, v in out.items() if k != "fields"}, indent=1)[:2000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
