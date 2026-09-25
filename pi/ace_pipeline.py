#!/usr/bin/env python3
"""
Accumulated Cyclone Energy (ACE), every basin, on the parsing server.

ACE is the season's hurricane activity in one number: for every tropical or
subtropical cyclone, add up the square of its maximum sustained wind (knots)
at each six hourly fix (00, 06, 12 and 18 UTC) while it is at least 34 kt,
and divide by 10,000. A long lived major hurricane piles it up; a string of
brief weak storms barely registers, which is why it tells a season's story
better than a count of names.

This follows the method Triple-A Tropics uses (and CSU): tropical and
subtropical stages both count; the US agencies' one minute wind is used where
there is one, and a ten minute wind from another agency is turned into a one
minute wind by dividing by 0.88. It is written from the public definitions,
not copied, and reads only NOAA's own data:

  IBTrACS (NCEI) since 1980      the normal: 1991 to 2020, and every season
                                 since 1980 for the rank. Rebuilt weekly.
  IBTrACS last three years       the current and last season, all basins.
  IBTrACS ACTIVE                 the storms up right now, provisional.
  NHC best tracks (b-decks)      the Atlantic and eastern/central Pacific,
                                 six hourly, fresher than IBTrACS.

Regions: the seven IBTrACS basins (North Atlantic, East Pacific, West Pacific,
North Indian, South Indian, South Pacific, South Atlantic), each hemisphere,
and the globe. A northern season is the calendar year; a southern one runs
July to June. Every region gets its cumulative ACE by day, the 1991-2020
normal (mean and the 10th to 90th percentile band), last season, its rank
among seasons since 1980 at the same point, and every storm's own ACE.

    python3 pi/ace_pipeline.py             # current season (and the normal if a week old)
    python3 pi/ace_pipeline.py --climo     # rebuild the normal now as well

Output: ~/wxdata/ace/ace.json, served by serve.py like everything else.
"""

import csv
import io
import json
import os
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone

import requests

OUT_DIR = os.path.expanduser("~/wxdata/ace")
IBTRACS = ("https://www.ncei.noaa.gov/data/international-best-track-archive-"
           "for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.{}.list.v04r01.csv")
NHC_BTK = "https://ftp.nhc.noaa.gov/atcf/btk/"
CLIMO_MAX_AGE_S = 7 * 86400
CLIMO_YEARS = (1991, 2020)
FIRST_YEAR = 1980
DAYS = 366

BASINS = {
    "NA": {"name": "North Atlantic", "hemi": "N", "at": [26, -52]},
    "EP": {"name": "East Pacific", "hemi": "N", "at": [14, -118]},
    "WP": {"name": "West Pacific", "hemi": "N", "at": [18, 142]},
    "NI": {"name": "North Indian", "hemi": "N", "at": [14, 78]},
    "SI": {"name": "South Indian", "hemi": "S", "at": [-16, 72]},
    "SP": {"name": "South Pacific", "hemi": "S", "at": [-17, 172]},
    "SA": {"name": "South Atlantic", "hemi": "S", "at": [-24, -32]},
}
GROUPS = {
    "NH": {"name": "Northern Hemisphere", "basins": ["NA", "EP", "WP", "NI"], "hemi": "N"},
    "SH": {"name": "Southern Hemisphere", "basins": ["SI", "SP", "SA"], "hemi": "S"},
    # The globe is counted by calendar year, whatever hemisphere a storm is in.
    "GL": {"name": "Global", "basins": list(BASINS), "hemi": "N"},
}

# The agencies whose wind in the WMO column is already a one minute wind.
ONE_MINUTE_AGENCIES = {"hurdat_atl", "hurdat_epa", "cphc", "atcf"}
TEN_TO_ONE = 1 / 0.88
COUNTING_NATURES = {"TS", "SS"}
# ATCF development level -> the IBTrACS nature it counts as.
STATUS_NATURE = {"TD": "TS", "TS": "TS", "TY": "TS", "HU": "TS", "ST": "TS",
                 "STY": "TS", "TC": "TS", "SD": "SS", "SS": "SS"}


def log(msg):
    print(f"{datetime.now(timezone.utc):%H:%M:%S} {msg}", flush=True)


def write_json(path, obj):
    """Whole file or nothing: written beside the target, then renamed over it."""
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    os.replace(tmp, path)


# -- The arithmetic ------------------------------------------------------------

def ace_of(kt):
    return kt * kt / 10000.0


def counts(t, kt, nature):
    """Is this fix one ACE adds up: a synoptic hour, 34 kt or more, and a
    tropical or subtropical cyclone at the time."""
    return (t.minute == 0 and t.hour % 6 == 0 and kt is not None and kt >= 34
            and nature in COUNTING_NATURES)


