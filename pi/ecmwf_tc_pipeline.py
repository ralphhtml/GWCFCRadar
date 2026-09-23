#!/usr/bin/env python3
"""
ECMWF ensemble tropical cyclone probabilities: strike probability and genesis.

    python3 pi/ecmwf_tc_pipeline.py              # the newest 00z/12z run
    python3 pi/ecmwf_tc_pipeline.py --check      # what is published, no work
    python3 pi/ecmwf_tc_pipeline.py --step 12 --out 240 --members 51

ECMWF draws two famous maps from its 51 member ensemble. "Strike probability"
is the chance that a tropical cyclone passes within 120 km of a place in the
next ten days. "Tropical cyclone activity (including genesis)" is the same
question asked of EVERY cyclone the ensemble produces, including the ones that
have not formed yet. Both come in three strengths: tropical depression,
tropical storm and hurricane.

ECMWF publish the maps as pictures only. The numbers under them are open
data, though: every member's pressure and heights, every run, free. So this
builds the maps itself, the same way ECMWF describe building theirs:

  1. In each member, at each forecast hour, find the tropical cyclones. That
     is enscenters_pipeline.py's job already (closed lows with a warm core,
     stitched into tracks), and it is reused here unchanged, on ECMWF's
     fields instead of GEFS's.

  2. For each member, mark every place a track passes within 120 km of during
     the window, at or above the strength asked about. The track is filled in
     between its forecast hours, so a storm moving 500 km in twelve hours
     paints a swath rather than two dots.

  3. The probability at a place is the share of members that marked it.

"Existing" keeps only the tracks that are already there at the start of the
run, which is ECMWF's strike probability; "all" keeps every track, which is
their activity map including genesis.

Strength comes from the central pressure (Atkinson-Holliday, as in
enscenters_pipeline.py), not the model's own wind: a 0.25 degree grid still
blunts a hurricane's core, so treat the hurricane map as the conservative one.
Anything the detector keeps is a warm core closed low, which is at least a
tropical depression, so the depression map has no wind floor.

WHAT IT COSTS

Three GRIB records per member per forecast hour (sea level pressure, and the
300 and 500 mb heights), read by byte range from ECMWF's own index, so about
a hundred small requests per forecast hour rather than the whole file. The
full 51 members to 240 hours at twelve hourly steps is roughly a gigabyte.
--members, --step and --out all move that.

OUTPUT

~/wxdata/enscenters/ecmwf/latest.json names the run, the windows and the
strength categories, and points at one greyscale PNG per map, where each
pixel's value IS the percentage (0 to 100) on a 0.5 degree grid from 60S to
60N. The site colours them itself, so the colours are a setting and the
Inspector can read a real number back.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enscenters_pipeline as ens  # noqa: E402

try:
    from PIL import Image
except ImportError:                                   # pragma: no cover
    Image = None

requests = ens.requests
eccodes = ens.eccodes
log = ens.log

OUT_DIR = os.path.join(os.path.dirname(ens.OUT_DIR), "enscenters", "ecmwf")

# ECMWF's own open data server, then its mirror on AWS. Same paths on both.
BASES = ["https://data.ecmwf.int/forecasts",
         "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"]

# The ensemble's full ten day runs are the 00z and 12z. They are complete
# on the open data server about eight hours later.
CYCLE_H = 12
LAG_H = 9
DEFAULT_STEP = 12
DEFAULT_OUT = 240
MEMBERS = 51                         # the control (0) and 50 perturbed

# The records, as ECMWF's index spells them: (param, levtype, level or None).
WANT = [("msl", "sfc", None), ("gh", "pl", "300"), ("gh", "pl", "500")]

# The maps.
RADIUS_KM = 120.0                    # ECMWF's strike radius
GRID_DEG = 0.5
LAT_N, LAT_S = 60.0, -60.0
CATEGORIES = {                       # peak wind floor, knots
    "td": 0.0,                       # every warm core closed low it keeps
    "ts": 34.0,
    "hu": 64.0,
}
CATEGORY_LABELS = {"td": "Tropical depression", "ts": "Tropical storm", "hu": "Hurricane"}
WINDOWS = [(0, 48), (0, 120), (0, 240)]
SCOPES = ("all", "existing")
DENSIFY_KM = 40.0

REQUEST_TIMEOUT = 60
FETCH_WORKERS = 6


# -- Where things are -----------------------------------------------------------
def run_prefix(base, date_str, cyc):
    return f"{base}/{date_str}/{cyc}z/ifs/0p25/enfo/{date_str}{cyc}0000"


def file_url(base, date_str, cyc, step):
    return f"{run_prefix(base, date_str, cyc)}-{step}h-enfo-ef.grib2"


def index_url(base, date_str, cyc, step):
    return f"{run_prefix(base, date_str, cyc)}-{step}h-enfo-ef.index"


def newest_cycle(now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    t = now - dt.timedelta(hours=LAG_H)
    hour = (t.hour // CYCLE_H) * CYCLE_H
    return t.strftime("%Y%m%d"), f"{hour:02d}"


# -- The index ---------------------------------------------------------------------
def parse_index(text):
    """ECMWF's .index is one JSON object per line, one per GRIB record, with
    the record's byte offset and length. Returns the rows we can use."""
    rows = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            r = json.loads(line)
            r["_offset"] = int(r["_offset"])
            r["_length"] = int(r["_length"])
        except (ValueError, KeyError, TypeError):
            continue
        rows.append(r)
    return rows


