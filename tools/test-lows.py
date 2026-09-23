#!/usr/bin/env python3
"""
Low pressure tracks and centres: the files behind the Low Tracks overlay.

    python3 tools/test-lows.py

Nothing here touches the network. Checked: the compact file format and the
index the site reads, with several models side by side and old runs pruned;
a fast mid latitude low (50 kt) stays one track with the looser lows speed
ceiling, where the tropical 40 kt ceiling would have broken it; GFS's .idx is
read for the pressure record's byte range; a deterministic run is built from
its forecast hours with a missing hour skipped; and the GEFS and ECMWF
ensemble pipelines now also write every low, not only the tropical ones.
"""

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "pi"))

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


try:
    import numpy as np  # noqa: F401
    import scipy  # noqa: F401
except ImportError as e:
    print(f"skipping: {e}")
    sys.exit(0)

import enscenters_pipeline as ens  # noqa: E402
import lows_pipeline as lp  # noqa: E402

tmp = tempfile.mkdtemp()
ens.LOWS_DIR = os.path.join(tmp, "lows")


def moving_low(step, speed_kt=50, lat=40.0, lon0=-100.0, p0=1000.0):
    """A low running east at speed_kt, deepening 1 hPa every 6 h."""
    km = speed_kt * 1.852 * step
    return {"lat": lat, "lon": lon0 + km / (111.0 * 0.766), "mslp_hpa": p0 - step / 6, "vmax_kt": 30}


print("\n1. stitching a fast mid latitude low")
by_step = {s: [moving_low(s)] for s in range(0, 49, 6)}
ok("the tropical ceiling (40 kt) breaks a 50 kt low into pieces", len(ens.stitch(by_step, 6)) != 1)
tr = ens.stitch(by_step, 6, ens.LOWS_MAX_KT)
ok("the lows ceiling keeps it one track", len(tr) == 1 and len(tr[0]["points"]) == 9, str(len(tr)))

print("\n2. the file and the index")
pay = ens.write_lows("gfs", "GFS", "20260923_00", "2026-09-23T00:00:00Z", 1, 6, 48,
                     [{"member": 0, **tr[0]}], "deterministic")
ok("each point is [hour, lat, lon, hPa], compact", pay["tracks"][0]["p"][0] == [0, 40.0, -100.0, 1000.0]
   and pay["tracks"][0]["m"] == 0, str(pay["tracks"][0]["p"][:2]))
ens.write_lows("gefs", "GEFS ensemble", "20260923_00", "2026-09-23T00:00:00Z", 31, 6, 48,
               [{"member": 3, **tr[0]}], "ensemble")
idx = json.load(open(os.path.join(ens.LOWS_DIR, "latest.json")))
ok("the index lists both models, each with its file", sorted(idx["models"]) == ["gefs", "gfs"]
   and idx["models"]["gefs"]["path"] == "lows/gefs_20260923_00.json" and idx["models"]["gefs"]["kind"] == "ensemble",
   json.dumps(idx)[:200])
for run in ("20260923_06", "20260923_12"):
    ens.write_lows("gfs", "GFS", run, "x", 1, 6, 48, [], "deterministic")
left = sorted(f for f in os.listdir(ens.LOWS_DIR) if f.startswith("gfs_"))
ok("only the newest two runs of a model are kept", left == ["gfs_20260923_06.json", "gfs_20260923_12.json"], str(left))
ok("and the other model's file is untouched", os.path.exists(os.path.join(ens.LOWS_DIR, "gefs_20260923_00.json")))

print("\n3. GFS's index")
idx_text = "\n".join([
    "1:0:d=2026092300:PRES:surface:anl:",
    "2:52000:d=2026092300:PRMSL:mean sea level:anl:",
    "3:98000:d=2026092300:HGT:500 mb:anl:",
])
ok("the pressure record's byte range", lp.gfs_prmsl_range(idx_text) == (52000, 97999), str(lp.gfs_prmsl_range(idx_text)))
ok("an index without it is None", lp.gfs_prmsl_range("1:0:d=x:TMP:2 m above ground:anl:") is None)

