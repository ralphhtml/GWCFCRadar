#!/usr/bin/env python3
"""The model charts' picture quality, measured off rendered pixels.

    python3 tools/test-model-quality.py

"The charts are blurry and washed out" turned out to be three multiplied
causes, and this test exists so none of them can quietly come back:

HALF THE MODEL WAS BEING THROWN AWAY. HRRR and the NAM nest are about 2300
cells across the box, and a 1600 pixel cap forced step 2 thinning: every
second cell discarded before anyone saw it. The cap is 2560 now and a
fine model must pass through at one pixel per cell.

COARSE MODELS ARRIVED AT HALF THE SCREEN. A 1000 pixel picture stretched
across an ordinary display doubles in the browser, and the browser stretches
finished COLOURS, blending across ramp boundaries into shades nothing
forecast. Values are interpolated to 2000 on the Pi instead, where the
numbers still exist.

OPACITY WAS APPLIED TWICE. 200 of 255 baked into the pixels, then the
browser's slider multiplied on top: the default view was 78 percent of 72
percent, about half strength, and no slider position could reach full. The
pixels are opaque now and the slider is the only fade.

Everything here calls the real render path in pi/gfs_pipeline.py and reads
the PNG it wrote, because the constants being right proves nothing about the
pixels being right.
"""

import io
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

import numpy as np              # noqa: E402
from PIL import Image           # noqa: E402
import gfs_pipeline as G        # noqa: E402

PASS = FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + ("  <%s>" % extra if extra else ""))


def render(field, spec, lats=None):
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        if lats is None:
            lats = np.linspace(50, 20, field.shape[0])
        G.render_png(field, lats, spec, path)
        im = Image.open(path)
        return im.size, np.asarray(im)
    finally:
        os.unlink(path)


TSPEC = {"convert": lambda a: a, "range": (-40, 45), "ramp": "temp"}

print("\n1. a fine model keeps every cell it computed")
# HRRR's real shape over the box. Under the old 1600 cap this came out
# 1150 wide: half the forecast discarded by step 2 thinning.
h, w = 1300, 2300
fine = (np.random.default_rng(3).random((h, w)) * 60 - 20).astype(np.float32)
(size, px) = render(fine, TSPEC)
ok("2300 cells arrive as 2300 pixels, not 1150", size[0] == 2300, str(size))
ok("and every row survives too", size[1] == 1300, str(size))
ok("the cap that allows that is written down",
   G.MAX_EDGE_PX >= 2560, str(G.MAX_EDGE_PX))

print("\n2. a coarse model is upsampled on VALUES, to a real screen's size")
hc, wc = 100, 240   # GFS 0.25 degree over a CONUS-ish box
yy, xx = np.mgrid[0:hc, 0:wc].astype(np.float32)
coarse = 40 - 60 * (yy / hc)
coarse[xx > wc * 0.6] -= 25   # a front, so sharpness is measurable
(size, px) = render(coarse, TSPEC)
ok("the long edge reaches 2000 pixels", size[0] == 2000, str(size))
ok("which is the floor the constant promises", G.SMOOTH_MIN_EDGE_PX >= 2000,
   str(G.SMOOTH_MIN_EDGE_PX))
# The invariant that justifies upsampling at all: interpolate the numbers,
# colour afterwards. Every rendered colour must therefore be a colour the
# ramp actually contains, never a blend that means a value nothing forecast.
lut = G.lut_for("temp", -40, 45)
lut_set = {tuple(c) for c in lut}
body = px[px[..., 3] > 0][:, :3]
sample = body[:: max(1, len(body) // 4000)]
alien = sum(1 for c in sample if tuple(c) not in lut_set)
ok("every painted colour exists in the ramp, none are blends",
   alien == 0, "%d alien colours" % alien)

print("\n3. opacity lives in one place now")
ok("data pixels are fully opaque", int(px[..., 3].max()) == 255,
   str(int(px[..., 3].max())))
src = io.open(os.path.join(ROOT, "pi", "gfs_pipeline.py"), encoding="utf-8").read()
ok("the baked 200 is gone from the renderer",
   "np.full(idx.shape, 200" not in src)
page = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
ok("the browser default rose to compensate",
   "let modelOpacity = 0.88;" in page)
ok("and the Settings slider starts where the default is",
   re.search(r'id="lqm-set-modelopacity"[^>]*value="88"', page) is not None)
ok("a saved slider position still wins over the default",
   "lqm_modelopacity" in page)

print("\n4. transparency that MEANS something is kept")
# Full opacity must not turn "nothing here" into an opaque wash. Precip's
# bottom of scale and velocity's near-zero band are silence, not data.
pspec = {"convert": lambda a: a, "range": (0, 3), "ramp": "precip"}
rain = np.zeros((80, 120), np.float32)
rain[30:40, 50:70] = 2.0
(_, ppx) = render(rain, pspec)
ok("dry ground stays invisible on a precip chart",
   int(ppx[0, 0, 3]) == 0, str(int(ppx[0, 0, 3])))
ok("while the rain itself is at full strength",
   int(ppx[..., 3].max()) == 255, str(int(ppx[..., 3].max())))
hole = coarse.copy()
hole[10:20, 10:20] = np.nan
(_, hpx) = render(hole, TSPEC)
ok("missing data is transparent, not painted",
   int(hpx[..., 3].min()) == 0)
frac = float((hpx[..., 3] == 0).mean())
ok("and the hole does not eat the picture around it",
   frac < 0.05, "%.3f transparent" % frac)

print("\n5. geometry survives the resize")
# Thinning keeps the first and last cell so the picture is not shifted, and
# upsampling must not move the front sideways.
big = np.zeros((900, 3000), np.float32)
big[:, 0] = 45.0
big[:, -1] = -40.0
(bsize, bpx) = render(big, TSPEC)
first_col = bpx[:, 0, :3]
last_col = bpx[:, -1, :3]
mid_col = bpx[:, bsize[0] // 2, :3]
ok("the first column keeps its own value after thinning",
   not np.array_equal(first_col[0], mid_col[0]))
ok("and so does the last",
   not np.array_equal(last_col[0], mid_col[0]))
# The front in the coarse render: its position in fractions of width must
# match where it was put, else upsampling slid the weather sideways.
(csize, cpx) = render(coarse, TSPEC)
row = cpx[csize[1] // 2, :, :3].astype(int)
jump = np.abs(np.diff(row.sum(axis=1)))
front_px = int(np.argmax(jump))
ok("the cold front is where the model put it",
   abs(front_px / csize[0] - 0.6) < 0.02,
   "%.3f of width, wanted 0.60" % (front_px / csize[0]))

print("\n6. what it costs, measured rather than shrugged at")
# The realistic case, not the noise worst case: a smooth field at the new
# size has to stay a sane download.
fd, path = tempfile.mkstemp(suffix=".png")
os.close(fd)
G.render_png(coarse, np.linspace(50, 20, hc), TSPEC, path)
kb = os.path.getsize(path) // 1024
os.unlink(path)
ok("a full-size smooth chart is still a small file (%d KB)" % kb, kb < 200,
   "%d KB" % kb)

EM = chr(0x2014)
files = ["pi/gfs_pipeline.py", "tools/test-model-quality.py"]
bad = [f for f in files
       if EM in io.open(os.path.join(ROOT, f), encoding="utf-8").read()]
ok("no em dashes in the touched files", not bad, ", ".join(bad))

print("\n%s" % ("%d FAILED, %d passed" % (FAIL, PASS) if FAIL
                else "all %d passed" % PASS))
sys.exit(1 if FAIL else 0)
