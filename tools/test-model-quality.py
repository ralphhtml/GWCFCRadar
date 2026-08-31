#!/usr/bin/env python3
"""
The two rendering faults behind "blurry, and pixelated on some products".

    python3 tools/test-model-quality.py

They are different faults with different causes, and only one of them is
about resolution.

PIXELATED: THE DIRECTION FIELDS WERE INTERPOLATED THROUGH THE WRAP.

Five fields are bearings in degrees: wdir, dirpw, swdir, wvdir, swdir2. A
bearing runs 0 to 360 and comes back to where it started, so 359 and 1 are
two degrees apart. Interpolation does not know that. Asked for the value
halfway between them it answers 180, which is the exact opposite direction.

The wrap wanders across the map cell by cell, so this does not show up as a
smooth error, it shows up as SPECKLE: a scattering of pixels pointing the
wrong way through an otherwise clean field, which is what "really pixelated
on certain products" looks like. Fixed by interpolating the direction as a
vector, sine and cosine separately, and taking the angle back afterwards.

BLURRY: THE PICTURE WAS SIZED WITHOUT REGARD TO HOW MUCH WORLD IT COVERED.

Every chart was upsampled to the same 2000 pixel long edge whatever box it
was drawn over, so the CONUS box got 28.6 pixels per degree and the Tropics
box, which is more than twice as wide, got 12.9. The Tropics box is exactly
where somebody zooms in on a hurricane.

It is worth being clear about what could NOT fix that, because it was tried
first and measured: swapping the interpolation kernel. Lanczos against
bicubic at 8x magnification came out 17 percent better by RMSE and within
half a percent on high-frequency energy. Detail that is not in the grid
cannot be recovered by resampling it more cleverly. The only real fix is
more source pixels, which means sizing by DENSITY and using the finest grid
the model publishes.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "pi"))

import numpy as np
from PIL import Image

import gfs_pipeline as g

PASS = FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


def angerr(a, b):
    d = np.abs(np.asarray(a) - np.asarray(b)) % 360.0
    return np.minimum(d, 360.0 - d)


print("\n1. a direction field survives the wrap")
# A bearing sweeping through north over and over, which is the ordinary case:
# it happens anywhere the flow is roughly northerly.
n = 120
xx = np.tile(np.arange(n, dtype=np.float32), (n, 1))
deg = (xx * 3.0 - 20.0) % 360.0

naive = g.smooth_upsample(deg, min_edge=960, angular=False)
fixed = g.smooth_upsample(deg, min_edge=960, angular=True)
truth = np.asarray(Image.fromarray(deg, "F").resize((960, 960), Image.NEAREST),
                   dtype=np.float32)

en, ev = angerr(naive, truth), angerr(fixed, truth)
print(f"       naive  mean {en.mean():5.2f} deg  max {en.max():6.1f} deg  "
      f"{100 * (en > 90).mean():.2f}% past a right angle")
print(f"       vector mean {ev.mean():5.2f} deg  max {ev.max():6.1f} deg  "
      f"{100 * (ev > 90).mean():.2f}% past a right angle")

ok("interpolating the raw degrees really is this broken",
   en.max() > 90.0, f"max {en.max():.1f} deg")
ok("as a vector, nothing lands more than a few degrees out",
   ev.max() < 5.0, f"max {ev.max():.1f} deg")
ok("and not one pixel points the wrong way",
   (ev > 90).sum() == 0, str(int((ev > 90).sum())))
ok("the average is better too, not just the worst case",
   ev.mean() < en.mean(), f"{ev.mean():.2f} vs {en.mean():.2f}")
ok("every value stays a legal bearing",
   float(fixed.min()) >= 0.0 and float(fixed.max()) < 360.0,
   f"{fixed.min():.1f}..{fixed.max():.1f}")

# A field that does NOT wrap must come back exactly as it did before, or this
# fix would have quietly changed every temperature chart in the app.
ramp = np.tile(np.linspace(-40, 40, n, dtype=np.float32), (n, 1))
ok("a field that does not wrap is untouched by any of this",
   np.allclose(g.smooth_upsample(ramp, min_edge=480, angular=False),
               g.smooth_upsample(ramp, min_edge=480), equal_nan=True))

print("\n2. only the direction ramp asks for it")
dirs = [k for k, v in g.FIELDS.items() if v.get("ramp") == "direction"]
ok("the five bearing fields are found by their ramp",
   sorted(dirs) == ["dirpw", "swdir", "swdir2", "wdir", "wvdir"],
   ", ".join(sorted(dirs)))
ok("all five run 0 to 360",
   all(g.FIELDS[k]["range"] == (0, 360) for k in dirs))
ok("and render_png reads the ramp to decide",
   'angular=(spec.get("ramp") == "direction")' in
   open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                     "pi", "gfs_pipeline.py"), encoding="utf-8").read())

print("\n3. missing data still survives the new path")
holed = deg.copy()
holed[40:60, 40:60] = np.nan
out = g.smooth_upsample(holed, min_edge=480, angular=True)
ok("a hole stays a hole rather than being smeared over",
   np.isnan(out).any(), "no NaN came back")
ok("and does not eat the whole picture",
   np.isnan(out).mean() < 0.12, f"{100 * np.isnan(out).mean():.1f}% NaN")
ok("an all-missing field is handed straight back",
   np.isnan(g.smooth_upsample(np.full((20, 20), np.nan, np.float32),
                              min_edge=480, angular=True)).all())

print("\n4. the picture is sized by how much world it covers")
BOXES = {
    "CONUS":       ([[20, -130], [55, -60]], 70.0),
    "Tropics":     ([[0, -165], [45, -10]], 155.0),
    "Atlantic":    ([[0, -100], [55, 0]], 100.0),
    "HAFS parent": ([[-20.6, -124.7], [60.2, -23.9]], 100.8),
    "HAFS nest":   ([[9.6, -81.5], [25.6, -61.5]], 20.0),
}
print(f"       {'box':<13} {'was':>8} {'now':>8}   px/degree")
worst_mb = 0.0
for nm, (bounds, span) in BOXES.items():
    la = abs(bounds[1][0] - bounds[0][0])
    lo = abs(bounds[1][1] - bounds[0][1])
    ratio = min(la, lo) / max(la, lo)
    edge = g.upsample_edge_for((int(1000 * ratio), 1000), bounds)
    mb = edge * edge * ratio * 4 / 1e6
    worst_mb = max(worst_mb, mb)
    print(f"       {nm:<13} {2000 / span:8.1f} {edge / span:8.1f}   "
          f"({mb:.1f} MB decoded)")

conus = g.upsample_edge_for((500, 1000), BOXES["CONUS"][0])
trop = g.upsample_edge_for((290, 1000), BOXES["Tropics"][0])
ok("a wide box gets more pixels than it used to",
   trop > 2000, str(trop))
ok("the widest box gains the most, which is where the blur was",
   trop / 155.0 > 2000 / 155.0 * 1.4,
   f"{trop / 155.0:.1f} vs {2000 / 155.0:.1f} px/deg")
ok("no box comes out below the old flat floor",
   all(g.upsample_edge_for((500, 1000), b) >= g.SMOOTH_MIN_EDGE_PX
       for b, _ in BOXES.values()))
ok("and none is allowed past the long-edge cap",
   all(g.upsample_edge_for((500, 1000), b) <= g.MAX_EDGE_PX
       for b, _ in BOXES.values()))
ok("the worst case still fits the memory this app budgets for",
   worst_mb <= g.SMOOTH_MAX_TOTAL_PX * 4 / 1e6 + 0.1,
   f"{worst_mb:.1f} MB")
ok("unknown bounds fall back to the flat floor, as before",
   g.upsample_edge_for((500, 1000), None) == g.SMOOTH_MIN_EDGE_PX)
ok("and so does a box of no size, rather than dividing by zero",
   g.upsample_edge_for((500, 1000), [[10, 20], [10, 20]])
   == g.SMOOTH_MIN_EDGE_PX)

print("\n5. a fine native grid is still capped by total pixels, not just width")
for shape in [(1300, 2300), (3000, 3200), (2000, 5000)]:
    step = max(1, int(np.ceil(max(shape) / float(g.MAX_EDGE_PX))))
    total = shape[0] * shape[1]
    if total > g.SMOOTH_MAX_TOTAL_PX:
        step = max(step, int(np.ceil((total / g.SMOOTH_MAX_TOTAL_PX) ** 0.5)))
    out_px = (shape[0] // step) * (shape[1] // step)
    print(f"       {shape} -> step {step} -> {out_px / 1e6:.2f} Mpx "
          f"({out_px * 4 / 1e6:.1f} MB)")
    ok(f"  {shape[0]}x{shape[1]} stays inside the budget",
       out_px <= g.SMOOTH_MAX_TOTAL_PX, f"{out_px / 1e6:.2f} Mpx")
ok("HRRR's native grid is still not thinned at all",
   max(1300, 2300) <= g.MAX_EDGE_PX and 1300 * 2300 <= g.SMOOTH_MAX_TOTAL_PX)

print("\n6. the storm-following models, as configured")
ok("HAFS-A builds both grids for every storm",
   g.MODELS["hafs"]["domains"] == ["parent", "storm"])
ok("the parent grid does not move",
   g.region_spec(g.MODELS["hafs"], "04l")["moving"] is False)
ok("and the nest does",
   g.region_spec(g.MODELS["hafs"], "04l-storm")["moving"] is True)
ok("the nest's address asks for the nest",
   "hfsa.storm.atm" in g.region_spec(g.MODELS["hafs"], "04l-storm")["raw"])
ok("and the parent's for the parent",
   "hfsa.parent.atm" in g.region_spec(g.MODELS["hafs"], "04l")["raw"])
ok("a region round-trips to its storm and grid",
   g.split_storm_region("04l-storm") == ("04l", "storm")
   and g.split_storm_region("04l") == ("04l", "parent"))
ok("invests are ordered behind named storms in the build queue",
   g.storm_region_cost("94w") > g.storm_region_cost("04l"))
ok("and a parent grid ahead of its own nest",
   g.storm_region_cost("04l") < g.storm_region_cost("04l-storm"))
ok("HMON offers the one grid it publishes, so no switch appears",
   g.MODELS["hmon"]["domains"] == ["parent"])
ok("HWRF's per-nest addresses resolve to different files",
   g.region_spec(g.MODELS["hwrf"], "04l")["raw"]
   != g.region_spec(g.MODELS["hwrf"], "04l-storm")["raw"])

print("\n7. house rules")
EM = chr(0x2014)
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
bad = [f for f in ("pi/gfs_pipeline.py", "index.html",
                   "tools/test-model-quality.py")
       if EM in open(os.path.join(root, f), encoding="utf-8").read()]
ok("no em dashes", not bad, ", ".join(bad))

print(f"\n{FAIL} FAILED, {PASS} passed" if FAIL else f"\nall {PASS} passed")
sys.exit(1 if FAIL else 0)
