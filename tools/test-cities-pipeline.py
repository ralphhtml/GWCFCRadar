#!/usr/bin/env python3
"""
The world-city tiler, held down offline.

    python3 tools/test-cities-pipeline.py

A miniature GeoNames dump is built in this file to the exact TSV shape the
real allCountries.txt has, zipped, and pushed through the real pipeline
with a tiny tile cap. What comes out has to prove the filters (populated
places only, no historical or abandoned entries, no "section of" pseudo
rows), the tiling arithmetic, the importance sort, the cap, and that a
name with accents survives the trip byte for byte.
"""

import io
import json
import os
import sys
import tempfile
import zipfile

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


def row(gid, name, lat, lon, fclass, fcode, pop):
    f = [""] * 19
    f[0], f[1], f[2] = str(gid), name, name
    f[4], f[5] = str(lat), str(lon)
    f[6], f[7] = fclass, fcode
    f[14] = str(pop)
    return "\t".join(f)


LINES = [
    row(1, "Atlanta", 33.749, -84.388, "P", "PPLA", 498715),
    row(2, "Decatur", 33.774, -84.296, "P", "PPL", 24928),
    row(3, "Tiny Hamlet", 33.9, -84.9, "P", "PPL", 0),
    row(4, "Fourth Place", 33.95, -84.95, "P", "PPL", 12),
    # The ones that must NOT survive: a mountain, a historical site, a
    # "section of" pseudo-entry, and a place with an unusable position.
    row(5, "Stone Mountain", 33.8, -84.1, "T", "MT", 0),
    row(6, "Old Ghost Town", 33.8, -84.2, "P", "PPLH", 0),
    row(7, "Midtown Section", 33.78, -84.38, "P", "PPLX", 90000),
    row(8, "Nowhere", "bad", -84.0, "P", "PPL", 5),
    # Another hemisphere entirely, with accents worth preserving.
    row(9, "São Paulo", -23.5505, -46.6333, "P", "PPLA", 12325232),
    row(10, "Zürich", 47.3769, 8.5417, "P", "PPLA", 421878),
]

print("\n1. the tiler filters, sorts, caps and keeps accents")
import cities_pipeline as cp  # noqa: E402

with tempfile.TemporaryDirectory() as td:
    z = os.path.join(td, "allCountries.zip")
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("allCountries.txt", "\n".join(LINES) + "\n")
    cp.OUT_DIR = os.path.join(td, "cities")
    cp.CACHE_DIR = os.path.join(cp.OUT_DIR, "_cache")
    cp.TILE_CAP = 3
    cp.fetch_dump = lambda force=False: z
    cp.build(force=True)

    idx = json.load(open(os.path.join(cp.OUT_DIR, "index.json")))
    check("the index counts what was kept", idx["total"] == 5, idx["total"])
    check("and names the license, which CC BY requires",
          "GeoNames" in idx["source"] and "CC BY" in idx["source"])

    atl_key = cp.tile_key(33.749, -84.388)
    atl = json.load(open(os.path.join(cp.OUT_DIR, f"t_{atl_key}.json"),
                         encoding="utf-8"))
    names = [r[0] for r in atl]
    check("a mountain is not a town", "Stone Mountain" not in names)
    check("historical and section pseudo-entries are dropped",
          "Old Ghost Town" not in names and "Midtown Section" not in names)
    check("an unusable position is dropped", "Nowhere" not in names)
    check("population sorts the tile, biggest first",
          names[0] == "Atlanta" and names[1] == "Decatur", names)
    check("the cap holds even with more places in the tile",
          len(atl) == 3, len(atl))
    check("the cap trims the least important place, not a random one",
          "Fourth Place" in names and "Tiny Hamlet" not in names, names)

    sp = json.load(open(os.path.join(
        cp.OUT_DIR, f"t_{cp.tile_key(-23.5505, -46.6333)}.json"),
        encoding="utf-8"))
    check("the southern hemisphere lands in its own tile",
          sp[0][0] == "São Paulo" and sp[0][1] == -23.5505, sp)
    zu = json.load(open(os.path.join(
        cp.OUT_DIR, f"t_{cp.tile_key(47.3769, 8.5417)}.json"),
        encoding="utf-8"))
    check("accents survive byte for byte", zu[0][0] == "Zürich")
    check("rows are compact arrays: name, lat, lon, pop, rank",
          len(zu[0]) == 5 and zu[0][3] == 421878 and isinstance(zu[0][4], int))

print("\n2. the machinery around it")
check("install.sh registers the weekly service and timer",
      "gwcfc-cities.service" in open(os.path.join(ROOT, "pi/install.sh")).read()
      and "gwcfc-cities.timer" in open(os.path.join(ROOT, "pi/install.sh")).read())
page = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
check("the page loads tiles from the Pi and falls back to the built-ins",
      "/cities/t_${key}.json" in page
      and "list = CITIES.filter(city => bounds.contains" in page)
check("GeoNames is credited on the credits panel",
      "geonames.org" in page and "CC BY 4.0" in page)
EM = chr(0x2014)
check("no em dashes in the pipeline, this test, or the page",
      EM not in open(os.path.join(ROOT, "pi/cities_pipeline.py")).read()
      and EM not in open(os.path.abspath(__file__)).read()
      and EM not in page)

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
