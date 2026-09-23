#!/usr/bin/env python3
"""
Ocean depth (HYCOM) in the SST pipeline: water temperature below the surface.

    python3 tools/test-ocean-depth.py

Nothing here touches the network. A fake HYCOM dataset stands in for the
OPeNDAP server, shaped like the real one: a 1/12 degree grid, forty depths,
a time axis that runs a week into the forecast, and land masked out. Checked:
seven depth products are declared, each with its shading span; the time step
nearest now is picked (not the last one, which is next week); the nearest
depth is used, and a server without anything near the asked depth is refused;
the grid comes back at a quarter degree; land and fill values become NaN; a
first address that is down falls through to the second; and a whole pass
writes the value-encoded PNG and a manifest entry the site can read.
"""

import datetime as dt
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
    import numpy as np
    from PIL import Image
except ImportError as e:
    print(f"skipping: {e} (numpy and Pillow are needed)")
    sys.exit(0)

import sst_pipeline as sp  # noqa: E402


class Var:
    def __init__(self, data, **attrs):
        self.data = data
        self.ndim = data.ndim
        self.reads = []
        for k, v in attrs.items():
            setattr(self, k, v)

    def __getitem__(self, key):
        self.reads.append(key)
        return self.data[key]


class FakeHycom:
    """A small stand-in for the real grid: 1/12 degree over a patch of ocean."""
    def __init__(self, now):
        lat = np.arange(10.0, 15.0 + 1e-9, 1 / 12)          # 61 rows
        lon = np.arange(260.0, 268.0 + 1e-9, 1 / 12)        # 97 cols, 0-360 like HYCOM
        depth = np.array([0, 2, 4, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80,
                          90, 100, 125, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900,
                          1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000], dtype=float)
        epoch = dt.datetime(2000, 1, 1)
        hours_now = (now - epoch).total_seconds() / 3600
        # Three analysis days back, then a week of forecast ahead, every 6 h.
        t = np.arange(hours_now - 72, hours_now + 168 + 1, 6.0)
        self.now_i = int(np.argmin(np.abs(t - hours_now)))
        # The temperature: warm at the surface, cooling with depth, and each
        # time step marked so the test can tell which one was read.
        T = np.empty((len(t), len(depth), len(lat), len(lon)), dtype=np.float32)
        for di, d in enumerate(depth):
            T[:, di] = 29.0 - 20.0 * (1 - np.exp(-d / 300.0))
        T += (np.arange(len(t)) * 0.001)[:, None, None, None]
        # Land in the north west corner, and one fill value in the water.
        T[:, :, 50:, :15] = -30000.0
        T[:, :, 5, 5] = -30000.0
        data = np.ma.masked_equal(T, -30000.0)
        self.variables = {
            "water_temp": Var(data, _FillValue=np.float32(-30000.0), units="degC"),
            "lat": Var(lat), "lon": Var(lon), "depth": Var(depth),
            "time": Var(t, units="hours since 2000-01-01 00:00:00"),
        }
        self.closed = False

    def close(self):
        self.closed = True


NOW = dt.datetime(2026, 9, 23, 13, 0)

print("\n1. the products")
ok("seven depths, surface to 1,000 m",
   sp.SOURCES["hycom"]["variants"] == ["t0", "t50", "t100", "t200", "t300", "t500", "t1000"],
   str(sp.SOURCES["hycom"]["variants"]))
spec = sp.variant_spec("hycom", "t500")
ok("each says its depth and the span to shade it across", spec["depth"] == 500 and spec["shade"] == (-2.0, 18.0), str(spec))
ok("encoded across a range sea water cannot leave", spec["range"] == (-4.0, 36.0))

print("\n2. reading one depth")
fake = FakeHycom(NOW)
arr, lats, lons, got = sp.read_hycom(fake, 100, now=NOW)
key = fake.variables["water_temp"].reads[-1]
ok("the time step nearest now, not the last one (next week)", key[0] == fake.now_i, f"{key[0]} vs {fake.now_i}")
ok("the depth asked for", got == 100.0 and key[1] == 19, f"{got} {key[1]}")
ok("a quarter degree grid crosses the network, not 1/12",
   key[2] == slice(None, None, 3) and key[3] == slice(None, None, 3) and abs(lats[1] - lats[0] - 0.25) < 1e-9, str(key))
