#!/usr/bin/env python3
"""The MRRL radar network (feeds.mrrl.net), for the site's radar pills.

MRRL publishes Level 2 volumes from radars around the world (Europe, Japan
and more) in the GR polling layout: /polling/config.cfg names the sites,
/polling/<SITE>/dir.list lists each site's files (size, then name), and the
files themselves are ordinary NEXRAD Archive II volumes (AR2V0006), the
same format the American radars send. So the browser's own Level 2 decoder
reads them unchanged; this file only has to get them to it.

Why through the parsing server and not straight from the page: the feed
sends no CORS header, so a browser is not allowed to read it directly. The
operator gave permission for the app to auto-pull the feed (their robots.txt
still says Disallow, which is aimed at crawlers; this pulls only what a
person looking at the map asks for, and caches it so the same volume is
never fetched twice).

    python mrrl.py            # rebuild sites.json (where every radar is)

A radar whose data carries no position (a few leave it zeroed) is left
off the map and named in the log; a line in positions.json places it.

Kept on disk under ~/wxdata/mrrl:
    sites.json               every site's code and position, read from the
                             radar's own volume header
    cache/<SITE>/<name>      volumes already fetched, oldest pruned first
"""

import bz2
import gzip
import json
import os
import re
import struct
import sys
import threading
import time
import urllib.request

try:                      # the IRIS converter (CABO, SABA), beside this file
    import mrrl_iris
except ImportError:       # pragma: no cover - run from another directory
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import mrrl_iris

FEED = "https://feeds.mrrl.net/polling"
UA = "GWCFCRadar parsing server (https://ralphhtml.github.io/GWCFCRadar/)"
DATA = os.path.join(os.environ.get("GWCFC_DATA", os.path.expanduser("~/wxdata")), "mrrl")
CACHE_MAX_BYTES = int(os.environ.get("GWCFC_MRRL_CACHE_MB", "400")) * 1024 * 1024

# Shapes, checked before anything is fetched, so the doors in serve.py can
# only ever ask the feed for a real site's real files.
SITE_RE = re.compile(r"[A-Za-z0-9_]{4}")
# Up to eight characters an extension: the IRIS volumes are .RAW02XU.gz.
FILE_RE = re.compile(r"[A-Za-z0-9_]{4,48}(\.[A-Za-z0-9]{1,8}){0,2}")

_lock = threading.Lock()
_list_cache = {}          # site -> (fetched_at, entries)
LIST_TTL = 30             # seconds; a new volume lands every few minutes
_gate = threading.Semaphore(4)   # at most four downloads from the feed at once


def _get(url, timeout=30, first_bytes=None):
    headers = {"User-Agent": UA}
    if first_bytes:
        headers["Range"] = f"bytes=0-{first_bytes - 1}"
    req = urllib.request.Request(url, headers=headers)
    with _gate:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()


def site_codes(text=None, index=None):
    """Every site: the ones config.cfg names, in its order, then any folder
    the feed's own directory listing has that config.cfg does not (a radar
    added to the feed before its config line)."""
    live = text is None
    if live:
        text = _get(f"{FEED}/config.cfg", timeout=20).decode("utf-8", "replace")
    out = []
    for line in text.splitlines():
        m = re.match(r"\s*Site:\s*(\S+)", line)
        if m and SITE_RE.fullmatch(m.group(1)) and m.group(1) not in out:
            out.append(m.group(1))
    if index is None and live:
        try:
            index = _get(f"{FEED}/", timeout=20).decode("utf-8", "replace")
        except Exception:
            index = ""
    for d in re.findall(r'href="([^"/]+)/"', index or ""):
        if SITE_RE.fullmatch(d) and d not in out:
            out.append(d)
    return out


def stamp_ms(name):
    """The scan time in a file name, whichever of the two spellings it uses:
    BOO__20260924155402.ar2v or AKIT20260924_154000_2.msg31.gz."""
    m = re.search(r"(20\d{2})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})", name[4:])
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x) for x in m.groups())
    try:
        import calendar
        return calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0)) * 1000
    except (ValueError, OverflowError):
        return None


def parse_dir_list(site, text):
    """dir.list is 'size name' per line. Only this site's own volume files,
    oldest first."""
    out = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        name = parts[1]
        if not FILE_RE.fullmatch(name) or not name.startswith(site):
            continue
        # Still being written (LT40's .ar2v.tmp), a stray double dot, or the
        # feed's own bookkeeping: not a volume, and a half-written one listed
        # as the newest would be drawn with most of the sweep missing.
        if name.endswith(".tmp") or ".." in name or name.endswith(".json"):
            continue
        t = stamp_ms(name)
        if t is None:
            continue
        out.append({"name": name, "size": int(parts[0]), "t": t})
    out.sort(key=lambda e: e["t"])
    return out


def listing(site):
    """A site's volumes, oldest first, cached for LIST_TTL seconds."""
    if not SITE_RE.fullmatch(site):
        raise ValueError("not a site code")
    now = time.time()
    with _lock:
        hit = _list_cache.get(site)
        if hit and now - hit[0] < LIST_TTL:
            return hit[1]
    text = _get(f"{FEED}/{site}/dir.list", timeout=20).decode("utf-8", "replace")
    entries = parse_dir_list(site, text)
    with _lock:
        _list_cache[site] = (now, entries)
    return entries


def as_ar2v(raw, site="____"):
    """The volume as plain Archive II. Some files are gzipped whole (the .gz
    ones, usually); some carry that name and are not. The magic number
    decides, not the name. An IRIS RAW volume (the Mexican radars) is
    converted to Archive II here, so the browser reads it like any other."""
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    if raw.startswith(b"AR2V"):
        return raw
    if mrrl_iris.is_iris(raw):
        return mrrl_iris.to_ar2v(raw, site)
    raise ValueError("not an Archive II or IRIS volume")


