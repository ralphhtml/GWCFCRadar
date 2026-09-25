#!/usr/bin/env python3
"""
The radar Time Machine's archive doors, for the products a browser cannot
reach into the past on its own.

The page reads the single-site radar archives itself: every Level 2 volume
since 1991 (AWS and Google mirrors) and every Level 3 file since March 2022
(Unidata's bucket). Three things are out of its reach, and this module is
how the parsing server fetches them instead:

  MRMS       the national mosaics (composite reflectivity, rotation tracks,
             hail, rainfall...). NOAA keeps every file since October 2020 in
             the noaa-mrms-pds bucket; one is fetched and painted with the
             very same code that paints the live ones.
  Level 3    before March 2022. Google keeps every radar's Level 3 products,
  (old)      one bundle per radar per day, back to the 1990s, but a bundle is
             a single compressed tar of 20 to 800 MB that cannot be jumped
             into. It is streamed once through `gzip -dc` (which reads both
             the older .tar.Z and the newer .tar.gz), and the products the
             page can draw are kept on disk as they pass, so the first frame
             of a radar-day is slow and every later one that day is instant.
  HRRR       reflectivity, the model's own radar picture, for any hour since
             mid 2014, built from NOAA's HRRR bucket by the model pipeline's
             own download and paint code.

Every input is checked against a strict shape before anything is fetched, so
the doors can only ever ask these three public NOAA/Google archives for the
kind of file they hold.
"""

import json
import os
import re
import shutil
import subprocess
import tarfile
import threading
import time
from datetime import datetime, timedelta, timezone

import requests

UA = "GWCFCRadar parsing server (https://ralphhtml.github.io/GWCFCRadar/)"
HTTP = requests.Session()
HTTP.headers["User-Agent"] = UA

DATA = os.path.expanduser("~/wxdata")


def log(msg):
    print(f"[radar_archive] {msg}", flush=True)


def _ms_to_dt(ms):
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)


# ============================================================================
# MRMS
# ============================================================================
MRMS_BUCKET = "https://noaa-mrms-pds.s3.amazonaws.com"
MRMS_FLOOR_MS = int(datetime(2020, 10, 14, tzinfo=timezone.utc).timestamp() * 1000)
MRMS_FILE_RE = re.compile(r"_(\d{8})-(\d{6})\.grib2\.gz$")
_mrms_dirs = {}          # catalogue name -> archive folder, found once


def _s3_keys(bucket, prefix, delimiter=None, max_keys=1000):
    """(keys, prefixes) for one listing page."""
    params = {"list-type": "2", "prefix": prefix, "max-keys": str(max_keys)}
    if delimiter:
        params["delimiter"] = delimiter
    r = HTTP.get(bucket + "/", params=params, timeout=30)
    r.raise_for_status()
    keys = re.findall(r"<Key>([^<]+)</Key>", r.text)
    prefixes = re.findall(r"<Prefix>([^<]+)</Prefix>", r.text)
    return keys, prefixes


def mrms_archive_dir(name, spec, lister=_s3_keys):
    """The bucket folder a catalogue product lives in, e.g.
    MergedReflectivityQCComposite -> CONUS/MergedReflectivityQCComposite_00.50/.

    The live feed names a product without its level; the archive adds one
    (_00.50, _00.00, or _scale_1 for the lightning grids), and FLASH products
    carry a FLASH_ prefix. Found by listing once and remembered.
    """
    if name in _mrms_dirs:
        return _mrms_dirs[name]
    path = spec["path"]
    cands = [path]
    if "FLASH" in str(spec.get("base", "")) and not path.startswith("FLASH_"):
        cands.append("FLASH_" + path)
    for cand in cands:
        _keys, prefixes = lister(MRMS_BUCKET, f"CONUS/{cand}", delimiter="/", max_keys=100)
        exact = f"CONUS/{cand}/"
        if exact in prefixes:
            _mrms_dirs[name] = exact
            return exact
        for p in prefixes:
            tail = p[len(f"CONUS/{cand}"):]
            if re.fullmatch(r"_(\d\d\.\d\d|scale_\d+)/", tail):
                _mrms_dirs[name] = p
                return p
    _mrms_dirs[name] = None
    return None


