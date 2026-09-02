#!/usr/bin/env python3
"""
The satellite archive: any GOES scan since 2017, rendered on demand.

    python3 pi/sat_archive.py east 13 conus 2023-05-30T12:00Z   # try one

The site's satellite Time Machine had nowhere real to go. The WMS bands only
reach as far back as Iowa Mesonet keeps them, and the Pi's own composites
keep three days. NOAA's public buckets keep every scan the satellites have
ever made (GOES-16 from mid 2017, GOES-West from 2019), but as raw NetCDF
files a browser cannot read. This module reads them for it.

serve.py opens two doors on it:

    GET /sat/archive/index?post=east&band=13&sector=conus&at=<ms>&n=24
        the scans leading up to a moment, oldest first, plus the rectangle
        they cover (the newest is rendered right away so the rectangle is
        known and the first picture is instant)
    GET /sat/archive/frame?bucket=&key=&band=&sector=
        one scan as a PNG, rendered the first time and served from disk
        after that

Every field is validated against a shape and the S3 key against the exact
filename pattern NOAA uses, so the door can only ever ask NOAA's four GOES
buckets for one kind of file.

Rendering is deliberately plain: a single band is one measurement, drawn in
grey the way every satellite service draws it (cold cloud tops white for the
infrared and water vapour bands, bright ground white for the visible ones).
The page's Satellite Colors presets tint it from there like any other
satellite surface.
"""

import io
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

# ── Which satellite stood at which post, when ──────────────────────────────
# NOAA keeps one bucket per spacecraft, and the spacecraft standing in a post
# has changed: GOES-16 was East from late 2017 until GOES-19 took over on
# 7 April 2025; GOES-17 was West from February 2019 until GOES-18 took over on
# 10 January 2023. Imagery is filed under the spacecraft, so a date has to be
# turned into a bucket before anything can be listed.
BUCKETS = {"noaa-goes16", "noaa-goes17", "noaa-goes18", "noaa-goes19"}
POSTS = {
    "east": [("noaa-goes16", datetime(2017, 7, 10, tzinfo=timezone.utc),
              datetime(2025, 4, 7, tzinfo=timezone.utc)),
             ("noaa-goes19", datetime(2025, 4, 7, tzinfo=timezone.utc), None)],
    "west": [("noaa-goes17", datetime(2019, 2, 12, tzinfo=timezone.utc),
              datetime(2023, 1, 10, tzinfo=timezone.utc)),
             ("noaa-goes18", datetime(2023, 1, 10, tzinfo=timezone.utc), None)],
}
SECTOR_PRODUCT = {"conus": "ABI-L2-CMIPC", "fulldisk": "ABI-L2-CMIPF"}
KEY_RE = re.compile(
    r"^ABI-L2-CMIP[CF]/\d{4}/\d{3}/\d{2}/OR_ABI-L2-CMIP[CF]-M\dC(\d{2})_G1[6-9]"
    r"_s(\d{14})_e\d{14}_c\d{14}\.nc$")
# A CONUS scan every five minutes, a full disk every ten: how many hours of
# listing it takes to gather n frames, with one spare hour for scan gaps.
CADENCE_MIN = {"conus": 5, "fulldisk": 10}
MAX_HOURS_BACK = 8
CACHE_DIR = os.path.expanduser("~/wxdata/satellite/archive")
CACHE_MAX_FILES = int(os.environ.get("GWCFC_SAT_ARCHIVE_MAX", "600"))
EDGE_PX = {"conus": 2400, "fulldisk": 2000}
HTTP_TIMEOUT = 180


def log(msg):
    print(f"{datetime.now(timezone.utc):%H:%M:%S} {msg}", flush=True)


def bucket_for(post, when):
    """The bucket holding the spacecraft at a post on a date, or None."""
    for bucket, start, end in POSTS.get(post, []):
        if when >= start and (end is None or when < end):
            return bucket
    return None


def stamp_utc(stamp):
    """YYYYDDDHHMMSSt (the ABI filename stamp) to a UTC datetime."""
    try:
        return (datetime(int(stamp[0:4]), 1, 1, tzinfo=timezone.utc)
                + timedelta(days=int(stamp[4:7]) - 1, hours=int(stamp[7:9]),
                            minutes=int(stamp[9:11]), seconds=int(stamp[11:13])))
    except Exception:
        return None


