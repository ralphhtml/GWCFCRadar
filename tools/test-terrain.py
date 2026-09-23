#!/usr/bin/env python3
"""
The parsing server's terrain backup for the 3D views.

    python3 tools/test-terrain.py

Pins which tiles are real, the Terrarium height code, that a tile is
downloaded once and served from disk after that, that something which is not
a picture is never cached, and that serve.py's /terrain door refuses bad
asks before downloading anything. Nothing here touches the network.
"""

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "pi"))

import terrain  # noqa: E402

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


print("\n1. which tiles are real")
ok("the one world tile at zoom 0", terrain.valid(0, 0, 0))
ok("a tile over Kansas at zoom 7", terrain.valid(7, 29, 49))
ok("x past the edge of the grid is not", not terrain.valid(3, 8, 0))
ok("a negative y is not", not terrain.valid(3, 0, -1))
ok("zoom 16 is past the last level", not terrain.valid(16, 0, 0))
ok("a string is not a number", not terrain.valid("3", 0, 0))

print("\n2. the colour code for height")
ok("sea level is 128, 0, 0", terrain.decode(128, 0, 0) == 0)
ok("Everest-ish: 8848 m", abs(terrain.decode(162, 144, 0) - 8848) < 1)
ok("the ocean floor is negative", terrain.decode(113, 0, 0) == -3840)

print("\n3. downloaded once, then served from disk")
cache = tempfile.mkdtemp()
PNG = terrain.PNG_MAGIC + b"fake tile body"
calls = []


def fetch(z, x, y):
    calls.append((z, x, y))
    return PNG


a = terrain.tile(6, 16, 25, cache, fetch=fetch)
b = terrain.tile(6, 16, 25, cache, fetch=fetch)
ok("the bytes come back", a == PNG and b == PNG)
ok("only the first ask downloads", len(calls) == 1, str(calls))
ok("the tile is kept at z/x/y.png", os.path.exists(os.path.join(cache, "6", "16", "25.png")))
ok("no half-written file is left behind", not os.path.exists(os.path.join(cache, "6", "16", "25.png.part")))

print("\n4. something that is not a picture is never cached")
try:
    terrain.tile(6, 17, 25, cache, fetch=lambda z, x, y: b"<html>error page</html>")
    ok("an error page is refused", False)
except IOError:
    ok("an error page is refused", True)
ok("and nothing was saved for it", not os.path.exists(os.path.join(cache, "6", "17", "25.png")))
try:
    terrain.tile(20, 0, 0, cache, fetch=fetch)
    ok("a tile that does not exist is refused", False)
except ValueError:
    ok("a tile that does not exist is refused", True)

print("\n5. the serve.py door refuses bad asks before downloading")
import serve  # noqa: E402


class Fake(serve.CORSHandler):
    def __init__(self, path):  # noqa: D107 - deliberately skips the socket setup
        self.path = path
        self.directory = tempfile.mkdtemp()
        self.replies = []

    def _reply_json(self, code, obj):
        self.replies.append((code, obj))

    def _reply_bytes(self, code, body, ctype):
        self.replies.append((code, ctype))


real_tile = terrain.tile
terrain.tile = lambda *a, **k: (_ for _ in ()).throw(AssertionError("downloaded"))
for name, path in (("a path with two parts", "/terrain/3/1"),
                   ("a word for z", "/terrain/z/1/1.png"),
                   ("not a png", "/terrain/3/1/1.jpg"),
                   ("off the edge of the grid", "/terrain/3/9/1.png"),
                   ("a path climbing out", "/terrain/../../etc.png")):
    f = Fake(path)
    serve.CORSHandler._terrain_tile(f, path)
    ok(name + " is a 400", f.replies and f.replies[0][0] == 400, str(f.replies))
terrain.tile = lambda z, x, y, cache: PNG
f = Fake("/terrain/6/16/25.png")
serve.CORSHandler._terrain_tile(f, "/terrain/6/16/25.png")
ok("a good ask answers with the picture", f.replies == [(200, "image/png")], str(f.replies))
terrain.tile = real_tile

print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
