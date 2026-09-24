#!/usr/bin/env python3
"""
Every ensemble member's fields, packed for the site's Ensemble tools.

    python3 tools/test-ens-fields.py

pi/ens_fields_pipeline.py fetches each member of GEFS, GEPS, SREF and ECMWF
ENS, reads the handful of fields the Ensemble tools use, puts them on one
half degree grid over the lower 48 and packs them as 16-bit codes. Checked
here, with no network:

  - the vectorised regridding agrees with model_volume's point by point one,
    and categories (precipitation type) are read by nearest point;
  - real GRIB records written by eccodes come out in the site's units:
    kelvin to Fahrenheit, m/s to mph, Pa to hPa, metres to decametres;
  - precipitation type flags become one code, worst type winning;
  - precipitation buckets become a running total whether a model publishes
    each bucket from the start or from the last hour;
  - packing round-trips to within half a step, and missing stays missing;
  - a run writes its files, manifest and index, stops cleanly at the first
    hour nobody has published, and a finished run is not built twice;
  - the timer is installed.
"""

import gzip
import json
import os
import sys
import tempfile

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
    print(f"numpy and eccodes are needed ({e}); skipping")
    sys.exit(0)

tmp = tempfile.mkdtemp(prefix="gwcfc_ensf_")
os.environ["GWCFC_DATA"] = tmp
import ens_fields_pipeline as ef   # noqa: E402
import model_volume as mv          # noqa: E402

EM = chr(0x2014)
for f in ("pi/ens_fields_pipeline.py", "tools/test-ens-fields.py"):
    ok(f"no em dashes in {f}", EM not in open(os.path.join(ROOT, f)).read())

print("\n1. regridding")
lats = np.arange(56, 18.5, -0.5)
lons = np.arange(228, 302.5, 0.5)
f = lambda la, lo: 3 * la - 0.2 * lo      # noqa: E731
g = np.array([[f(a, b) for b in lons] for a in lats])
tl = np.array([25.3, 40.0, 51.75])
tn = np.array([-120.2, -95.0, -71.3])
fast = ef.regrid_regular(g, 56, 19, 228, 301.5, tl, tn)
slow = mv.sample_regular(g, 56, 19, 228, 301.5, list(tl), list(tn))
ok("the same answer as the point by point version", np.allclose(fast, slow, atol=1e-9), (fast, slow))
cat = np.zeros_like(g)
cat[:, lons >= 265] = 2
near = ef.regrid_regular(cat, 56, 19, 228, 301.5, np.array([40.0]), np.array([-95.2, -94.8]), nearest=True)
ok("categories by nearest point, never blended", set(near.ravel()) <= {0.0, 2.0}, near)
glob = np.array([[la for _ in range(360)] for la in np.arange(90, -90.5, -1.0)])
r = ef.regrid_regular(glob, 90, -90, 0, 359, np.array([30.5]), np.array([-0.5, 179.5]))
ok("a global grid wraps", np.allclose(r, 30.5), r)

print("\n2. real GRIB records, in the site's units")
tlats, tlons = ef.target()
ok("the target is the lower 48 at half a degree", tlats[0] == 20 and tlats[-1] == 55 and tlons[0] == -130 and tlons[-1] == -60
   and len(tlats) == 71 and len(tlons) == 141)
path = os.path.join(tmp, "m.grib2")


def write(fh, pid, level_type, level, value, extra=None):
    gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2" if level_type != "isobaricInhPa" else "regular_ll_pl_grib2")
    for k, v in (("Ni", 150), ("Nj", 80), ("iDirectionIncrementInDegrees", 0.5), ("jDirectionIncrementInDegrees", 0.5),
                 ("jScansPositively", 0), ("latitudeOfFirstGridPointInDegrees", 57.0),
                 ("latitudeOfLastGridPointInDegrees", 17.5), ("longitudeOfFirstGridPointInDegrees", 228.0),
                 ("longitudeOfLastGridPointInDegrees", 302.5)):
        eccodes.codes_set(gid, k, v)
    eccodes.codes_set(gid, "paramId", pid)
    if level_type == "isobaricInhPa":
        eccodes.codes_set(gid, "level", level)
    for k, v in (extra or {}).items():
        eccodes.codes_set(gid, k, v)
    eccodes.codes_set_values(gid, np.full(150 * 80, float(value)))
    eccodes.codes_write(gid, fh)
    eccodes.codes_release(gid)


