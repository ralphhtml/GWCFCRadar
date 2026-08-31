#!/usr/bin/env python3
"""The pipeline that stops models going stale, held to its promises.

    python3 tools/test-pipeline-freshness.py

Models kept going stale for three reasons, each fixed and each pinned here.

First, wrong maxima: run_is_complete probes a run's LAST forecast hour, so a
model whose configured maximum exceeds what NOAA publishes NEVER builds (the
probe 404s forever), and one set short never reaches the hours it could. The
maxima below were read from the live S3 buckets, not from documentation, and
this file keeps every ladder at exactly those figures.

Second, no backoff: a permanently failing model is by definition the stalest,
so it sat at the head of the stalest-first queue burning the whole budget
every single pass while healthy models behind it aged. Now a failure earns a
growing wait, a new run resets it, and "the run is not published yet" is
explicitly not a failure at all.

Third, one worker and a fixed calendar: covered on the install.sh side, whose
timer and budget arithmetic are asserted here too, because the three parts
only prevent staleness together.
"""

import os
import re
import sys
import threading
import time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "pi"))

import gfs_pipeline as gp  # noqa: E402

PASS = FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + ("  <%s>" % extra if extra else ""))


print("\n1. every ladder reaches the hour the bucket actually serves")
f = gp.fhours_for
M = gp.MODELS
for name, cyc, last in [
    # GEFS publishes two grids with different reaches: the half-degree
    # pgrb2a set runs to f384, the quarter-degree pgrb2s set stops at f240.
    ("gfs", None, 384), ("gefs", None, 384), ("gefsp01", None, 384),
    ("gefs0p25", None, 240), ("gefsspr25", None, 240),
    ("nam", None, 84), ("nbm", None, 264), ("gfswave", None, 384),
    ("ecmwf", None, 360), ("ecmwfaifs", None, 360),
    ("hrrr", 0, 48), ("hrrr", 6, 48), ("hrrr", 12, 48), ("hrrr", 18, 48),
    ("hrrr", 1, 18), ("hrrr", 7, 18),
    ("rap", 3, 51), ("rap", 9, 51), ("rap", 15, 51), ("rap", 21, 51),
    ("rap", 0, 21), ("rap", 12, 21),
    ("hafs", None, 126), ("hafsb", None, 126),
]:
    if name not in M:
        ok("%s exists" % name, False)
        continue
    hours = f(M[name], cyc)
    tag = name + ("" if cyc is None else " %02dz" % cyc)
    ok("%s reaches f%03d" % (tag, last), hours[-1] == last, str(hours[-1]))

print("\n2. and every ladder is a usable ladder")
for name, m in M.items():
    for cyc in (0, 6, 12, 18):
        hours = f(m, cyc)
        if not hours:
            ok("%s has hours" % name, False)
            break
        strictly = all(b > a for a, b in zip(hours, hours[1:]))
        if not strictly:
            ok("%s %02dz hours strictly increase" % (name, cyc), False,
               str(hours[:8]))
            break
    else:
        ok("%s hours strictly increase at every cycle" % name, True)

# A region's own "out" override must never undercut the model's raised reach:
# that is how NAM's nests quietly stopped short once before.
short = []
for name, m in M.items():
    base = m.get("out")
    for rname, r in (m.get("regions") or {}).items():
        if base and r.get("out") and r["out"] < base and "domain" not in r:
            short.append("%s/%s" % (name, rname))
ok("no fixed region is cut shorter than its model", not short, ", ".join(short))

print("\n3. failure backoff: the stalest-first queue cannot be hogged")
bw, na = gp.backoff_wait_s, gp.note_attempt
now = time.time()
ok("a model never tried waits nothing", bw(None, "20260831_06") == 0)
ok("a NEW run resets an old run's failures",
   bw({"run": "20260831_00", "at": now, "fails": 5}, "20260831_06") == 0)
