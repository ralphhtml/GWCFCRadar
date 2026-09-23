#!/usr/bin/env python3
"""
Cloud-top heights for Satellite 3D.

    python3 tools/test-sat-cth.py

Pins which spacecraft and sector a zone is read from, the regridder's
geometry, the ACHA + infrared height fit (and its fallback to the standard
atmosphere), the wire encoding, the ACHA file matching against a stubbed
bucket, the frame builder end to end with the file reader stubbed out, and
the serve.py doors' validation. No netCDF4 needed.
"""

import os
import sys
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "pi"))

import numpy as np  # noqa: E402

import sat_cth as sc  # noqa: E402

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


print("\n1. which spacecraft, which sector")
ok("a zone over Georgia is GOES-East", sc.post_for(-85, -80) == "east")
ok("a zone over California is GOES-West", sc.post_for(-122, -116) == "west")
ok("Georgia sits inside East's CONUS sector", sc.sector_for("east", 30, -86, 35, -80) == "conus")
ok("the mid Atlantic is outside it: full disk", sc.sector_for("east", 30, -60, 35, -50) == "fulldisk")
ok("Hawaii is outside West's CONUS sector", sc.sector_for("west", 18, -160, 23, -154) == "fulldisk")

print("\n2. the mesh is about 2 km cells, clamped")
nx, ny = sc.grid_size(33, -85, 34, -84)
ok("a one-degree box is roughly 46 x 56 cells", 40 <= nx <= 50 and 52 <= ny <= 60, f"{nx}x{ny}")
ok("a tiny box is never below the floor", sc.grid_size(33, -85, 33.01, -84.99) == (16, 16))
ok("a huge box is never above the cap", max(sc.grid_size(10, -120, 35, -85)) == 220)

print("\n3. the regridder puts samples in the right cells, north up")
bbox = (30.0, -90.0, 40.0, -80.0)
lats = np.array([39.5, 30.5, 35.0])
lons = np.array([-89.5, -80.5, -85.0])
vals = np.array([1.0, 2.0, 3.0])
g = sc.grid_into(vals, lats, lons, bbox, 10, 10)
ok("the north west sample lands in row 0, column 0", g[0, 0] == 1.0, str(g[0, 0]))
ok("the south east sample lands in the last row and column", g[9, 9] == 2.0, str(g[9, 9]))
ok("the centre sample lands in the middle", g[5, 5] == 3.0, str(g[5, 5]))
ok("a sample outside the box is dropped",
   not np.isfinite(sc.grid_into(np.array([5.0]), np.array([50.0]), np.array([-85.0]), bbox, 4, 4)).any())
dense_la, dense_lo = np.meshgrid(np.linspace(30.05, 39.95, 40), np.linspace(-89.95, -80.05, 40))
dense = sc.grid_into(np.ones(dense_la.size), dense_la.ravel(), dense_lo.ravel(), bbox, 20, 20)
ok("a dense scan leaves no pinholes", np.isfinite(dense).all())

print("\n4. heights: ACHA calibrates the infrared, else the standard atmosphere")
rng = np.random.default_rng(1)
bt = np.full((40, 40), 295.0)
bt[5:30, 5:30] = rng.uniform(210.0, 270.0, (25, 25))
true_a, true_b = 78000.0, -150.0  # 150 m higher per kelvin colder
acha = np.where(bt < 285.0, true_a + true_b * bt, np.nan)
h, info = sc.heights(bt, acha)
ok("with ACHA the fit is used", info["source"] == "acha+ir", str(info))
ok("and it recovers the slope", abs(info["b"] - true_b) < 1.0, str(info["b"]))
ok("clear ground is height 0", h[0, 0] == 0.0 and h[35, 35] == 0.0)
cold = np.unravel_index(np.argmin(bt), bt.shape)
ok("the coldest top is the highest, capped near ACHA's own top",
   h[cold] == h.max() and h.max() <= np.nanmax(acha) + 1500.0, f"{h.max()}")
