#!/usr/bin/env node
/*
 * The basemap's second wind, and the end of the three second tap.
 *
 *     node tools/test-map-health.mjs
 *
 * Two fixes held in place. One: when MapTiler stops answering (a spent key
 * quota looks exactly like an outage), every style swaps to a keyless
 * stand-in instead of leaving a black map. Two: the city-label filler used
 * to read ninety labels' worth of layer values in ONE main-thread task,
 * which is the measured 3.1 second INP and the frozen tiles that came with
 * it; it must now run in slices that hand the thread back between bites.
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

console.log('\n1. the shape of both fixes');
{
  ok('every style has a keyless stand-in',
     /basemaps\.cartocdn\.com\/dark_all/.test(PAGE)
     && /basemaps\.cartocdn\.com\/light_all/.test(PAGE)
     && /World_Imagery\/MapServer\/tile/.test(PAGE)
     && /World_Topo_Map\/MapServer\/tile/.test(PAGE));
  ok('exhausted retries change horses instead of retrying a dead key',
     /_mtRetries >= 3 && _mtErrors >= 10\) \{ window\._mtFallBack\(\); return; \}/.test(PAGE));
  ok('the 20s watchdog heals instead of only apologising',
     /typeof window\._mtFallBack === 'function'\) \{ window\._mtFallBack\(\); return; \}/.test(PAGE));
  ok('the label filler is sliced with a real frame budget',
     /const until = performance\.now\(\) \+ 8;/.test(PAGE)
     && /_mbCityFillGen/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-map-health.mjs'), 'utf8').includes(EM));
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

console.log('\n2. the basemap fallback really swaps the layers');
{
  const r = await p.evaluate(() => {
    const out = {};
    const before = mapTileLayers.satellite;
    out.wasOn = map.hasLayer(before);
    window._mtFallBack();
    out.satUrl = mapTileLayers.satellite._url || '';
    out.darkUrl = mapTileLayers.dark._url || '';
    out.oldGone = !map.hasLayer(before);
    out.newOn = map.hasLayer(mapTileLayers.satellite);
    const again = mapTileLayers.satellite;
    window._mtFallBack();            // must be idempotent
    out.stable = mapTileLayers.satellite === again;
    return out;
  });
  ok('the active style swaps in place',
     r.wasOn && r.oldGone && r.newOn, JSON.stringify(r));
  ok('imagery falls to Esri, streets to CARTO',
     /arcgisonline\.com/.test(r.satUrl) && /cartocdn\.com/.test(r.darkUrl),
     r.satUrl);
  ok('a second failure does not churn the layers again', r.stable);
}

console.log('\n3. ninety heavy labels can no longer own the main thread');
{
  const r = await p.evaluate(async () => {
    const out = {};
    // Sixty labels whose value read burns 4ms each: 240ms of real work.
    // Under the old one-task fill that was one 240ms block; the slicer must
    // spread it across many tasks with the thread handed back in between.
    const host = document.getElementById('map');
    for (let i = 0; i < 60; i++) {
      const s = document.createElement('span');
      s.className = 'mb-city';
      s.dataset.lat = String(30 + i * 0.1);
      s.dataset.lng = String(-95 + i * 0.1);
      s.innerHTML = 'X<span class="mb-city-data"></span>';
      host.appendChild(s);
    }
    const stamps = [];
    window._mbCityValues = () => {
      const t0 = performance.now();
      stamps.push(t0);
      while (performance.now() - t0 < 4) { /* burn */ }
      return 'v';
    };
    _mbOn.cities = true;
    _mbCityLayer = _mbCityLayer || {};
    _mbCityFillValues();
    await new Promise(res => setTimeout(res, 2500));
    out.calls = stamps.length;
    // Group the calls into contiguous bursts: a gap over 6ms means the
    // thread was handed back between them.
    let bursts = 1, longest = 1, run = 1;
    for (let i = 1; i < stamps.length; i++) {
      if (stamps[i] - stamps[i - 1] > 6) { bursts++; run = 1; }
      else { run++; longest = Math.max(longest, run); }
    }
    out.bursts = bursts;
    out.longest = longest;
    out.filled = [...document.querySelectorAll('#map .mb-city .mb-city-data')]
      .filter(el => el.innerHTML === 'v').length;
    [...document.querySelectorAll('#map > .mb-city')].forEach(el => el.remove());
    return out;
  });
  ok('every label still gets its value', r.filled === 60 && r.calls >= 60,
     `${r.filled} filled, ${r.calls} calls`);
  ok('the work was spread across many tasks, not one',
     r.bursts >= 8, String(r.bursts));
  ok('no single burst hogged the thread',
     r.longest <= 4, String(r.longest));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
