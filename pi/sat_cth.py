#!/usr/bin/env python3
"""
Cloud-top heights for Satellite 3D.

    python3 pi/sat_cth.py 35.0 -98.0 36.0 -97.0     # one zone, newest scan

Satellite 3D lifts every pixel of a zone to the height of the cloud top
it sees. Two sources, used together:

  NOAA's own Cloud Top Height product (ABI-L2-ACHA). The official answer,
  retrieved by NOAA's algorithm with a real atmosphere behind it, but on a
  10 km grid: a whole thunderstorm is a handful of cells.

  Band 13, the clean infrared window, on its native 2 km grid. Cold means
  high: a cloud top radiates at the temperature of the air it sits in, and
  that air cools with height. Detailed, but on its own only as good as the
  guess about how fast the air cools.

So each frame fits the two against each other: inside the zone, every
cloudy 2 km pixel that also has an ACHA height becomes a pair (brightness
temperature, height), and a straight line through the pairs is the local
relationship between cold and high, for this scene, today. That line then
lifts every cloudy pixel at the full 2 km detail. NOAA's heights set the
scale; band 13 draws the shape.

When ACHA has nothing for the zone (no product at that moment, too few
cloudy cells to fit, or a fit that comes out backwards), the line comes
from the standard atmosphere instead: 6.5 K colder per kilometre up from
the warmest ground in the zone. The frame says which it used.

serve.py opens two doors on it:

    GET /sat/cth/index?south=&west=&north=&east=&n=6[&at=<ms>]
        the band 13 scans leading up to now (or to a moment), oldest first
    GET /sat/cth/frame?bucket=&key=&sector=&south=&west=&north=&east=
        one scan's heights for the zone, as JSON, built once and cached
"""

import base64
import json
import os
import re
import sys
import time
from datetime import timedelta

import numpy as np

import sat_archive as sa

ACHA_PRODUCT = {"conus": "ABI-L2-ACHAC", "fulldisk": "ABI-L2-ACHAF"}
ACHA_KEY_RE = re.compile(
    r"^ABI-L2-ACHA[CF]/\d{4}/\d{3}/\d{2}/OR_ABI-L2-ACHA[CF]-M\d_G1[6-9]"
    r"_s(\d{14})_e\d{14}_c\d{14}\.nc$")
# ACHA is not made for every infrared scan; the nearest one within this
# long of the scan stands in for it. Cloud tops move, but twenty minutes of
# drift barely touches a fit made over a whole zone.
ACHA_MATCH_MIN = 20
CACHE_DIR = os.path.expanduser("~/wxdata/satellite/cth")
CACHE_MAX_FILES = int(os.environ.get("GWCFC_SAT_CTH_MAX", "800"))
# 2 km cells, the band's own resolution; capped so a huge box stays cheap.
CELL_KM = 2.0
GRID_MIN, GRID_MAX = 16, 220
# The biggest zone the door accepts, in degrees.
MAX_SPAN_LAT, MAX_SPAN_LON = 25.0, 35.0
# The standard atmosphere's lapse rate, K per metre.
LAPSE = 0.0065
# A pixel this much colder than the warmest ground in the zone is cloud.
CLOUD_MARGIN_K = 4.0
# Fewer pairs than this and the fit is not trusted.
MIN_PAIRS = 25
TOP_M = 18000.0

# Where each post's CONUS sector reaches, roughly: a zone inside it is read
# from the 5-minute CONUS scans, anywhere else from the full disk.
CONUS_COVER = {
    "east": (16.0, 52.0, -123.0, -64.0),
    "west": (16.0, 52.0, -155.0, -100.0),
}


def log(msg):
    sa.log(msg)


def post_for(west, east):
    """GOES-West for a zone centred west of 105 W, GOES-East otherwise."""
    return "west" if (west + east) / 2.0 < -105.0 else "east"


def sector_for(post, south, west, north, east):
    s0, n0, w0, e0 = CONUS_COVER[post]
    inside = south >= s0 and north <= n0 and west >= w0 and east <= e0
    return "conus" if inside else "fulldisk"