def _cache_path(site, name):
    base = name[:-3] if name.endswith(".gz") else name
    return os.path.join(DATA, "cache", site, base)


def _prune():
    root = os.path.join(DATA, "cache")
    files = []
    for dirpath, _, names in os.walk(root):
        for n in names:
            p = os.path.join(dirpath, n)
            try:
                st = os.stat(p)
            except OSError:
                continue
            files.append((st.st_mtime, st.st_size, p))
    total = sum(f[1] for f in files)
    for _, size, p in sorted(files):
        if total <= CACHE_MAX_BYTES:
            break
        try:
            os.remove(p)
            total -= size
        except OSError:
            pass


def volume(site, name):
    """One volume as Archive II bytes, from the cache or the feed."""
    if not SITE_RE.fullmatch(site) or not FILE_RE.fullmatch(name) or not name.startswith(site):
        raise ValueError("not a volume of that site")
    path = _cache_path(site, name)
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        pass
    data = as_ar2v(_get(f"{FEED}/{site}/{name}", timeout=60), site)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    _prune()
    return data


# -- Where each radar is --------------------------------------------------------
# Read from the radar's own data: every Message 31 radial carries a volume
# block (RVOL) with the site's latitude, longitude and height.

def _streams(data):
    """The message stream(s) inside an Archive II file: bzip2 records after
    the 24-byte header, or the messages themselves when uncompressed. A
    record cut short (a ranged read) ends the walk rather than failing it."""
    if data[28:31] != b"BZh":
        yield data[24:]
        return
    p = 24
    while p + 4 <= len(data):
        n = abs(struct.unpack(">i", data[p:p + 4])[0])
        p += 4
        if n == 0 or p + n > len(data):
            return
        try:
            yield bz2.decompress(data[p:p + n])
        except (OSError, ValueError, EOFError):
            return
        p += n


def site_location(data):
    """(lat, lon, height_m) from the first Message 31 in the volume, or None."""
    for buf in _streams(data):
        p = 0
        while p + 28 <= len(buf):
            size_hw = struct.unpack(">H", buf[p + 12:p + 14])[0]
            mtype = buf[p + 15]
            if mtype == 31:
                body = buf[p + 28:p + 12 + size_hw * 2]
                if len(body) >= 32:
                    count = struct.unpack(">H", body[30:32])[0]
                    for i in range(min(count, 10)):
                        off = 32 + i * 4
                        if off + 4 > len(body):
                            break
                        ptr = struct.unpack(">I", body[off:off + 4])[0]
                        blk = body[ptr:ptr + 20]
                        if len(blk) >= 18 and blk[:4] == b"RVOL":
                            lat, lon = struct.unpack(">ff", blk[8:16])
                            h = struct.unpack(">h", blk[16:18])[0]
                            # Some radars leave the block zeroed (the
                            # Norwegian ones do): no position, not the Gulf
                            # of Guinea.
                            if -90 <= lat <= 90 and -180 <= lon <= 180 and (abs(lat) > 0.01 or abs(lon) > 0.01):
                                return round(lat, 4), round(lon, 4), h
                ln = size_hw * 2 + 12
            else:
                ln = 2432
            if ln <= 12:
                return None
            p += ln
    return None


def build_sites(codes=None, fetch_head=None, log=print):
    """Every site's position, written to sites.json. A site that cannot be
    read this time keeps the position it had before."""
    path = os.path.join(DATA, "sites.json")
    old = {}
    try:
        with open(path) as f:
            old = {s["id"]: s for s in json.load(f).get("sites", [])}
    except (OSError, ValueError):
        pass
    # Positions typed in by hand, for the radars whose data does not carry
    # one: {"nhas": [70.5, 22.1]} in positions.json beside sites.json.
    manual = {}
    try:
        with open(os.path.join(DATA, "positions.json")) as f:
            manual = {k: v for k, v in json.load(f).items() if SITE_RE.fullmatch(k)}
    except (OSError, ValueError):
        pass
    if codes is None:
        codes = site_codes()
    if fetch_head is None:
        def fetch_head(site):
            entries = listing(site)
            if not entries:
                return None
            newest = entries[-1]["name"]
            return _get(f"{FEED}/{site}/{newest}", timeout=60, first_bytes=1_200_000)
    sites = []
    for code in codes:
        where = None
        if code in manual:
            try:
                lat, lon = float(manual[code][0]), float(manual[code][1])
                sites.append({"id": code, "lat": lat, "lon": lon, "height_m": 0})
                continue
            except (TypeError, ValueError, IndexError):
                log(f"{code}: positions.json entry is not [lat, lon]")
        try:
            head = fetch_head(code)
            if head:
                if head[:2] == b"\x1f\x8b":
                    head = gzip.GzipFile(fileobj=__import__("io").BytesIO(head)).read1(4_000_000)
                where = mrrl_iris.location(head) if mrrl_iris.is_iris(head) else site_location(head)
        except Exception as e:  # one site's trouble is not the network's
            log(f"{code}: {e.__class__.__name__}: {e}")
        if where:
            lat, lon, h = where
            sites.append({"id": code, "lat": lat, "lon": lon, "height_m": h})
        elif code in old:
            sites.append(old[code])
        else:
            log(f"{code}: no position found")
    os.makedirs(DATA, exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "w") as f:
        json.dump({"updated": int(time.time()), "source": "feeds.mrrl.net", "sites": sites}, f)
    os.replace(tmp, path)
    log(f"{len(sites)} of {len(codes)} MRRL sites placed")
    return sites


if __name__ == "__main__":
    build_sites()
    sys.exit(0)
