#!/usr/bin/env python3
"""
ECMWF ensemble tropical cyclone probabilities (pi/ecmwf_tc_pipeline.py).

    python3 tools/test-ecmwf-tc.py

Nothing here touches the network. Checked: ECMWF's index is read and the
three records are picked for every member (the control included); a member
missing one is left out; a byte range is cut correctly even from a server
that ignores Range; tracks are filled in between forecast hours; the strike
probability is the share of members that pass within 120 km, for each
strength and time window; "existing" drops the storms that form later
(genesis) and "all" keeps them; and a whole run writes the greyscale maps and
the manifest the site reads.
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
    from PIL import Image
except ImportError as e:
    print(f"skipping: {e} (numpy, scipy and Pillow are needed)")
    sys.exit(0)

import ecmwf_tc_pipeline as tc  # noqa: E402

print("\n1. where the files are")
ok("the ensemble's file for a forecast hour",
   tc.file_url(tc.BASES[0], "20260923", "00", 120)
   == "https://data.ecmwf.int/forecasts/20260923/00z/ifs/0p25/enfo/20260923000000-120h-enfo-ef.grib2")
ok("its index beside it", tc.index_url(tc.BASES[1], "20260923", "12", 0).endswith("/20260923/12z/ifs/0p25/enfo/20260923120000-0h-enfo-ef.index"))
import datetime as dt  # noqa: E402
ok("the newest complete run, nine hours back, on the 00z/12z clock",
   tc.newest_cycle(dt.datetime(2026, 9, 23, 20, 0, tzinfo=dt.timezone.utc)) == ("20260923", "00")
   and tc.newest_cycle(dt.datetime(2026, 9, 23, 5, 0, tzinfo=dt.timezone.utc)) == ("20260922", "12"))

print("\n2. the index: three records per member")


def row(**k):
    base = {"domain": "g", "stream": "enfo", "step": "0", "_offset": 0, "_length": 10}
    base.update(k)
    return json.dumps(base)


lines = [
    row(type="cf", param="msl", levtype="sfc", _offset=0, _length=10),
    row(type="cf", param="gh", levtype="pl", levelist="300", _offset=10, _length=10),
    row(type="cf", param="gh", levtype="pl", levelist="500", _offset=20, _length=10),
    row(type="cf", param="gh", levtype="pl", levelist="850", _offset=30, _length=10),
    row(type="pf", number="1", param="msl", levtype="sfc", _offset=40, _length=10),
    row(type="pf", number="1", param="gh", levtype="pl", levelist="300", _offset=50, _length=10),
    row(type="pf", number="1", param="gh", levtype="pl", levelist="500", _offset=60, _length=10),
    row(type="pf", number="2", param="msl", levtype="sfc", _offset=70, _length=10),   # missing gh
    "not json", "",
]
rows = tc.parse_index("\n".join(lines))
ok("every JSON line is read, junk is skipped", len(rows) == 8, str(len(rows)))
w = tc.wanted_rows(rows, 51)
ok("the control is member 0", 0 in w and [r["param"] for r in w[0]] == ["msl", "gh", "gh"], str(w.get(0)))
ok("the 850 mb height is not one of the three", all(r.get("levelist") != "850" for rs in w.values() for r in rs))
ok("a member missing a record is left out rather than half read", 2 not in w and 1 in w, str(sorted(w)))
ok("--members caps it", sorted(tc.wanted_rows(rows, 1)) == [0])

print("\n3. byte ranges")


class Resp:
    def __init__(self, code, content=b"", text=""):
        self.status_code, self.content, self.text = code, content, text


class Session:
    def __init__(self, honour):
        self.honour, self.asked = honour, []

    def get(self, url, headers=None, timeout=None):
        blob = bytes(range(100))
        rng = (headers or {}).get("Range")
        self.asked.append(rng)
        if rng and self.honour:
            a, b = rng[6:].split("-")
            return Resp(206, blob[int(a):int(b) + 1])
        return Resp(200, blob)


s = Session(True)
got = tc.fetch_member(s, "u", w[1])
ok("one range request per record", s.asked == ["bytes=40-49", "bytes=50-59", "bytes=60-69"], str(s.asked))
ok("and the bytes are the records", got[0] == bytes(range(40, 50)) and got[2] == bytes(range(60, 70)))
got2 = tc.fetch_member(Session(False), "u", w[1])
ok("a server that ignores Range still yields just the record", got2[1] == bytes(range(50, 60)), str(got2[1][:4]))

print("\n4. tracks are filled in between forecast hours")
pts = [{"step_h": 0, "lat": 15.0, "lon": -60.0, "vmax_kt": 30},
       {"step_h": 12, "lat": 15.0, "lon": -55.0, "vmax_kt": 50}]
d = tc.densify(pts)
ok("a 537 km leg becomes points about 40 km apart", 13 <= len(d) <= 16, str(len(d)))
mid = d[len(d) // 2]
ok("with the time and strength in between too", 5 < mid[0] < 7 and 38 < mid[3] < 42, str(mid))
wrap = tc.densify([{"step_h": 0, "lat": 10, "lon": 179, "vmax_kt": 30},
                   {"step_h": 12, "lat": 10, "lon": -179, "vmax_kt": 30}])
ok("across the date line it takes the short way", all(abs(p[2]) >= 178.9 for p in wrap), str([round(p[2], 1) for p in wrap]))

print("\n5. strike probability")
lats, lons = tc.grid_axes()
ok("a half degree grid from 60S to 60N", len(lats) == 240 and len(lons) == 720)


def track(start_h, lat, lon0, vmax, steps=21, dlon=1.0):
    return {"points": [{"step_h": start_h + 12 * i, "lat": lat, "lon": lon0 + dlon * i, "vmax_kt": vmax}
                       for i in range(steps) if start_h + 12 * i <= 240]}


def cell(grid, lat, lon):
    i = int((tc.LAT_N - lat) / tc.GRID_DEG)
    j = int((lon + 180) / tc.GRID_DEG)
    return int(grid[i, j])


# 51 members. 40 carry an existing storm west along 15N from 60W, 20 of them
# strong enough to be a hurricane. 30 also form a new storm at 120 h at 20N 40W.
members = {}
for m in range(51):
    tr = []
    if m < 40:
        tr.append(track(0, 15.0, -60.0, 70 if m < 20 else 40, dlon=-1.0))
    if m < 30:
        tr.append(track(120, 20.0, -40.0, 45, steps=8, dlon=0.5))
    members[m] = tr
p_all = tc.probability(members, 51, (0, 240), 0.0, "all")
p_ts = tc.probability(members, 51, (0, 240), 34.0, "all")
p_hu = tc.probability(members, 51, (0, 240), 64.0, "all")
p_ex = tc.probability(members, 51, (0, 240), 0.0, "existing")
p_48 = tc.probability(members, 51, (0, 48), 0.0, "all")
ok("on the track: 40 of 51 members is 78%", cell(p_all, 15.0, -65.0) == 78, str(cell(p_all, 15.0, -65.0)))
ok("100 km off the track still counts (inside 120 km)", cell(p_all, 15.9, -65.0) == 78, str(cell(p_all, 15.9, -65.0)))
ok("300 km off it does not", cell(p_all, 17.8, -65.0) == 0, str(cell(p_all, 17.8, -65.0)))
ok("the hurricane map counts only the 20 hurricanes: 39%", cell(p_hu, 15.0, -65.0) == 39, str(cell(p_hu, 15.0, -65.0)))
ok("the tropical storm map counts all 40 (they are all 34 kt or more)", cell(p_ts, 15.0, -65.0) == 78)
ok("genesis: the storm that forms later shows on the 'all' map, 30 of 51",
   cell(p_all, 20.0, -38.0) == 59, str(cell(p_all, 20.0, -38.0)))
ok("and not on the 'existing' map", cell(p_ex, 20.0, -38.0) == 0 and cell(p_ex, 15.0, -65.0) == 78)
ok("the 48 hour window only reaches as far as the storm has gone by then",
   cell(p_48, 15.0, -63.0) == 78 and cell(p_48, 15.0, -70.0) == 0, f"{cell(p_48, 15.0, -63.0)} {cell(p_48, 15.0, -70.0)}")
ok("empty ocean is 0", cell(p_all, -20.0, 80.0) == 0)

print("\n6. a whole run, with the downloads stubbed")
tmp = tempfile.mkdtemp()
tc.OUT_DIR = os.path.join(tmp, "ecmwf")


def fake_centers(step):
    if step > 96:
        return None                                 # not published past 96 h
    out = {}
    for m in range(51):
        cs = []
        if m < 40:
            cs.append({"lat": 15.0, "lon": -60.0 - step / 12.0, "mslp_hpa": 990.0, "vmax_kt": 55.0})
        out[m] = cs
    return out


man = tc.build("20260923", "00", 12, 240, 51, centers_fn=fake_centers, verbose=False)
ok("it finishes and reports what it read", man and man["members"] == 51 and man["out_h"] == 96, json.dumps(man)[:200] if man else "")
ok("windows are cut to what was published", man["windows"] == [[0, 48], [0, 96]], str(man["windows"]))
ok("three strengths x two scopes x two windows = 12 maps", len(man["products"]) == 12, str(len(man["products"])))
latest = json.load(open(os.path.join(tc.OUT_DIR, "latest.json")))
ok("latest.json is the manifest", latest["run"] == "20260923_00" and latest["base"] == "2026-09-23T00:00:00Z")
p = latest["products"]["ts_all_0_96"]
img = Image.open(os.path.join(tc.OUT_DIR, p["path"]))
ok("each map is a 720 x 240 greyscale picture", img.size == (720, 240) and img.mode == "L", f"{img.size} {img.mode}")
arr = np.asarray(img)
ok("whose pixels are the percentages", cell(arr, 15.0, -62.0) == 78 and p["max"] == 78, f"{cell(arr, 15.0, -62.0)} {p['max']}")
ok("the hurricane map is empty (55 kt storms)", latest["products"]["hu_all_0_96"]["max"] == 0)
tr = json.load(open(os.path.join(tc.OUT_DIR, latest["tracks"])))
ok("the tracks are kept too, one per member that had a storm", len(tr["tracks"]) == 40, str(len(tr["tracks"])))
ok("nothing to read writes nothing", tc.build("20260923", "12", 12, 24, 51, centers_fn=lambda s: None, verbose=False) is None)

src = open(os.path.join(ROOT, "pi", "ecmwf_tc_pipeline.py"), encoding="utf8").read()
EM = chr(0x2014)
ok("no em dashes", EM not in src and EM not in open(__file__, encoding="utf8").read())

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
