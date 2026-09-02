#!/usr/bin/env python3
"""
The satellite archive reads NOAA's own scans.

    python3 tools/test-sat-archive.py

Pins the spacecraft-by-date table, the hour-walking listing against a
stubbed bucket, NOAA's key pattern as the only door, the grey scales, the
regridder's geometry, and the serve.py doors' validation. When a real scan
is sitting in the scratchpad (tools fetch one when the buckets are
reachable) it is rendered end to end and the picture measured.
"""

import glob
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "pi"))

import numpy as np  # noqa: E402

import sat_archive as sa  # noqa: E402

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


print("\n1. which spacecraft stood where, when")
ok("GOES-16 was East in 2018", sa.bucket_for("east", utc(2018, 6, 1)) == "noaa-goes16")
ok("GOES-19 is East from April 2025", sa.bucket_for("east", utc(2025, 6, 1)) == "noaa-goes19")
ok("nothing stood East before mid 2017", sa.bucket_for("east", utc(2017, 1, 1)) is None)
ok("GOES-17 was West in 2020", sa.bucket_for("west", utc(2020, 6, 1)) == "noaa-goes17")
ok("GOES-18 is West from January 2023", sa.bucket_for("west", utc(2024, 6, 1)) == "noaa-goes18")
ok("nothing stood West in 2018", sa.bucket_for("west", utc(2018, 6, 1)) is None)

print("\n2. the listing walks back through the hours and keeps only the band asked for")
{
    # A stub bucket: two hours of CONUS scans every five minutes, bands 13
    # and 02, plus a stray file that is not a scan at all.
}
def fake_keys(bucket, prefix):
    m = __import__("re").match(r"ABI-L2-CMIPC/(\d{4})/(\d{3})/(\d{2})/", prefix)
    if not m:
        return []
    y, d, h = m.groups()
    out = []
    for mnt in range(0, 60, 5):
        for band in ("13", "02"):
            s = f"{y}{d}{h}{mnt:02d}17"
            out.append(f"ABI-L2-CMIPC/{y}/{d}/{h}/OR_ABI-L2-CMIPC-M6C{band}_G16_s{s}2"
                       f"_e{s}5_c{s}9.nc")
    out.append(f"ABI-L2-CMIPC/{y}/{d}/{h}/junk.txt")
    return out


at = utc(2023, 5, 30, 12, 33)
got = sa.frames_around("east", 13, "conus", int(at.timestamp() * 1000), 20, lister=fake_keys)
ok("twenty frames come back for a CONUS band", got and len(got["frames"]) == 20,
   str(got and len(got["frames"])))
ok("oldest first, none after the moment",
   got["frames"] == sorted(got["frames"], key=lambda f: f["t"])
   and all(f["t"] <= int(at.timestamp() * 1000) for f in got["frames"]))
ok("only band 13, only real scans",
   all("C13_" in f["key"] and sa.KEY_RE.match(f["key"]) for f in got["frames"]))
ok("the newest is the 12:30 scan", got["frames"][-1]["stamp"].startswith("2023150123017"),
   got["frames"][-1]["stamp"])
ok("a moment before the satellite existed is refused, not searched",
   sa.frames_around("west", 13, "conus", int(utc(2018, 1, 1).timestamp() * 1000), 5,
                    lister=fake_keys) is None)

print("\n3. NOAA's key pattern is the only shape the door accepts")
real = "ABI-L2-CMIPC/2023/150/12/OR_ABI-L2-CMIPC-M6C13_G16_s20231501201172_e20231501203556_c20231501204056.nc"
ok("a real key matches", bool(sa.KEY_RE.match(real)))
ok("a traversal does not", not sa.KEY_RE.match("../../etc/passwd"))
ok("a different product does not",
   not sa.KEY_RE.match(real.replace("CMIPC", "RadC")))
ok("a bucket outside the four is not a bucket", "noaa-nexrad-level2" not in sa.BUCKETS)

print("\n4. the grey scales read the way a satellite picture should")
ir = sa.colorize(np.array([180.0, 250.0, 320.0, np.nan], np.float32), 13)
ok("infrared: cold cloud tops white, warm ground black, no data black",
   ir[0] == 255 and 100 < ir[1] < 160 and ir[2] == 0 and ir[3] == 0, str(ir.tolist()))
vis = sa.colorize(np.array([0.0, 0.25, 1.0], np.float32), 2)
ok("visible: reflectance lifts dim land with a square root",
   vis[0] == 0 and vis[1] == 127 and vis[2] == 255, str(vis.tolist()))
wv = sa.colorize(np.array([190.0, 270.0], np.float32), 9)
ok("water vapour: cold moist air white, dry warm air black", wv[0] == 255 and wv[1] == 0)

