#!/usr/bin/env node
/*
 * The CT 112 bug report, pinned down as tests.
 *
 *     node tools/test-ct112-fixes.mjs
 *
 * Covers: the GRIB decode fixes (polar stereographic coordinates computed
 * without eccodes' refusing Geoiterator, want-check before grid keys,
 * tolerant level/Ni reads, once-per-grid failure logging), serve.py's 404
 * lines naming the request and client hangups not printing tracebacks,
 * the runtime-pip guard on sounding builds, selfupdate's recovery no
 * longer blocked by untracked files, and the bot's clean SIGTERM exit
 * plus the idle screenshot-browser reaper.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GFS = readFileSync(join(ROOT, 'pi/gfs_pipeline.py'), 'utf8');
const SERVE = readFileSync(join(ROOT, 'pi/serve.py'), 'utf8');
const SND = readFileSync(join(ROOT, 'pi/sounding_service.py'), 'utf8');
const UPD = readFileSync(join(ROOT, 'pi/selfupdate.sh'), 'utf8');
const BOT = readFileSync(join(ROOT, 'services/bot/asturio-bot.mjs'), 'utf8');
const INST = readFileSync(join(ROOT, 'pi/install.sh'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the polar stereographic maths really is the grid');
{
  // The pure function, lifted out of the pipeline and run against a grid
  // shaped like NAM Alaska (NCEP 242): 11.25 km cells true at 60N. If the
  // maths is right, the first point comes back exactly where the GRIB said
  // it is, and neighbouring points near 60N sit 11.25 km apart.
  const py = `
import json, re
import numpy as np
src = open(${JSON.stringify(join(ROOT, 'pi/gfs_pipeline.py'))}).read()
fn = src[src.index('def _polar_stereo_latlon'):src.index('def _polar_stereo_coords')]
ns = {'np': np}
exec(fn, ns)
lat, lon = ns['_polar_stereo_latlon'](30.0, 187.0, 225.0, 60.0,
                                      11250.0, 11250.0, 553, 425,
                                      False, 6371200.0)
out = {}
out['n'] = int(lat.size)
out['first'] = [float(lat[0]), float(lon[0])]
out['finite'] = bool(np.isfinite(lat).all() and np.isfinite(lon).all())
out['bounded'] = bool((np.abs(lat) <= 90.0001).all() and (np.abs(lon) <= 180.0001).all())
# A neighbour pair as close to 60N as the whole grid gets, measured with
# the haversine: the projection promises 11.25 km ground distance there.
# And at the southern edge, the analytic scale factor of the projection
# says exactly how much smaller the ground step must be; both must hold.
R = 6371200.0
def ground_km(i):
    p1 = np.radians([lat[i], lon[i]]); p2 = np.radians([lat[i+1], lon[i+1]])
    dphi, dlmb = p2[0]-p1[0], p2[1]-p1[1]
    a = np.sin(dphi/2)**2 + np.cos(p1[0])*np.cos(p2[0])*np.sin(dlmb/2)**2
    return float(2*R*np.arcsin(np.sqrt(a)) / 1000.0)
cand = np.abs(lat - 60.0).copy()
cand[552::553] = 1e9                      # no i+1 neighbour at a row's end
i60 = int(np.argmin(cand))
out['near60'] = float(lat[i60])
out['spacing_km'] = ground_km(i60)
iedge = 100                               # southern edge, well inside row 0
k = (1.0 + np.sin(np.radians(60.0))) / (1.0 + np.sin(np.radians(float(lat[iedge]))))
out['edge_km'] = ground_km(iedge)
out['edge_expect_km'] = float(11.25 / k)
# South polar sanity: same shape flipped under the other pole.
lat2, lon2 = ns['_polar_stereo_latlon'](-20.0, 100.0, 100.0, -60.0,
                                        12000.0, 12000.0, 100, 100,
                                        True, 6371200.0)
out['south_first'] = [float(lat2[0]), float(lon2[0])]
out['south_bounded'] = bool((lat2 <= -0.0001).all() if (lat2 < 0).all() else True)
out['south_all_finite'] = bool(np.isfinite(lat2).all())
print(json.dumps(out))
`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  let d = null;
  try { d = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) {}
  ok('the function runs and covers the whole grid', !!d && d.n === 553 * 425,
     (r.stderr || '').slice(0, 200));
  if (d) {
    ok('the first point comes back exactly where the GRIB said it stands',
       Math.abs(d.first[0] - 30.0) < 1e-3 && Math.abs(d.first[1] - (187.0 - 360.0)) < 1e-3,
       JSON.stringify(d.first));
    ok('every point is finite and on the earth', d.finite && d.bounded);
    ok('neighbouring cells near 60N are the promised 11.25 km apart',
       Math.abs(d.near60 - 60) < 1.5 && Math.abs(d.spacing_km - 11.25) < 0.12,
       JSON.stringify({ near: d.near60, km: d.spacing_km }));
    ok('and away from 60N the spacing follows the projection\'s own scale factor',
       Math.abs(d.edge_km - d.edge_expect_km) < d.edge_expect_km * 0.005,
       JSON.stringify({ got: d.edge_km, expect: d.edge_expect_km }));
    ok('a south polar grid works the same way, mirrored',
       Math.abs(d.south_first[0] - (-20.0)) < 1e-3
       && Math.abs(d.south_first[1] - 100.0) < 1e-3 && d.south_all_finite,
       JSON.stringify(d.south_first));
  }
}

console.log('\n2. the decode no longer dies on grids the Geoiterator refuses');
{
  ok('polar stereographic coordinates come from the pipeline itself, not the iterator',
     GFS.includes('def _polar_stereo_latlon(') && GFS.includes('def _polar_stereo_coords(')
     && /if gtype == "polar_stereographic":\s*\n\s*try:\s*\n\s*return _polar_stereo_coords/.test(GFS));
  ok('a message is judged wanted BEFORE any grid key is touched',
     /# Decide whether this message is wanted BEFORE touching any/.test(GFS)
     && GFS.indexOf('want = short in ("10u", "10v")')
        < GFS.indexOf('# Ni/Nj only exist on grids that have rows'));
  ok('a missing level or Ni/Nj is tolerated instead of thrown',
     /try:\s*\n\s*lev = int\(eccodes\.codes_get\(gid, "level"\)\)\s*\n\s*except Exception:\s*\n\s*lev = 0/.test(GFS)
     && /ni = nj = None/.test(GFS));
  ok('a grid with no readable coordinates logs once per file, not per message',
     GFS.includes('coords[sig] = (None, None)')
     && GFS.includes('grid has no readable'));
}

console.log('\n3. serve.py: 404s carry the request, hangups carry no traceback');
{
  ok('log_error names the method and path',
     /def log_error\(self, fmt, \*args\):/.test(SERVE)
     && SERVE.includes("f\"{getattr(self, 'command', None) or '?'} \""));
  ok('a client hanging up mid-reply is swallowed, not a stack trace',
     /class QuietDisconnectServer\(ThreadingHTTPServer\):/.test(SERVE)
     && SERVE.includes('(BrokenPipeError, ConnectionResetError, TimeoutError)')
     && SERVE.includes('srv = QuietDisconnectServer(("127.0.0.1", port), handler)'));
}

console.log('\n4. no pipeline installs packages at runtime');
{
  ok('the sounderpy import path forces pip offline first',
     SND.includes('os.environ.setdefault("PIP_NO_INDEX", "1")')
     && SND.indexOf('PIP_NO_INDEX') < SND.indexOf('import sounderpy as spy'));
  ok('the sounding service unit carries the same guard',
     INST.includes('Environment=PIP_NO_INDEX=1'));
}

console.log('\n5. selfupdate recovery is not blocked by untracked files');
{
  ok('both dirty-tree checks ignore untracked files, which a reset never deletes',
     (UPD.match(/git status --porcelain --untracked-files=no/g) || []).length === 2
     && !/\$\(git status --porcelain 2>\/dev\/null\)/.test(UPD));
}

console.log('\n6. the bot dies politely and does not park Chromium forever');
{
  ok('SIGTERM and SIGINT close the browser and the gateway, then exit 0',
     /process\.on\('SIGTERM', \(\) => \{ shutdown\('SIGTERM'\); \}\);/.test(BOT)
     && /process\.on\('SIGINT', \(\) => \{ shutdown\('SIGINT'\); \}\);/.test(BOT)
     && /if \(_browser\) jobs\.push\(_browser\.close\(\)\.catch\(\(\) => \{\}\)\);/.test(BOT)
     && BOT.includes('process.exit(0)'));
  ok('the warm screenshot browser is reaped after ten idle minutes',
     BOT.includes('BROWSER_IDLE_MS = 10 * 60 * 1000')
     && BOT.includes('_browserLastUse = Date.now();   // for the idle reaper below')
     && BOT.includes('screenshot browser closed after idling'));
  ok('the reaper timer never keeps the process alive on its own',
     /\}, 60 \* 1000\)\.unref\(\);/.test(BOT));
}

const EM = String.fromCharCode(0x2014);
console.log('\n7. no em dashes in anything touched');
{
  ok('none in the touched files or this test',
     ![GFS, SERVE, SND, UPD, BOT, INST,
       readFileSync(join(ROOT, 'tools/test-ct112-fixes.mjs'), 'utf8')]
       .some(s => s.includes(EM)));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
