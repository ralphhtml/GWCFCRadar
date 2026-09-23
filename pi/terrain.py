#!/usr/bin/env python3
"""
Ground and seafloor heights for the 3D views, kept on disk.

The browser reads elevation straight from the public Terrarium tiles
(AWS Open Data, "elevation-tiles-prod"). When it cannot reach them, it asks
this parsing server instead, through serve.py's /terrain/{z}/{x}/{y}.png
door, and this file answers: the same tile, downloaded once and then served
from the cache forever after (terrain does not change).

A Terrarium tile is a 256 x 256 PNG where each pixel's colour IS a height:

    metres = (red * 256 + green + blue / 256) - 32768

so land comes out positive and the ocean floor negative, which is what lets
the ocean layers show how deep the water is.

    python3 pi/terrain.py 6 16 25     # fetch one tile into the cache
"""

import os
import sys
import urllib.request

SOURCE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
MAX_Z = 15                     # the tiles stop at zoom 15
TIMEOUT_S = 20
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def valid(z, x, y):
    """True when z/x/y names a real tile. Each is a whole number, z from 0 to
    MAX_Z, and x and y inside the 2^z by 2^z grid of that zoom."""
    if not all(isinstance(v, int) for v in (z, x, y)):
        return False
    if not 0 <= z <= MAX_Z:
        return False
    n = 1 << z
    return 0 <= x < n and 0 <= y < n


def cache_path(cache_dir, z, x, y):
    return os.path.join(cache_dir, str(z), str(x), f"{y}.png")


def _download(z, x, y):
    url = SOURCE.format(z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": "GWCFCRadar-terrain/1"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return r.read()


def tile(z, x, y, cache_dir, fetch=None):
    """The PNG bytes of one tile: from the cache when it is there, otherwise
    downloaded, checked to really be a PNG, and saved for next time.
    `fetch` replaces the download (the tests use it)."""
    if not valid(z, x, y):
        raise ValueError("not a tile")
    path = cache_path(cache_dir, z, x, y)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            return fh.read()
    body = (fetch or _download)(z, x, y)
    if not body or not body.startswith(PNG_MAGIC):
        raise IOError("the elevation service did not send a picture")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "wb") as fh:
        fh.write(body)
    os.replace(tmp, path)          # a half-written tile is never served
    return body


def decode(r, g, b):
    """Metres above (or, negative, below) sea level for one pixel."""
    return (r * 256 + g + b / 256) - 32768


if __name__ == "__main__":
    z, x, y = (int(v) for v in sys.argv[1:4])
    out = tile(z, x, y, os.path.expanduser("~/wxdata/terrain"))
    print(f"{len(out)} bytes")
