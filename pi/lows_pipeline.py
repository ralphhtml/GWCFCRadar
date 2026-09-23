#!/usr/bin/env python3
"""
Low pressure centres and tracks from the ordinary (deterministic) models.

    python3 pi/lows_pipeline.py              # GFS and ECMWF, newest runs
    python3 pi/lows_pipeline.py --model gfs  # just one
    python3 pi/lows_pipeline.py --check      # what is published, no work

The two ensemble pipelines (enscenters_pipeline.py for GEFS and
ecmwf_tc_pipeline.py for the ECMWF ensemble) already find every closed low in
every member and now keep them for the low tracks overlay. This does the same
for one run of each deterministic model, which is the line a forecaster reads
first before looking at the spread around it.

It needs only the sea level pressure record at each forecast hour, so it asks
for that one record out of each file by byte range (the same trick the other
pipelines use) rather than downloading the files: about 500 KB an hour for
GFS at half a degree, about 1 MB for ECMWF at a quarter.

The detection, stitching and output format are the ensemble ones, reused, so
a GFS low and a GEFS member's low are found by exactly the same rule.
"""

import argparse
import datetime as dt
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import enscenters_pipeline as ens  # noqa: E402

try:
    import requests
except ImportError:                                   # pragma: no cover
    requests = None

try:
    import ecmwf_tc_pipeline as etc                   # ECMWF index + decode
except Exception:                                     # pragma: no cover
    etc = None

log = ens.log

GFS_BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
ECMWF_BASES = ["https://data.ecmwf.int/forecasts",
               "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"]

MODELS = {
    # step_h is the spacing of the track points, out_h how far out. GFS
    # publishes hourly to 120 h and three hourly after; six hourly to ten
    # days is the same spacing the ensembles use, so the lines compare.
    "gfs":   {"label": "GFS", "cycle_h": 6, "lag_h": 5, "step_h": 6, "out_h": 240},
    # ECMWF's open data has the 00z and 12z runs to ten days (06z and 18z
    # stop at 90 h), so the long runs are the ones worth drawing.
    "ecmwf": {"label": "ECMWF", "cycle_h": 12, "lag_h": 8, "step_h": 6, "out_h": 240},
}