with open(path, "wb") as fh:
    write(fh, 167, "sfc", 0, 293.15)          # 2t
    write(fh, 168, "sfc", 0, 283.15)          # 2d
    write(fh, 165, "sfc", 0, 3.0)             # 10u
    write(fh, 166, "sfc", 0, 4.0)             # 10v
    write(fh, 151, "sfc", 0, 101325.0)        # msl
    write(fh, 156, "isobaricInhPa", 500, 5640.0)
    write(fh, 130, "isobaricInhPa", 850, 283.15)
    write(fh, 228, "sfc", 0, 0.0254, {"stepRange": "0-12"})   # tp, metres
raw, meta = ef.decode(path, tlats, tlons)
out, tp = ef.to_fields(raw, meta)
mid = (35, 70)
ok("temperature and dew point in F", abs(out["t2m"][mid] - 68) < 0.01 and abs(out["td2m"][mid] - 50) < 0.01,
   (out.get("t2m", [[0]])[mid], out.get("td2m", [[0]])[mid]))
ok("wind in mph from its components", abs(out["wind10"][mid] - 5 * 2.23694) < 0.01, out.get("wind10", [[0]])[mid])
ok("pressure in hPa, 500 mb in dam, 850 mb in C",
   abs(out["mslp"][mid] - 1013.25) < 0.01 and abs(out["h500"][mid] - 564) < 0.01 and abs(out["t850"][mid] - 10) < 0.01)
ok("precipitation in inches, from metres, since the start", abs(tp[mid] - 1.0) < 1e-6 and meta["tp_start"] == 0, (tp[mid], meta))

print("\n3. precipitation type and dew point from humidity")
o, _ = ef.to_fields({"crain": np.array([1.0, 1.0, 0.0, 0.0]), "csnow": np.array([0.0, 1.0, 1.0, 0.0]),
                     "cfrzr": np.array([0.0, 0.0, 1.0, 0.0])}, {})
ok("worst type wins: rain, snow over rain, freezing rain over snow, none", list(o["ptype"]) == [1, 2, 3, 0], o["ptype"])
o, _ = ef.to_fields({"ptype": np.array([1.0, 5.0, 3.0, 8.0, 0.0])}, {})
ok("ECMWF's type codes become the same categories", list(o["ptype"]) == [1, 2, 3, 4, 0], o["ptype"])
o, _ = ef.to_fields({"t2m": np.array([293.15]), "rh2m": np.array([52.5])}, {})
ok("dew point from humidity when a model has none", abs(o["td2m"][0] - 50) < 0.5, o["td2m"])

print("\n4. packing")
spec = ef.FIELDS["t2m"]
v = np.array([[[-40.0, 0.0], [72.37, np.nan]]])
back = ef.unpack(ef.pack(v, spec), spec, v.shape)
ok("round trips within half a step, missing stays missing",
   np.allclose(back[~np.isnan(v)], v[~np.isnan(v)], atol=spec["scale"] / 2) and np.isnan(back[0, 1, 1]), back)
TOP = {"t2m": 140, "td2m": 100, "wind10": 250, "gust": 300, "mslp": 1090, "h500": 620, "t850": 45,
       "qpf": 60, "cape": 10000, "ptype": 4}
LOW = {"t2m": -80, "td2m": -90, "mslp": 910, "h500": 460, "t850": -55}
ok("every field's real range fits in 16 bits",
   all(s["offset"] + 65534 * s["scale"] >= TOP[k] and s["offset"] <= LOW.get(k, 0) for k, s in ef.FIELDS.items()))

print("\n5. a run")
calls = []


def fake(mem, fhr):
    calls.append((mem, fhr))
    if fhr > 12:
        return None                                   # not published yet
    k = int(mem[-2:])
    shape = (len(tlats), len(tlons))
    raw = {"t2m": np.full(shape, 273.15 + k), "u10": np.full(shape, 1.0), "v10": np.zeros(shape),
           "tp": np.full(shape, 25.4 * (k + 1)), "crain": np.ones(shape)}
    # Member 1 publishes 6 hour buckets; the others running totals.
    return raw, {"tp_start": (fhr - 6) if k == 1 else 0, "tp_units_m": False}


ef.ENSEMBLES["test"] = {"label": "Test ENS", "kind": "noaa", "cycle_h": 6, "lag_h": 6,
                        "members": ["gep00", "gep01", "gep02"], "steps": [6, 12, 18, 24]}
