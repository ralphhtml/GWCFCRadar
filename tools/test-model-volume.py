#!/usr/bin/env python3
"""
Model 3D's volumes, cut from real model files on the parsing server.

    python3 tools/test-model-volume.py

pi/model_volume.py cuts a box of temperature, humidity, height, wind and
omega at ten pressure levels out of a model run and resamples it onto the
small grid the page draws. Checked here with GRIB files written by eccodes
itself, so the reading is the real reading:

  - resampling from a 0..360 grid (GFS), a -180..180 global grid (ECMWF)
    and across the date line, and nearest points on a grid that is not
    latitude/longitude (HRRR and NAM are Lambert conformal);
  - units: kelvin in the file, Celsius out; missing points as null;
  - the NOAA path asks the filter service for only the box and only the
    levels and fields the index lists;
  - the ECMWF path takes byte ranges off the index, keeps the hour on disk,
    and cuts the next box from it without downloading again;
  - the serve.py doors exist and check what they are given.

Nothing here touches the network.
"""

import json
import math
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (("  <" + str(extra) + ">") if extra else ""))


try:
    import numpy as np
    import eccodes
except ImportError as e:
    print(f"numpy and eccodes are needed for this test ({e}); skipping")
    sys.exit(0)

tmpdir = tempfile.mkdtemp(prefix="gwcfc_voltest_")
os.environ["GWCFC_DATA"] = tmpdir
import model_volume as mv  # noqa: E402

EM = chr(0x2014)
for f in ("pi/model_volume.py", "tools/test-model-volume.py"):
    ok(f"no em dashes in {f}", EM not in open(os.path.join(ROOT, f)).read())

print("\n1. resampling")
f = lambda la, lo: 2 * la + 0.1 * ((lo + 180) % 360 - 180)   # noqa: E731
# GFS style: 0..360, north to south.
lats = np.arange(50, 29.75, -0.25)
lons = np.arange(250, 280.25, 0.25)
g = np.array([[f(la, lo) for lo in lons] for la in lats])
out = mv.sample_regular(g, 50, 30, 250, 280, [35.1, 40.33], [-100.2, -95.07])
want = np.array([[f(35.1, -100.2), f(35.1, -95.07)], [f(40.33, -100.2), f(40.33, -95.07)]])
ok("a 0..360 grid read at -180..180 longitudes, bilinear", np.allclose(out, want, atol=1e-6), out)
# ECMWF style: global, -180..180, wraps.
lats = np.arange(90, -90.5, -1.0)
lons = np.arange(-180, 180, 1.0)
g = np.array([[math.sin(math.radians(lo)) + la for lo in lons] for la in lats])
out = mv.sample_regular(g, 90, -90, -180, 179, [10.5], [179.5, -179.5, 0.25])
ok("a global grid wraps across the date line",
   np.allclose(out[0], [10.5 + 0.5 * (math.sin(math.radians(179)) + math.sin(math.radians(-180))),
                        10.5 + 0.5 * (math.sin(math.radians(-180)) + math.sin(math.radians(-179))),
                        10.5 + 0.75 * 0 + 0.25 * math.sin(math.radians(1))], atol=1e-6), out)
out = mv.sample_regular(np.ones((5, 5)), 40, 36, 260, 264, [30, 38], [-98])
ok("outside a cropped grid is missing, not stretched", np.isnan(out[0, 0]) and out[1, 0] == 1, out)
# A Lambert-ish grid: points on a skewed mesh.
gl = np.array([[30 + j * 0.03 + i * 0.005 for i in range(200)] for j in range(200)])
go = np.array([[-100 + i * 0.035 - j * 0.004 for i in range(200)] for j in range(200)])
idx, good = mv.nearest_index(gl, go, [33.0, 45.0], [-97.0])
k = idx[0, 0]
ok("nearest point on a grid that is not latitude/longitude",
   abs(gl.ravel()[k] - 33.0) < 0.03 and abs(go.ravel()[k] + 97.0) < 0.04 and good[0, 0], (gl.ravel()[k], go.ravel()[k]))
ok("and a point off that grid is marked outside", not good[1, 0])

print("\n2. reading a real GRIB file")
PARAM = {"t": 130, "r": 157, "gh": 156, "u": 131, "v": 132, "w": 135}