def grid_size(south, west, north, east):
    """Cells across and down for ~2 km cells, clamped."""
    mid = np.radians((south + north) / 2.0)
    w_km = abs(east - west) * 111.32 * max(0.2, np.cos(mid))
    h_km = abs(north - south) * 111.32
    nx = int(np.clip(np.ceil(w_km / CELL_KM), GRID_MIN, GRID_MAX))
    ny = int(np.clip(np.ceil(h_km / CELL_KM), GRID_MIN, GRID_MAX))
    return nx, ny


def grid_into(vals, lats, lons, bbox, nx, ny):
    """Average scattered samples into a regular lat/lon mesh over bbox.

    bbox is (south, west, north, east). Row 0 is north. Cells nothing
    landed in are NaN, then filled from their neighbours for two passes so
    the seam between the satellite's scan grid and this mesh never leaves
    pinholes.
    """
    south, west, north, east = bbox
    ok = (np.isfinite(vals) & np.isfinite(lats) & np.isfinite(lons)
          & (lats >= south) & (lats <= north) & (lons >= west) & (lons <= east))
    grid = np.full((ny, nx), np.nan, dtype=np.float64)
    if not ok.any():
        return grid
    la, lo, v = lats[ok], lons[ok], vals[ok].astype(np.float64)
    ix = np.clip(((lo - west) / (east - west) * nx).astype(np.int64), 0, nx - 1)
    iy = np.clip(((north - la) / (north - south) * ny).astype(np.int64), 0, ny - 1)
    idx = iy * nx + ix
    s = np.bincount(idx, weights=v, minlength=nx * ny)
    c = np.bincount(idx, minlength=nx * ny).astype(np.float64)
    grid = np.where(c > 0, s / np.maximum(c, 1.0), np.nan).reshape(ny, nx)
    for _ in range(2):
        holes = ~np.isfinite(grid)
        if not holes.any():
            break
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
        fill = holes & (cnt >= 2)
        grid[fill] = acc[fill] / cnt[fill]
    return grid


def heights(bt, acha):
    """Cloud-top heights in metres from brightness temperature (K).

    bt and acha are same-shaped grids; acha may be None or all NaN. Returns
    (heights, info) where heights is 0 for clear sky and info records what
    was used: {"source": "acha+ir" | "ir", "a", "b", "pairs", "tsfc"}.
    """
    finite = np.isfinite(bt)
    if not finite.any():
        return np.zeros_like(bt), {"source": "none", "a": 0.0, "b": 0.0, "pairs": 0, "tsfc": 0.0}
    # The warmest ground in the zone: a high percentile rather than the
    # maximum, so one hot pixel cannot set the scale for everything.
    tsfc = float(np.clip(np.percentile(bt[finite], 97), 250.0, 320.0))
    cloudy = finite & (bt < tsfc - CLOUD_MARGIN_K)
    # The standard atmosphere, as a line: h = a + b * bt.
    a, b = tsfc / LAPSE, -1.0 / LAPSE
    source, pairs = "ir", 0
    if acha is not None:
        pair = cloudy & np.isfinite(acha) & (acha > 0)
        pairs = int(pair.sum())
        if pairs >= MIN_PAIRS and float(np.ptp(bt[pair])) > 2.0:
            fb, fa = np.polyfit(bt[pair].astype(np.float64), acha[pair].astype(np.float64), 1)
            # Colder must be higher, at a rate the real atmosphere can have.
            # Anything else (a fit pulled sideways by a thin cirrus sheet
            # over warm cloud, say) is not trusted.
            if -400.0 < fb < -40.0:
                a, b, source = float(fa), float(fb), "acha+ir"
    h = np.where(cloudy, a + b * bt, 0.0)
    cap = TOP_M
    if source == "acha+ir":
        top = float(np.nanmax(np.where(np.isfinite(acha), acha, np.nan)))
        if np.isfinite(top):
            cap = min(TOP_M, top + 1500.0)
    h = np.clip(np.nan_to_num(h, nan=0.0), 0.0, cap)
    return h, {"source": source, "a": round(a, 3), "b": round(b, 4),
               "pairs": pairs, "tsfc": round(tsfc, 2)}