ok("the shape matches the axes", arr.shape == (len(lats), len(lons)), f"{arr.shape} {len(lats)} {len(lons)}")
exp = 29.0 - 20.0 * (1 - np.exp(-100 / 300.0))
ok("the value is the water temperature at that depth", abs(float(np.nanmean(arr)) - exp) < 0.2, f"{np.nanmean(arr):.2f} vs {exp:.2f}")
ok("land comes back as NaN", np.isnan(arr[-1, 0]) and np.isfinite(arr[0, -1]))
_, _, _, got_deep = sp.read_hycom(FakeHycom(NOW), 1000, now=NOW)
ok("1,000 m reads the 1,000 m level", got_deep == 1000.0)

print("\n3. fetching, with the addresses tried in turn")
opened = []


def opener(url):
    opened.append(url)
    if url == sp.HYCOM_URLS[0]:
        raise OSError("server down")
    return FakeHycom(NOW)


a2, la2, lo2 = sp.build_hycom("t200", open_ds=opener, now=NOW)
ok("the first address down, the second is used", opened == sp.HYCOM_URLS[:2] and a2.size > 0, str(opened))


class Shallow(FakeHycom):
    def __init__(self, now):
        super().__init__(now)
        self.variables["depth"] = Var(np.array([0.0, 10.0, 20.0]))


try:
    sp.build_hycom("t1000", open_ds=lambda u: Shallow(NOW), now=NOW)
    refused = False
except RuntimeError as e:
    refused = "1000" in str(e)
ok("a server with nothing near the asked depth is refused, not mislabelled", refused)
try:
    sp.build_hycom("t50", open_ds=lambda u: (_ for _ in ()).throw(OSError("offline")), now=NOW)
    said = False
except RuntimeError as e:
    said = "could not be reached" in str(e)
ok("every address down says so", said)

print("\n4. a whole pass writes what the site reads")
tmp = tempfile.mkdtemp()
sp.OUT_DIR = tmp
real = sp.build_hycom
sp.build_hycom = lambda variant: real(variant, open_ds=lambda u: FakeHycom(NOW), now=NOW)
sp.prune = lambda: None
built = sp.build_pass("hycom", None, dt.date(2026, 9, 23), budget=120)
sp.build_hycom = real
idx = json.load(open(os.path.join(tmp, "index.json")))
ent = idx["sources"]["hycom"]
ok("all seven depths built", built == 7 and sorted(ent["variants"]) == sorted(sp.HYCOM_VARIANTS), f"{built} {sorted(ent['variants'])}")
v = ent["variants"]["t300"]
ok("the manifest carries the depth, the shade span and the frame",
   v["depth"] == 300 and v["shade"] == [-2.0, 24.0] and v["frames"] == ["20260923"], json.dumps(v)[:200])
img = Image.open(os.path.join(tmp, "hycom", "t300", "20260923.png"))
px = np.asarray(img)
ok("an RGBA picture whose pixels are the numbers", img.mode == "RGBA" and px.shape[2] == 4)
lo, hi = v["range"]
water = px[0, -1].astype(int)
val = lo + (water[0] * 256 + water[1]) / 65535 * (hi - lo)
exp300 = 29.0 - 20.0 * (1 - np.exp(-300 / 300.0))
ok("decoding a pixel gives the temperature back", abs(val - exp300) < 0.05, f"{val:.3f} vs {exp300:.3f}")
ok("land is transparent", px[-1, 0][3] == 0 or px[0, 0][3] == 0)
ok("the bounds are the grid's", v["bounds"][0][0] == 10.0 and v["bounds"][1][0] >= 14.9, str(v["bounds"]))

src = open(os.path.join(ROOT, "pi", "sst_pipeline.py"), encoding="utf8").read()
EM = chr(0x2014)
ok("no em dashes", EM not in src and EM not in open(__file__, encoding="utf8").read())

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
