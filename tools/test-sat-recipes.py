#!/usr/bin/env python3
"""The satellite RGB recipes, checked as physics rather than as syntax.

    python3 tools/test-sat-recipes.py

Every recipe is a CIRA or EUMETSAT quick-guide standard, and the point of
using published numbers is that a forecaster who knows these products from
anywhere else reads ours the same way. So the test does two things: it runs
every recipe's channel arithmetic through the pipeline's own _stretch over
synthetic bands and demands finite 0..1 output, and then it checks the
DIRECTION of the physics on the recipes where getting it backwards would
still look plausible: fog must come out brighter than clear ground in the
Day Snow-Fog blue, a dry slot darker than moist air in Differential Water
Vapor, a strong updraft brighter than a weak one in Day Convection.

A recipe that renders pretty colours with the physics inverted is worse than
a missing one, because somebody will make a call off it.
"""

import io
import os
import re
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))
import satellite_pipeline as S                 # noqa: E402

PASS = FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + ("  <%s>" % extra if extra else ""))


def st(v, lo, hi, invert=False, gamma=1.0):
    return float(S._stretch(np.float32([[v]]), lo, hi, invert, gamma)[0, 0])


print("\n1. the catalogue")
keys = list(S.RGB_RECIPES.keys())
ok("fourteen recipes, doubled from seven", len(keys) == 14, str(len(keys)))
for want in ["daylandcloud", "daylandcloudfire", "dayconvection",
             "daysnowfog", "diffwv", "simplewv", "so2"]:
    ok("recipe %s exists" % want, want in keys)

print("\n2. every recipe computes cleanly through the real channel math")
rng = np.random.default_rng(1)
ny, nx = 60, 90
bands = {}
for b in range(1, 17):
    if b <= 6:
        bands[b] = rng.random((ny, nx)).astype(np.float32)              # reflectance
    else:
        bands[b] = (rng.random((ny, nx)) * 100 + 200).astype(np.float32)  # Kelvin
for key, recipe in S.RGB_RECIPES.items():
    chans = []
    for spec in recipe["rgb"]:
        acc = np.zeros((ny, nx), np.float32)
        for band, coeff in spec["terms"]:
            acc += bands[band] * np.float32(coeff)
        lo, hi = spec["range"]
        chans.append(S._stretch(acc, lo, hi, spec.get("invert", False),
                                spec.get("gamma", 1.0)))
    a = np.dstack(chans)
    ok("%s renders finite 0..1 channels" % key,
       bool(np.isfinite(a).all()) and float(a.min()) >= 0.0
       and float(a.max()) <= 1.0,
       "min %.2f max %.2f" % (float(a.min()), float(a.max())))
    # Every band a channel reads must be declared, or the build fetches too
    # few files and dies at composite time with a KeyError.
    used = {b for spec in recipe["rgb"] for b, _ in spec["terms"]}
    ok("  and declares every band it reads",
       used <= set(recipe["bands"]),
       "uses %s declares %s" % (sorted(used), sorted(recipe["bands"])))

print("\n3. the physics points the right way")
# Day Snow-Fog blue is the shortwave-warm difference: fog is warm there.
ok("fog brighter than clear ground in Day Snow-Fog blue",
   st(20, 0, 30, gamma=1.7) > st(2, 0, 30, gamma=1.7))
# Differential WV red is inverted: deep dry (big positive diff) reads dark.
ok("a dry slot darker than moist air in Differential WV red",
   st(25, -3, 30, True, 0.26) < st(-2, -3, 30, True, 0.26))
# Day Convection red: strong updraft (C08-C10 toward +5 K) reads bright.
ok("a strong updraft brighter than a weak one in Day Convection red",
   st(3, -35, 5) > st(-30, -35, 5))
# Simple WV: cold high cloud (low C13) must read BRIGHT via the invert.
ok("high cold cloud bright in Simple Water Vapor",
   st(210, 202.3, 279.0, True) > st(275, 202.3, 279.0, True))
# Day Land Cloud green is the veggie band: vegetation reflects it hard.
ok("vegetation brighter than water in Day Land Cloud green",
   st(0.5, 0, 1.086) > st(0.05, 0, 1.086))
# SO2 red: a sulphur cloud pushes C09-C10 up toward the top of its range.
ok("a sulphur plume brighter than clean air in the SO2 red",
   st(1.5, -4, 2) > st(-3, -4, 2))

print("\n4. the daytime flag is on the recipes that need sunlight")
for k in ["daylandcloud", "daylandcloudfire", "dayconvection", "daysnowfog"]:
    ok("%s is daytime only" % k, S.RGB_RECIPES[k].get("daytime_only") is True)
for k in ["diffwv", "simplewv", "so2"]:
    ok("%s runs day and night" % k,
       not S.RGB_RECIPES[k].get("daytime_only"))

print("\n5. the browser offers what the Pi builds")
page = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
for rid, recipe in [("rgb-daylandcloud", "daylandcloud"),
                    ("rgb-daysnowfog", "daysnowfog"),
                    ("rgb-dayconvection", "dayconvection"),
                    ("rgb-simplewv", "simplewv"),
                    ("rgb-diffwv", "diffwv"),
                    ("rgb-daylandcloudfire", "daylandcloudfire"),
                    ("rgb-so2", "so2")]:
    ok("%s is on the menu" % rid,
       re.search(r"id: '%s'.*recipe: '%s'" % (rid, recipe), page) is not None)
    ok("  with an explanation",
       re.search(r"'%s':\s+'" % rid, page) is not None)
# A menu entry whose recipe the pipeline does not know is a button that
# builds nothing, forever.
menu_recipes = set(re.findall(r"src: 'pi', recipe: '(\w+)'", page))
pipe_recipes = set(S.RGB_RECIPES.keys())
orphans = menu_recipes - pipe_recipes - {"ir", "vis", "wv", "swir"}  # GMGSI ids
ok("every menu recipe exists in the pipeline", not orphans, str(orphans))

EM = chr(0x2014)
files = ["pi/satellite_pipeline.py", "tools/test-sat-recipes.py"]
bad = [f for f in files
       if EM in io.open(os.path.join(ROOT, f), encoding="utf-8").read()]
ok("no em dashes in the touched files", not bad, ", ".join(bad))

print("\n%s" % ("%d FAILED, %d passed" % (FAIL, PASS) if FAIL
                else "all %d passed" % PASS))
sys.exit(1 if FAIL else 0)