def encode(heights_m, bt):
    """The frame body: heights as uint16 metres, band 13 as 8-bit grey."""
    h16 = np.clip(np.round(heights_m), 0, 65535).astype("<u2")
    grey = sa.colorize(bt, 13)
    return (base64.b64encode(h16.tobytes()).decode("ascii"),
            base64.b64encode(grey.astype(np.uint8).tobytes()).decode("ascii"))


def decode_heights(b64, nx, ny):
    return np.frombuffer(base64.b64decode(b64), dtype="<u2").reshape(ny, nx)


# -- Reading the files -------------------------------------------------------

def _window(x, y, lon0, H, req, rpol, bbox, margin=0.6):
    """Index ranges of a scan's grid that cover bbox, found on a coarse pass.

    Computing latitude and longitude for all four million points of a CONUS
    scan just to keep a few thousand of them is most of the work, so a
    sparse grid finds the window first and only that window is done fully.
    """
    south, west, north, east = bbox
    step = 24
    xs, ys = x[::step], y[::step]
    la, lo = sa.fixed_grid_latlon(xs, ys, lon0, H, req, rpol)
    inside = ((la >= south - margin) & (la <= north + margin)
              & (lo >= west - margin) & (lo <= east + margin))
    if not inside.any():
        return None
    rows, cols = np.where(inside)
    r0 = max(0, (rows.min() - 1) * step)
    r1 = min(len(y), (rows.max() + 2) * step)
    c0 = max(0, (cols.min() - 1) * step)
    c1 = min(len(x), (cols.max() + 2) * step)
    return r0, r1, c0, c1


def read_field(raw, var, bbox, keep_quality=True):
    """One field of an ABI NetCDF, cropped to bbox: (vals, lats, lons)."""
    import netCDF4  # imported here so the tests run without it

    ds = netCDF4.Dataset("inmem", mode="r", memory=raw)
    try:
        x = np.asarray(ds.variables["x"][:], dtype=np.float64)
        y = np.asarray(ds.variables["y"][:], dtype=np.float64)
        proj = ds.variables["goes_imager_projection"]
        lon0 = float(proj.longitude_of_projection_origin)
        H = float(proj.perspective_point_height) + float(proj.semi_major_axis)
        req = float(proj.semi_major_axis)
        rpol = float(proj.semi_minor_axis)
        win = _window(x, y, lon0, H, req, rpol, bbox)
        if win is None:
            return None
        r0, r1, c0, c1 = win
        vals = np.ma.filled(ds.variables[var][r0:r1, c0:c1].astype(np.float32), np.nan)
        if keep_quality and "DQF" in ds.variables:
            dqf = np.ma.filled(ds.variables["DQF"][r0:r1, c0:c1], 255)
            vals = np.where(dqf == 0, vals, np.nan)
    finally:
        ds.close()
    lats, lons = sa.fixed_grid_latlon(x[c0:c1], y[r0:r1], lon0, H, req, rpol)
    return vals, lats, lons


_listing_memo = {}


def _list_memo(bucket, prefix, lister):
    hit = _listing_memo.get((bucket, prefix))
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    keys = lister(bucket, prefix)
    _listing_memo[(bucket, prefix)] = (time.time(), keys)
    while len(_listing_memo) > 64:
        _listing_memo.pop(next(iter(_listing_memo)))
    return keys


def acha_key_for(bucket, sector, stamp, lister=sa.list_keys):
    """The ACHA file nearest a band 13 scan, within ACHA_MATCH_MIN, or None."""
    when = sa.stamp_utc(stamp)
    if when is None:
        return None
    product = ACHA_PRODUCT[sector]
    best, gap = None, None
    for dh in (0, -1):
        t = when + timedelta(hours=dh)
        prefix = f"{product}/{t.year}/{t.timetuple().tm_yday:03d}/{t.hour:02d}/"
        for k in _list_memo(bucket, prefix, lister):
            m = ACHA_KEY_RE.match(k)
            if not m:
                continue
            st = sa.stamp_utc(m.group(1))
            if st is None:
                continue
            g = abs((st - when).total_seconds())
            if g <= ACHA_MATCH_MIN * 60 and (gap is None or g < gap):
                best, gap = k, g
    return best