h2, info2 = sc.heights(bt, None)
ok("without ACHA the infrared alone is used", info2["source"] == "ir" and info2["pairs"] == 0)
ok("at the standard lapse rate (about 154 m per kelvin)", abs(info2["b"] + 1 / 0.0065) < 0.01)
ok("a 220 K top is 11 to 12 km there",
   11000 < info2["a"] + info2["b"] * 220.0 < 12500, str(info2["a"] + info2["b"] * 220.0))
bad = np.where(bt < 285.0, 2000.0 + 10.0 * bt, np.nan)  # warmer is higher: nonsense
_, info3 = sc.heights(bt, bad)
ok("an ACHA fit where warmer is higher is not trusted", info3["source"] == "ir", str(info3))
few = np.full_like(bt, np.nan)
few[5, 5:15] = true_a + true_b * bt[5, 5:15]
_, info4 = sc.heights(bt, few)
ok("ten pairs is too few to fit", info4["source"] == "ir" and info4["pairs"] == 10, str(info4))
clear, _ = sc.heights(np.full((20, 20), 290.0), None)
ok("a clear sky is flat", not clear.any())
empty, info5 = sc.heights(np.full((8, 8), np.nan), None)
ok("a zone the scan missed is flat and says so", not empty.any() and info5["source"] == "none")

print("\n5. the wire format round trips")
hb, gb = sc.encode(h, bt)
back = sc.decode_heights(hb, 40, 40)
ok("heights come back to the metre", np.abs(back - np.round(h)).max() == 0)
import base64  # noqa: E402
grey = np.frombuffer(base64.b64decode(gb), dtype=np.uint8)
ok("the grey skin is one byte a cell", grey.size == 1600)
ok("cold cloud reads brighter than warm ground", grey[cold[0] * 40 + cold[1]] > grey[0])

print("\n6. the nearest ACHA file within twenty minutes")
calls = []


def fake_keys(bucket, prefix):
    calls.append(prefix)
    if not prefix.startswith("ABI-L2-ACHAC/2023/150/"):
        return []
    hh = prefix.rsplit("/", 2)[-2]
    out = []
    for mnt in ((26, 46) if hh == "12" else (6, 26, 46)):
        s = f"2023150{hh}{mnt:02d}17"
        out.append(f"ABI-L2-ACHAC/2023/150/{hh}/OR_ABI-L2-ACHAC-M6_G16_s{s}2_e{s}5_c{s}9.nc")
    out.append(f"ABI-L2-ACHAC/2023/150/{hh}/junk.nc")
    return out


k = sc.acha_key_for("noaa-goes16", "conus", "20231501231172", lister=fake_keys)
ok("a 12:31 scan pairs with the 12:26 ACHA, not the 12:46", k and "s20231501226" in k, str(k))
k = sc.acha_key_for("noaa-goes16", "conus", "20231501202172", lister=fake_keys)
ok("a 12:02 scan reaches back to 11:46 when 12:26 is too far", k and "s20231501146" in k, str(k))
k = sc.acha_key_for("noaa-goes16", "conus", "20231511231172", lister=fake_keys)
ok("no ACHA that day means none", k is None)
k = sc.acha_key_for("noaa-goes16", "conus", "junk", lister=fake_keys)
ok("a stamp that is not a stamp means none", k is None)
n0 = len(calls)
sc.acha_key_for("noaa-goes16", "conus", "20231501231172", lister=fake_keys)
ok("the listing is remembered, not fetched again", len(calls) == n0)

print("\n7. a frame is built end to end, then served from disk")
key = "ABI-L2-CMIPC/2023/150/12/OR_ABI-L2-CMIPC-M6C13_G16_s20231501231172_e20231501233556_c20231501234056.nc"
zb = (33.0, -86.0, 35.0, -83.0)
la, lo = np.meshgrid(np.linspace(33.01, 34.99, 80), np.linspace(-85.99, -83.01, 80), indexing="ij")
field_bt = np.where((la > 33.8) & (la < 34.4), 225.0, 293.0)
field_ht = np.where(field_bt < 280, 78000.0 - 300.0 * field_bt, np.nan)
real_read = sc.read_field
sc.read_field = lambda raw, var, bbox, keep_quality=True: (
    ((field_bt if var == "CMI" else field_ht).ravel(), la.ravel(), lo.ravel()))