print("\n5. the regridder puts north at the top and reports the rectangle it drew")
lat = np.linspace(40.0, 30.0, 50)[:, None] * np.ones((1, 80), np.float32)
lon = np.ones((50, 1), np.float32) * np.linspace(-100.0, -80.0, 80)[None, :]
vals = np.where(lat > 35.0, 200.0, 50.0).astype(np.float32)
grid, cov, bounds = sa.regrid(vals, lat, lon, 80)
ok("the rectangle is the data's own extent",
   abs(bounds[0][0] - 30) < 1e-4 and abs(bounds[1][0] - 40) < 1e-4
   and abs(bounds[0][1] + 100) < 1e-4 and abs(bounds[1][1] + 80) < 1e-4, str(bounds))
ok("row zero is the north, so the bright half is on top",
   grid[0, 40] > 150 and grid[-1, 40] < 100, f"{grid[0, 40]} / {grid[-1, 40]}")
ok("every cell was covered or filled", bool(cov.all()))

print("\n6. serve.py's doors validate before they touch the network")
sys.path.insert(0, os.path.join(ROOT, "pi"))
import serve  # noqa: E402


class Fake(serve.CORSHandler):
    """A handler with a path and a notebook, and no socket behind it."""
    def __init__(self, path):  # noqa: D107 - deliberately skips the socket setup
        self.path = path
        self.directory = tempfile.mkdtemp()
        self.replies = []

    def _reply_json(self, code, obj):
        self.replies.append((code, obj))

    def _reply_bytes(self, code, body, ctype):
        self.replies.append((code, ctype))


f = Fake("/sat/archive/index?post=north&band=13&sector=conus&at=1&n=5")
serve.CORSHandler._sat_archive_index(f)
ok("a post that is not east or west is a 400", f.replies and f.replies[0][0] == 400, str(f.replies))
f = Fake("/sat/archive/index?post=east&band=99&sector=conus&at=1700000000000&n=5")
serve.CORSHandler._sat_archive_index(f)
ok("a band outside 1 to 16 is a 400", f.replies and f.replies[0][0] == 400, str(f.replies))
f = Fake("/sat/archive/index?post=east&band=13&sector=conus&at=5&n=5")
serve.CORSHandler._sat_archive_index(f)
ok("a moment before 2017 is a 400", f.replies and f.replies[0][0] == 400, str(f.replies))
f = Fake("/sat/archive/frame?bucket=noaa-goes16&key=../x&band=13&sector=conus")
serve.CORSHandler._sat_archive_frame(f)
ok("a key that is not a GOES scan is a 400", f.replies and f.replies[0][0] == 400, str(f.replies))
f = Fake("/sat/archive/frame?bucket=evil-bucket&key=" + real + "&band=13&sector=conus")
serve.CORSHandler._sat_archive_frame(f)
ok("a bucket outside NOAA's four is a 400", f.replies and f.replies[0][0] == 400, str(f.replies))

print("\n7. a real scan, if one is in the scratchpad, renders to a georeferenced picture")
cands = glob.glob("/tmp/claude-0/*/*/scratchpad/c13.nc") + glob.glob(os.path.join(HERE, "fixtures", "*.nc"))
if not cands:
    print("  (no scan on disk; skipping the render)")
else:
    raw = open(cands[0], "rb").read()
    cache = tempfile.mkdtemp()
    t0 = datetime.now()
    png, bounds = sa.render("noaa-goes16", real, 13, "conus", cache_dir=cache,
                            fetch=lambda b, k: raw, edge=800)
    secs = (datetime.now() - t0).total_seconds()
    from PIL import Image
    im = Image.open(png)
    a = np.asarray(im)
    ok("a PNG landed in the cache with its rectangle beside it",
       os.path.exists(png) and os.path.exists(png[:-4] + ".json"))
    ok("the rectangle is the CONUS the scan covers",
       14 < bounds[0][0] < 22 and 50 < bounds[1][0] < 58
       and -155 < bounds[0][1] < -145 and -55 < bounds[1][1] < -45, str(bounds))
    # The scan is thinned by a whole step (2500 wide over an 800 ask is a
    # step of 4, so 625), never upsampled: no invented pixels.
    ok("the picture is grey with a coverage alpha, thinned to under the asked edge",
       im.mode == "RGBA" and 500 <= max(im.size) <= 800 and a[..., 3].max() == 255,
       f"{im.mode} {im.size}")
    # Cloud tops colder than about 240 K read above 140 grey; warm ground
    # above freezing reads below 90. A CONUS scan in late May has plenty of both.
    ok("it has real cloud and real ground in it: bright and dark pixels both",
       int((a[..., 0] > 140).sum()) > 1000 and int((a[..., 0] < 90).sum()) > 1000,
       f"bright {int((a[..., 0] > 140).sum())} dark {int((a[..., 0] < 90).sum())}")
    ok("the same scan again is served from disk, not rendered",
       sa.render("noaa-goes16", real, 13, "conus", cache_dir=cache,
                 fetch=lambda b, k: (_ for _ in ()).throw(RuntimeError("no")), edge=800)[0] == png)
    print(f"  (rendered in {secs:.1f}s)")

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