ef.FIELDS_T = ef.FIELDS
man = ef.build("test", "20260924", "12", fetch=fake, workers=2)
run_dir = os.path.join(tmp, "ens", "test", "20260924_12")
ok("stops at the first hour nobody has published", man["hours"] == [6, 12] and not any(h == 24 for _m, h in calls), man["hours"])
ok("writes a file per field per hour", sorted(os.listdir(run_dir)) == sorted(
    ["manifest.json"] + [f"{n}_f{h:03d}.bin.gz" for n in ("t2m", "wind10", "qpf", "ptype") for h in (6, 12)]), sorted(os.listdir(run_dir)))
blob = open(os.path.join(run_dir, "t2m_f012.bin.gz"), "rb").read()
arr = ef.unpack(blob, ef.FIELDS["t2m"], (3, 71, 141))
ok("members in order, each its own value", np.allclose(arr[:, 10, 10], [32, 33.8, 35.6], atol=0.05), arr[:, 10, 10])
q = ef.unpack(open(os.path.join(run_dir, "qpf_f012.bin.gz"), "rb").read(), ef.FIELDS["qpf"], (3, 71, 141))
ok("rain is a running total, from buckets or from totals", np.allclose(q[:, 0, 0], [1.0, 4.0, 3.0], atol=0.001), q[:, 0, 0])
m = json.load(open(os.path.join(run_dir, "manifest.json")))
ok("the manifest describes the grid, members, fields and scaling",
   m["grid"]["nx"] == 141 and m["grid"]["ny"] == 71 and m["members"] == ["gep00", "gep01", "gep02"]
   and m["fields"]["t2m"]["scale"] == 0.05 and m["complete"] and m["base"] == "2026-09-24T12:00:00Z", m)
idx = json.load(open(os.path.join(tmp, "ens", "index.json")))
ok("the index names the run, its hours and fields", idx["models"]["test"]["run"] == "20260924_12"
   and idx["models"]["test"]["hours"] == [6, 12] and idx["models"]["test"]["complete"], idx)
ok("a finished run is not built twice", ef.already_built("test", "20260924_12"))
os.makedirs(os.path.join(tmp, "ens", "test", "20260923_12"))
ef.build("test", "20260924", "18", fetch=fake, workers=2)
ok("older runs are pruned", sorted(os.listdir(os.path.join(tmp, "ens", "test"))) == ["20260924_18"],
   os.listdir(os.path.join(tmp, "ens", "test")))
ok("gzip is plain gzip the browser can open", gzip.decompress(blob)[:2] is not None)

print("\n6. one point, every member (the meteogram)")
pt = ef.point_series("test", 38.1, -95.2)
ok("snaps to the nearest grid point", pt["lat"] == 38.0 and pt["lon"] == -95.0, (pt["lat"], pt["lon"]))
ok("every member at every hour", pt["hours"] == [6, 12] and len(pt["fields"]["t2m"]) == 2 and len(pt["fields"]["t2m"][1]) == 3, pt["fields"]["t2m"])
ok("in the site's units", [round(v, 1) for v in pt["fields"]["t2m"][1]] == [32.0, 33.8, 35.6] and pt["fields"]["qpf"][1] == [1.0, 4.0, 3.0], pt["fields"])
ok("the second ask is answered from memory", ef.point_series("test", 38.1, -95.2) is pt)
try:
    ef.point_series("test", 10, -95)
    ok("a point off the grid is refused", False)
except ValueError:
    ok("a point off the grid is refused", True)
srv = open(os.path.join(ROOT, "pi/serve.py")).read()
ok("the /ens/point door", 'head == "/ens/point"' in srv and "ef.point_series(model, lat, lon)" in srv)

print("\n6. the ensembles and the timer")
ok("GEFS 31, GEPS 21, SREF 26 and ECMWF ENS 51 members",
   [len(ef.ENSEMBLES[k]["members"]) for k in ("gefs", "geps", "sref", "ecmwfens")] == [31, 21, 26, 51])
ok("SREF runs at 03, 09, 15 and 21z", ef.newest_cycle(ef.ENSEMBLES["sref"], __import__("datetime").datetime(
    2026, 9, 24, 13, tzinfo=__import__("datetime").timezone.utc))[1] == "03")
inst = open(os.path.join(ROOT, "pi/install.sh")).read()
ok("installed as its own timer", "gwcfc-ensfields.service" in inst and "enable --now gwcfc-ensfields.timer" in inst
   and "pi/ens_fields_pipeline.py" in inst)

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
