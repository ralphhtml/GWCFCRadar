#!/usr/bin/env python3
"""
The SST pruner, which once ate its own dinner.

    python3 tools/test-sst-prune.py

The old prune() watched the WHOLE filesystem and deleted SST files until the
percentage came down. On a card filled by radar and the models the
percentage never came down, so every pass deleted more SST, finishing with
the day rendered minutes earlier. The index then said frames: 0 and every
Pi-built sea surface temperature product simply never loaded on the site.

The rewrite is held to three promises here, against a real temporary tree:

  1. the newest days of every rendered product survive even a disk that
     reads 99 percent full forever,
  2. once SST's own footprint is at its floor, deletion stops outright,
     because deleting SST cannot fix a disk something else filled, and
  3. a healthy disk is never pruned at all.

Also proven: the derived relative humidity the analyses need. RTMA and URMA
publish temperature and dewpoint but no RH message (checked against the
live noaa-rtma-pds index: TMP, DPT, SPFH, no RH), so the pipeline works RH
out from those two, and the arithmetic is checked against textbook values.
"""

import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + ("  <" + str(extra) + ">" if extra else ""))


print("\n1. the pruner keeps its promises")
import sst_pipeline as sp  # noqa: E402

with tempfile.TemporaryDirectory() as td:
    out = os.path.join(td, "sst")
    sp.OUT_DIR = out
    sp.CACHE_DIR = os.path.join(out, "_cache")

    prod = os.path.join(out, "oisst", "anomaly")
    raw = os.path.join(sp.CACHE_DIR, "raw", "oisst")
    clim = os.path.join(sp.CACHE_DIR, "clim")
    for d in (prod, raw, clim):
        os.makedirs(d)
    MB = 1024 * 1024

    def fill():
        for i in range(10):
            with open(os.path.join(prod, f"202608{i + 10:02d}.png"), "wb") as f:
                f.write(b"x" * MB)

    fill()
    for i in range(5):
        with open(os.path.join(raw, f"202608{i + 10:02d}.nc"), "wb") as f:
            f.write(b"x" * MB)
    with open(os.path.join(clim, "20260815.png"), "wb") as f:
        f.write(b"x" * MB)

    # A disk that reads full forever, exactly what radar and the models do
    # to the card, with the floor out of the way.
    sp.disk_pct_used = lambda p: 99.0
    sp.SST_FLOOR_GB = 0.0
    sp.PRUNE_KEEP_DAYS = 3
    dropped = sp.prune()
    days = sorted(os.listdir(prod))
    check("raw cache goes first, and all of it may go", not os.listdir(raw))
    check("the newest 3 rendered days survive a full disk",
          days == ["20260817.png", "20260818.png", "20260819.png"], days)
    check("the cached climatology is never touched",
          os.listdir(clim) == ["20260815.png"])
    check("the count reported matches what went", dropped == 12, dropped)

    # The floor: SST holds ~13 MB, the floor says 1 GB, the disk still
    # reads full. Deleting SST cannot help, so nothing goes.
    fill()
    sp.SST_FLOOR_GB = 1.0
    check("at the floor, deletion stops outright", sp.prune() == 0)
    check("and every file is still there", len(os.listdir(prod)) == 10)

    # A healthy disk is left entirely alone.
    sp.disk_pct_used = lambda p: 40.0
    sp.SST_FLOOR_GB = 0.0
    check("a healthy disk is never pruned", sp.prune() == 0)

print("\n2. the analyses get a real relative humidity")
import numpy as np  # noqa: E402
import gfs_pipeline as gp  # noqa: E402

src = open(os.path.join(ROOT, "pi", "gfs_pipeline.py")).read()
check("open_fields derives rh2m when the file has none",
      'if "rh2m" not in found and "t2m" in found and "d2m" in found:' in src)
check("and never overrides a model that carries RH itself",
      '"rh2m" not in found' in src)

# The exact arithmetic the pipeline runs, against textbook values: saturated
# air is 100, 30C over a 10C dewpoint is about 29, freezing air over a -10C
# dewpoint is about 47.
t = np.array([293.15, 303.15, 273.15])
d = np.array([293.15, 283.15, 263.15])
tc, dc = t - 273.15, d - 273.15
es = np.exp(17.625 * tc / (243.04 + tc))
e = np.exp(17.625 * dc / (243.04 + dc))
rh = np.clip(100.0 * e / np.maximum(es, 1e-12), 0.0, 100.0)
check("saturated air reads 100 percent", abs(rh[0] - 100.0) < 0.01, rh[0])
check("30C over a 10C dewpoint reads about 29", abs(rh[1] - 28.9) < 0.5, rh[1])
check("0C over a -10C dewpoint reads about 47", abs(rh[2] - 46.9) < 0.5, rh[2])
check("the pipeline clips, so RH can never exceed 100",
      "np.clip(100.0 * e / np.maximum(es, 1e-12), 0.0, 100.0)" in src)

print("\n3. Greenwich-first grids are rolled into the map's world")
# OISST counts longitude 0 to 360, so unrolled its picture starts at
# Greenwich and the site's -180..180 rectangle cannot describe it: the
# eastern hemisphere rendered over the Pacific. normalize_lons must roll
# such a grid to dateline-first, and leave a -180..180 grid alone.
lons360 = np.arange(0.125, 360.0, 0.25)
vals360 = np.tile(lons360, (3, 1))          # each cell remembers its lon
v2, l2 = sp.normalize_lons(vals360, lons360)
check("longitudes come out ascending from the dateline",
      l2[0] < -179.0 and np.all(np.diff(l2) > 0), l2[0])
check("the values rolled with them, cell for cell",
      float(v2[0, 0]) == 180.125 and float(v2[0, -1]) == 179.875,
      (float(v2[0, 0]), float(v2[0, -1])))
lats3 = np.array([-89.875, 0.0, 89.875])
b = gp.bounds_from(lats3, l2)
check("and bounds_from finally yields a right-side-out rectangle",
      b[0][1] < b[1][1] and b[0][1] < -179.0 and b[1][1] > 179.0, b)
lons180 = np.arange(-179.875, 180.0, 0.25)
v3, l3 = sp.normalize_lons(vals360, lons180)
check("a grid already dateline-first passes through untouched",
      v3 is vals360 and np.array_equal(l3, lons180))

EM = chr(0x2014)
here = open(os.path.abspath(__file__)).read()
check("no em dashes in this test, the sst pipeline, or the model pipeline",
      EM not in here
      and EM not in open(os.path.join(ROOT, "pi", "sst_pipeline.py")).read()
      and EM not in src)

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
