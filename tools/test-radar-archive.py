#!/usr/bin/env python3
"""The parsing server's radar Time Machine doors (pi/radar_archive.py).

    python3 tools/test-radar-archive.py

Offline: NOAA's listings and Google's day bundles are stood in for, so this
checks what the module does with them (which folder, which file, what is
kept, what is refused), not the archives themselves.
"""

import io
import os
import sys
import tarfile
import tempfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))
import radar_archive as ra  # noqa: E402

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


def ms(*a):
    return int(datetime(*a, tzinfo=timezone.utc).timestamp() * 1000)


EM = chr(0x2014)
ok("no em dashes in the module or this test",
   EM not in open(os.path.join(ROOT, "pi", "radar_archive.py"), encoding="utf-8").read()
   and EM not in open(__file__, encoding="utf-8").read())

print("\n1. MRMS: the archive folder and the nearest file")
LIST = {
    "CONUS/MergedReflectivityQCComposite": (["x"], ["CONUS/MergedReflectivityQCComposite_00.50/"]),
    "CONUS/QPE_ARI01H": ([], []),
    "CONUS/FLASH_QPE_ARI01H": ([], ["CONUS/FLASH_QPE_ARI01H_00.00/"]),
    "CONUS/MergedReflectivityQCComposite_00.50/20240506/": ([
        "CONUS/MergedReflectivityQCComposite_00.50/20240506/MRMS_MergedReflectivityQCComposite_00.50_20240506-225838.grib2.gz",
        "CONUS/MergedReflectivityQCComposite_00.50/20240506/MRMS_MergedReflectivityQCComposite_00.50_20240506-230040.grib2.gz",
        "CONUS/MergedReflectivityQCComposite_00.50/20240506/MRMS_MergedReflectivityQCComposite_00.50_20240506-230238.grib2.gz",
    ], []),
}


def lister(bucket, prefix, delimiter=None, max_keys=1000):
    return LIST.get(prefix, ([], []))


ra._mrms_dirs.clear()
d = ra.mrms_archive_dir("composite", {"path": "MergedReflectivityQCComposite"}, lister)
ok("a live product name finds its archive folder with its level", d == "CONUS/MergedReflectivityQCComposite_00.50/", d)
d = ra.mrms_archive_dir("ari01", {"path": "QPE_ARI01H", "base": "https://mrms.ncep.noaa.gov/data/FLASH"}, lister)
ok("a FLASH product is found under its FLASH_ name", d == "CONUS/FLASH_QPE_ARI01H_00.00/", d)
k = ra.mrms_nearest_key("CONUS/MergedReflectivityQCComposite_00.50/", ms(2024, 5, 6, 23, 0, 30), lister)
ok("the file nearest the moment is chosen, not the last before it", k and k[0].endswith("20240506-230040.grib2.gz"), str(k))
try:
    ra.mrms_frame("composite", ms(2019, 5, 6), lister=lister)
    ok("a moment before October 2020 is refused plainly", False)
except LookupError as e:
    ok("a moment before October 2020 is refused plainly", "October 2020" in str(e), str(e))
try:
    ra.mrms_frame("not-a-product", ms(2024, 5, 6), lister=lister)
    ok("a name outside the catalogue is refused", False)
except ValueError:
    ok("a name outside the catalogue is refused", True)

print("\n2. Level 3 before 2022: one pass over the day's bundle")
tmp = tempfile.mkdtemp()
ra.DATA = tmp


def bundle():
    """A small stand-in for a radar-day: a few kept products, and others."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        for name, data in [
            ("KOUN_SDUS54_N0HTLX_201505062255", b"a" * 50),
            ("KOUN_SDUS54_N0HTLX_201505062305", b"b" * 50),
            ("KOUN_SDUS24_N0QTLX_201505062259", b"c" * 50),
            ("KOUN_NXUS64_GSMTLX_201505062259", b"status message, not kept"),
            ("KOUN_SDUS84_DVLTLX_201505062259", b"d" * 50),
            ("../../etc/passwd", b"not kept either"),
        ]:
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            t.addfile(ti, io.BytesIO(data))
    buf.seek(0)
    return buf


ra.l3_bundle = lambda site, day: ("https://storage.googleapis.com/x.tar.gz", 1234)
at = ms(2015, 5, 6, 23, 1)
r = ra.l3_request("KTLX", ["N0H"], at, opener=lambda url: bundle(), background=False)
ok("the nearest scan of the product asked for is ready", r.get("status") == "ready" and r.get("stamp") == "201505062305", str(r))
kept = sorted(os.listdir(os.path.join(tmp, "radar-archive", "l3", "KTLX", "20150506")))
ok("only the drawable products were kept", kept == ["DVL", "N0H", "N0Q"], str(kept))
ok("a name that tries to climb out of the folder was not written",
   not os.path.exists(os.path.join(tmp, "etc")) and not os.path.exists(os.path.join(tmp, "radar-archive", "etc")))
r2 = ra.l3_request("KTLX", ["DVL", "NVL"], at, background=False)
ok("a second product of the same day is answered from disk", r2.get("status") == "ready" and r2.get("code") == "DVL", str(r2))
r3 = ra.l3_request("KTLX", ["N0S"], at, background=False)
ok("a product the radar did not make that day says so", r3.get("status") == "missing", str(r3))
body = ra.l3_file("KTLX", "N0H", "201505062305", at)
ok("the kept file comes back byte for byte", body == b"b" * 50, str(body)[:40])
ok("a stamp that is not a stamp is refused", ra.l3_file("KTLX", "N0H", "../../x", at) is None)
ok("a code outside the list is refused", ra.l3_file("KTLX", "GSM", "201505062259", at) is None)
ra.l3_bundle = lambda site, day: None
r4 = ra.l3_request("KTLX", ["N0H"], ms(2015, 5, 7, 12), background=False)
ok("a day the archive does not have is reported, not hung on", r4.get("status") == "missing" and "no Level 3 bundle" in r4.get("error", ""), str(r4))

print("\n3. HRRR: the hour and the floor")
try:
    ra.hrrr_frame("refc", ms(2013, 1, 1))
    ok("before July 2014 is refused plainly", False)
except LookupError as e:
    ok("before July 2014 is refused plainly", "July 2014" in str(e), str(e))
try:
    ra.hrrr_frame("t2m", ms(2024, 5, 6))
    ok("only the fields this door builds are accepted", False)
except ValueError:
    ok("only the fields this door builds are accepted", True)

print("\n4. serve.py checks every door's input")
src = open(os.path.join(ROOT, "pi", "serve.py"), encoding="utf-8").read()
ok("the four doors are routed", all(d in src for d in ("/radar/archive/mrms", "/radar/archive/l3", "/radar/archive/l3file", "/radar/archive/hrrr")))
ok("sites, codes and the moment are checked before anything is fetched",
   "ra.SITE_RE.fullmatch(site)" in src and "c not in ra.L3_CODES" in src and "must be a moment since 1990" in src)
ok("rendering is one at a time", "_radar_arc_gate.acquire" in src)

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