def newest_cycle(model, now=None):
    m = MODELS[model]
    now = now or dt.datetime.now(dt.timezone.utc)
    t = now - dt.timedelta(hours=m["lag_h"])
    hour = (t.hour // m["cycle_h"]) * m["cycle_h"]
    return t.strftime("%Y%m%d"), f"{hour:02d}"


# -- GFS -------------------------------------------------------------------------
def gfs_path(date_str, cyc, step):
    return f"gfs.{date_str}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.0p50.f{step:03d}"


def gfs_prmsl_range(idx_text):
    """(start, end or None) of the PRMSL record in a GFS .idx, or None."""
    rows = []
    for line in (idx_text or "").splitlines():
        f = line.split(":")
        if len(f) > 5:
            try:
                rows.append((int(f[1]), f[3], f[4]))
            except ValueError:
                pass
    for i, (start, var, lev) in enumerate(rows):
        if var == "PRMSL" and lev == "mean sea level":
            end = rows[i + 1][0] - 1 if i + 1 < len(rows) else None
            return start, end
    return None


def gfs_step(date_str, cyc, step, get=None):
    """Every closed low at one GFS forecast hour, or None if not published."""
    get = get or ens.http_get
    base = f"{GFS_BUCKET}/{gfs_path(date_str, cyc, step)}"
    r = get(base + ".idx")
    if r.status_code != 200:
        return None
    rng = gfs_prmsl_range(r.text)
    if rng is None:
        return None
    a, b = rng
    rr = get(base, headers={"Range": f"bytes={a}-" + ("" if b is None else str(b))})
    if rr.status_code not in (200, 206):
        return None
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
        tf.write(rr.content)
        tmp = tf.name
    try:
        got = ens.decode(tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if got is None:
        return None
    mslp, _thk, lats, lons = got
    return ens.detect_centers(mslp, lats, lons)


# -- ECMWF -----------------------------------------------------------------------
def ecmwf_index_url(base, date_str, cyc, step):
    return f"{base}/{date_str}/{cyc}z/ifs/0p25/oper/{date_str}{cyc}0000-{step}h-oper-fc.index"


def ecmwf_step(date_str, cyc, step, session=None):
    """Every closed low at one ECMWF forecast hour, or None if not published."""
    if etc is None:
        raise RuntimeError("ecmwf_tc_pipeline could not be imported")
    session = session or requests.Session()
    for base in ECMWF_BASES:
        try:
            r = etc.http_get(session, ecmwf_index_url(base, date_str, cyc, step))
        except RuntimeError:
            continue
        if r.status_code != 200:
            continue
        rows = [x for x in etc.parse_index(r.text)
                if x.get("param") == "msl" and x.get("levtype") == "sfc"]
        if not rows:
            continue
        url = ecmwf_index_url(base, date_str, cyc, step).replace(".index", ".grib2")
        msgs = etc.fetch_member(session, url, rows[:1])
        if not msgs:
            return None
        got = etc.decode_member(msgs)
        if got is None:
            return None
        mslp, _thk, lats, lons = got
        return ens.detect_centers(mslp, lats, lons)
    return None


# -- A run -----------------------------------------------------------------------
def build(model, date_str, cyc, step_fn=None, verbose=True, lows_dir=None):
    """Find and track the lows in one run. step_fn(step) -> [centres] or None
    replaces the download (the tests use it)."""
    m = MODELS[model]
    if step_fn is None:
        if model == "gfs":
            step_fn = lambda s: gfs_step(date_str, cyc, s)  # noqa: E731
        else:
            session = requests.Session()
            step_fn = lambda s: ecmwf_step(date_str, cyc, s, session)  # noqa: E731
    by_step = {}
    for s in range(0, m["out_h"] + 1, m["step_h"]):
        try:
            centers = step_fn(s)
        except Exception as e:                        # one hour, not the run
            log(f"  {model} f{s:03d}: {e}")
            continue
        if centers is None:
            if verbose:
                log(f"  {model} f{s:03d}: not published")
            continue
        by_step[s] = centers
    if not by_step:
        log(f"{model} {date_str} {cyc}z: nothing could be read; nothing written")
        return None
    tracks = [{"member": 0, **t} for t in ens.stitch(by_step, m["step_h"], ens.LOWS_MAX_KT)]
    run = f"{date_str}_{cyc}"
    out = ens.write_lows(model, m["label"], run, ens.run_base_iso(date_str, cyc), 1,
                         m["step_h"], max(by_step), tracks, "deterministic", lows_dir=lows_dir)
    log(f"{model} {run}: {len(by_step)} hours, {len(tracks)} tracks")
    return out


def already_built(model, run, lows_dir=None):
    import json
    try:
        with open(os.path.join(lows_dir or ens.LOWS_DIR, "latest.json")) as fh:
            return json.load(fh).get("models", {}).get(model, {}).get("run") == run
    except (OSError, ValueError):
        return False


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=list(MODELS))
    ap.add_argument("--date")
    ap.add_argument("--cyc")
    ap.add_argument("--force", action="store_true", help="rebuild a run already done")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    if requests is None:
        log("requests is not installed")
        return 1
    models = [args.model] if args.model else list(MODELS)
    for model in models:
        date_str, cyc = newest_cycle(model)
        date_str = args.date or date_str
        cyc = args.cyc or cyc
        if args.check:
            # Only asks whether the first hour's index exists: no download.
            if model == "gfs":
                url = f"{GFS_BUCKET}/{gfs_path(date_str, cyc, 0)}.idx"
            else:
                url = ecmwf_index_url(ECMWF_BASES[0], date_str, cyc, 0)
            try:
                code = requests.get(url, timeout=20).status_code
            except requests.RequestException as e:
                code = e.__class__.__name__
            log(f"{model} {date_str} {cyc}z: f000 index {code}")
            continue
        if not ens.HAVE_SCIPY or ens.eccodes is None:
            log("scipy and eccodes are needed")
            return 1
        if not args.force and already_built(model, f"{date_str}_{cyc}"):
            log(f"{model} {date_str}_{cyc} already built")
            continue
        build(model, date_str, cyc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
