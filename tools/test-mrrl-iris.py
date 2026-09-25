#!/usr/bin/env python3
"""pi/mrrl_iris.py: the IRIS RAW radars (CABO, SABA) read and converted.

    python3 tools/test-mrrl-iris.py

Offline. The fixture is the start of a real CABO (Los Cabos) volume from
feeds.mrrl.net, and the truth is xradar's own reading of the same file,
gate for gate. Checked: the file is recognised as IRIS, the radar's
position comes out of its header, every moment decodes to xradar's values,
the conversion is Archive II the browser's decoder reads (small records,
one bzip2 block each, Message 31 with the volume block), and mrrl.py hands
an IRIS file through that conversion and places the radar from it.
"""

import bz2
import gzip
import json
import math
import os
import struct
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "pi"))
import mrrl  # noqa: E402
import mrrl_iris as M  # noqa: E402

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


fx = os.path.join(ROOT, "tools", "fixtures")
raw = gzip.decompress(open(os.path.join(fx, "cabo-iris-sweep1.raw.gz"), "rb").read())
truth = json.load(open(os.path.join(fx, "cabo-iris-truth.json")))

for f in (__file__, os.path.join(ROOT, "pi", "mrrl_iris.py"), os.path.join(ROOT, "pi", "mrrl.py")):
    ok("no em dashes in " + os.path.basename(f), chr(0x2014) not in open(f, encoding="utf-8").read())

ok("an IRIS RAW file is recognised", M.is_iris(raw))
ok("an Archive II file is not", not M.is_iris(b"AR2V0006.001" + b"\x00" * 20000))
loc = M.location(raw)
ok("the radar is placed from its own header (Los Cabos)",
   loc and abs(loc[0] - truth["lat"]) < 1e-3 and abs(loc[1] - truth["lon"]) < 1e-3, loc)

hdr, sweeps = M.read(raw)
rays = sweeps[0]["rays"]
ok("the sweep is read, ray by ray", len(rays) == truth["nrays_in_fixture"], len(rays))
# IRIS stores 0 for "no data"; xradar still decodes a 0 into a number (a
# ZDR of -8, a velocity of zero), so those gates are empty here and numbers
# there. Every gate this reader gives a value must be xradar's value, and it
# must give values for nearly all the gates xradar does.
ZERO = {"VEL": (0.0,), "SW": (0.0,), "ZDR": (-8.0,), "PHI": (180.0 * -1 / 254,)}
worst, gates, extra, theirs, missed = {}, 0, 0, 0, 0
for k, row in enumerate(truth["rays"]):
    for name, want in row.items():
        got = rays[k].get(name)
        for g, w in enumerate(want):
            v = None if got is None or g >= len(got) or math.isnan(got[g]) else float(got[g])
            theirs += w is not None
            if v is None:
                # Only a stored zero may be missing here: what 0 decodes to.
                if w is not None and not any(abs(w - z) < 0.01 for z in ZERO.get(name, ())):
                    missed += 1
                continue
            if w is None:
                extra += 1
                continue
            gates += 1
            worst[name] = max(worst.get(name, 0.0), abs(v - w))
ok(f"every moment matches xradar gate for gate ({gates} gates)",
   extra == 0 and all(d < 0.01 for d in worst.values()) and set(worst) == {"REF", "VEL", "ZDR", "PHI", "RHO", "SW"},
   (extra, worst))
ok("and every gate xradar has that this leaves empty is a stored no-data zero",
   missed == 0, (missed, gates, theirs))

ar = M.to_ar2v(raw, "CABO")
ok("the conversion is an Archive II volume named for the site", ar[:12] == b"AR2V0006.001" and ar[20:24] == b"CABO")
p, sizes, first = 24, [], None
while p + 4 <= len(ar):
    n = abs(struct.unpack(">i", ar[p:p + 4])[0])
    blk = ar[p + 4:p + 4 + n]
    out = bz2.decompress(blk)
    sizes.append(len(out))
    first = first or out
    p += 4 + n
ok("every record is one bzip2 block (under 900 KB), as the browser decoder needs",
   sizes and max(sizes) < 900_000, max(sizes) if sizes else None)
ok("the radials are Message 31 carrying the radar's position", first[15] == 31 and b"RVOL" in first[:400])
ok("and mrrl.py reads the position back out of the converted file",
   mrrl.site_location(ar) and abs(mrrl.site_location(ar)[0] - truth["lat"]) < 1e-3)

# mrrl.py: an IRIS file is converted on the way through, and a .tmp is skipped.
conv = mrrl.as_ar2v(raw, "CABO")
ok("mrrl.as_ar2v converts IRIS rather than refusing it", conv[:4] == b"AR2V")
listing = "\r\n".join([
    "100 LT40_20260925184000.ar2v",
    "200 LT40_20260925184500.ar2v.tmp",
    "300 CABO20260925182853.RAW02XU.gz",
    "10 CABO.cabos_seen.json",
])
names = [e["name"] for e in mrrl.parse_dir_list("LT40", listing)]
ok("a volume still being written (.tmp) is not listed", names == ["LT40_20260925184000.ar2v"], names)
names = [e["name"] for e in mrrl.parse_dir_list("CABO", listing)]
ok("an IRIS volume is listed, the feed's bookkeeping is not", names == ["CABO20260925182853.RAW02XU.gz"], names)
codes = mrrl.site_codes("Site: BOO_\nSite: CABO\n", index='<a href="BOO_/">x</a><a href="NEW_/">y</a><a href="../">z</a>')
ok("every site in the feed's own folder list is included too", codes == ["BOO_", "CABO", "NEW_"], codes)

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
