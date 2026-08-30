#!/usr/bin/env python3
"""Every model in the pipeline, fetched from its real address.

    python3 tools/test-model-index.py            # the newly added ones
    python3 tools/test-model-index.py --all      # every model in the table
    python3 tools/test-model-index.py --key hrrrak

A model in MODELS that has never been fetched is worse than an absent one: it
puts a name on the menu and then quietly fails, and the failure looks like the
Pi being slow rather than like a wrong path. So this asks the actual question,
against the actual host, at a forecast hour and cycle the pipeline would
really request.

WHAT COUNTS AS WORKING. Not "the server answered". A 200 carrying an HTML
error page is still a 200, and NOMADS in particular answers a burst with a
redirect to a throttle notice that looks exactly like a file. So the body has
to parse as a GRIB index: colon-separated fields, a record number first, and
a byte offset second. That is the thing the pipeline's byte-range fetch
depends on, so it is the thing worth checking.

WHY AWS AND NOT NOMADS. The pipeline prefers NOMADS and falls back to the AWS
open-data mirror. The mirror carries the same files under the same names, so
verifying there verifies the path. It is also the only one reachable from
some networks, this sandbox included, which is the honest reason this test
uses it: a test that cannot run proves nothing.

DATES. Model output expires. The test walks back through recent cycles rather
than pinning one, so it keeps working tomorrow, and it says which cycle
answered so a failure can be told apart from a model simply not having run
yet.
"""

import argparse
import concurrent.futures as cf
import datetime
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = open(os.path.join(ROOT, "pi", "gfs_pipeline.py"), encoding="utf-8").read()

# The models added in the pass that introduced this test. Kept as a list so
# the default run is fast and targeted; --all sweeps the whole table.
NEW = [
    "gfsb", "gfs0p50b", "gfsflux", "gdasflux", "gfssat",
    "gfswaveatl", "gfswavepac", "gfswavewc", "gfswavegulf", "gfswavearc",
    "hrrrprs", "hrrrnat", "hrrrak", "hrrrakprs", "hrrrsubak",
    "rap130", "rapp252", "rapp236", "rapak", "rapnat",
    "namak", "namhi", "nampr", "namawak", "namafwaca", "namafwahi", "namawip32",
    "gefsp08", "gefsp09", "gefsp10", "gefsp11", "gefsp12", "gefsspr25",
    "urmaak",
]


def models_block():
    i = SRC.index("\nMODELS = {")
    m = re.search(r"\n\}\n", SRC[i:])
    return SRC[i:i + m.start()]


def mirrors():
    m = re.search(r"S3_MIRRORS = \{(.*?)\}", SRC, re.S)
    return dict(re.findall(r'"(\w+)":\s*"([\w-]+)"', m.group(1)))


def raw_templates(block, key):
    """Every raw address a model names, as URL templates."""
    m = re.search(r'^    "%s": \{(.*?)\n    \},' % re.escape(key), block, re.S | re.M)
    if not m:
        return []
    body = m.group(1)
    out = []
    for rm in re.finditer(r'"raw":\s*(\[.*?\]|(?:"[^"]*"\s*)+)', body, re.S):
        for s in re.findall(r'"((?:[^"\\]|\\.)*)"', rm.group(1)):
            if s.strip():
                out.append(s)
    # Adjacent string literals are concatenated by Python, and a template split
    # across two lines is one address rather than two. Joining anything that
    # does not already look like a complete address is what reassembles them.
    joined, buf = [], ""
    for piece in out:
        buf += piece
        if buf.endswith(".idx") or buf.endswith(".index") or buf.endswith(".grb2"):
            joined.append(buf)
            buf = ""
    if buf:
        joined.append(buf)
    return joined


def to_s3(tmpl, mir):
    """An address this test can actually reach, or None."""
    if tmpl.startswith("http"):
        return tmpl if "s3.amazonaws.com" in tmpl else None
    parts = tmpl.split("/")
    bucket = mir.get(parts[0])
    if not bucket:
        return None
    rest = parts[1:]
    if rest and rest[0] == "prod":
        rest = rest[1:]
    return "https://%s.s3.amazonaws.com/%s" % (bucket, "/".join(rest))


def looks_like_index(body):
    """A GRIB index, not an HTML error page that happened to return 200."""
    txt = body.decode("latin-1", "replace")
    if "<" in txt[:40]:
        return False
    line = txt.splitlines()[0] if txt.splitlines() else ""
    # "1:0:d=2026083000:PRMSL:mean sea level:anl:"
    return bool(re.match(r"^\s*\d+:\d+:", line))


