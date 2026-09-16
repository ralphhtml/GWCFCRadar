#!/usr/bin/env node
/*
 * Canada single-site radar (ECCC CAPPI), checked end to end.
 *
 *     node tools/test-ca-cappi.mjs
 *
 * Covers the station list itself (31 real CASxx codes, no duplicates), the
 * URL/timestamp/bounding-box math a browser never needs a network call to
 * get right, and the menu + map-pin flow in a real (offline) browser: opening
 * Canada CAPPI shows the station pins, tapping one probes the Datamart and,
 * since every request is aborted here, ends in the honest "not published"
 * toast rather than a stuck spinner or a thrown error.
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

console.log('\n1. the station list, read straight out of the page');
{
  const m = PAGE.match(/const CA_CAPPI_STATIONS = \[([\s\S]*?)\n\];/);
  ok('CA_CAPPI_STATIONS is in the page', !!m);
  const ids = m ? [...m[1].matchAll(/id:'([A-Z]+)'/g)].map(x => x[1]) : [];
  ok('all 31 official CASxx stations are listed', ids.length === 31, String(ids.length));
  ok('every id starts with CAS and no two are the same',
     ids.every(id => /^CAS[A-Z]{2}$/.test(id)) && new Set(ids).size === ids.length,
     JSON.stringify(ids.filter(id => !/^CAS[A-Z]{2}$/.test(id))));
  const lats = m ? [...m[1].matchAll(/lat:(-?[0-9.]+)/g)].map(x => Number(x[1])) : [];
  const lons = m ? [...m[1].matchAll(/lon:(-?[0-9.]+)/g)].map(x => Number(x[1])) : [];
  ok('every station sits inside Canada’s rough lat/lon box',
     lats.every(v => v > 41 && v < 61) && lons.every(v => v < -52 && v > -125),
     JSON.stringify({ lats: lats.filter(v => !(v > 41 && v < 61)),
                       lons: lons.filter(v => !(v < -52 && v > -125)) }));
  ok('this is a new source, not the existing Canada composite mosaic',
     PAGE.includes('CA_CAPPI_STATIONS') && PAGE.includes('CANADA_WMS')
     && PAGE.includes("const CANADA_LAYER = 'ca_composite_dz'"));
  ok('the menu carries its own bubble and description',
     /id:'radar-ca',[\s\S]{0,200}label:'Canada CAPPI'/.test(PAGE)
     && PAGE.includes("'radar-ca':") );
  ok('every place a frame is shown runs it through the basemap filter first',
     PAGE.includes('shown.filteredUrl = await _caCappiStripBasemap(shown.url);')
     && PAGE.includes('f.filteredUrl = await _caCappiStripBasemap(f.url);')
     && PAGE.includes('_caCappiOverlay = L.imageOverlay(shown.filteredUrl, bounds,')
     && PAGE.includes('_caCappiOverlay.setUrl(f.filteredUrl);'));
}

console.log('\n2. the math a browser never has to touch a network to get right');
{
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes in the feature or in this test file',
     !PAGE.slice(PAGE.indexOf('CANADA SINGLE-SITE RADAR'), PAGE.indexOf('MRMS NATIONAL MOSAIC')).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-ca-cappi.mjs'), 'utf8').includes(EM));
  ok('the URL builder pads the timestamp and matches the real ECCC filename shape',
     /_caCappiUrl\(id, ts, alt, type\) \{/.test(PAGE)
     && /dd\.weather\.gc\.ca\/today\/radar\/CAPPI\/GIF\/\$\{id\}\/\$\{stamp\}_\$\{id\}_CAPPI_\$\{alt\}_\$\{type\}\.gif/.test(PAGE));
  ok('the bounding-box math uses the same metres-per-degree constant as the rest of the file',
     /_caCappiBounds\(lat, lon, radiusKm\) \{[\s\S]{0,300}111320/.test(PAGE));
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
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n3. the pure math, run for real inside the browser');
{
  const r = await p.evaluate(() => {
    const b1 = _caCappiBounds(45.0, -76.0, 240);
    const url = _caCappiUrl('CASET', new Date(Date.UTC(2026, 8, 16, 0, 6)), '1.5', 'RAIN');
    return { b1, url };
  });
  ok('a 240 km box straddles the station and is roughly square in degrees',
     r.b1[0][0] < 45 && r.b1[1][0] > 45 && r.b1[0][1] < -76 && r.b1[1][1] > -76
     && Math.abs((r.b1[1][0] - r.b1[0][0]) - 240000 / 55660) < 0.05,
     JSON.stringify(r.b1));
  ok('the timestamp is UTC and zero-padded',
     r.url === 'https://dd.weather.gc.ca/today/radar/CAPPI/GIF/CASET/202609160006_CASET_CAPPI_1.5_RAIN.gif',
     r.url);
}

console.log('\n3b. the basemap-stripping filter, fed a picture it can actually read');
{
  // A tiny hand-built picture standing in for a real CAPPI GIF: a near-black
  // basemap pixel, a gray range-ring pixel, a near-white text pixel, and one
  // clearly saturated "echo" pixel (orange, the kind of colour real
  // reflectivity ramps use). A data: URL never taints the canvas, so this
  // exercises the real pixel loop without needing the network at all.
  const r = await p.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 1;
    const ctx = c.getContext('2d');
    const put = (x, r, g, b) => { ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x, 0, 1, 1); };
    put(0, 10, 10, 12);      // basemap: near-black
    put(1, 150, 150, 150);   // range ring / coastline: flat gray
    put(2, 245, 245, 245);   // label text: near-white
    put(3, 230, 120, 20);    // radar echo: saturated orange
    const dataUrl = c.toDataURL('image/png');
    const out = await _caCappiStripBasemap(dataUrl);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = out; });
    const oc = document.createElement('canvas');
    oc.width = 4; oc.height = 1;
    const octx = oc.getContext('2d');
    octx.drawImage(img, 0, 0);
    const d = octx.getImageData(0, 0, 4, 1).data;
    return { alphas: [d[3], d[7], d[11], d[15]], echo: [d[12], d[13], d[14]] };
  });
  ok('the basemap, the range ring and the label text all turn transparent',
     r.alphas[0] === 0 && r.alphas[1] === 0 && r.alphas[2] === 0, JSON.stringify(r.alphas));
  ok('the actual echo pixel survives, in its real colour',
     r.alphas[3] > 0 && r.echo[0] === 230 && r.echo[1] === 120 && r.echo[2] === 20,
     JSON.stringify(r));
}

console.log('\n4. opening the row shows the pins, and a pin does something honest offline');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    renderSubBubbles('regular');
    toggleRadarSub();
    const caBubble = document.getElementById('sub-radar-ca');
    caBubble.click();
    await sleep(150);
    const hasBack = !!document.querySelector('#sub-bubbles .sb-back');
    const hint = document.getElementById('sub-radar-ca-hint');
    const hintBefore = hint ? hint.textContent : '';
    const pinsShown = !!(_caCappiSiteLayer && map.hasLayer(_caCappiSiteLayer));
    const pinCount = Object.keys(_caCappiSiteMarkers).length;
    // Click one station pin the same way a real tap would.
    _caCappiMarkerClick(CA_CAPPI_STATIONS.find(s => s.id === 'CASET'));
    await sleep(200);
    const loadingText = document.getElementById('ca-cappi-panel')?.textContent || '';
    // Every probed URL is aborted by the route handler above, so this
    // resolves to "nothing published" well within a few seconds.
    await sleep(6000);
    const panelAfter = document.getElementById('ca-cappi-panel');
    const panelHiddenAfterMiss = !panelAfter || panelAfter.style.display === 'none';
    const stationClearedAfterMiss = _caCappiStation === null;
    return { hasBack, hintBefore, pinsShown, pinCount, loadingText,
             panelHiddenAfterMiss, stationClearedAfterMiss, errCount: 0 };
  });
  ok('the row opens with a Back row', r.hasBack);
  ok('the hint names the map before anything is picked',
     /Pick a CAS station pin/.test(r.hintBefore), r.hintBefore);
  ok('the 31 CASxx pins are added to the map', r.pinsShown && r.pinCount === 31, String(r.pinCount));
  ok('tapping a pin shows a loading state right away', /loading/.test(r.loadingText), r.loadingText);
  ok('and cleanly gives up (no stuck panel, no stuck station) when nothing was found offline',
     r.panelHiddenAfterMiss && r.stationClearedAfterMiss);
  ok('none of that threw', errs.length === 0, errs[0]);
}

console.log('\n5. picking Level 2 afterward tears the Canada CAPPI pins back down');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    renderSubBubbles('regular');
    toggleRadarSub();
    document.getElementById('sub-radar-ca').click();
    await sleep(150);
    const shownBefore = !!(_caCappiSiteLayer && map.hasLayer(_caCappiSiteLayer));
    _radarSource = 'ca'; _caCappiStation = { id: 'CASET', lat: 43.3722, lon: -81.37748 };
    _disableRadar();
    const shownAfter = !!(_caCappiSiteLayer && map.hasLayer(_caCappiSiteLayer));
    const stationAfter = _caCappiStation;
    return { shownBefore, shownAfter, stationAfter };
  });
  ok('the pins were up while the row was open', r.shownBefore);
  ok('switching radar source (_disableRadar) hides the pins and forgets the station',
     !r.shownAfter && r.stationAfter === null);
  ok('and none of that threw either', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