print("\n4. a deterministic run")


def step_fn(s):
    if s == 12:
        return None                                      # not published yet
    return [moving_low(s), {"lat": 20.0, "lon": -60.0, "mslp_hpa": 1008.0, "vmax_kt": 25}]


out = lp.build("ecmwf", "20260923", "12", step_fn=step_fn, verbose=False)
ok("built, deterministic, one member", out and out["kind"] == "deterministic" and out["members"] == 1)
ok("a missing hour is skipped, the track carries on across it",
   any(len(t["p"]) >= 20 for t in out["tracks"]), str([len(t["p"]) for t in out["tracks"]]))
ok("two lows, two tracks", len(out["tracks"]) == 2, str(len(out["tracks"])))
ok("and it is recorded as built", lp.already_built("ecmwf", "20260923_12"))
ok("nothing readable writes nothing", lp.build("gfs", "20260923", "18", step_fn=lambda s: None, verbose=False) is None)

print("\n5. the GEFS pipeline keeps every low now")
calls = {"n": 0}
ens_fetch, ens_decode, ens_detect, ens_warm = ens.fetch_records, ens.decode, ens.detect_centers, ens.filter_warm
ens.fetch_records = lambda *a: True
ens.decode = lambda p: (None, None, None, None)
ens.detect_centers = lambda *a, **k: [moving_low(calls.setdefault("s", 0))]


def fake_detect(mslp, lats, lons, _state={"s": -6}):
    _state["s"] += 6
    if _state["s"] > 24:
        _state["s"] = 0
    return [moving_low(_state["s"])]


ens.detect_centers = fake_detect
ens.filter_warm = lambda centers, *a, **k: []            # nothing tropical at all
ens.OUT_DIR = tmp
try:
    ens.build("20260923", "06", 6, 24, ["gec00", "gep01"], verbose=False)
finally:
    ens.fetch_records, ens.decode, ens.detect_centers, ens.filter_warm = ens_fetch, ens_decode, ens_detect, ens_warm
idx = json.load(open(os.path.join(ens.LOWS_DIR, "latest.json")))
g = idx["models"].get("gefs", {})
ok("with no tropical storms at all, the lows are still written", g.get("run") == "20260923_06", json.dumps(g)[:200])
gf = json.load(open(os.path.join(ens.LOWS_DIR, "gefs_20260923_06.json")))
ok("one track per member, numbered 0 (control) and 1", sorted(t["m"] for t in gf["tracks"]) == [0, 1],
   str([t["m"] for t in gf["tracks"]]))

print("\n6. the ECMWF ensemble pipeline too")
import ecmwf_tc_pipeline as etc  # noqa: E402
etc.OUT_DIR = os.path.join(tmp, "ecmwf")


def fake_step(session, date_str, cyc, step, members, all_out=None):
    if step > 24:
        return None
    lows = {m: [moving_low(step, lat=45.0 + m)] for m in range(3)}
    if all_out is not None:
        all_out.update(lows)
    return {m: [] for m in range(3)}


real = etc.step_centers
etc.step_centers = fake_step
etc.requests = type("R", (), {"Session": staticmethod(lambda: None)})
try:
    etc.build("20260923", "00", 12, 48, 3, verbose=False)
finally:
    etc.step_centers = real
idx = json.load(open(os.path.join(ens.LOWS_DIR, "latest.json")))
e = idx["models"].get("ecmwf-ens", {})
ok("ECMWF ensemble lows are written beside its cyclone maps", e.get("kind") == "ensemble" and e.get("members") == 3, json.dumps(e)[:200])

EM = chr(0x2014)
srcs = [open(os.path.join(ROOT, "pi", f), encoding="utf8").read() for f in
        ("lows_pipeline.py", "enscenters_pipeline.py", "ecmwf_tc_pipeline.py")]
ok("no em dashes", all(EM not in x for x in srcs) and EM not in open(__file__, encoding="utf8").read())

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
