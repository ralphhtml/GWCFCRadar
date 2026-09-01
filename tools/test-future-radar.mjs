#!/usr/bin/env node
/*
 * Future radar: the MRMS loop continues into HRRR.
 *
 *     node tools/test-future-radar.mjs
 *
 * The contract: when the 1 km MRMS composite loads, the animation bar's
 * timeline no longer ends at the newest scan. HRRR simulated reflectivity
 * frames (15-minute steps, three hours ahead) are appended to the same
 * pool, the bar lands on "now" rather than the far future, and any frame
 * past "now" is labeled FUTURE in gold.
 *
 * The planner is pure and gets held down hard offline; the pool builder is
 * exercised with synthetic frames so the WMS layer choice (MRMS vs IEM
 * HRRR) is proven without the network.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the source keeps the shape of the feature');
{
  ok('the future frames ride the same pool as the scans',
     /_refSiteFrames = _refSiteFrames\.concat\(_futRadarFrames/.test(PAGE));
  ok('and the bar lands on the newest real scan, not the far future',
     /_showSingleSiteRefFrame\(Math\.max\(0, lastPast\)\)/.test(PAGE));
  ok('future layers come from the IEM HRRR WMS the Severe panel uses',
     /frame\.future\s*\?\s*L\.tileLayer\.wms\(IEM_HRRR_REFD_WMS/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-future-radar.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'),
             { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);

console.log('\n2. the planner is right about time');
{
  const r = await p.evaluate(() => {
    const out = {};
    // A run from 14:00Z with "now" at 16:07Z: the first future frame is the
    // first 15-minute step at or past now (2h07m = 127 min into the run, so
    // minute 135), and the last is within 3h of now.
    const run = Date.UTC(2026, 7, 31, 14, 0, 0);
    const now = Date.UTC(2026, 7, 31, 16, 7, 0);
    out.plan = _futRadarPlan(run, now);
    // Deep into a run's reach, the plan must stop at HRRR's 1080 minutes.
    out.clamped = _futRadarPlan(now - 1000 * 60000, now);
    // The frames carry real valid times and the future flag.
    const frames = _futRadarFrames(now);
    out.allFuture = frames.every(f => f.future === true);
    out.firstAheadMin = (frames[0].time * 1000 - now) / 60000;
    out.count = frames.length;
    out.runIsTopOfHour = frames[0].iso.endsWith(':00:00Z');
    return out;
  });
  ok('the first frame is the first step at or past now',
     r.plan[0] === 135, String(r.plan[0]));
  ok('steps are 15 minutes apart',
     r.plan[1] === 150 && r.plan[2] === 165, JSON.stringify(r.plan.slice(0, 3)));
  ok('the span reaches about three hours ahead',
     r.plan[r.plan.length - 1] >= 127 + 165
     && r.plan[r.plan.length - 1] <= 127 + 180,
     String(r.plan[r.plan.length - 1]));
  ok('a stale run is clamped to HRRR\'s 1080-minute reach',
     r.clamped.every(m => m <= 1080), String(r.clamped[r.clamped.length - 1]));
  ok('every planned frame is marked future', r.allFuture);
  ok('the first future frame sits within one step of now',
     r.firstAheadMin >= 0 && r.firstAheadMin <= 15, String(r.firstAheadMin));
  ok('a dozen frames cover the three hours', r.count >= 11 && r.count <= 14,
     String(r.count));
  ok('the assumed run is a top-of-hour init time', r.runIsTopOfHour);
}

console.log('\n3. the pool mixes scans and forecasts, and the bar says which is which');
{
  const r = await p.evaluate(() => {
    const out = {};
    // Synthetic frames: two past scans and the real future plan, exactly
    // what _loadMrmsComposite assembles, minus its network fetch.
    const nowS = Date.now() / 1000;
    _mrmsActive = true; _refStation = null;
    _refSiteFrames = [
      { iso: new Date((nowS - 600) * 1000).toISOString(), time: nowS - 600, date: new Date() },
      { iso: new Date((nowS - 300) * 1000).toISOString(), time: nowS - 300, date: new Date() },
    ].concat(_futRadarFrames(Date.now()));
    _buildMrmsPool();
    out.poolSize = _refSitePool.length;
    out.frameCount = _refSiteFrames.length;
    const params = _refSitePool.map(l => (l.wmsParams || {}).layers);
    out.pastLayers = params.slice(0, 2);
    out.futureLayers = params.slice(2, 4);
    out.futureUrl = _refSitePool[2]._url || '';

    // The label: a past frame reads as a time, a future frame says FUTURE
    // in gold, and going back to the past clears the gold.
    const at = document.getElementById('anim-time');
    _showSingleSiteRefFrame(2);
    out.futLabel = at ? at.textContent : '';
    out.futColor = at ? at.style.color : '';
    _showSingleSiteRefFrame(1);
    out.pastLabel = at ? at.textContent : '';
    out.pastColor = at ? at.style.color : '';
    // Clean up so nothing keeps polling dead layers.
    _clearSingleSiteRef();
    return out;
  });
  ok('every frame got a layer in the pool', r.poolSize === r.frameCount,
     `${r.poolSize} vs ${r.frameCount}`);
  ok('past frames draw from the MRMS mosaic',
     r.pastLayers.every(l => l === 'conus_bref_qcd'), JSON.stringify(r.pastLayers));
  ok('future frames draw from HRRR refd_MMMM layers',
     r.futureLayers.every(l => /^refd_\d{4}$/.test(l || '')),
     JSON.stringify(r.futureLayers));
  ok('served by the IEM HRRR WMS', /hrrr\/refd\.cgi/.test(r.futureUrl),
     r.futureUrl);
  ok('a future frame is labeled FUTURE, with the model named',
     /^FUTURE \+\d+ MIN · \d\d:\d\d UTC · HRRR$/.test(r.futLabel), r.futLabel);
  ok('in gold', r.futColor === 'rgb(232, 184, 0)', r.futColor);
  ok('a past frame stays a plain time', /UTC/.test(r.pastLabel)
     && !/FUTURE/.test(r.pastLabel), r.pastLabel);
  ok('with the gold gone', r.pastColor === '', r.pastColor);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
