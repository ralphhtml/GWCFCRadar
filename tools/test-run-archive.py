#!/usr/bin/env python3
"""The model run archive: five days of every run, pruned by age, listed in
the index, and never able to delete the last picture a model has.

    python3 tools/test-run-archive.py

Everything here runs the real functions in pi/gfs_pipeline.py against a real
temporary directory, because retention code that is only ever reasoned about
is retention code that one day deletes the wrong five days.

WHY AGE AND NOT COUNT. Count-based pruning kept four runs of everything,
which is one day of a six-hourly model and four HOURS of an hourly one: how
much history you got depended on the model's cadence, which nobody chose.
Age treats them alike.

THE TWO GUARDS. The newest run never goes, however old, so a model that
stopped publishing keeps its last picture instead of aging into nothing.
And the window rides the disk: on a filling card the ladder in
hours_for_disk shortens history evenly by age rather than letting whichever
model pruned last keep more.
"""

import datetime as dt
import io
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))
import gfs_pipeline as G                      # noqa: E402

PASS = FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + ("  <%s>" % extra if extra else ""))


def run_id(hours_ago):
    t = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours_ago)
    return t.strftime("%Y%m%d_%H")


def mk(base, run, manifest=True):
    p = os.path.join(base, run)
    os.makedirs(p, exist_ok=True)
    if manifest:
        with open(os.path.join(p, "manifest.json"), "w") as f:
            f.write("{}")


print("\n1. the window is five days, by age")
ok("the constant says five", getattr(G, "KEEP_DAYS", None) == 5,
   str(getattr(G, "KEEP_DAYS", None)))
d = tempfile.mkdtemp()
try:
    ages = [0, 6, 24, 72, 118, 121, 130, 200]
    for a in ages:
        mk(d, run_id(a))
    G.prune(d)
    left = set(os.listdir(d))
    for a in ages:
        want = a <= 120
        ok("a run %dh old is %s" % (a, "kept" if want else "pruned"),
           (run_id(a) in left) == want)
finally:
    shutil.rmtree(d, ignore_errors=True)

print("\n2. the newest run never goes, however old")
d = tempfile.mkdtemp()
try:
    # A model that stopped publishing months ago: every run is far past the
    # window, and the floor has to hold the newest few anyway.
    for a in [2000, 2010, 2020, 2030, 2040, 2050]:
        mk(d, run_id(a))
    G.prune(d)
    left = sorted(os.listdir(d))
    ok("the KEEP_RUNS floor holds even when everything is ancient",
       len(left) == G.KEEP_RUNS, "%d left" % len(left))
    ok("and what it held is the newest, not an arbitrary pick",
       run_id(2000) in left and run_id(2050) not in left)
finally:
    shutil.rmtree(d, ignore_errors=True)

print("\n3. things prune must not trip over")
d = tempfile.mkdtemp()
try:
    mk(d, run_id(1))
    mk(d, "palettes", manifest=False)           # a non-run directory
    os.makedirs(os.path.join(d, "_scratch"))    # not digit-led either
    with open(os.path.join(d, "notes.txt"), "w") as f:
        f.write("x")
    G.prune(d)
    ok("non-run directories and files are untouched",
       os.path.isdir(os.path.join(d, "palettes"))
       and os.path.isdir(os.path.join(d, "_scratch"))
       and os.path.exists(os.path.join(d, "notes.txt")))
    ok("a directory that does not exist is a no-op, not a crash",
       G.prune(os.path.join(d, "nope")) is None)
    ok("an unparseable run id is treated as new, so it is never deleted",
       G._run_age_h("garbage") == 0.0)
finally:
    shutil.rmtree(d, ignore_errors=True)

print("\n4. the index advertises the archive")
d = tempfile.mkdtemp()
try:
    old_out = G.OUT_DIR
    G.OUT_DIR = d
    base = os.path.join(d, "gfs", "conus")
    newest, older = run_id(2), run_id(8)
    mk(base, older)
    mk(base, newest)
    mk(base, run_id(5), manifest=False)     # died halfway: must not be offered
    runs = G._runs_on_disk("gfs", "conus")
    ok("runs are listed newest first", runs and runs[0] == newest, str(runs))
    ok("and the older one is there too", older in runs)
    # A run without a manifest is a blank map with a date on it.
    ok("a half-built run is not offered", run_id(5) not in runs)
    entry = G._index_entry("gfs", "conus",
                           {"run": newest, "label": "GFS", "fields": {}})
    ok("the index entry carries the archive", entry.get("runs") == runs)
    ok("and still points its path at the run it was given",
       entry["path"] == "gfs/conus/%s/manifest.json" % newest)
    ok("a model with no directory lists an empty archive, not a crash",
       G._runs_on_disk("nosuch", "conus") == [])
    G.OUT_DIR = old_out
finally:
    shutil.rmtree(d, ignore_errors=True)

print("\n5. the browser is wired to read it")
page = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
ok("the run picker fills from the entry's archive",
   "Array.isArray(entry.runs)" in page)
ok("an old index without runs degrades to the single Latest line",
   "degrades to exactly the single Latest line" in page)
ok("picking a run loads that run's own manifest",
   "_hdLoadRunManifest" in page and "run + '/manifest.json'" in page)
ok("the picture directory follows the LOADED manifest, not the index's latest",
   page.count("entry.path.replace(/[^/]+\\/manifest\\.json$/, _hdManifest.run)") == 2)
ok("a past run tints the picker so the past is visible at a glance",
   "sel.style.color = sel.value === runs[0]" in page)
ok("region changes go back to the latest run",
   '_hdRun = null;   // "the 06z run" of one place says nothing about another'
   in page)
ok("a run the Pi no longer holds refuses with an explanation",
   "That run is no longer on the Pi. It keeps five days." in page)

EM = chr(0x2014)
files = ["pi/gfs_pipeline.py", "tools/test-run-archive.py", "index.html"]
bad = [f for f in files
       if EM in io.open(os.path.join(ROOT, f), encoding="utf-8").read()]
ok("no em dashes in the touched files", not bad, ", ".join(bad))

print("\n%s" % ("%d FAILED, %d passed" % (FAIL, PASS) if FAIL
                else "all %d passed" % PASS))
sys.exit(1 if FAIL else 0)