def grib(path, lat1, lat2, lon1, lon2, d, fn, levels=mv.LEVELS, params=PARAM, append=False):
    """Writes eccodes' own GRIB2, one message per field per level."""
    offsets = []
    with open(path, "ab" if append else "wb") as fh:
        for p in levels:
            for name, pid in params.items():
                gid = eccodes.codes_grib_new_from_samples("regular_ll_pl_grib2")
                ni = int(round((lon2 - lon1) / d)) + 1
                nj = int(round((lat1 - lat2) / d)) + 1
                for k, v in (("Ni", ni), ("Nj", nj), ("iDirectionIncrementInDegrees", d),
                             ("jDirectionIncrementInDegrees", d), ("jScansPositively", 0),
                             ("latitudeOfFirstGridPointInDegrees", lat1), ("latitudeOfLastGridPointInDegrees", lat2),
                             ("longitudeOfFirstGridPointInDegrees", lon1), ("longitudeOfLastGridPointInDegrees", lon2),
                             ("paramId", pid), ("level", p)):
                    eccodes.codes_set(gid, k, v)
                la = np.linspace(lat1, lat2, nj)
                lo = np.linspace(lon1, lon2, ni)
                vals = np.array([[fn(name, p, a, b) for b in lo] for a in la], dtype="float64").ravel()
                eccodes.codes_set_values(gid, vals)
                start = fh.tell()
                eccodes.codes_write(gid, fh)
                offsets.append({"param": name, "levtype": "pl", "levelist": str(p),
                                "_offset": start, "_length": fh.tell() - start})
                eccodes.codes_release(gid)
    return offsets


def atmos(name, p, la, lo):
    lo = (lo + 180) % 360 - 180
    std = {1000: 110, 925: 760, 850: 1460, 700: 3010, 600: 4210, 500: 5570, 400: 7180, 300: 9160, 250: 10360, 200: 11780}
    return {"t": 288.15 - std[p] / 1000 * 6.5 + 0.5 * (lo + 95), "r": 70.0, "gh": std[p] + 10 * (la - 38),
            "u": 10.0 + (30 if p == 250 else 0), "v": -2.0, "w": -0.5 if p == 500 else 0.1}[name]


path = os.path.join(tmpdir, "gfs.grib2")
grib(path, 46, 30, 255, 275, 0.5, atmos)
tl, tn = mv.target_grid(33, 43, -101, -89, 5)
vol = mv.read_volume(path, tl, tn)
ok("every field at every level", all(set(vol[f_]) == set(mv.LEVELS) for f_ in mv.FIELDS), {k: len(v) for k, v in vol.items()})
out = mv.pack(vol, tl, tn, {"model": "gfs"})
n = 5 * 5
t500 = out["fields"]["t"][mv.LEVELS.index(500) * n + 2 * 5 + 2]
ok("temperature comes out in Celsius", abs(t500 - (15 - 5.57 * 6.5 + 0.5 * 0)) < 0.05, t500)
ok("heights in metres, winds in m/s, omega in Pa/s",
   abs(out["fields"]["gh"][mv.LEVELS.index(500) * n + 12] - 5570) < 0.5
   and abs(out["fields"]["u"][mv.LEVELS.index(250) * n] - 40) < 0.01
   and abs(out["fields"]["omega"][mv.LEVELS.index(500) * n] + 0.5) < 1e-3, out["fields"]["omega"][:3])
ok("ten levels up from 1000 mb, rows from the south",
   out["levels"] == mv.LEVELS and out["lats"][0] == 33 and len(out["fields"]["t"]) == 10 * n)
tl2, tn2 = mv.target_grid(28, 38, -101, -89, 5)
out2 = mv.pack(mv.read_volume(path, tl2, tn2), tl2, tn2, {})
ok("points past the file's edge are null", out2["fields"]["t"][0] is None and out2["fields"]["t"][4 * 5] is not None)

print("\n3. the NOAA path: only the box, only what the index lists")
calls = []


class Resp:
    def __init__(self, code, content=b"", text=""):
        self.status_code, self.content, self.text = code, content, text


grib_bytes = open(path, "rb").read()
fake = types.SimpleNamespace(
    FILTER_BASE="https://nomads.example/cgi-bin",
    MODELS={"gfs": {"label": "GFS", "res": "0.25 deg", "cycle_h": 6, "lag_h": 5, "filter": "filter_gfs_0p25.pl",
                    "dir": "/gfs.{date}/{cyc}/atmos", "file": "gfs.t{cyc}z.pgrb2.0p25.f{fhr:03d}", "raw": "x"},
            "ecmwf": {"label": "ECMWF", "res": "0.25 deg", "cycle_h": 12, "lag_h": 8, "source": "ecmwf"}},
    lev_flag=lambda lv: "lev_" + lv.replace(" ", "_"),
    cycle_for=lambda m: ("20260924", "12"),
    inventory=lambda m, d, c, f: {(v, f"{p} mb") for v in ("TMP", "RH", "HGT", "UGRD", "VGRD", "VVEL", "ABSV")
                                  for p in mv.LEVELS + [975, 150, 10]} | {("TMP", "2 m above ground")},
)