w1 = bw({"run": "20260831_06", "at": now, "fails": 1}, "20260831_06")
w2 = bw({"run": "20260831_06", "at": now, "fails": 2}, "20260831_06")
w9 = bw({"run": "20260831_06", "at": now, "fails": 9}, "20260831_06")
ok("one failure earns a short wait", 0 < w1 <= 15 * 60, str(int(w1)))
ok("repeated failures wait longer", w2 > w1, "%d vs %d" % (w2, w1))
ok("but never more than four hours", w9 <= 4 * 3600, str(int(w9)))
ok("and time served counts",
   bw({"run": "20260831_06", "at": now - 5 * 3600, "fails": 9},
      "20260831_06") == 0)

st = {}
na(st, "gfs/conus", "20260831_06", False)
na(st, "gfs/conus", "20260831_06", False)
ok("failures accumulate", st["gfs/conus"]["fails"] == 2)
na(st, "gfs/conus", "20260831_06", True)
ok("success clears the slate entirely", "gfs/conus" not in st)
na(st, "nam/conus", "20260831_00", False)
na(st, "nam/conus", "20260831_06", False)
ok("a fresh run starts its count at one", st["nam/conus"]["fails"] == 1)

print("\n4. the parallel machinery is actually wired in")
SRC = open(os.path.join(ROOT, "pi", "gfs_pipeline.py")).read()
ok("builds run in a worker pool", "ThreadPoolExecutor(max_workers=workers)" in SRC)
ok("worker count is tunable", 'GWCFC_WORKERS' in SRC)
ok("the index is mutated under a lock", "index_lock" in SRC)
ok("attempts are saved at the end of a pass", "_attempts_save(attempts)" in SRC)
ok('"not published yet" is not treated as a failure',
   '_build_why.reason = "unpublished"' in SRC
   and 'why != "unpublished"' in SRC)
sess_main = gp._http()
seen = []
t = threading.Thread(target=lambda: seen.append(gp._http()))
t.start(); t.join()
ok("each worker thread gets its own HTTP session",
   seen and seen[0] is not sess_main)
ok("the module-level HTTP alias the other pipelines import still exists",
   hasattr(gp, "HTTP"))

print("\n5. the budgets and the timer agree with each other")
ok("a standard pass stops at 25 minutes", gp.TIME_BUDGET_S == 25 * 60,
   str(gp.TIME_BUDGET_S))
ok("a first-install catch-up still gets three hours",
   gp.CATCHUP_BUDGET_S == 3 * 3600, str(gp.CATCHUP_BUDGET_S))
ok("the archive keeps five days", gp.KEEP_DAYS == 5, str(gp.KEEP_DAYS))
INSTALL = open(os.path.join(ROOT, "pi", "install.sh")).read()
mtimer = re.search(r'gwcfc-models\.timer.*?^EOF', INSTALL, re.S | re.M)
tblock = mtimer.group(0) if mtimer else ""
# A directive LINE, not the word: the comment explaining the change away
# from OnCalendar is allowed to say its name.
ok("the models timer chains rather than keeping appointments",
   "OnUnitInactiveSec=" in tblock
   and not re.search(r"^OnCalendar", tblock, re.M))
ok("and starts soon after boot", "OnBootSec=" in tblock)
msvc = re.search(r'gwcfc-models\.service.*?^EOF', INSTALL, re.S | re.M)
sblock = msvc.group(0) if msvc else ""
tmo = re.search(r"TimeoutStartSec=(\d+)", sblock)
ok("the service timeout clears the catch-up budget",
   tmo and int(tmo.group(1)) > gp.CATCHUP_BUDGET_S,
   tmo.group(1) if tmo else "missing")
ok("the update timer still checks every minute",
   "OnUnitActiveSec=60" in INSTALL)

print("\n6. the neighbours still stand")
import check_models  # noqa: E402,F401
ok("check_models imports against the new fhours_for", True)
hours_one_arg = gp.fhours_for(M["gfs"])
ok("fhours_for still answers with one argument",
   hours_one_arg[-1] == 384, str(hours_one_arg[-1]))
EM = chr(0x2014)
bad = [p for p in ("pi/gfs_pipeline.py", "pi/install.sh",
                   "tools/test-pipeline-freshness.py")
       if EM in open(os.path.join(ROOT, p)).read()]
ok("no em dashes", not bad, ", ".join(bad))

print()
print("%d FAILED, %d passed" % (FAIL, PASS) if FAIL else "all %d passed" % PASS)
sys.exit(1 if FAIL else 0)