cache = tempfile.mkdtemp()
try:
    fr = sc.build_frame("noaa-goes16", key, "conus", zb, cache_dir=cache,
                        fetch=lambda b, k: b"x", lister=fake_keys)
finally:
    sc.read_field = real_read
nx, ny = sc.grid_size(*zb)
ok("the frame carries its grid and rectangle", fr["w"] == nx and fr["h"] == ny
   and fr["bounds"] == [[33.0, -86.0], [35.0, -83.0]], f"{fr['w']}x{fr['h']} {fr['bounds']}")
ok("its moment is the scan's", fr["t"] == int(datetime(2023, 5, 30, 12, 31, 17,
                                                        tzinfo=timezone.utc).timestamp() * 1000))
ok("it names the ACHA file it used", fr["acha"] and "ACHAC" in fr["acha"], str(fr["acha"]))
fh = sc.decode_heights(fr["heights"], nx, ny)
ok("the cloud band stands up and the ground is flat",
   fh.max() > 8000 and fh[0, 0] == 0 and fh[-1, -1] == 0, f"max {fh.max()}")
fr2 = sc.build_frame("noaa-goes16", key, "conus", zb, cache_dir=cache,
                     fetch=lambda b, k: (_ for _ in ()).throw(RuntimeError("no")), lister=fake_keys)
ok("the same frame again comes from disk", fr2 == fr)

print("\n8. the zone door")
q = lambda d: (lambda k: d.get(k, ""))  # noqa: E731
ok("a sensible zone parses", sc.parse_bbox(q({"south": "33", "west": "-86", "north": "35", "east": "-83"}))
   == (33.0, -86.0, 35.0, -83.0))
for name, d in (("a missing edge", {"south": "33", "west": "-86", "north": "35"}),
                ("south above north", {"south": "35", "west": "-86", "north": "33", "east": "-83"}),
                ("off the earth", {"south": "33", "west": "-190", "north": "35", "east": "-83"}),
                ("too big a zone", {"south": "0", "west": "-120", "north": "40", "east": "-60"}),
                ("not a number", {"south": "nan", "west": "-86", "north": "35", "east": "-83"})):
    try:
        sc.parse_bbox(q(d))
        ok(name + " is refused", False)
    except ValueError:
        ok(name + " is refused", True)

print("\n9. the serve.py doors refuse bad asks before touching NOAA")
import serve  # noqa: E402


class Fake(serve.CORSHandler):
    def __init__(self, path):  # noqa: D107 - deliberately skips the socket setup
        self.path = path
        self.directory = tempfile.mkdtemp()
        self.replies = []

    def _reply_json(self, code, obj):
        self.replies.append((code, obj))


Z = "&south=33&west=-86&north=35&east=-83"
for name, path, fn in (
        ("an index with no zone", "/sat/cth/index?n=6", "_sat_cth_index"),
        ("an index before 2017", "/sat/cth/index?at=5" + Z, "_sat_cth_index"),
        ("an index with a word for n", "/sat/cth/index?n=six" + Z, "_sat_cth_index"),
        ("a frame from a stranger's bucket", "/sat/cth/frame?bucket=evil&sector=conus&key=" + key + Z, "_sat_cth_frame"),
        ("a frame whose key is a path", "/sat/cth/frame?bucket=noaa-goes16&sector=conus&key=../x" + Z, "_sat_cth_frame"),
        ("a frame of the wrong band", "/sat/cth/frame?bucket=noaa-goes16&sector=conus&key="
         + key.replace("M6C13", "M6C02") + Z, "_sat_cth_frame"),
        ("a frame of an unknown sector", "/sat/cth/frame?bucket=noaa-goes16&sector=meso&key=" + key + Z, "_sat_cth_frame"),
        ("a frame with no zone", "/sat/cth/frame?bucket=noaa-goes16&sector=conus&key=" + key, "_sat_cth_frame")):
    f = Fake(path)
    getattr(serve.CORSHandler, fn)(f)
    ok(name + " is a 400", f.replies and f.replies[0][0] == 400, str(f.replies))

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
