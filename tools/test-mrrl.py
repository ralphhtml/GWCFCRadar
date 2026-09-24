#!/usr/bin/env python3
"""pi/mrrl.py: the MRRL radar feed on the parsing server.

    python3 tools/test-mrrl.py

Offline. Checked: the site list and dir.list are read the way the feed
writes them (including CRLF lines and files with no extension); scan times
come out of both name spellings; the shapes refuse anything that is not a
real site's own file (no paths, no other hosts); gzipped volumes are
unwrapped by their magic number; a radar's position is read from its own
volume block, bzip2 or plain, and a zeroed one is refused; sites.json keeps
an old position when a site cannot be read, and positions.json places one
by hand.
"""

import gzip
import json
import os
import sys
import tempfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "pi"))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import mrrl  # noqa: E402
import mrrl_synth  # noqa: E402

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


print("\n1. the feed's own lists")
codes = mrrl.site_codes("Site: 1852\r\nSite: BOO_\nSite: ../x\nSite: BOO_\nnonsense\n")
ok("config.cfg: every site once, bad names dropped", codes == ["1852", "BOO_"], codes)
entries = mrrl.parse_dir_list("1852", "6222893 1852CAN20260924_152740_V06\r\n5921255 1852CAN20260924_153537_V06\r\n12 OTHER_20260924153537.ar2v\r\nx y\r\n")
ok("dir.list: CRLF lines, files with no extension, only this site's", [e["name"] for e in entries] == ["1852CAN20260924_152740_V06", "1852CAN20260924_153537_V06"], entries)
ok("oldest first, sizes kept", entries[0]["t"] < entries[1]["t"] and entries[0]["size"] == 6222893)
ok("scan time from BOO__20260924155402.ar2v", mrrl.stamp_ms("BOO__20260924155402.ar2v") == 1790265242000)
ok("and from AKIT20260924_154000_2.msg31.gz", mrrl.stamp_ms("AKIT20260924_154000_2.msg31.gz") == 1790264400000)

print("\n2. only real files of real sites")
bad = ["../etc", "BOO", "BOO_/x", "http:", "A B_"]
ok("site codes are four letters, digits or underscores", all(not mrrl.SITE_RE.fullmatch(b) for b in bad) and mrrl.SITE_RE.fullmatch("dbor"))
bad_files = ["../BOO__x.ar2v", "BOO_/../../x", "BOO__x.ar2v?y=1", "BOO__x.a.b.c"]
ok("file names cannot carry a path or a query", all(not mrrl.FILE_RE.fullmatch(f) for f in bad_files))
try:
    mrrl.volume("BOO_", "SP41_20260924155008.ar2v")
    ok("another site's file is refused", False)
except ValueError:
    ok("another site's file is refused", True)

print("\n3. volumes and positions")
plain = mrrl_synth.volume("1852", 21.03, -86.85)
bz = mrrl_synth.volume("BOO_", 54.0, 10.05, bz=True)
ok("a gzipped volume is unwrapped by its magic number", mrrl.as_ar2v(gzip.compress(plain)) == plain)
ok("a plain one is left alone", mrrl.as_ar2v(plain) == plain)
try:
    mrrl.as_ar2v(b"<html>maintenance</html>")
    ok("a page that is not a volume is refused", False)
except ValueError:
    ok("a page that is not a volume is refused", True)
loc = mrrl.site_location(plain)
ok("position from a plain volume", loc and abs(loc[0] - 21.03) < 1e-3 and abs(loc[1] + 86.85) < 1e-3, loc)
loc = mrrl.site_location(bz)
ok("and from bzip2 records", loc and abs(loc[0] - 54.0) < 1e-3 and abs(loc[1] - 10.05) < 1e-3, loc)
ok("a volume cut short still gives it", mrrl.site_location(plain[:5000]) is not None)
ok("a zeroed position is no position", mrrl.site_location(mrrl_synth.volume("nhas", 0.0, 0.0)) is None)

print("\n4. sites.json")
with tempfile.TemporaryDirectory() as d:
    mrrl.DATA = d
    heads = {"BOO_": bz, "1852": plain, "nhas": mrrl_synth.volume("nhas", 0.0, 0.0)}
    logs = []
    mrrl.build_sites(codes=["BOO_", "1852", "nhas"], fetch_head=lambda c: heads[c], log=logs.append)
    js = json.load(open(os.path.join(d, "sites.json")))
    ok("placed from their own volumes", [s["id"] for s in js["sites"]] == ["BOO_", "1852"], js)
    ok("the one without a position is named in the log", any("nhas" in x for x in logs), logs)
    json.dump({"nhas": [70.5, 22.1]}, open(os.path.join(d, "positions.json"), "w"))
    def fail_boo(c):
        if c == "BOO_":
            raise OSError("down for maintenance")
        return heads[c]
    mrrl.build_sites(codes=["BOO_", "1852", "nhas"], fetch_head=fail_boo, log=lambda *_: None)
    js = {s["id"]: s for s in json.load(open(os.path.join(d, "sites.json")))["sites"]}
    ok("a site that cannot be read keeps its old position", js.get("BOO_", {}).get("lat") == 54.0, js)
    ok("positions.json places one by hand", js.get("nhas", {}).get("lat") == 70.5, js)

print("\n5. no em dashes")
EM = chr(0x2014)
ok("in mrrl.py, mrrl_synth.py and this test", all(EM not in open(os.path.join(ROOT, f)).read()
   for f in ("pi/mrrl.py", "tools/mrrl_synth.py", "tools/test-mrrl.py")))

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