def season_of(hemi, t):
    """(season label, day index in that season) for a moment. A northern
    season is the calendar year; a southern one starts on 1 July."""
    if hemi == "N":
        return str(t.year), (t.date() - date(t.year, 1, 1)).days
    y = t.year if t.month >= 7 else t.year - 1
    return f"{y}-{(y + 1) % 100:02d}", (t.date() - date(y, 7, 1)).days


def current_season(hemi, now):
    return season_of(hemi, now)


def _num(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v if v == v else None


def wind_of(row):
    """The one minute wind in knots: the US agencies' where there is one, the
    WMO agency's otherwise (divided by 0.88 when that is a ten minute wind)."""
    v = _num(row.get("USA_WIND"))
    if v is not None:
        return v
    v = _num(row.get("WMO_WIND"))
    if v is None:
        return None
    agency = (row.get("WMO_AGENCY") or "").strip().lower()
    return v if agency in ONE_MINUTE_AGENCIES else v * TEN_TO_ONE


def nature_of(row):
    """What the storm was at this fix. The real time (provisional) rows of
    the current season carry no NATURE ("NR", not reported), which would
    leave the whole live season out; for those the US agency's own status
    says it (TS, TY, HU... tropical; SD, SS subtropical; EX, LO... neither),
    and a provisional fix with no status at all is a tracked cyclone."""
    nat = (row.get("NATURE") or "").strip()
    if nat in COUNTING_NATURES or nat in ("ET", "DS"):
        return nat
    status = (row.get("USA_STATUS") or "").strip().upper()
    if status:
        return STATUS_NATURE.get(status, "DS")
    return "TS" if "PROVISIONAL" in (row.get("TRACK_TYPE") or "").upper() else nat


def ibtracs_fixes(path):
    """Every fix in an IBTrACS CSV, as plain tuples. Spur tracks (the
    alternative positions some agencies keep) are left out: they are the same
    storm again."""
    with open(path, newline="", encoding="utf-8", errors="replace") as fh:
        rd = csv.DictReader(fh)
        for row in rd:
            if row.get("SID", "").strip() in ("", " "):
                continue
            if not row.get("ISO_TIME") or row["ISO_TIME"].startswith(" "):
                continue            # the units row under the header
            if (row.get("TRACK_TYPE") or "").lower().startswith("spur"):
                continue
            basin = (row.get("BASIN") or "").strip()
            if basin not in BASINS:
                continue
            try:
                t = datetime.strptime(row["ISO_TIME"], "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            atcf = (row.get("USA_ATCF_ID") or "").strip().upper()
            if len(atcf) >= 4 and atcf[2:4].isdigit() and 90 <= int(atcf[2:4]) <= 99:
                continue            # an invest, never a cyclone's ACE
            yield {
                "sid": row["SID"].strip(),
                "basin": basin,
                "t": t,
                "kt": wind_of(row),
                "nature": nature_of(row),
                "name": (row.get("NAME") or "").strip(),
                "lat": _num(row.get("LAT")),
                "lon": _num(row.get("LON")),
                "atcf": atcf,
            }


def parse_bdeck(text):
    """An NHC best track file: one six hourly (and odd special) fix per time,
    each written several times over for the wind radii."""
    out, seen = [], set()
    for line in text.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 11 or f[4] != "BEST":
            continue
        try:
            t = datetime.strptime(f[2], "%Y%m%d%H")
            cy = int(f[1])
        except ValueError:
            continue
        if 90 <= cy <= 99 or t in seen:
            continue            # an invest, or a repeat line for the radii
        seen.add(t)
        lat = _num(f[6][:-1]); lon = _num(f[7][:-1])
        if lat is not None:
            lat = lat / 10 * (-1 if f[6].endswith("S") else 1)
        if lon is not None:
            lon = lon / 10 * (-1 if f[7].endswith("W") else 1)
        name = f[27] if len(f) > 27 else ""
        out.append({"t": t, "kt": _num(f[8]), "nature": STATUS_NATURE.get(f[10], f[10]),
                    "lat": lat, "lon": lon, "name": name})
    return out


# -- Downloads -------------------------------------------------------------------

def _session():
    s = requests.Session()
    s.headers["User-Agent"] = "GWCFC parsing server (ACE)"
    return s


def download(session, url, dest, timeout=600):
    with session.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with open(dest, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
    return dest


def nhc_bdecks(session, year):
    """This year's NHC best tracks: {ATCF id: fixes}."""
    try:
        idx = session.get(NHC_BTK, timeout=60).text
    except requests.RequestException as e:
        log(f"NHC b-deck listing failed: {e}")
        return {}
    import re
    names = sorted(set(re.findall(rf"b(?:al|ep|cp)\d\d{year}\.dat", idx)))
    out = {}
    for nm in names:
        cy = int(nm[3:5])
        if 90 <= cy <= 99:
            continue
        try:
            text = session.get(NHC_BTK + nm, timeout=60).text
        except requests.RequestException:
            continue
        fixes = parse_bdeck(text)
        if fixes:
            out[nm[1:3].upper() + nm[3:5] + str(year)] = fixes
    return out


# -- The normal and the record ---------------------------------------------------

def _region_of_basin(basin):
    return [basin] + [g for g, spec in GROUPS.items() if basin in spec["basins"]]


def _hemi(region):
    return (BASINS.get(region) or GROUPS[region])["hemi"]


def daily_increments(fixes):
    """{region: {season: [ACE added on each day]}} for a stream of fixes."""
    inc = {}
    for fx in fixes:
        if not counts(fx["t"], fx["kt"], fx["nature"]):
            continue
        a = ace_of(fx["kt"])
        for region in _region_of_basin(fx["basin"]):
            label, day = season_of(_hemi(region), fx["t"])
            if not 0 <= day < DAYS:
                continue
            arr = inc.setdefault(region, {}).setdefault(label, [0.0] * DAYS)
            arr[day] += a
    return inc


def cumulative(arr):
    out, s = [], 0.0
    for v in arr:
        s += v
        out.append(s)
    return out


def season_year(label):
    return int(label[:4])


def build_climo(path):
    """From IBTrACS since 1980: every season's cumulative curve per region,
    and the 1991-2020 mean with its 10th and 90th percentiles."""
    log("building the normal from IBTrACS since 1980")
    inc = daily_increments(ibtracs_fixes(path))
    this_year = datetime.now(timezone.utc).year
    climo = {"built": datetime.now(timezone.utc).isoformat(timespec="seconds"), "regions": {}}
    for region in list(BASINS) + list(GROUPS):
        seasons = inc.get(region, {})
        hemi = _hemi(region)
        # Every season in range, including the quiet ones with no ACE at all.
        labels = []
        for y in range(FIRST_YEAR, this_year):
            labels.append(str(y) if hemi == "N" else f"{y}-{(y + 1) % 100:02d}")
        curves = {lb: [round(v, 2) for v in cumulative(seasons.get(lb, [0.0] * DAYS))]
                  for lb in labels}
        normal = [curves[lb] for lb in labels
                  if CLIMO_YEARS[0] <= season_year(lb) <= CLIMO_YEARS[1]]
        mean, p10, p90 = [], [], []
        for d in range(DAYS):
            col = sorted(c[d] for c in normal)
            n = len(col)
            mean.append(round(sum(col) / n, 2) if n else 0)
            p10.append(col[int(0.1 * (n - 1))] if n else 0)
            p90.append(col[int(0.9 * (n - 1))] if n else 0)
        climo["regions"][region] = {"curves": curves, "mean": mean, "p10": p10, "p90": p90}
    return climo


# -- This season -------------------------------------------------------------------

def storms_from(fixes_by_storm, now):
    """Per storm: its ACE, peak, where it is now, whether it is still going."""
    out = []
    for sid, fx in fixes_by_storm.items():
        fx = sorted(fx, key=lambda f: f["t"])
        ace = sum(ace_of(f["kt"]) for f in fx if counts(f["t"], f["kt"], f["nature"]))
        winds = [f["kt"] for f in fx if f["kt"] is not None]
        last = fx[-1]
        name = next((f["name"] for f in reversed(fx)
                     if f.get("name") and f["name"].upper() not in ("NOT_NAMED", "UNNAMED", "INVEST")), "")
        out.append({
            "id": sid, "name": name.title() if name else sid,
            "basin": last["basin"], "ace": round(ace, 3),
            "peak": round(max(winds)) if winds else None,
            "lat": last["lat"], "lon": last["lon"],
            "last": last["t"].strftime("%Y-%m-%dT%H:%MZ"),
            # Still being tracked: a fix in the last eighteen hours.
            "active": (now - last["t"]) < timedelta(hours=18),
            "first": fx[0]["t"].strftime("%Y-%m-%dT%H:%MZ"),
        })
    return out


def season_fixes(paths, bdecks):
    """This season's and last season's fixes, IBTrACS for everything, with
    each NHC storm's own best track taking the place of its IBTrACS copy (it
    is hours fresher). Keyed by storm."""
    by_storm = {}
    for p in paths:
        for fx in ibtracs_fixes(p):
            by_storm.setdefault(fx["sid"], {})[fx["t"]] = fx
    # The NHC storms: drop the IBTrACS copy of any storm with a b-deck.
    atcf_to_sid = {}
    for sid, fxs in by_storm.items():
        for fx in fxs.values():
            if fx["atcf"]:
                atcf_to_sid[fx["atcf"]] = sid
                break
    for atcf, fixes in bdecks.items():
        basin = "NA" if atcf.startswith("AL") else "EP"
        sid = atcf_to_sid.get(atcf, "ATCF:" + atcf)
        by_storm[sid] = {f["t"]: dict(f, basin=basin, sid=sid, atcf=atcf) for f in fixes}
    return {sid: list(fxs.values()) for sid, fxs in by_storm.items()}


def rank_to_date(curves, day, value):
    """1 = the most active season since 1980 at this point in the season."""
    vals = sorted((c[min(day, DAYS - 1)] for c in curves.values()), reverse=True)
    return 1 + sum(1 for v in vals if v > value + 1e-9), len(vals) + 1


def build(climo, fixes_by_storm, now):
    all_fixes = [f for fx in fixes_by_storm.values() for f in fx]
    inc = daily_increments(all_fixes)
    storms = storms_from(fixes_by_storm, now)
    regions = {}
    for region in list(BASINS) + list(GROUPS):
        hemi = _hemi(region)
        label, today = current_season(hemi, now)
        prior_label, _ = season_of(hemi, now - timedelta(days=365))
        cur = cumulative(inc.get(region, {}).get(label, [0.0] * DAYS))
        prior = cumulative(inc.get(region, {}).get(prior_label, [0.0] * DAYS))
        cl = climo["regions"].get(region, {})
        mean = cl.get("mean") or [0] * DAYS
        ytd = cur[today]
        normal_ytd = mean[today]
        # A rank among seasons that had nothing either says nothing.
        rank, of = (rank_to_date(cl["curves"], today, ytd)
                    if cl.get("curves") and ytd > 0 else (None, None))
        members = GROUPS[region]["basins"] if region in GROUPS else [region]
        own = [s for s in storms if s["basin"] in members
               and season_of(hemi, datetime.strptime(s["first"], "%Y-%m-%dT%H:%MZ"))[0] == label
               and s["ace"] > 0]
        own.sort(key=lambda s: -s["ace"])
        regions[region] = {
            "name": (BASINS.get(region) or GROUPS[region])["name"],
            "at": BASINS[region]["at"] if region in BASINS else None,
            "season": label, "day": today,
            "ace": round(ytd, 2),
            "normal_to_date": round(normal_ytd, 2),
            "normal_season": round(mean[-1], 2),
            "pct_of_normal": round(100 * ytd / normal_ytd) if normal_ytd > 0.05 else None,
            "rank": rank, "of": of,
            "curve": [round(v, 2) for v in cur[:today + 1]],
            "normal": mean, "p10": cl.get("p10") or [], "p90": cl.get("p90") or [],
            "prior": {"season": prior_label, "curve": [round(v, 2) for v in prior],
                      "total": round(prior[-1], 2)},
            "storms": own[:40] if region in BASINS else [],
            "active": sum(1 for s in own if s["active"]),
        }
    latest = max((f["t"] for f in all_fixes), default=None)
    return {
        "generated": now.strftime("%Y-%m-%dT%H:%MZ"),
        "latest_fix": latest.strftime("%Y-%m-%dT%H:%MZ") if latest else None,
        "normal_years": list(CLIMO_YEARS),
        "method": ("Sum of (max wind kt)^2 / 10,000 at 00/06/12/18 UTC while at least 34 kt, "
                   "tropical and subtropical; one minute winds (ten minute winds / 0.88)."),
        "sources": ["NOAA NCEI IBTrACS v04r01", "NOAA NHC best tracks"],
        "regions": regions,
    }


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    os.makedirs(OUT_DIR, exist_ok=True)
    session = _session()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    climo_path = os.path.join(OUT_DIR, "climo.json")
    climo = None
    if "--climo" not in argv and os.path.exists(climo_path) \
            and time.time() - os.path.getmtime(climo_path) < CLIMO_MAX_AGE_S:
        with open(climo_path) as fh:
            climo = json.load(fh)
    with tempfile.TemporaryDirectory(dir=OUT_DIR) as tmp:
        if climo is None:
            p = download(session, IBTRACS.format("since1980"), os.path.join(tmp, "since1980.csv"))
            climo = build_climo(p)
            os.remove(p)
            write_json(climo_path, climo)
            log("normal written")
        paths = []
        for which in ("last3years", "ACTIVE"):
            try:
                paths.append(download(session, IBTRACS.format(which), os.path.join(tmp, which + ".csv")))
            except requests.RequestException as e:
                log(f"IBTrACS {which} failed: {e}")
        bdecks = nhc_bdecks(session, now.year)
        log(f"{len(bdecks)} NHC best tracks")
        out = build(climo, season_fixes(paths, bdecks), now)
    write_json(os.path.join(OUT_DIR, "ace.json"), out)
    for k, r in out["regions"].items():
        log(f"{k:3} {r['season']:8} ACE {r['ace']:7.1f}  normal {r['normal_to_date']:7.1f}"
            f"  rank {r['rank']}/{r['of']}  active {r['active']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