def _cache_path(cache_dir, bucket, key, bbox):
    m = sa.KEY_RE.match(key)
    stamp = m.group(2) if m else re.sub(r"[^0-9A-Za-z]", "_", key)[-32:]
    tag = "_".join(f"{v:.2f}" for v in bbox).replace("-", "m")
    return os.path.join(cache_dir, bucket, f"{stamp}_{tag}.json")


def prune_cache(cache_dir, keep=CACHE_MAX_FILES):
    files = []
    for root, _dirs, names in os.walk(cache_dir):
        for nm in names:
            if nm.endswith(".json"):
                p = os.path.join(root, nm)
                try:
                    files.append((os.path.getmtime(p), p))
                except OSError:
                    pass
    files.sort()
    for _mt, p in files[:max(0, len(files) - keep)]:
        try:
            os.unlink(p)
        except OSError:
            pass


def build_frame(bucket, key, sector, bbox, cache_dir=CACHE_DIR,
                fetch=sa._download, lister=sa.list_keys):
    """One scan's heights over bbox, as the dict the page reads. Cached."""
    path = _cache_path(cache_dir, bucket, key, bbox)
    if os.path.exists(path):
        try:
            with open(path) as fh:
                out = json.load(fh)
            os.utime(path, None)
            return out
        except Exception:
            pass
    m = sa.KEY_RE.match(key)
    stamp = m.group(2)
    nx, ny = grid_size(*bbox)
    got = read_field(fetch(bucket, key), "CMI", bbox, keep_quality=False)
    if got is None:
        raise RuntimeError("that scan does not cover the zone")
    bt = grid_into(*got, bbox, nx, ny)
    acha = None
    akey = acha_key_for(bucket, sector, stamp, lister)
    if akey:
        try:
            ag = read_field(fetch(bucket, akey), "HT", bbox, keep_quality=True)
            if ag is not None:
                acha = grid_into(*ag, bbox, nx, ny)
        except Exception as e:
            log(f"  cth: ACHA {akey.rsplit('/', 1)[-1]}: {e}")
    h, info = heights(bt, acha)
    hb, gb = encode(h, bt)
    south, west, north, east = bbox
    out = {"w": nx, "h": ny, "bounds": [[south, west], [north, east]],
           "t": int(sa.stamp_utc(stamp).timestamp() * 1000), "stamp": stamp,
           "key": key, "acha": akey, "heights": hb, "ir": gb, **info}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(out, fh)
    os.replace(tmp, path)
    try:
        prune_cache(cache_dir)
    except Exception:
        pass
    return out


def index(bbox, at_ms, n, lister=sa.list_keys):
    """The band 13 scans for the zone's post and sector, oldest first."""
    south, west, north, east = bbox
    post = post_for(west, east)
    sector = sector_for(post, south, west, north, east)
    got = sa.frames_around(post, 13, sector, at_ms, n, lister=lister)
    if got is None:
        return None
    return {"post": post, "sector": sector, "bucket": got["bucket"],
            "frames": got["frames"], "bounds": [[south, west], [north, east]]}


def parse_bbox(one):
    """(south, west, north, east) from a query getter, or raise ValueError."""
    s, w, n, e = (float(one(k)) for k in ("south", "west", "north", "east"))
    if not all(np.isfinite(v) for v in (s, w, n, e)):
        raise ValueError("coordinates must be numbers")
    if not (-90.0 <= s < n <= 90.0 and -180.0 <= w < e <= 180.0):
        raise ValueError("south/north and west/east must be in order and on the earth")
    if n - s > MAX_SPAN_LAT or e - w > MAX_SPAN_LON:
        raise ValueError("that zone is too big for a 3D view")
    return (round(s, 3), round(w, 3), round(n, 3), round(e, 3))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) < 4:
        print(__doc__)
        return 2
    bbox = tuple(float(v) for v in argv[:4])
    got = index(bbox, int(time.time() * 1000), 2)
    if not got or not got["frames"]:
        print("no scans")
        return 1
    f = got["frames"][-1]
    t0 = time.time()
    out = build_frame(got["bucket"], f["key"], got["sector"], bbox)
    h = decode_heights(out["heights"], out["w"], out["h"])
    print(f"{out['w']}x{out['h']} {out['source']} tops up to {h.max()} m "
          f"(pairs {out['pairs']}) in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