def fetch(url, timeout=25):
    rq = urllib.request.Request(url, method="GET", headers={"Range": "bytes=0-400"})
    try:
        with urllib.request.urlopen(rq, timeout=timeout) as r:
            return r.status, r.read(400)
    except Exception as e:                       # noqa: BLE001
        return getattr(e, "code", 0) or 0, b""


def cycles_for(cycle_h):
    step = max(1, int(cycle_h or 6))
    return ["%02d" % h for h in range(0, 24, step)]


def spec_body(block, key):
    m = re.search(r'^    "%s": \{(.*?)\n    \},' % re.escape(key), block, re.S | re.M)
    return m.group(1) if m else ""


def spec(block, key):
    m = re.search(r'^    "%s": \{(.*?)\n    \},' % re.escape(key), block, re.S | re.M)
    body = m.group(1) if m else ""
    def num(name, default):
        mm = re.search(r'"%s":\s*(\d+)' % name, body)
        return int(mm.group(1)) if mm else default
    lab = re.search(r'"label":\s*"([^"]*)"', body)
    return {"cycle_h": num("cycle_h", 6), "step": num("step", 3),
            "label": lab.group(1) if lab else key}


def check(key, block, mir):
    sp = spec(block, key)
    tmpls = raw_templates(block, key)
    urls = [u for u in (to_s3(t, mir) for t in tmpls) if u]
    if not tmpls:
        # A model with a "source" key is fetched by a named handler that knows
        # a layout of its own (ECMWF's date/cycle tree, DWD's, Environment
        # Canada's) rather than by filling in a NOMADS-shaped template. There
        # is no path here to check, and calling that a failure would be this
        # test reporting its own blind spot as the pipeline's bug.
        if re.search(r'"source":\s*"', spec_body(block, key)):
            return key, "SKIP", sp["label"], "fetched by a source handler, no raw path"
        return key, "NOPATH", sp["label"], "no raw address in the table"
    if not urls:
        # Honest rather than a false pass: NOMADS-only models exist and the Pi
        # can reach them even though this test cannot.
        return key, "SKIP", sp["label"], "no AWS mirror, NOMADS only"
    now = datetime.datetime.utcnow()
    fhr = sp["step"]
    for back in range(0, 3):
        d = (now - datetime.timedelta(days=back)).strftime("%Y%m%d")
        for cyc in reversed(cycles_for(sp["cycle_h"])):
            for u in urls:
                try:
                    url = u.format(date=d, cyc=cyc, fhr=fhr)
                except (KeyError, IndexError, ValueError):
                    # The storm-following hurricane nests name a storm in their
                    # path, and which storms exist changes by the day. Without
                    # a live storm id there is nothing to fetch, so this is a
                    # skip rather than a failure.
                    if "{storm}" in u:
                        return key, "SKIP", sp["label"], "storm-following nest, needs a live storm id"
                    return key, "BADTMPL", sp["label"], u
                st, body = fetch(url)
                if st in (200, 206):
                    if looks_like_index(body):
                        return key, "OK", sp["label"], "%s %sz f%03d" % (d, cyc, fhr)
                    return key, "NOTINDEX", sp["label"], url
    return key, "MISS", sp["label"], urls[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="every model, not just the new ones")
    ap.add_argument("--key", action="append", help="check one model by key")
    ap.add_argument("--jobs", type=int, default=10)
    a = ap.parse_args()

    block = models_block()
    mir = mirrors()
    all_keys = re.findall(r'^    "([a-z0-9_]+)": \{', block, re.M)
    if a.key:
        keys = a.key
    elif a.all:
        keys = all_keys
    else:
        keys = NEW

    missing = [k for k in keys if k not in all_keys]
    if missing:
        print("these keys are not in MODELS at all: " + ", ".join(missing))
        return 1

    print("checking %d of %d models against the AWS open-data mirror\n" % (len(keys), len(all_keys)))
    rows = []
    with cf.ThreadPoolExecutor(a.jobs) as ex:
        for r in ex.map(lambda k: check(k, block, mir), keys):
            rows.append(r)
            key, st, lab, note = r
            mark = {"OK": "  ok  ", "SKIP": " skip ", "MISS": " FAIL ",
                    "NOTINDEX": " FAIL ", "NOPATH": " FAIL ", "BADTMPL": " FAIL "}[st]
            print("%s %-14s %-28s %s" % (mark, key, lab, note if st != "OK" else note))

    ok = sum(1 for r in rows if r[1] == "OK")
    skip = sum(1 for r in rows if r[1] == "SKIP")
    bad = [r for r in rows if r[1] not in ("OK", "SKIP")]
    print("\n%d fetched a real GRIB index, %d skipped (NOMADS only), %d failed"
          % (ok, skip, len(bad)))
    for k, st, lab, note in bad:
        print("   %-14s %-10s %s" % (k, st, note))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
