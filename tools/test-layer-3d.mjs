#!/usr/bin/env node
/*
 * Layer 3D: every weather layer on the real ground, one panel per layer.
 *
 *     node tools/test-layer-3d.mjs
 *
 * Elevation tiles are faked (a sea to the west, land rising to the east) so
 * nothing touches the network. Checked here: the map menu offers a row per
 * layer that is on (and only the pressed pane's layer in a cross-layer
 * split); drawing a box opens that layer's own panel; the ground is read
 * from the public tiles, or from the parsing server when they fail; the
 * layer's own pixels are draped, and follow the map when it changes; the
 * ocean layers show the seafloor with a Water toggle; the height stretch,
 * looks, cutaway, walk and fullscreen work; two layers keep two panels; and
 * Radar 3D and Satellite 3D gained a Terrain button.
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

console.log('\n1. the pieces are in the page');
{
  ok('a registry of layers with their own panel',
     /const L3D_LAYERS = \[/.test(PAGE) && ['models', 'waves', 'air', 'wind', 'temperature', 'pressure', 'ocean', 'mrms']
       .every(id => new RegExp(`\\{ id: '${id}'`).test(PAGE.slice(PAGE.indexOf('const L3D_LAYERS'), PAGE.indexOf('const L3D_LAYERS') + 3000))));
  ok('the ground comes from the public Terrarium tiles',
     PAGE.includes("const L3D_TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';"));
  ok('with the parsing server\'s /terrain door as the backup', /\$\{base\}\/terrain\/\$\{key\}\.png/.test(PAGE));
  ok('a new menu icon', PAGE.includes('<symbol id="ic-terrain3d"'));
  ok('an info text', /'tool-l3d': +'Any weather layer on the real ground/.test(PAGE));
  ok('Radar 3D has a Terrain button', PAGE.includes('id="r3d-terrain-btn"'));
  ok('Satellite 3D has a Terrain button', PAGE.includes('id="s3d-terrain-btn"'));
  ok('no em dashes in the new code or this test',
     !PAGE.slice(PAGE.indexOf('// -- Layer 3D: every layer'), PAGE.indexOf('// -- COMPARING LAYERS: THE CROSS-LAYER SPLIT'))
       .includes(String.fromCharCode(0x2014))
     && !readFileSync(join(ROOT, 'tools/test-layer-3d.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));
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
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });

// One fake Terrarium tile: sea (2000 m deep) on the west half, land rising
// to 1500 m on the east half. Encoded by the page itself on first use.
let TILE = null;
const tileHits = { aws: 0, server: 0 };
let awsDown = false;
await p.route('**://**', async route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('elevation-tiles-prod/terrarium/')) {
    tileHits.aws++;
    if (awsDown || !TILE) return route.abort();
    return route.fulfill({ contentType: 'image/png', body: TILE, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  if (url.startsWith('http://pi.test/terrain/')) {
    tileHits.server++;
    return route.fulfill({ contentType: 'image/png', body: TILE, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
ok('the page boots clean', errs.length === 0, errs[0]);

const b64 = await p.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const x = c.getContext('2d'); const im = x.createImageData(256, 256);
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
    const m = i < 128 ? -2000 : (i - 128) / 128 * 1500;
    const v = m + 32768, r = Math.floor(v / 256), g = Math.floor(v - r * 256);
    const o = (j * 256 + i) * 4;
    im.data[o] = r; im.data[o + 1] = g; im.data[o + 2] = 0; im.data[o + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  return c.toDataURL('image/png').split(',')[1];
});
TILE = Buffer.from(b64, 'base64');

// A fake waves layer: a canvas in the waves pane covering the whole map,
// red on the left half of the screen and blue on the right.
const paintWaves = (color1, color2) => p.evaluate(([c1, c2]) => {
  const pane = map.getPane('wavesPane') || map.createPane('wavesPane');
  let cv = document.getElementById('__fakewaves');
  if (!cv) {
    cv = document.createElement('canvas'); cv.id = '__fakewaves';
    pane.appendChild(cv);
  }
  const r = map.getContainer().getBoundingClientRect();
  const pr = pane.getBoundingClientRect();
  cv.width = Math.round(r.width); cv.height = Math.round(r.height);
  cv.style.position = 'absolute';
  cv.style.left = (r.left - pr.left) + 'px'; cv.style.top = (r.top - pr.top) + 'px';
  cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
  const x = cv.getContext('2d');
  x.fillStyle = c1; x.fillRect(0, 0, cv.width / 2, cv.height);
  x.fillStyle = c2; x.fillRect(cv.width / 2, 0, cv.width / 2, cv.height);
}, [color1, color2]);

console.log('\n2. the map menu offers a row per layer that is on');
{
  const r = await p.evaluate(() => {
    const ic = (n) => `<i data-ic="${n}"></i>`;
    const none = _l3dMenuItems(ic);
    wavesActive = true;
    const one = _l3dMenuItems(ic);
    const out = { none, one, air: _l3dIsOn('air') };
    return out;
  });
  ok('nothing is on: no rows', r.none === '', r.none);
  ok('waves on: one row that draws a waves zone',
     /Draw a 3D waves zone/.test(r.one) && /_cmLayer3DDraw\('waves'\)/.test(r.one) && /data-ic="terrain3d"/.test(r.one), r.one);
  ok('layers that are off are not offered', !r.air && !/air zone/.test(r.one));
  const xc = await p.evaluate(() => {
    const real = _xcLayerAt;
    temperatureActive = true;
    window._xcLayerAt = () => 'temperature';
    const t = _l3dMenuItems(n => '', 100, 100);
    window._xcLayerAt = () => 'radar';
    const rr = _l3dMenuItems(n => '', 100, 100);
    window._xcLayerAt = real;
    temperatureActive = false;
    return { t, rr };
  });
  ok('in a cross-layer split, only the pressed pane\'s layer is offered',
     /temperature zone/.test(xc.t) && !/waves zone/.test(xc.t), xc.t);
  ok('and nothing when that pane is radar (Radar 3D covers it)', xc.rr === '', xc.rr);
}

console.log('\n3. drawing a box opens that layer\'s own panel on the real ground');
await paintWaves('rgb(230,20,20)', 'rgb(20,40,230)');
{
  const r = await p.evaluate(async () => {
    map.setView([30, -80], 7, { animate: false });
    await new Promise(res => setTimeout(res, 300));
    const b = map.getBounds();
    const s = b.getSouth() + 0.8, n = b.getNorth() - 0.8, w = b.getWest() + 1, e = b.getEast() - 1;
    // Through the same drawing path the menu row starts.
    _cmLayer3DDraw('waves');
    const target = _r3dDrawFor;
    _r3dDrawStop();
    const opened = _l3dOpenBounds('waves', s, w, n, e);
    const P = _l3dPanels.waves;
    for (let i = 0; i < 100 && !P.ground; i++) await new Promise(res => setTimeout(res, 50));
    await P.renderIdle();
    const cv = P.el('canvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0;
    for (let k = 0; k < d.length; k += 16) if (d[k] + d[k + 1] + d[k + 2] > 60) lit++;
    return { target, opened, open: P.panel.classList.contains('open'), id: P.panel.id,
             nx: P.nx, ny: P.ny, ground: !!P.ground, minM: P.ground && P.ground.minM, maxM: P.ground && P.ground.maxM,
             server: P.ground && P.ground.server, painted: P.painted, lit,
             title: P.panel.querySelector('.xs-title').textContent, status: P.el('status').textContent,
             where: P.el('where').textContent, rect: !!P.rect };
  });
  ok('the menu row draws for Layer 3D', r.target === 'l3d:waves', r.target);
  ok('the waves panel opened, its own element', r.opened && r.open && r.id === 'l3d-waves-panel', JSON.stringify(r));
  ok('titled for the layer', r.title === 'Waves 3D', r.title);
  ok('the box is outlined on the map', r.rect);
  ok('the same detail on every device: 200 cells on the long side', Math.max(r.nx, r.ny) === 200, `${r.nx}x${r.ny}`);
  ok('the ground was read from the public tiles', r.ground && r.server === false && tileHits.aws > 0, JSON.stringify(tileHits));
  ok('it holds the seafloor and the land', r.minM < -1500 && r.maxM > 500, `${r.minM} to ${r.maxM}`);
  ok('the header says how deep the sea gets', /deepest/.test(r.where), r.where);
  ok('the layer was draped from the screen', r.painted > 1000, String(r.painted));
  ok('and the picture is drawn', r.lit > 500, String(r.lit));
  ok('the status says where the ground came from', /Terrarium/.test(r.status), r.status);
}

console.log('\n4. the drape is the layer\'s own colours, and follows the map');
{
  const r = await p.evaluate(async () => {
    const P = _l3dPanels.waves;
    P.water = false; P.colours = null;
    const col = P.cellColours();
    const n = P.nx * P.ny;
    // A cell on the far left and far right of the middle row.
    const mid = Math.floor(P.ny / 2) * P.nx;
    const L = [col.floor[mid * 3], col.floor[mid * 3 + 1], col.floor[mid * 3 + 2]];
    const R = [col.floor[(mid + P.nx - 1) * 3], col.floor[(mid + P.nx - 1) * 3 + 1], col.floor[(mid + P.nx - 1) * 3 + 2]];
    return { L, R, n };
  });
  ok('the west of the box wears the layer\'s red', r.L[0] > 150 && r.L[2] < 90, JSON.stringify(r.L));
  ok('the east wears its blue', r.R[2] > 150 && r.R[0] < 90, JSON.stringify(r.R));
  await paintWaves('rgb(20,200,20)', 'rgb(20,200,20)');
  const r2 = await p.evaluate(async () => {
    const P = _l3dPanels.waves;
    await new Promise(res => setTimeout(res, 1200));      // one resample beat
    const col = P.cellColours();
    const mid = Math.floor(P.ny / 2) * P.nx;
    return [col.floor[mid * 3], col.floor[mid * 3 + 1], col.floor[mid * 3 + 2]];
  });
  ok('when the layer changes on the map (a new frame), the 3D drape follows by itself',
     r2[1] > 150 && r2[0] < 90, JSON.stringify(r2));
}

console.log('\n5. the ocean: a see-through sea over the seafloor, or the layer on the seafloor');
{
  const r = await p.evaluate(async () => {
    const P = _l3dPanels.waves;
    const fk = P.floorKm();
    let seaCells = 0, below = 0;
    for (let k = 0; k < fk.length; k++) if (P.ground.m[k] < 0) { seaCells++; if (fk[k] < -1) below++; }
    const snap = async () => {
      P.dirty = true; await P.renderIdle();
      const cv = P.el('canvas');
      return Array.from(cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data.filter((_, i) => i % 97 === 0));
    };
    const btn = P.el('water');
    const off = await snap();
    btn.click();
    const on = await snap();
    const col = P.cellColours();
    let diff = 0;
    for (let i = 0; i < on.length; i++) diff += Math.abs(on[i] - off[i]);
    return { seaCells, below, water: P.water, btnOn: btn.classList.contains('on'), diff, anySea: col.anySea };
  });
  ok('the ocean layer stands on the real seafloor, not a flat sea', r.seaCells > 100 && r.below === r.seaCells, JSON.stringify(r));
  ok('the Water button turns the see-through sea on', r.water && r.btnOn && r.anySea, JSON.stringify(r));
  ok('and the picture changes with it', r.diff > 1000, String(r.diff));
  const land = await p.evaluate(async () => {
    temperatureActive = true;
    const P = _l3dPanel('temperature');
    const Q = _l3dPanels.waves;
    P.openBounds(Q.zone.s, Q.zone.w, Q.zone.n, Q.zone.e);
    for (let i = 0; i < 100 && !P.ground; i++) await new Promise(res => setTimeout(res, 50));
    const fk = P.floorKm();
    let min = Infinity; for (const v of fk) if (v < min) min = v;
    const out = { min, water: !!P.el('water'), both: Q.on && P.on, two: document.querySelectorAll('.l3d-panel.open').length,
                  right: [Q.panel.style.right, P.panel.style.right] };
    P.close(); temperatureActive = false;
    return out;
  });
  ok('a land layer keeps a flat sea at sea level', land.min === 0, String(land.min));
  ok('and has no Water button', !land.water);
  ok('two layers keep two panels open side by side, offset', land.both && land.two === 2 && land.right[0] !== land.right[1], JSON.stringify(land));
}

console.log('\n6. the controls');
{
  const r = await p.evaluate(async () => {
    const P = _l3dPanels.waves;
    const auto = P.exag();
    const ex = P.el('exag');
    ex.value = '1000'; ex.dispatchEvent(new Event('input'));
    const max = P.exag();
    const label = P.el('exag-label').textContent;
    P.el('exag-auto').click();
    const back = P.exag();
    const mode = P.el('mode'); mode.value = 'height'; mode.dispatchEvent(new Event('change'));
    const cut = P.el('cut'); cut.value = 'e'; cut.dispatchEvent(new Event('change'));
    const box = P.cutBox(P.zone.wKm / 2, P.zone.hKm / 2);
    P.dirty = true; await P.renderIdle();
    P.el('walk').click();
    const walking = !!P.walk && P.el('pad').style.display === '';
    const aboveGround = P.walk && P.walk.z > P.groundKmAt(P.walk.x, P.walk.y) * P.exag();
    P.el('walk').click();
    P.el('full').click();
    const full = P.panel.classList.contains('fullscreen');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const unfull = !P.panel.classList.contains('fullscreen');
    mode.value = 'lit'; mode.dispatchEvent(new Event('change'));
    cut.value = 'off'; cut.dispatchEvent(new Event('change'));
    return { auto, max, label, back, mode: P.mode, cutMax: box.maxX, half: P.zone.wKm / 2, walking, aboveGround, full, unfull,
             tm: !!P.el('tm'), mrmsTm: _l3dSpec('mrms').tm };
  });
  ok('the stretch starts automatic and above 1', r.auto > 1 && r.back === r.auto, JSON.stringify(r));
  ok('the slider reaches the top of the scale', Math.round(r.max) === 300 && /300×$/.test(r.label), r.label);
  ok('Relief colours is a look', r.mode === 'lit');
  ok('the cutaway trims the box', r.cutMax < r.half, JSON.stringify(r));
  ok('Walk puts you above the ground with the pad showing', r.walking && r.aboveGround, JSON.stringify(r));
  ok('fullscreen, and Esc leaves it', r.full && r.unfull);
  ok('only the MRMS panel carries a Time Machine button', !r.tm && r.mrmsTm === 'mosaic');
}

console.log('\n7. the parsing server answers when the public tiles do not');
{
  awsDown = true;
  const before = tileHits.server;
  const r = await p.evaluate(async () => {
    _hdBase = 'http://pi.test';
    _l3dTileMemo.clear();
    const P = _l3dPanels.waves;
    const z = P.zone;
    P.openBounds(z.s + 0.1, z.w + 0.1, z.n - 0.1, z.e - 0.1);
    for (let i = 0; i < 100 && !P.ground; i++) await new Promise(res => setTimeout(res, 50));
    return { ground: !!P.ground, server: P.ground && P.ground.server, status: P.el('status').textContent };
  });
  ok('the ground still arrives', r.ground, JSON.stringify(r));
  ok('from the parsing server\'s /terrain door', r.server === true && tileHits.server > before, JSON.stringify(tileHits));
  ok('and the status says so', /parsing server/.test(r.status), r.status);
  awsDown = false;
}

console.log('\n8. Satellite 3D and Radar 3D can stand on the ground too');
{
  const r = await p.evaluate(async () => {
    _s3dZone = { s: 29, w: -72, n: 31, e: -62, lat: 30, lng: -67, wKm: 964, hKm: 222 };
    const d = { w: 40, h: 24, hm: new Float32Array(40 * 24) };
    const flat = _s3dShownHeights(d);
    document.getElementById('s3d-terrain-btn').click();
    _s3dShownHeights(d);
    for (let i = 0; i < 100; i++) {
      const k = [_s3dZone.s, _s3dZone.w, _s3dZone.n, _s3dZone.e, d.w, d.h].join('|');
      if (_s3dGroundMemo.get(k) instanceof Float32Array) break;
      await new Promise(res => setTimeout(res, 50));
    }
    const raised = _s3dShownHeights(d);
    let maxFlat = 0, maxRaised = 0, west = raised[12 * 40];
    for (let k = 0; k < flat.length; k++) { maxFlat = Math.max(maxFlat, flat[k]); maxRaised = Math.max(maxRaised, raised[k]); }
    document.getElementById('s3d-terrain-btn').click();
    _s3dZone = null;
    // Radar 3D: the ground loads for its zone and is drawn under the storm.
    _r3dZone = { lat: 30, lng: -80, wKm: 120, hKm: 120 };
    document.getElementById('r3d-terrain-btn').click();
    _r3dGroundNow();
    for (let i = 0; i < 100 && !_r3dGround; i++) await new Promise(res => setTimeout(res, 50));
    const g = _r3dGround;
    const out = { maxFlat, maxRaised, west, r3d: !!g, r3dOn: _r3dTerrainOn,
                  r3dBtn: document.getElementById('r3d-terrain-btn').classList.contains('on'),
                  r3dMax: g ? Math.max(...g.d.hm) : 0 };
    document.getElementById('r3d-terrain-btn').click();
    _r3dZone = null;
    return out;
  });
  ok('Satellite 3D: clear sky is flat without it', r.maxFlat === 0, JSON.stringify(r));
  ok('and rises to the hills with Terrain on (the fake tile tops out near 360 m there)', r.maxRaised > 0.3, JSON.stringify(r));
  ok('while the sea stays at sea level', r.west === 0, JSON.stringify(r));
  ok('Radar 3D: the button turns on and the ground loads for the zone', r.r3dOn && r.r3dBtn && r.r3d && r.r3dMax > 0.5, JSON.stringify(r));
}

console.log('\n9. closing');
{
  const r = await p.evaluate(() => {
    const P = _l3dPanels.waves;
    P.el('x').click();
    return { open: P.panel.classList.contains('open'), on: P.on, rect: !!P.rect, timer: !!P.resampleTimer };
  });
  ok('the panel closes, its box leaves the map, and it stops reading the layer',
     !r.open && !r.on && !r.rect && !r.timer, JSON.stringify(r));
}

ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
