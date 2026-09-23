#!/usr/bin/env node
/*
 * The Inspector in a radar or satellite comparison reads the pane under the
 * crosshair, not always the main picture. It used to read pane A (the main
 * satellite layer) everywhere, so a water vapour pane beside Clean IR
 * reported Clean IR's cloud-top temperature.
 *
 *     node tools/test-inspector-compare.mjs
 *
 * Real Leaflet; the panes' pictures are drawn in the page as data URLs so
 * their pixels are readable, and a radar pane carries a hand-built mesh.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) { console.log('playwright is not installed, skipping'); process.exit(0); }

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
ok('the page boots clean', errs.length === 0, errs[0]);

// A flat picture of one colour, covering the whole map, inside `host`.
const SETUP = () => {
  window.__flat = (host, rgb) => new Promise(res => {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const x = c.getContext('2d'); x.fillStyle = `rgb(${rgb.join(',')})`; x.fillRect(0, 0, 8, 8);
    const img = new Image();
    img.onload = () => res(img);
    img.src = c.toDataURL();
    const r = map.getContainer().getBoundingClientRect();
    img.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    host.appendChild(img);
  });
};

console.log('\n1. satellite comparison: each pane reads its own picture and product');
{
  const r = await p.evaluate(async (setup) => {
    eval('(' + setup + ')()');
    activeLayers.satellite = true;
    _goesProductId = 'ch13';
    const mainHost = document.createElement('div');
    mainHost.className = 'leaflet-layer';
    document.body.appendChild(mainHost);
    await __flat(mainHost, [200, 200, 200]);          // cold, bright Clean IR
    _goesLayer = { getContainer: () => mainHost };
    _scOn = true;
    _scSetGrid(1, 2);
    const slot = { id: 'stest', productId: 'ch02', regionId: 'auto', kind: 'wms', layer: null,
                   frames: null, frameIso: '', labelEl: null, token: 0 };
    _scSlots.push(slot);
    const pane = map.createPane(_scPaneName(slot));
    await __flat(pane, [40, 40, 40]);                // dark visible
    const rc = map.getContainer().getBoundingClientRect();
    const at = (fx, fy) => [rc.left + rc.width * fx, rc.top + rc.height * fy];
    const left = _inspSatelliteRow(...at(0.25, 0.5));
    const right = _inspSatelliteRow(...at(0.75, 0.5));
    // Turn the split line: a point just right of centre near the top is
    // now on pane A's side of a line leaning right at the top.
    _scColRots[0] = 40;
    const tilted = _inspSatelliteRow(...at(0.55, 0.1));
    const tiltedLow = _inspSatelliteRow(...at(0.45, 0.9));
    _scColRots[0] = 0;
    const rows = _inspRowsAt(map.containerPointToLatLng([rc.width * 0.75, rc.height * 0.5]),
                             ...at(0.75, 0.5), false).filter(x => /^Satellite/.test(x.label));
    _scSlots.length = 0; _scSetGrid(null); _scOn = false;
    return { left, right, tilted, tiltedLow, rows };
  }, SETUP.toString());
  ok('pane A is named A and reads the main picture as Clean IR', r.left.label === 'Satellite A'
     && /°/.test(r.left.value) && /Clean IR/.test(r.left.unit || ''), JSON.stringify(r.left));
  ok('pane B is named B and reads ITS picture, as its own product', r.right.label === 'Satellite B'
     && /%/.test(r.right.value) && /Red Visible/.test(r.right.unit || ''), JSON.stringify(r.right));
  ok('the two readings differ, because the pictures do', r.left.value !== r.right.value);
  ok('with the line turned, the pane follows the angled cut, not the old straight one',
     r.tilted.label === 'Satellite A' && r.tiltedLow.label === 'Satellite B',
     JSON.stringify([r.tilted.label, r.tiltedLow.label]));
  ok('the Inspector readout itself shows exactly one satellite row, for pane B',
     r.rows.length === 1 && r.rows[0].label === 'Satellite B', JSON.stringify(r.rows));
}

console.log('\n2. radar comparison: each pane reads its own radar, exact where it can');
{
  const r = await p.evaluate(async (setup) => {
    eval('(' + setup + ')()');
    _rcOn = true;
    _rcSetGrid(1, 2);
    const rc = map.getContainer().getBoundingClientRect();
    const at = (fx, fy) => [rc.left + rc.width * fx, rc.top + rc.height * fy];
    const ll = (fx, fy) => map.containerPointToLatLng([rc.width * fx, rc.height * fy]);
    // A mesh pane: one quad over the whole right half, 57 dBZ.
    const b = map.getBounds();
    const mesh = new Float32Array([b.getWest(), b.getSouth(), b.getEast(), b.getSouth(),
                                   b.getEast(), b.getNorth(), b.getWest(), b.getNorth(), 57]);
    const slotM = { id: 'rtest1', site: 'kinx', prodSel: null, kind: 'mesh-l2', layer: null,
                    mesh, meshProduct: 'ref', meshBox: _inspMeshBox(mesh), labelEl: null, token: 0 };
    _rcSlots.push(slotM);
    const meshRow = _inspRadarRow(ll(0.75, 0.5), ...at(0.75, 0.5));
    // A picture pane: the NWS colour for about 45 dBZ, read back as dBZ.
    _rcSlots.length = 0;
    const slotP = { id: 'rtest2', site: 'ktlx', prodSel: 'ref', kind: 'wms', layer: null, labelEl: null, token: 0 };
    _rcSlots.push(slotP);
    const pane = map.createPane(_rcPaneName(slotP));
    const c45 = NWS_SOURCE_COLORS.find(s => NWS_DBZ_META[NWS_SOURCE_COLORS.indexOf(s)].dbz >= 45);
    await __flat(pane, [c45[1], c45[2], c45[3]]);
    const pixRow = _inspRadarRow(ll(0.75, 0.5), ...at(0.75, 0.5));
    const aRow = _inspRadarRow(ll(0.25, 0.5), ...at(0.25, 0.5));
    _rcSlots.length = 0; _rcSetGrid(null); _rcOn = false;
    const plain = _inspRadarRow(ll(0.25, 0.5), ...at(0.25, 0.5));
    return { meshRow, pixRow, aRow, plain };
  }, SETUP.toString());
  ok('a decoded pane reports its exact value, named B and with its radar', r.meshRow.label === 'Radar B'
     && r.meshRow.value === '57.00' && /KINX/.test(r.meshRow.unit), JSON.stringify(r.meshRow));
  ok('a picture pane reads its own colour back to dBZ', r.pixRow.label === 'Radar B'
     && /dBZ/.test(r.pixRow.value) && /KTLX/.test(r.pixRow.unit), JSON.stringify(r.pixRow));
  ok('the other side is pane A, the main radar', r.aRow.label === 'Radar A', JSON.stringify(r.aRow));
  ok('with no comparison running the row is plain Radar again', r.plain.label === 'Radar', JSON.stringify(r.plain));
}

console.log('\n3. the pictures stay readable');
{
  const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('a radar pane\'s parsing server picture loads CORS-readable',
     /pane: _rcPaneName\(slot\),\s*\n\s*crossOrigin: 'anonymous' \}\)\.addTo\(map\);/.test(PAGE));
  ok('and so does the main parsing server radar picture',
     /pane: 'radarPane', crossOrigin: 'anonymous' \}\);/.test(PAGE));
}

ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
