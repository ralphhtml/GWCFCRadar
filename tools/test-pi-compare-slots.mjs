#!/usr/bin/env node
/*
 * The Pi's models work in the comparison slots.
 *
 *     node tools/test-pi-compare-slots.mjs
 *
 * The Compare button splits the map into strips, and until now the extra
 * strips could only show five outside WMS services: the Pi's own twenty-odd
 * models, the ones this app actually builds, were not in the slot dropdown
 * at all. So "compare the Pi's GFS run against its previous run" was simply
 * not a thing the panel could say.
 *
 * This drives the real page in a browser with a stubbed Pi (a fake index and
 * a fetch that answers the manifest URLs), because the whole feature is glue:
 * dropdown -> slot state -> manifest fetch -> image overlay in the right pane
 * with the right URL and the right ground under it. Each link is asserted
 * separately so a failure names the broken link rather than "no picture".
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the source agrees with itself');
{
  ok('slots have a Pi render branch',
     /function _sevRenderPiSlot/.test(PAGE)
     && /startsWith\('pi:'\)\) \{ _sevRenderPiSlot/.test(PAGE));
  ok('the slot dropdown gets a Pi optgroup',
     /GWCFC Pi Models/.test(PAGE));
  ok('a saved group carries the region',
     /section: s\.section, var: s\.var, run: s\.run, region: s\.piRegion/.test(PAGE));
  ok('and the loader hands it back',
     /_sevMakeSlot\(c\.section, c\.var, c\.run, c\.region\)/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes in the page or this test',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-pi-compare-slots.mjs'), 'utf8').includes(EM));
}

console.log('\n2. in a real browser, against a stubbed Pi');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('  playwright is not installed, skipping');
} else {
  // Leaflet comes from a CDN, which a file:// page cannot reach, and without
  // it there is no map and no panes for the slots to render into. Served from
  // the local copy instead, the same way every other map-driving test boots;
  // everything else off-disk is aborted so the test runs with no network.
  const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.on('dialog', d => d.dismiss().catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
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
  await p.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

  const r = await p.evaluate(async () => {
    const out = {};
    // A Pi that answers instantly: one single-region model, one two-region
    // model, two archived runs each. Bare assignment on purpose: these are
    // top-level lets, and window.X would make a shadow copy the page ignores.
    _hdBase = 'https://pi.test';
    _hdIndex = { updated: 'now', models: {
      gfs: { label: 'GFS', res: '25 km', regions: {
        conus: { path: 'gfs/conus/20260831_06/manifest.json', run: '20260831_06',
                 runs: ['20260831_06', '20260831_00'],
                 fields: ['refc', 't2m'],
                 bounds: [[20, -130], [55, -60]] } } },
      nam: { label: 'NAM', res: '12 km', regions: {
        conus:  { path: 'nam/conus/20260831_06/manifest.json', run: '20260831_06',
                  runs: ['20260831_06'], fields: ['t2m'],
                  bounds: [[20, -130], [55, -60]] },
        alaska: { path: 'nam/alaska/20260831_06/manifest.json', run: '20260831_06',
                  runs: ['20260831_06'], fields: ['t2m'],
                  bounds: [[50, -170], [72, -130]] } } },
    } };
    const manifests = {
      'https://pi.test/models/gfs/conus/20260831_06/manifest.json': {
        run: '20260831_06', bounds: [[20, -130], [55, -60]],
        fields: { t2m: { hours: [0, 3, 6] }, refc: { hours: [0, 3, 6] } },
        frame_bounds: { 6: [[21, -129], [56, -59]] } },
      'https://pi.test/models/gfs/conus/20260831_00/manifest.json': {
        run: '20260831_00', bounds: [[20, -130], [55, -60]],
        fields: { t2m: { hours: [0, 3] }, refc: { hours: [0, 3] } } },
      'https://pi.test/models/nam/alaska/20260831_06/manifest.json': {
        run: '20260831_06', bounds: [[50, -170], [72, -130]],
        fields: { t2m: { hours: [0, 3] } } },
    };
    const origFetch = window.fetch;
    window.fetch = (url, opts) => {
      const man = manifests[String(url)];
      if (man) return Promise.resolve({ ok: true, json: async () => man });
      if (String(url).startsWith('https://pi.test/')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return origFetch(url, opts);
    };
    const tick = ms => new Promise(r => setTimeout(r, ms));

    if (!_sevCompareOn) _sevToggleCompare();  // adds one slot by itself
    await tick(50);
    const slot = _sevExtraSlots[0];

    // The dropdown itself offers the Pi's models.
    const sel = document.querySelector('#sev-slots-container select');
    out.piOptions = sel
      ? [...sel.querySelectorAll('optgroup[label="GWCFC Pi Models"] option')]
          .map(o => o.value) : [];

    // Pick the Pi's GFS: defaults come from the index, then the manifest
    // arrives and the overlay goes up.
    _sevSetSlotSection(slot.id, 'pi:gfs');
    await tick(150);
    out.var0 = slot.var;                 // first built product, HD_FIELDS order
    out.run0 = slot.run;                 // latest archived run
    out.layerUrl = slot.layer && slot.layer._url;
    out.layerPane = slot.layer && slot.layer.options.pane;
    out.layerClass = slot.layer && slot.layer.options.className;
    out.paneExists = !!map.getPane('sev-cmp-' + slot.id);

    // The product picker was filled from the entry, labeled through HD_FIELDS.
    const varSel = document.getElementById('sev-slot-var-' + slot.id);
    out.products = varSel ? [...varSel.querySelectorAll('option')].map(o => o.value) : [];
    const runSel = document.getElementById('sev-slot-run-' + slot.id);
    out.runs = runSel ? [...runSel.querySelectorAll('option')].map(o => o.value) : [];

    // Scrub to frame 2: hours[2] is 6, and hour 6 carries its own recorded
    // ground, so both the URL and the rectangle must move.
    _sevFrame = 2;
    _sevRenderSlot(slot);
    await tick(80);
    out.layerUrlF6 = slot.layer && slot.layer._url;
    out.f6North = slot.layer && slot.layer._bounds && slot.layer._bounds.getNorth();

    // Past the end: a shared frame beyond this model's last hour clamps to
    // the last hour rather than asking for a picture that was never built.
    _sevFrame = 99;
    _sevRenderSlot(slot);
    await tick(50);
    out.layerUrlPastEnd = slot.layer && slot.layer._url;

    // An archived run: new manifest, new hours, URL under the old run's dir.
    _sevFrame = 0;
    _sevSetSlotRun(slot.id, '20260831_00');
    await tick(150);
    out.layerUrlOldRun = slot.layer && slot.layer._url;

    // A two-region model grows a region picker, and switching region swaps
    // the entry, the archive, and the picture.
    _sevSetSlotSection(slot.id, 'pi:nam');
    await tick(150);
    const regSel = [...document.querySelectorAll('#sev-slots-container select')]
      .find(s => [...s.options].some(o => o.value === 'alaska'));
    out.regionOptions = regSel ? [...regSel.options].map(o => o.value) : [];
    _sevSetSlotPiRegion(slot.id, 'alaska');
    await tick(150);
    out.alaskaUrl = slot.layer && slot.layer._url;
    out.alaskaNorth = slot.layer && slot.layer._bounds && slot.layer._bounds.getNorth();

    // The on-map label speaks the Pi's own names, both run spellings.
    out.labelSlot = _sevCompareLabelText('pi:gfs', 't2m', '20260831_06');
    out.labelA = _sevCompareLabelText('pi:gfs', 't2m', '2026083106');

    // Saved and loaded back, region included.
    document.getElementById('sev-save-name-input').value = 'pi test';
    _sevSaveGroup();
    _sevLoadGroup('pi test');
    await tick(150);
    const back = _sevExtraSlots[0];
    out.groupBack = back && { section: back.section, region: back.piRegion, run: back.run };

    _sevToggleCompare();  // leave the map clean
    window.fetch = origFetch;
    return out;
  });
  await b.close();

  ok('the slot dropdown lists the Pi models',
     JSON.stringify(r.piOptions) === JSON.stringify(['pi:gfs', 'pi:nam']),
     JSON.stringify(r.piOptions));
  ok('picking one lands on its first built product', r.var0 === 'refc'
     || r.var0 === 't2m', String(r.var0));
  ok('and on the latest archived run', r.run0 === '20260831_06', String(r.run0));
  ok('the overlay asks for exactly that picture',
     r.layerUrl === 'https://pi.test/models/gfs/conus/20260831_06/'
       + r.var0 + '_f000.png', String(r.layerUrl));
  ok('in this slot\'s own clipped pane', r.paneExists
     && String(r.layerPane || '').startsWith('sev-cmp-'), String(r.layerPane));
  ok('drawn smooth like every model chart', r.layerClass === 'wx-model-smooth',
     String(r.layerClass));
  ok('the product picker offers what the model built',
     JSON.stringify([...r.products].sort()) === JSON.stringify(['refc', 't2m']),
     JSON.stringify(r.products));
  ok('the run picker offers the archive',
     JSON.stringify(r.runs) === JSON.stringify(['20260831_06', '20260831_00']),
     JSON.stringify(r.runs));
  ok('scrubbing moves the URL to the right hour',
     String(r.layerUrlF6 || '').endsWith('_f006.png'), String(r.layerUrlF6));
  ok('and onto that frame\'s own recorded ground', r.f6North === 56,
     String(r.f6North));
  ok('a frame past the end clamps to the last hour',
     String(r.layerUrlPastEnd || '').endsWith('_f006.png'),
     String(r.layerUrlPastEnd));
  ok('an archived run draws from the archived directory',
     r.layerUrlOldRun === 'https://pi.test/models/gfs/conus/20260831_00/'
       + r.var0 + '_f000.png', String(r.layerUrlOldRun));
  ok('a two-region model grows a region picker',
     JSON.stringify(r.regionOptions) === JSON.stringify(['conus', 'alaska']),
     JSON.stringify(r.regionOptions));
  ok('and switching region swaps the picture and the ground',
     String(r.alaskaUrl || '').includes('/nam/alaska/') && r.alaskaNorth === 72,
     `${r.alaskaUrl} north=${r.alaskaNorth}`);
  ok('the label names the model, product and run',
     r.labelSlot === 'GFS · 2m Temperature · 08/31 06z'
     || /GFS · .+ · 08\/31 06z/.test(r.labelSlot || ''), String(r.labelSlot));
  ok('whichever way the run was spelled',
     /08\/31 06z/.test(r.labelA || ''), String(r.labelA));
  ok('a saved group brings the Pi slot back, region and all',
     r.groupBack && r.groupBack.section === 'pi:nam'
     && r.groupBack.region === 'alaska', JSON.stringify(r.groupBack));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