def mrms_nearest_key(folder, at_ms, lister=_s3_keys):
    """The archived file nearest a moment, looking at that day and the next
    and previous (a moment near midnight has its nearest scan across it)."""
    at = _ms_to_dt(at_ms)
    best, gap = None, None
    for day in (at, at - timedelta(days=1), at + timedelta(days=1)):
        keys, _ = lister(MRMS_BUCKET, f"{folder}{day:%Y%m%d}/")
        for k in keys:
            m = MRMS_FILE_RE.search(k)
            if not m:
                continue
            t = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
            g = abs((t - at).total_seconds())
            if gap is None or g < gap:
                best, gap = (k, t), g
        if best and gap < 3600:
            break
    return best


def mrms_frame(name, at_ms, cache_dir=None, lister=_s3_keys, reader=None):
    """One archived MRMS product painted like the live one.

    Returns {file, bounds, t, label, unit, min, max, ramp}, `file` relative to
    DATA so serve.py hands it out as a plain file.
    """
    import numpy as np
    from PIL import Image
    import radar_pipeline as rp

    spec = rp.MRMS_PRODUCTS.get(name)
    if spec is None:
        raise ValueError("not an MRMS product this site builds")
    if at_ms < MRMS_FLOOR_MS:
        raise LookupError("NOAA's MRMS archive starts in October 2020")
    folder = mrms_archive_dir(name, spec, lister)
    if not folder:
        raise LookupError("NOAA's archive does not keep this MRMS product")
    got = mrms_nearest_key(folder, at_ms, lister)
    if not got:
        raise LookupError("NOAA has no MRMS file archived near that moment")
    key, when = got
    cache_dir = cache_dir or os.path.join(DATA, "radar-archive", "mrms")
    stamp = when.strftime("%Y%m%d_%H%M%S")
    rel = os.path.join("radar-archive", "mrms", name, f"{stamp}.png")
    png = os.path.join(cache_dir, name, f"{stamp}.png")
    side = png[:-4] + ".json"
    if os.path.exists(png) and os.path.exists(side):
        with open(side) as fh:
            return json.load(fh)
    grid = (reader or rp._mrms_read)(f"{MRMS_BUCKET}/{key}")
    if not grid:
        raise LookupError("that archived MRMS file could not be read")
    arr, south, north, west, east = grid
    rgba = rp.mrms_paint(arr, spec)
    os.makedirs(os.path.dirname(png), exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(png, optimize=True)
    lo, hi = spec["range"]
    meta = {"file": rel.replace(os.sep, "/"), "bounds": [[south, west], [north, east]],
            "t": int(when.timestamp() * 1000), "label": spec["label"], "unit": spec["unit"],
            "min": lo, "max": hi, "ramp": spec["ramp"], "product": name}
    with open(side, "w") as fh:
        json.dump(meta, fh)
    _prune(os.path.join(DATA, "radar-archive", "mrms"), 800)
    return meta


# ============================================================================
# Level 3, before March 2022
# ============================================================================
L3_API = "https://storage.googleapis.com/storage/v1/b/gcp-public-data-nexrad-l3/o"
L3_MEDIA = "https://storage.googleapis.com/gcp-public-data-nexrad-l3/"
# The Unidata bucket the page reads itself starts here.
L3_SPLIT_MS = int(datetime(2022, 3, 1, tzinfo=timezone.utc).timestamp() * 1000)
L3_FLOOR_MS = int(datetime(1995, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
SITE_RE = re.compile(r"^[KPT][A-Z]{3}$")
# The product codes the page's decoder draws. Only these are kept as a
# bundle streams past; everything else in it is skipped.
L3_CODES = {
    "N0Q", "N1Q", "N2Q", "N3Q", "N0B", "N1B", "N2B", "N3B",     # reflectivity
    "N0U", "N1U", "N2U", "N3U", "N0G", "N1G",                   # velocity
    "N0S", "N1S", "N2S", "N3S",                                 # storm relative velocity
    "N0C", "N1C", "N2C", "N3C", "N0X", "N1X", "N2X", "N3X",     # dual polarization
    "N0K", "N1K", "N2K", "N3K", "N0H", "N1H", "N2H", "N3H", "HHC",
    "EET", "DVL", "NVL", "DAA", "N1P", "DTA", "NTP",
}
# e.g. KOUN_SDUS54_N0HTLX_201505062203: office, WMO header, product, radar, time
MEMBER_RE = re.compile(r"^(?:\./)?[A-Z]{4}_[A-Z]{4}\d\d_([A-Z0-9]{3})([A-Z]{3})_(\d{12})$")
_l3_jobs = {}            # (site, ymd) -> {"done", "error", "read", "size", "started"}
_l3_lock = threading.Lock()


def _l3_day_dir(site, ymd):
    return os.path.join(DATA, "radar-archive", "l3", site, ymd)


def l3_bundle(site, day):
    """The day's bundle for a radar: (url, size) or None."""
    prefix = f"{day:%Y/%m/%d}/{site}/"
    r = HTTP.get(L3_API, params={"prefix": prefix, "maxResults": "10",
                                 "fields": "items(name,size)"}, timeout=30)
    r.raise_for_status()
    items = [i for i in (r.json().get("items") or [])
             if re.search(r"\.tar\.(gz|Z)$", i.get("name", ""))]
    if not items:
        return None
    it = items[0]
    return L3_MEDIA + it["name"], int(it.get("size") or 0)


def _l3_extract(site, day, job, opener=None):
    """Stream one radar-day bundle and keep the drawable products.

    `gzip -dc` does the unpacking: it reads Unix compress (.Z) as well as
    gzip, which is the whole of the difference between the old and the new
    bundles, and it streams, so nothing the size of the bundle ever sits in
    memory or on disk.
    """
    ymd = day.strftime("%Y%m%d")
    out = _l3_day_dir(site, ymd)
    tmp = out + ".part"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    try:
        found = l3_bundle(site, day)
        if not found:
            raise LookupError(f"Google's archive has no Level 3 bundle for {site} on {day:%Y-%m-%d}")
        url, size = found
        job["size"] = size
        if opener is not None:
            stream = opener(url)
            proc = None
            src = stream
        else:
            resp = HTTP.get(url, stream=True, timeout=60)
            resp.raise_for_status()
            proc = subprocess.Popen(["gzip", "-dc"], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

            def pump():
                try:
                    for chunk in resp.iter_content(1 << 20):
                        job["read"] += len(chunk)
                        proc.stdin.write(chunk)
                except Exception:
                    pass
                finally:
                    try:
                        proc.stdin.close()
                    except Exception:
                        pass
            threading.Thread(target=pump, daemon=True).start()
            src = proc.stdout
        kept = 0
        with tarfile.open(fileobj=src, mode="r|") as tar:
            for member in tar:
                if not member.isfile():
                    continue
                m = MEMBER_RE.match(member.name)
                if not m or m.group(1) not in L3_CODES:
                    continue
                code, stamp = m.group(1), m.group(3)
                fh = tar.extractfile(member)
                if fh is None:
                    continue
                d = os.path.join(tmp, code)
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, stamp), "wb") as w:
                    w.write(fh.read())
                kept += 1
        if proc is not None:
            proc.wait(timeout=60)
        shutil.rmtree(out, ignore_errors=True)
        os.replace(tmp, out)
        job["kept"] = kept
        job["done"] = True
        log(f"l3 {site} {ymd}: kept {kept} products")
    except Exception as e:
        job["error"] = str(e) or e.__class__.__name__
        shutil.rmtree(tmp, ignore_errors=True)
        log(f"l3 {site} {ymd}: {job['error']}")
    finally:
        _prune(os.path.join(DATA, "radar-archive", "l3"), 3000)


def l3_request(site, codes, at_ms, opener=None, background=True):
    """Where an old Level 3 product stands.

    {"status": "ready", "code", "stamp", "t"} once the radar-day is on disk,
    {"status": "working", "read", "size"} while the bundle streams, or
    {"status": "missing", "error"} when the archive has nothing to give.
    """
    at = _ms_to_dt(at_ms)
    day = at.replace(hour=0, minute=0, second=0, microsecond=0)
    ymd = day.strftime("%Y%m%d")
    out = _l3_day_dir(site, ymd)
    if os.path.isdir(out):
        best = None
        for code in codes:
            d = os.path.join(out, code)
            if not os.path.isdir(d):
                continue
            for stamp in os.listdir(d):
                try:
                    t = datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                g = abs((t - at).total_seconds())
                if best is None or g < best[0]:
                    best = (g, code, stamp, t)
            if best:
                break            # the first code that exists wins: they are in order of preference
        if best:
            return {"status": "ready", "code": best[1], "stamp": best[2],
                    "t": int(best[3].timestamp() * 1000)}
        return {"status": "missing",
                "error": f"{site} made none of {', '.join(codes)} on {day:%Y-%m-%d}"}
    key = (site, ymd)
    with _l3_lock:
        job = _l3_jobs.get(key)
        if job and job.get("error") and time.time() - job["started"] > 120:
            job = None                       # a failure is retried, but not in a tight loop
        if job is None:
            job = {"done": False, "error": None, "read": 0, "size": 0, "started": time.time()}
            _l3_jobs[key] = job
            if background:
                threading.Thread(target=_l3_extract, args=(site, day, job, opener), daemon=True).start()
            else:
                _l3_extract(site, day, job, opener)
    if job.get("error"):
        return {"status": "missing", "error": job["error"]}
    if job.get("done"):
        return l3_request(site, codes, at_ms, opener, background)
    return {"status": "working", "read": job["read"], "size": job["size"]}


def l3_file(site, code, stamp, at_ms):
    """The bytes of one kept product, or None."""
    if code not in L3_CODES or not re.fullmatch(r"\d{12}", stamp or ""):
        return None
    ymd = _ms_to_dt(at_ms).strftime("%Y%m%d")
    path = os.path.join(_l3_day_dir(site, ymd), code, stamp)
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as fh:
        return fh.read()


# ============================================================================
# HRRR reflectivity
# ============================================================================
HRRR_FLOOR_MS = int(datetime(2014, 7, 30, 18, tzinfo=timezone.utc).timestamp() * 1000)
HRRR_FIELDS = {"refc"}


def hrrr_frame(field, at_ms, fetcher=None):
    """The HRRR analysis hour nearest a moment, one field, painted the way
    the live HRRR frames are. Returns {file, bounds, t, run, scale}."""
    import tempfile
    import gfs_pipeline as gp

    if field not in HRRR_FIELDS:
        raise ValueError("not an HRRR field this door builds")
    if at_ms < HRRR_FLOOR_MS:
        raise LookupError("NOAA's HRRR archive starts in July 2014")
    at = _ms_to_dt(at_ms + 30 * 60 * 1000).replace(minute=0, second=0, microsecond=0)
    date_str, cyc = at.strftime("%Y%m%d"), at.strftime("%H")
    rel = os.path.join("radar-archive", "hrrr", f"{date_str}{cyc}", f"{field}.png")
    png = os.path.join(DATA, rel)
    side = png[:-4] + ".json"
    if os.path.exists(png) and os.path.exists(side):
        with open(side) as fh:
            return json.load(fh)
    m = gp.MODELS["hrrr"]
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
        tmp = tf.name
    try:
        if not (fetcher or gp.fetch_hour)(m, date_str, cyc, 0, tmp):
            raise LookupError(f"NOAA has no HRRR run archived for {date_str} {cyc}Z")
        fields = gp.open_fields(tmp, m.get("box", gp.BOX))
        if field not in fields:
            raise LookupError(f"that HRRR run has no {field}")
        vals, lats, lons = fields[field]
        spec = gp.FIELDS[field]
        bounds = gp.bounds_from(lats, lons)
        os.makedirs(os.path.dirname(png), exist_ok=True)
        gp.render_png(vals, lats, spec, png, bounds=bounds)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    meta = {"file": rel.replace(os.sep, "/"), "bounds": bounds, "t": int(at.timestamp() * 1000),
            "run": f"{date_str}{cyc}", "field": field,
            "scale": {"lo": spec["range"][0], "hi": spec["range"][1], "ramp": spec["ramp"]}}
    with open(side, "w") as fh:
        json.dump(meta, fh)
    _prune(os.path.join(DATA, "radar-archive", "hrrr"), 400)
    return meta


# ============================================================================
def _prune(root, max_mb):
    """Oldest-first, until the folder is under its size."""
    try:
        files = []
        total = 0
        for dp, _dn, fn in os.walk(root):
            for f in fn:
                p = os.path.join(dp, f)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                files.append((st.st_mtime, st.st_size, p))
                total += st.st_size
        files.sort()
        limit = max_mb * 1024 * 1024
        for _mt, size, p in files:
            if total <= limit:
                break
            if p.endswith(".part") or ".part" + os.sep in p:
                continue
            try:
                os.unlink(p)
                total -= size
            except OSError:
                pass
    except Exception:
        pass