def list_keys(bucket, prefix, timeout=30):
    """The keys under one S3 prefix, or [] when the bucket will not say."""
    url = f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}"
    req = urllib.request.Request(url, headers={"User-Agent": "gwcfc-sat-archive"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(4 * 1024 * 1024).decode("utf-8", "replace")
    except Exception as e:
        log(f"  s3 {bucket}/{prefix}: {e}")
        return []
    return re.findall(r"<Key>([^<]+)</Key>", body)


def frames_around(post, band, sector, at_ms, n, lister=list_keys):
    """The n scans leading up to a moment, oldest first.

    Returns {"bucket", "frames": [{"t": ms, "stamp", "key"}]} or None when
    no spacecraft stood at that post on that date. Walks the hourly S3
    folders backwards from the moment's hour until it has n scans or has
    looked far enough that the gap is real.
    """
    when = datetime.fromtimestamp(at_ms / 1000.0, tz=timezone.utc)
    bucket = bucket_for(post, when)
    if not bucket:
        return None
    product = SECTOR_PRODUCT[sector]
    tag = f"C{int(band):02d}_"
    want_hours = min(MAX_HOURS_BACK,
                     int(np.ceil(n * CADENCE_MIN[sector] / 60.0)) + 1)
    found = {}
    for h in range(want_hours):
        t = when - timedelta(hours=h)
        prefix = f"{product}/{t.year}/{t.timetuple().tm_yday:03d}/{t.hour:02d}/"
        for k in lister(bucket, prefix):
            m = KEY_RE.match(k)
            if not m or f"-M6{tag}" not in k and f"-M3{tag}" not in k and f"-M4{tag}" not in k:
                continue
            if f"C{int(band):02d}_" != f"C{int(m.group(1)):02d}_":
                continue
            st = stamp_utc(m.group(2))
            if st is None or st > when:
                continue
            found[m.group(2)] = k
        if len(found) >= n:
            break
    stamps = sorted(found)[-n:]
    return {"bucket": bucket, "frames": [
        {"t": int(stamp_utc(s).timestamp() * 1000), "stamp": s, "key": found[s]}
        for s in stamps]}


def _download(bucket, key):
    url = f"https://{bucket}.s3.amazonaws.com/{key}"
    req = urllib.request.Request(url, headers={"User-Agent": "gwcfc-sat-archive"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        return r.read()


def fixed_grid_latlon(x, y, lon0, H, req, rpol):
    """ABI scan angles to latitude and longitude (GOES-R PUG, section 5.1.2.8).

    Points that miss the earth, the corners of a full disk, come back NaN.
    """
    X, Y = np.meshgrid(x, y)
    sx, cx = np.sin(X), np.cos(X)
    sy, cy = np.sin(Y), np.cos(Y)
    del X, Y
    rr = (req * req) / (rpol * rpol)
    a = sx ** 2 + (cx ** 2) * (cy ** 2 + rr * sy ** 2)
    b = -2.0 * H * cx * cy
    c = H * H - req * req
    disc = b * b - 4.0 * a * c
    with np.errstate(all="ignore"):
        good = disc >= 0
        rs = np.where(good, (-b - np.sqrt(np.maximum(disc, 0))) / (2.0 * a), np.nan)
        sxk = rs * cx * cy
        syk = -rs * sx
        szk = rs * cx * sy
        lat = np.degrees(np.arctan(rr * szk / np.sqrt((H - sxk) ** 2 + syk ** 2)))
        lon = np.degrees(lon0 * np.pi / 180.0 - np.arctan(syk / (H - sxk)))
    return (np.where(good, lat, np.nan).astype(np.float32),
            np.where(good, lon, np.nan).astype(np.float32))


def colorize(vals, band):
    """One band to 0..255 grey, the way every satellite service draws it."""
    band = int(band)
    with np.errstate(all="ignore"):
        if band <= 6:
            # Reflectance 0..1; a square root lifts the dim land without
            # burning the bright cloud.
            v = np.sqrt(np.clip(np.nan_to_num(vals, nan=0.0), 0.0, 1.0))
        elif 8 <= band <= 10:
            # Water vapour: brightness temperature, cold (moist, high) bright.
            v = 1.0 - (vals - 190.0) / (270.0 - 190.0)
        else:
            # Infrared: cold cloud tops bright, warm ground dark.
            v = 1.0 - (vals - 180.0) / (320.0 - 180.0)
        v = np.clip(np.nan_to_num(v, nan=0.0), 0.0, 1.0)
    return (v * 255.0).astype(np.uint8)


def regrid(vals, lats, lons, edge):
    """Drop a scan onto a plain lat/lon mesh, row 0 north, with a coverage mask.

    The satellite's grid is scan angles, not rows of latitude, so the values
    are binned into whichever cell of a regular mesh they land in, averaged
    where several land in one and left as a gap where none do. A gap is then
    filled from its neighbours once, so the picture is not speckled with
    holes where the two grids simply disagreed on a cell boundary.
    """
    ok = np.isfinite(lats) & np.isfinite(lons) & np.isfinite(vals)
    if int(ok.sum()) < 100:
        return None
    la, lo, v = lats[ok].astype(np.float64), lons[ok].astype(np.float64), vals[ok].astype(np.float64)
    lat0, lat1 = float(la.min()), float(la.max())
    lon0, lon1 = float(lo.min()), float(lo.max())
    span_lat, span_lon = max(lat1 - lat0, 1e-6), max(lon1 - lon0, 1e-6)
    if span_lon >= span_lat:
        nx, ny = int(edge), max(2, int(round(edge * span_lat / span_lon)))
    else:
        ny, nx = int(edge), max(2, int(round(edge * span_lon / span_lat)))
    ix = np.clip(((lo - lon0) / span_lon * nx).astype(np.int64), 0, nx - 1)
    iy = np.clip(((lat1 - la) / span_lat * ny).astype(np.int64), 0, ny - 1)
    idx = iy * nx + ix
    s = np.bincount(idx, weights=v, minlength=nx * ny)
    c = np.bincount(idx, minlength=nx * ny).astype(np.float64)
    grid = np.where(c > 0, s / np.maximum(c, 1.0), np.nan).reshape(ny, nx)
    cov = (c > 0).reshape(ny, nx)
    # One neighbour-fill pass for the pinholes.
    holes = ~cov
    if holes.any():
        pad = np.pad(grid, 1, mode="edge")
        acc = np.zeros_like(grid)
        cnt = np.zeros_like(grid)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                nb = pad[1 + dy:1 + dy + ny, 1 + dx:1 + dx + nx]
                good = np.isfinite(nb)
                acc[good] += nb[good]
                cnt[good] += 1
        fill = holes & (cnt >= 3)
        grid[fill] = acc[fill] / cnt[fill]
        cov = cov | fill
    bounds = [[lat0, lon0], [lat1, lon1]]
    return grid, cov, bounds


def _cache_paths(cache_dir, bucket, key, band, sector):
    m = KEY_RE.match(key)
    stamp = m.group(2) if m else re.sub(r"[^0-9A-Za-z]", "_", key)[-32:]
    d = os.path.join(cache_dir, bucket, sector, f"C{int(band):02d}")
    return os.path.join(d, f"{stamp}.png"), os.path.join(d, f"{stamp}.json")


def prune_cache(cache_dir, keep=CACHE_MAX_FILES):
    """Oldest-touched frames go first once the cache is past its size."""
    files = []
    for root, _dirs, names in os.walk(cache_dir):
        for nm in names:
            if nm.endswith(".png"):
                p = os.path.join(root, nm)
                try:
                    files.append((os.path.getmtime(p), p))
                except OSError:
                    pass
    files.sort()
    for _mt, p in files[:max(0, len(files) - keep)]:
        for q in (p, p[:-4] + ".json"):
            try:
                os.unlink(q)
            except OSError:
                pass


def render(bucket, key, band, sector, cache_dir=CACHE_DIR, fetch=_download,
           edge=None):
    """One scan to a PNG on disk. Returns (png_path, bounds)."""
    png, side = _cache_paths(cache_dir, bucket, key, band, sector)
    if os.path.exists(png) and os.path.exists(side):
        try:
            with open(side) as fh:
                meta = json.load(fh)
            os.utime(png, None)
            return png, meta["bounds"]
        except Exception:
            pass
    import netCDF4  # imported here so --check and the tests run without it
    from PIL import Image

    raw = fetch(bucket, key)
    ds = netCDF4.Dataset("inmem", mode="r", memory=raw)
    try:
        cmi = ds.variables["CMI"]
        ny, nx = cmi.shape
        edge = int(edge or EDGE_PX.get(sector, 2000))
        step = max(1, int(np.ceil(max(ny, nx) / float(edge))))
        vals = np.ma.filled(cmi[::step, ::step].astype(np.float32), np.nan)
        x = np.asarray(ds.variables["x"][::step], dtype=np.float64)
        y = np.asarray(ds.variables["y"][::step], dtype=np.float64)
        proj = ds.variables["goes_imager_projection"]
        lon0 = float(proj.longitude_of_projection_origin)
        H = float(proj.perspective_point_height) + float(proj.semi_major_axis)
        req = float(proj.semi_major_axis)
        rpol = float(proj.semi_minor_axis)
    finally:
        ds.close()
    lats, lons = fixed_grid_latlon(x, y, lon0, H, req, rpol)
    grey = colorize(vals, band).astype(np.float32)
    grey[~np.isfinite(vals)] = np.nan
    out = regrid(grey, lats, lons, min(edge, max(vals.shape)))
    if out is None:
        raise RuntimeError("no points on the earth")
    grid, cov, bounds = out
    g8 = np.clip(np.nan_to_num(grid, nan=0.0), 0, 255).astype(np.uint8)
    a8 = np.where(cov, 255, 0).astype(np.uint8)
    os.makedirs(os.path.dirname(png), exist_ok=True)
    Image.fromarray(np.dstack([g8, g8, g8, a8]), mode="RGBA").save(png, optimize=True)
    tmp = side + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"bounds": bounds, "band": int(band), "sector": sector,
                   "key": key, "built": datetime.now(timezone.utc).isoformat()}, fh)
    os.replace(tmp, side)
    try:
        prune_cache(cache_dir)
    except Exception:
        pass
    return png, bounds


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) < 4:
        print(__doc__)
        return 2
    post, band, sector, when = argv[0], int(argv[1]), argv[2], argv[3]
    at = datetime.fromisoformat(when.replace("Z", "+00:00"))
    got = frames_around(post, band, sector, int(at.timestamp() * 1000), 3)
    if not got or not got["frames"]:
        print("nothing archived there")
        return 1
    f = got["frames"][-1]
    t0 = time.time()
    png, bounds = render(got["bucket"], f["key"], band, sector)
    print(f"{png}  bounds={bounds}  in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
