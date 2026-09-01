#!/usr/bin/env node
/*
 * The world gazetteer on the map: half a million towns, a screenful at a
 * time, with the hand-typed list as the net under it.
 *
 *     node tools/test-world-cities.mjs
 *
 * The Pi's tiles are served from this file's route table, so the whole
 * loader runs offline: tile keys, the per-screen cap with biggest places
 * first, dots for gazetteer towns, and the fallback to the built-in
 * CITIES list the moment the Pi has nothing to say.
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

console.log('\n1. the shape of the thing');
{
  ok('the page loads 5-degree tiles from the Pi',
     /const CITY_TILE_DEG = 5;/.test(PAGE)
     && /\/cities\/t_\$\{key\}\.json/.test(PAGE));
  ok('a fixed cap per screen, biggest places first',
     /const CITY_SCREEN_CAP = \d+;/.test(PAGE)
     && /rows\.sort\(\(a, b\) => \(b\[3\] - a\[3\]\) \|\| \(a\[4\] - b\[4\]\)\);/.test(PAGE));
  ok('the built-in list is the fallback, not deleted',
     /list = CITIES\.filter\(city => bounds\.contains/.test(PAGE)
     && /const CITIES = \[/.test(PAGE));
  ok('the pipeline exists and installs weekly',
     readFileSync(join(ROOT, 'pi/cities_pipeline.py'), 'utf8').includes('allCountries.zip')
     && readFileSync(join(ROOT, 'pi/install.sh'), 'utf8').includes('gwcfc-cities.timer'));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-world-cities.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

// A dense fake tile: more places than the cap, so the cap has to choose.
const CAP = parseInt(PAGE.match(/const CITY_SCREEN_CAP = (\d+);/)[1], 10);
const tileRows = [];
for (let i = 0; i < CAP + 60; i++) {
  // Spread across the tile that holds [33.7, -84.4]: lats 30..35, lons -85..-80.
  tileRows.push([`Town ${i}`, 30.2 + (i % 40) * 0.11, -84.9 + Math.floor(i / 40) * 0.6,
                 1000000 - i * 1000, 4]);
}
tileRows.push(['Megalopolis', 33.7, -84.4, 9000000, 0]);
const TILE = JSON.stringify(tileRows);

// The web tier's fixture, in the cities.json shape: lat/lng as STRINGS and
// no population field, which is exactly what the second mirror serves. A
// thousand filler towns far away make it big enough to pass the sanity
// floor, plus Tokyo-area targets and two broken rows that must be skipped.
const webRows = [];
for (let i = 0; i < 1100; i++) {
  webRows.push({ name: `Filler ${i}`, lat: String(-44 - (i % 30) * 0.1),
                 lng: String(160 + Math.floor(i / 30) * 0.1), country: 'NZ' });
}
webRows.push({ name: 'Tokyo', lat: '35.6895', lng: '139.6917', country: 'JP' });
webRows.push({ name: 'Kawasaki', lat: '35.5206', lng: '139.7172', country: 'JP' });
webRows.push({ name: 'Broken Town', lat: 'not-a-lat', lng: '139.0', country: 'JP' });
webRows.push({ lat: '35.0', lng: '139.0', country: 'JP' });
const WEBCITIES = JSON.stringify(webRows);

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
let tileHits = 0;
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('all-the-cities'))
    return route.fulfill({ status: 404, body: 'gone' });   // first mirror down
  if (url.includes('cities.json@1.1.20'))
    return route.fulfill({ contentType: 'application/json', body: WEBCITIES });
  if (url.includes('fakepi.invalid/cities/')) {
    tileHits++;
    // Only the Atlanta-area tile answers; ocean tiles are honest 404s.
    if (url.includes('t_24_19.json'))
      return route.fulfill({ contentType: 'application/json', body: TILE });
    return route.fulfill({ status: 404, body: 'not here' });
  }
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

console.log('\n2. the gazetteer feeds the dots, capped, biggest first');
{
  const r = await p.evaluate(async () => {
    const out = {};
    _hdBase = 'https://fakepi.invalid';
    activeLayers.forecasts = true;
    if (!cityMarkersLayer) cityMarkersLayer = L.layerGroup().addTo(map);
    map.setView([33.2, -83.5], 7, { animate: false });
    await new Promise(res => setTimeout(res, 150));
    await _refreshVisibleCityTemps();
    out.count = 0; out.tips = [];
    cityMarkersLayer.eachLayer(m => {
      out.count++;
      const t = m.getTooltip();
      if (t) out.tips.push(String(t.getContent()));
    });
    out.cap = CITY_SCREEN_CAP;
    out.hasBiggest = out.tips.some(t => t.includes('Megalopolis'));
    // The exact key arithmetic: the tile that holds Atlanta.
    out.key = _cityTileKeysFor(L.latLngBounds([[33.7, -84.4], [33.8, -84.3]]))[0];
    return out;
  });
  ok('the tile that holds the view is the tile that was computed',
     r.key === '24_19', r.key);
  ok('dots appear from the gazetteer, and never more than the cap',
     r.count > 0 && r.count <= r.cap, `${r.count} vs cap ${r.cap}`);
  ok('the biggest place always makes the screen', r.hasBiggest);
  ok('tiles were actually asked of the Pi', tileHits > 0, String(tileHits));
}

console.log('\n3. no Pi yet: the web mirror carries towns right now');
{
  const r = await p.evaluate(async () => {
    const out = {};
    // Tokyo: the fake Pi has no tile there, so the loader must fall
    // through to the web mirror, surviving the dead first mirror and the
    // string lat/lng shape of the second.
    map.setView([35.62, 139.7], 9, { animate: false });
    await new Promise(res => setTimeout(res, 150));
    await _refreshVisibleCityTemps();
    out.tips = [];
    cityMarkersLayer.eachLayer(m => {
      const t = m.getTooltip();
      if (t) out.tips.push(String(t.getContent()));
    });
    out.webReady = _cityWebTiles instanceof Map;
    return out;
  });
  ok('the web list parsed, string coordinates and all', r.webReady);
  ok('Tokyo and Kawasaki appear from the mirror',
     r.tips.some(t => t.includes('Tokyo')) && r.tips.some(t => t.includes('Kawasaki')),
     r.tips.slice(0, 4).join(' | '));
  ok('the broken rows never became dots',
     !r.tips.some(t => t.includes('Broken Town')));
}

console.log('\n4. no Pi, no mirror: the built-in list carries the dots');
{
  const r = await p.evaluate(async () => {
    const out = {};
    // Somewhere the fake Pi has no tile for: the loader must fall back.
    _cityTileCache.clear();
    map.setView([48.85, 2.35], 7, { animate: false });   // Paris
    await new Promise(res => setTimeout(res, 150));
    await _refreshVisibleCityTemps();
    out.tips = [];
    cityMarkersLayer.eachLayer(m => {
      const t = m.getTooltip();
      if (t) out.tips.push(String(t.getContent()));
    });
    return out;
  });
  ok('the hand-typed list still answers where tiles are missing',
     r.tips.some(t => /Paris/.test(t)), r.tips.slice(0, 3).join(' | '));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