def member_of(row):
    """The control forecast is member 0; its rows may carry no number."""
    if row.get("type") == "cf":
        return 0
    try:
        return int(row.get("number", 0))
    except (TypeError, ValueError):
        return None


def wanted_rows(rows, members):
    """{member: [rows in WANT order]} for every member that has all three."""
    out = {}
    for row in rows:
        m = member_of(row)
        if m is None or m >= members:
            continue
        for i, (param, levtype, level) in enumerate(WANT):
            if row.get("param") != param or row.get("levtype") != levtype:
                continue
            if level is not None and str(row.get("levelist", "")) != level:
                continue
            out.setdefault(m, [None] * len(WANT))[i] = row
    return {m: rs for m, rs in out.items() if all(rs)}


# -- Fetching --------------------------------------------------------------------
def http_get(session, url, headers=None):
    last = None
    for attempt in range(3):
        try:
            r = session.get(url, headers=headers or {}, timeout=REQUEST_TIMEOUT)
            if r.status_code in (200, 206, 404):
                return r
            last = r.status_code
        except requests.RequestException as e:
            last = str(e)
    raise RuntimeError(f"{url}: {last}")


def find_index(session, date_str, cyc, step):
    """(base, rows) from the first server that has this forecast hour."""
    for base in BASES:
        try:
            r = http_get(session, index_url(base, date_str, cyc, step))
        except RuntimeError:
            continue
        if r.status_code == 200:
            rows = parse_index(r.text)
            if rows:
                return base, rows
    return None, []


def fetch_member(session, url, rows):
    """The member's three records as bytes, one range request each."""
    out = []
    for row in rows:
        a = row["_offset"]
        b = a + row["_length"] - 1
        r = http_get(session, url, headers={"Range": f"bytes={a}-{b}"})
        if r.status_code not in (200, 206):
            return None
        body = r.content
        # A server that ignores Range sends the whole file: cut the record out.
        if r.status_code == 200 and len(body) > row["_length"]:
            body = body[a:b + 1]
        out.append(body)
    return out


