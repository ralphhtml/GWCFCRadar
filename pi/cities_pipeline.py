#!/usr/bin/env python3
"""
Every named town on Earth, tiled for the forecast dots.

    python3 pi/cities_pipeline.py            # build ~/wxdata/cities
    python3 pi/cities_pipeline.py --force    # rebuild even if fresh

The site's forecast dots used to come from a hand-typed list of a couple
of thousand cities. This replaces the ceiling: the full GeoNames gazetteer
(every populated place with a name, millions of them) is downloaded once,
filtered, and cut into 5 degree tiles the page loads only as they scroll
into view. The browser then shows the biggest N places on screen, so
zooming in keeps revealing smaller towns all the way down to hamlets.

Memory is the constraint this file is shaped around. The dump is a 1.6 GB
text file inside a ~400 MB zip, and a Pi cannot hold four million parsed
rows at once. So it streams: pass one reads the zip line by line and
appends compact rows to per-tile spill files, flushing whenever the
buffer grows; pass two loads one tile at a time, sorts it by importance,
caps it, and writes the JSON the site reads. Nothing ever holds more than
one tile plus a bounded buffer.

The gazetteer is CC BY 4.0: GeoNames (geonames.org) is credited on the
site's credits panel. Towns move rarely, so the timer runs weekly and the
build is skipped while the newest output is under MAX_AGE_DAYS old.
"""

import io
import json
import os
import sys
import time
import urllib.request
import zipfile

OUT_DIR = os.path.expanduser("~/wxdata/cities")
CACHE_DIR = os.path.join(OUT_DIR, "_cache")
DUMP_URL = "https://download.geonames.org/export/dump/allCountries.zip"
TILE_DEG = 5
# Sorted by importance inside each tile, then capped: a dense European tile
# holds tens of thousands of places, and past this many the extras are
# hamlets no screenful will ever have room to show anyway.
TILE_CAP = 4000
MAX_AGE_DAYS = 7
FLUSH_EVERY = 200_000    # buffered rows across all tiles before a spill

# Feature codes that are not places anyone forecasts for: historical,
# abandoned, destroyed, and the "section of" pseudo-entries that would put
# five dots inside one town.
SKIP_CODES = {"PPLH", "PPLQ", "PPLW", "PPLCH", "PPLX"}
# Importance rank by feature code: national capital first, then admin
# seats, then plain populated places. Population sorts within a rank.
CODE_RANK = {"PPLC": 0, "PPLA": 1, "PPLA2": 2, "PPLA3": 3, "PPLA4": 3,
             "PPLG": 1, "PPL": 4, "PPLS": 5, "PPLL": 5, "PPLF": 5}


def log(msg):
    print(time.strftime("%H:%M:%S ") + msg, flush=True)


def tile_key(lat, lon):
    la = int((lat + 90) // TILE_DEG)
    lo = int((lon + 180) // TILE_DEG)
    return f"{la}_{lo}"


def fetch_dump(force=False):
    os.makedirs(CACHE_DIR, exist_ok=True)
    z = os.path.join(CACHE_DIR, "allCountries.zip")
    if not force and os.path.exists(z) and os.path.getsize(z) > 100 * 1024 * 1024:
        return z
    log("cities: downloading the GeoNames gazetteer (about 400 MB, once)")
    req = urllib.request.Request(DUMP_URL, headers={"User-Agent": "gwcfc-cities"})
    tmp = z + ".tmp"
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as fh:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    os.replace(tmp, z)
    return z


def stream_rows(zip_path):
    """Yield (tile, [name, lat, lon, pop, rank]) for every wanted place."""
    with zipfile.ZipFile(zip_path) as zf:
        with zf.open("allCountries.txt") as raw:
            for line in io.TextIOWrapper(raw, encoding="utf-8", errors="replace"):
                f = line.rstrip("\n").split("\t")
                if len(f) < 15 or f[6] != "P" or f[7] in SKIP_CODES:
                    continue
                try:
                    lat, lon = float(f[4]), float(f[5])
                except ValueError:
                    continue
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    continue
                name = f[1].strip()
                if not name:
                    continue
                try:
                    pop = int(f[14] or 0)
                except ValueError:
                    pop = 0
                rank = CODE_RANK.get(f[7], 6)
                yield (tile_key(lat, lon),
                       [name, round(lat, 4), round(lon, 4), pop, rank])


def build(force=False):
    done = os.path.join(OUT_DIR, "index.json")
    if not force and os.path.exists(done):
        age = time.time() - os.path.getmtime(done)
        if age < MAX_AGE_DAYS * 86400:
            log(f"cities: index is {age / 86400:.1f} days old, nothing to do")
            return 0

    zip_path = fetch_dump(force)
    spill_dir = os.path.join(CACHE_DIR, "spill")
    os.makedirs(spill_dir, exist_ok=True)
    for f in os.listdir(spill_dir):
        os.remove(os.path.join(spill_dir, f))

    # Pass one: stream the dump into per-tile spill files, memory bounded.
    t0 = time.time()
    buf, buffered, total = {}, 0, 0

    def flush():
        nonlocal buffered
        for key, rows in buf.items():
            with open(os.path.join(spill_dir, key + ".jsonl"), "a",
                      encoding="utf-8") as fh:
                for row in rows:
                    fh.write(json.dumps(row, ensure_ascii=False,
                                        separators=(",", ":")) + "\n")
        buf.clear()
        buffered = 0

    for key, row in stream_rows(zip_path):
        buf.setdefault(key, []).append(row)
        buffered += 1
        total += 1
        if buffered >= FLUSH_EVERY:
            flush()
    flush()
    log(f"cities: streamed {total} places into "
        f"{len(os.listdir(spill_dir))} tiles in {time.time() - t0:.0f}s")

    # Pass two: one tile at a time, sorted by importance, capped, written.
    os.makedirs(OUT_DIR, exist_ok=True)
    kept_total = 0
    counts = {}
    for fn in sorted(os.listdir(spill_dir)):
        key = fn[:-6]
        rows = []
        with open(os.path.join(spill_dir, fn), encoding="utf-8") as fh:
            for line in fh:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
        rows.sort(key=lambda r: (-r[3], r[4], r[0]))
        rows = rows[:TILE_CAP]
        counts[key] = len(rows)
        kept_total += len(rows)
        tmp = os.path.join(OUT_DIR, f"t_{key}.json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, os.path.join(OUT_DIR, f"t_{key}.json"))
        os.remove(os.path.join(spill_dir, fn))

    tmp = done + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "tile_deg": TILE_DEG, "tile_cap": TILE_CAP,
                   "total": kept_total, "source": "GeoNames (CC BY 4.0)",
                   "tiles": counts}, fh, separators=(",", ":"))
    os.replace(tmp, done)
    log(f"cities: wrote {kept_total} places across {len(counts)} tiles")
    return 0


if __name__ == "__main__":
    sys.exit(build(force="--force" in sys.argv))