def http_get(url, params=None, timeout=None, headers=None):
    calls.append((url, params, headers))
    if "nomads" in url:
        return Resp(200, grib_bytes)
    rng = headers["Range"].split("=")[1].split("-")
    return Resp(206, ec_bytes[int(rng[0]):int(rng[1]) + 1])


fake.http_get = http_get
mv._pipeline = lambda: fake
import model_sounding  # noqa: E402
model_sounding._pipeline = lambda: fake
out = mv.volume("gfs", 33, 43, -101, -89, fhr=12)
url, params, _h = calls[0]
ok("one filter request, for the box plus a margin, in 0..360",
   len(calls) == 1 and url.endswith("/filter_gfs_0p25.pl") and params["toplat"] == 43.6 and params["bottomlat"] == 32.4
   and params["leftlon"] == round((-101.6) % 360, 2) and params["rightlon"] == round((-88.4) % 360, 2), params)
levs = sorted(int(k.split("_")[1]) for k in params if k.startswith("lev_"))
ok("only the ten levels, only the six fields", levs == sorted(mv.LEVELS)
   and sorted(k for k in params if k.startswith("var_")) == ["var_HGT", "var_RH", "var_TMP", "var_UGRD", "var_VGRD", "var_VVEL"], (levs, params))
ok("says which run and hour it is", out["run"] == "20260924/12" and out["fhr"] == 12 and out["valid"] == "2026-09-25T00:00:00Z", out["valid"])
calls.clear()
again = mv.volume("gfs", 33, 43, -101, -89, fhr=12)
ok("the same box again is answered from memory", not calls and again.get("cached"))

print("\n4. the ECMWF path: byte ranges, kept on disk")
ec_path = os.path.join(tmpdir, "ec.grib2")
index = grib(ec_path, 90, -90, -180, 179, 1.0, atmos)
# Surface fields and an unwanted level sit in the index too and must be skipped.
index.append({"param": "2t", "levtype": "sfc", "_offset": 0, "_length": 10})
index.append({"param": "t", "levtype": "pl", "levelist": "50", "_offset": 0, "_length": 10})
ec_bytes = open(ec_path, "rb").read()
fake.ecmwf_index = lambda m, d, c, f: ("idx", "\n".join(json.dumps(r) for r in index), [], "host")
fake.ecmwf_paths = lambda m, d, c, f, host=None: (f"https://ecmwf.example/{d}{c}-{f}h.grib2", [])
calls.clear()
out = mv.volume("ecmwf", 33, 43, -101, -89, fhr=24)
ok("only byte ranges, merged", calls and all(h and h.get("Range") for _u, _p, h in calls) and len(calls) < 10, len(calls))
t = out["fields"]["t"][mv.LEVELS.index(850) * 169 + 6 * 13 + 6]
ok("and the values are right", abs(t - (15 - 1.46 * 6.5 + 0.5 * (-95 + 95))) < 0.2, t)
calls.clear()
out = mv.volume("ecmwf", 20, 30, -80, -70, fhr=24)
ok("a second box from the same hour downloads nothing", not calls and out["fields"]["t"][0] is not None)
ok("the hour is kept on disk", any(f_.startswith("ecmwf_2026092412_f024") for f_ in os.listdir(mv.CACHE_DIR)))
try:
    mv.volume("gfs", 60, 0, -100, -90)
    ok("a box upside down is refused", False)
except ValueError:
    ok("a box upside down is refused", True)
ok("and no size limit is left in the code", "MAX_SPAN" not in open(os.path.join(ROOT, "pi/model_volume.py")).read())

print("\n5. the doors")
src = open(os.path.join(ROOT, "pi/serve.py")).read()
ok("/model3d and /model3d/sources", '"/model3d/sources"' in src and 'head == "/model3d"' in src)
ok("the box, model, hour and run are checked before anything is asked",
   all(x in src for x in ('"s, n, w and e are required', 'r"[a-z0-9]{1,24}"', '"fhr is out of range"', '"run must be YYYYMMDD/HH"')))
ok("and it waits its turn with the soundings", "mv.volume(model, s_, n_, w_, e_, fhr, run)" in src)

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