def decode_member(messages):
    """(mslp_hPa, thickness_gpm, lats, lons), thinned to half a degree, which
    is the grid enscenters_pipeline.py's constants were tuned on."""
    got, lats, lons = {}, None, None
    for msg in messages:
        gid = eccodes.codes_new_from_message(msg)
        try:
            short = eccodes.codes_get(gid, "shortName")
            level = int(eccodes.codes_get(gid, "level"))
            ni = int(eccodes.codes_get(gid, "Ni"))
            nj = int(eccodes.codes_get(gid, "Nj"))
            vals = np.asarray(eccodes.codes_get_values(gid), dtype=float).reshape(nj, ni)
            if lats is None:
                lat1 = float(eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"))
                lat2 = float(eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees"))
                lon1 = float(eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees"))
                lon2 = float(eccodes.codes_get(gid, "longitudeOfLastGridPointInDegrees"))
                lats = np.linspace(lat1, lat2, nj)
                lons = np.linspace(lon1, lon2, ni)
            if short in ("msl", "prmsl"):
                got["mslp"] = vals / 100.0
            elif short in ("gh", "z"):
                got[f"gh{level}"] = vals if short == "gh" else vals / 9.80665
        finally:
            eccodes.codes_release(gid)
    if "mslp" not in got:
        return None
    thin = (slice(None, None, 2), slice(None, None, 2))
    thk = (got["gh300"] - got["gh500"])[thin] if "gh300" in got and "gh500" in got else None
    return got["mslp"][thin], thk, lats[::2], lons[::2]


def step_centers(session, date_str, cyc, step, members, all_out=None):
    """{member: [tropical centres]} for one forecast hour, or None when the
    hour is not published. Downloads run in parallel; decoding does not.
    all_out, when given, also collects every closed low per member (the
    low tracks overlay), which the warm core test would otherwise discard."""
    base, rows = find_index(session, date_str, cyc, step)
    if not rows:
        return None
    by_member = wanted_rows(rows, members)
    url = file_url(base, date_str, cyc, step)
    out = {}
    with cf.ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futs = {pool.submit(fetch_member, session, url, rs): m for m, rs in by_member.items()}
        for fut in cf.as_completed(futs):
            m = futs[fut]
            try:
                msgs = fut.result()
                if not msgs:
                    continue
                got = decode_member(msgs)
                if got is None:
                    continue
                mslp, thk, lats, lons = got
                centers = ens.detect_centers(mslp, lats, lons)
                if all_out is not None:
                    all_out[m] = centers
                out[m] = ens.filter_warm(centers, thk, lats, lons)
            except Exception as e:                       # one member, not the hour
                log(f"  m{m:02d} f{step:03d}: {e}")
    return out


# -- The maps ------------------------------------------------------------------
def grid_axes():
    lats = np.arange(LAT_N - GRID_DEG / 2, LAT_S, -GRID_DEG)
    lons = np.arange(-180 + GRID_DEG / 2, 180, GRID_DEG)
    return lats, lons


def densify(points, step_km=DENSIFY_KM):
    """A track's points with the gaps between forecast hours filled in:
    (step_h, lat, lon, vmax_kt) every step_km or so along each leg."""
    out = []
    for a, b in zip(points, points[1:]):
        d = ens.haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
        n = max(1, int(math.ceil(d / step_km)))
        dlon = ens.norm_lon(b["lon"] - a["lon"])
        for k in range(n):
            f = k / n
            out.append((a["step_h"] + f * (b["step_h"] - a["step_h"]),
                        a["lat"] + f * (b["lat"] - a["lat"]),
                        ens.norm_lon(a["lon"] + f * dlon),
                        a.get("vmax_kt", 0) + f * (b.get("vmax_kt", 0) - a.get("vmax_kt", 0))))
    if points:
        p = points[-1]
        out.append((p["step_h"], p["lat"], p["lon"], p.get("vmax_kt", 0)))
    return out


def mark_disk(hit, lats, lons, lat, lon, radius_km=RADIUS_KM):
    """Set every grid cell within radius_km of (lat, lon)."""
    dlat = radius_km / 111.2
    rows = np.where(np.abs(lats - lat) <= dlat + GRID_DEG)[0]
    if not len(rows):
        return
    coslat = max(0.05, math.cos(math.radians(lat)))
    dlon = min(180.0, radius_km / (111.2 * coslat) + GRID_DEG)
    ddl = np.abs(((lons - lon + 180.0) % 360.0) - 180.0)
    cols = np.where(ddl <= dlon)[0]
    if not len(cols):
        return
    la = np.radians(lats[rows])[:, None]
    lo = np.radians(lons[cols])[None, :]
    p1, l1 = math.radians(lat), math.radians(lon)
    a = (np.sin((la - p1) / 2) ** 2
         + math.cos(p1) * np.cos(la) * np.sin((lo - l1) / 2) ** 2)
    d = 2 * 6371.0 * np.arcsin(np.minimum(1.0, np.sqrt(a)))
    sub = hit[np.ix_(rows, cols)]
    sub |= d <= radius_km
    hit[np.ix_(rows, cols)] = sub


def member_mask(tracks, window, vmin, scope, lats, lons):
    """Where one member's cyclones pass within RADIUS_KM during the window, at
    or above vmin knots. scope 'existing' keeps only tracks there at hour 0."""
    lo_h, hi_h = window
    hit = np.zeros((len(lats), len(lons)), dtype=bool)
    for t in tracks:
        pts = t["points"]
        if not pts:
            continue
        if scope == "existing" and pts[0]["step_h"] != 0:
            continue
        for h, la, lo, v in densify(pts):
            if h < lo_h or h > hi_h or v < vmin:
                continue
            mark_disk(hit, lats, lons, la, lo)
    return hit


def probability(tracks_by_member, n_members, window, vmin, scope):
    """Percent of members (0 to 100, uint8) whose cyclones reach each cell."""
    lats, lons = grid_axes()
    count = np.zeros((len(lats), len(lons)), dtype=np.int32)
    for tracks in tracks_by_member.values():
        count += member_mask(tracks, window, vmin, scope, lats, lons)
    n = max(1, n_members)
    return np.clip(np.rint(count * 100.0 / n), 0, 100).astype(np.uint8)


def write_png(path, grid):
    tmp = f"{path}.tmp{os.getpid()}.png"
    Image.fromarray(grid, mode="L").save(tmp, optimize=True)
    os.replace(tmp, path)


# -- Run ------------------------------------------------------------------------
def build(date_str, cyc, step_h, out_h, members, centers_fn=None, verbose=True):
    """Everything for one run. centers_fn(step) -> {member: [centres]} or None
    replaces the download (the tests use it)."""
    steps = list(range(0, out_h + 1, step_h))
    run = f"{date_str}_{cyc}"
    out_run = os.path.join(OUT_DIR, run)
    os.makedirs(out_run, exist_ok=True)

    all_steps = {}                            # step -> {member: every closed low}
    if centers_fn is None:
        session = requests.Session()
        centers_fn = lambda s: step_centers(session, date_str, cyc, s, members,  # noqa: E731
                                            all_out=all_steps.setdefault(s, {}))

    per_member = {}                           # member -> {step: [centres]}
    got_steps = []
    for s in steps:
        res = centers_fn(s)
        if res is None:
            if verbose:
                log(f"  f{s:03d}: not published")
            continue
        got_steps.append(s)
        for m, centers in res.items():
            per_member.setdefault(m, {})[s] = centers
        if verbose:
            log(f"  f{s:03d}: {len(res)} members, {sum(len(c) for c in res.values())} centres")
    if not per_member:
        log("no forecast hours could be read; nothing written")
        return None

    tracks_by_member = {}
    all_tracks = []
    for m, by_step in per_member.items():
        tr = ens.stitch(by_step, step_h)
        tracks_by_member[m] = tr
        for t in tr:
            all_tracks.append({"member": m, **t})
    n_members = len(per_member)
    last = max(got_steps)

    products = {}
    windows = [(a, min(b, last)) for a, b in WINDOWS if a < last]
    windows = [w for i, w in enumerate(windows) if w not in windows[:i]]
    for cat, vmin in CATEGORIES.items():
        for scope in SCOPES:
            for w in windows:
                key = f"{cat}_{scope}_{w[0]}_{w[1]}"
                grid = probability(tracks_by_member, n_members, w, vmin, scope)
                name = f"{key}.png"
                write_png(os.path.join(out_run, name), grid)
                products[key] = {"path": f"{run}/{name}", "max": int(grid.max())}

    built = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ens.write_json(os.path.join(out_run, "tracks.json"),
                   {"model": "ecmwf-ens", "run": run, "members": n_members,
                    "step_h": step_h, "out_h": last, "tracks": all_tracks})
    manifest = {
        "model": "ecmwf-ens",
        "label": "ECMWF ensemble",
        "run": run,
        "base": f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{cyc}:00:00Z",
        "members": n_members,
        "step_h": step_h,
        "out_h": last,
        "radius_km": RADIUS_KM,
        "grid_deg": GRID_DEG,
        "bounds": [[LAT_S, -180.0], [LAT_N, 180.0]],
        "windows": [list(w) for w in windows],
        "categories": {k: {"label": CATEGORY_LABELS[k], "min_kt": v} for k, v in CATEGORIES.items()},
        "scopes": list(SCOPES),
        "products": products,
        "tracks": f"{run}/tracks.json",
        "built": built,
    }
    ens.write_json(os.path.join(OUT_DIR, "latest.json"), manifest)
    # Every low, tropical or not, for the low tracks overlay.
    lows_per_member = {}
    for s, per in all_steps.items():
        for m, centers in per.items():
            lows_per_member.setdefault(m, {})[s] = centers
    low_tracks = []
    for m, by_step in lows_per_member.items():
        for t in ens.stitch(by_step, step_h, ens.LOWS_MAX_KT):
            low_tracks.append({"member": m, **t})
    if low_tracks:
        ens.write_lows("ecmwf-ens", "ECMWF ensemble", run, manifest["base"], n_members,
                       step_h, last, low_tracks, "ensemble")
    log(f"{n_members} members, {len(all_tracks)} tracks, {len(products)} maps -> {out_run}")
    return manifest


def already_built(run):
    try:
        with open(os.path.join(OUT_DIR, "latest.json")) as fh:
            return json.load(fh).get("run") == run
    except (OSError, ValueError):
        return False


def check(date_str, cyc, step_h):
    session = requests.Session()
    base, rows = find_index(session, date_str, cyc, step_h)
    n = len(wanted_rows(rows, MEMBERS)) if rows else 0
    log(f"{date_str} {cyc}z f{step_h:03d}: {n} of {MEMBERS} members readable"
        + (f" from {base}" if base else ""))
    return n


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=int, default=DEFAULT_STEP)
    ap.add_argument("--out", type=int, default=DEFAULT_OUT)
    ap.add_argument("--members", type=int, default=MEMBERS)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--date")
    ap.add_argument("--cyc")
    ap.add_argument("--force", action="store_true", help="rebuild a run already built")
    args = ap.parse_args(argv)
    if requests is None:
        log("requests is not installed")
        return 1
    date_str, cyc = newest_cycle()
    date_str = args.date or date_str
    cyc = args.cyc or cyc
    if args.check:
        return 0 if check(date_str, cyc, args.step) else 1
    if not ens.HAVE_SCIPY:
        log("scipy is not installed: apt install python3-scipy")
        return 1
    if eccodes is None:
        log("eccodes is not installed")
        return 1
    if Image is None:
        log("Pillow is not installed")
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)
    # The timer checks four times a day; a run already built is left alone,
    # so only a new run costs a download.
    if not args.force and already_built(f"{date_str}_{cyc}"):
        log(f"{date_str} {cyc}z is already built")
        return 0
    return 0 if build(date_str, cyc, args.step, args.out, min(MEMBERS, args.members)) else 1


if __name__ == "__main__":
    sys.exit(main())
