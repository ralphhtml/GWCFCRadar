#!/usr/bin/env python3
"""
The ACE pipeline's arithmetic (pi/ace_pipeline.py).

    python3 tools/test-ace.py

Checked against hand-worked numbers: the formula, which fixes count (the
synoptic hours, 34 kt and up, tropical and subtropical only), the wind
choice (one minute winds, ten minute ones divided by 0.88), the real time
rows' missing NATURE read from the US status, the southern season running
July to June, an NHC best track's repeated radii lines counted once and
invests left out, and a season total being the sum of its storms.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pi"))
import ace_pipeline as A  # noqa: E402

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


print("\n1. the formula")
ok("100 kt for one fix is 1.0 ACE", abs(A.ace_of(100) - 1.0) < 1e-12)
t = datetime(2026, 9, 1, 6, 0)
ok("a 6 hourly fix of a 34 kt tropical storm counts", A.counts(t, 34, "TS"))
ok("33 kt does not", not A.counts(t, 33, "TS"))
ok("an off-hour special fix does not", not A.counts(datetime(2026, 9, 1, 3, 0), 90, "TS"))
ok("a subtropical storm counts", A.counts(t, 45, "SS"))
ok("an extratropical one does not", not A.counts(t, 80, "ET"))

print("\n2. the wind")
ok("the US one minute wind first", A.wind_of({"USA_WIND": "90", "WMO_WIND": "70", "WMO_AGENCY": "tokyo"}) == 90)
ok("a ten minute wind is divided by 0.88",
   abs(A.wind_of({"USA_WIND": " ", "WMO_WIND": "88", "WMO_AGENCY": "tokyo"}) - 100) < 1e-9)
ok("HURDAT's WMO wind is already one minute",
   A.wind_of({"USA_WIND": " ", "WMO_WIND": "88", "WMO_AGENCY": "hurdat_atl"}) == 88)

print("\n3. what the storm was")
ok("a real time row with no NATURE is read from the US status",
   A.nature_of({"NATURE": "NR", "USA_STATUS": "TY", "TRACK_TYPE": "PROVISIONAL"}) == "TS")
ok("and an extratropical status stays out",
   A.nature_of({"NATURE": "NR", "USA_STATUS": "EX", "TRACK_TYPE": "PROVISIONAL"}) == "DS")
ok("a provisional fix with no status at all is a tracked cyclone",
   A.nature_of({"NATURE": "NR", "USA_STATUS": "", "TRACK_TYPE": "PROVISIONAL"}) == "TS")

print("\n4. seasons")
ok("a northern season is the calendar year", A.season_of("N", datetime(2026, 3, 2)) == ("2026", 60))
ok("a southern one starts on 1 July", A.season_of("S", datetime(2026, 7, 1)) == ("2026-27", 0))
ok("and February is still last year's", A.season_of("S", datetime(2026, 2, 1)) == ("2025-26", 215))

print("\n5. an NHC best track")
bdeck = "\n".join([
    "AL, 07, 2026090100,   , BEST,   0, 150N,  450W,  35, 1005, TS,  34, NEQ,   40,   30,    0,   40, 1012,  150,  30,  45,   0,   L,   0,    ,   0,   0,       FAY, M,",
    "AL, 07, 2026090100,   , BEST,   0, 150N,  450W,  35, 1005, TS,  50, NEQ,    0,    0,    0,    0, 1012,  150,  30,  45,   0,   L,   0,    ,   0,   0,       FAY, M,",
    "AL, 07, 2026090106,   , BEST,   0, 155N,  460W,  70,  985, HU,  34, NEQ,   40,   30,    0,   40, 1012,  150,  30,  45,   0,   L,   0,    ,   0,   0,       FAY, M,",
    "AL, 07, 2026090112,   , BEST,   0, 160N,  470W,  60,  990, EX,  34, NEQ,   40,   30,    0,   40, 1012,  150,  30,  45,   0,   L,   0,    ,   0,   0,       FAY, M,",
])
fx = A.parse_bdeck(bdeck)
ok("one fix per time, the radii repeats dropped", len(fx) == 3, len(fx))
ok("position and name read", fx[1]["lat"] == 15.5 and fx[1]["lon"] == -46.0 and fx[0]["name"] == "FAY", fx[1])
ace = sum(A.ace_of(f["kt"]) for f in fx if A.counts(f["t"], f["kt"], f["nature"]))
ok("ACE counts the TS and HU fixes, not the extratropical one", abs(ace - (35 ** 2 + 70 ** 2) / 1e4) < 1e-12, ace)
inv = "AL, 93, 2026090100,   , BEST,   0, 150N,  450W,  35, 1005, TS,  34, NEQ,   40,   30,    0,   40,"
ok("an invest never counts", A.parse_bdeck(inv) == [])

print("\n6. a season is the sum of its storms")
fixes = {
    "S1": [dict(basin="NA", t=datetime(2026, 9, 1, h), kt=100, nature="TS", name="ONE", lat=20, lon=-60, atcf="AL01") for h in (0, 6, 12)],
    "S2": [dict(basin="NA", t=datetime(2026, 9, 2, 0), kt=50, nature="TS", name="TWO", lat=20, lon=-60, atcf="AL02")],
}
climo = {"regions": {}}
out = A.build(climo, fixes, datetime(2026, 9, 3))
na = out["regions"]["NA"]
ok("season 3.25 = 3 x 1.0 + 0.25", abs(na["ace"] - 3.25) < 1e-9, na["ace"])
ok("and its storms say the same", abs(sum(s["ace"] for s in na["storms"]) - na["ace"]) < 1e-9)
ok("the hemisphere and the globe include it", out["regions"]["NH"]["ace"] == 3.25 and out["regions"]["GL"]["ace"] == 3.25)
ok("the curve steps on the right days", na["curve"][243] == 3.0 and na["curve"][244] == 3.25, na["curve"][242:246])

EM = chr(0x2014)
ok("no em dashes in the pipeline or this test",
   EM not in open(A.__file__).read() and EM not in open(__file__).read())
print(f"\n{failed} FAILED, {passed} passed" if failed else f"\nall {passed} passed")
sys.exit(1 if failed else 0)
