#!/usr/bin/env node
/*
 * Shaped 3D zones: the Polygon and Radius tools open any 3D view (Radar,
 * Satellite, Model, a layer), and each one is cut to the shape drawn, not
 * the box around it. Model 3D can be dragged out as a box too.
 *
 *     node tools/test-shaped-zones.mjs
 *
 * Offline. Checked: the shape maths; the 3D button's picker lists every 3D
 * view there is (and the layers that are on); each view keeps the shape
 * and outlines it on the map; the radar marcher and the shared ground and
 * cloud-top rasteriser leave out everything outside it (viewed from
 * straight above, a circle zone lights a circle, not a square); and Model
 * 3D opens on a dragged box with its own proportions.
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

console.log('\n1. the pieces');
{
  const EM = String.fromCharCode(0x2014);
  const a = PAGE.indexOf('// -- SHAPED 3D ZONES'), b = PAGE.indexOf('// -- Drawing the zone on the map');
  ok('the shared shape code is in the page', a > 0 && b > a);
  ok('no em dashes in it or in this test', !PAGE.slice(a, b).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-shaped-zones.mjs'), 'utf8').includes(EM));
  ok('the map menu offers a Model 3D box', /_cmModel3DDraw\(\)">\$\{ic\('terrain3d'\)\} Draw a 3D model zone/.test(PAGE));
  ok('the Polygon and Radius 3D buttons pass their click on', /_r3dFromPolygon\(event\)/.test(PAGE) && /_r3dFromRadius\(event\)/.test(PAGE));
}

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
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
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; map.setView([35.3, -97.3], 7, { animate: false }); });

console.log('\n2. the shape maths');
{
  const r = await p.evaluate(() => {
    const circ = _zoneShapeKm({ type: 'circle', lat: 35, lng: -97, km: 25 }, 35, -97);
    const tri = _zoneShapeKm({ type: 'poly', pts: [{ lat: 34.8, lng: -97.3 }, { lat: 34.8, lng: -96.7 }, { lat: 35.3, lng: -97 }] }, 35, -97);
    const zone = { lat: 35, lng: -97, wKm: 100, hKm: 100, shape: circ };
    const m = _zoneMask(zone, 100, 100);
    let inside = 0; m.forEach(v => { inside += v; });
    return { circ, triIn: _zoneInsideXY(tri, 0, -10), triOut: _zoneInsideXY(tri, 20, 20),
      circIn: _zoneInsideXY(circ, 10, 10), circOut: _zoneInsideXY(circ, 20, 20), frac: inside / m.length,
      same: _zoneMask(zone, 100, 100) === m, ring: _zoneOutlineXY(zone).length, box: _zoneOutlineXY({ wKm: 10, hKm: 6 }).join(' '),
      map: _zoneMapLatLngs(zone).length };
  });
  ok('a circle is kept in km from the zone centre', r.circ.type === 'circle' && Math.abs(r.circ.r - 25) < 1e-9 && Math.abs(r.circ.cx) < 1e-9);
  ok('inside and outside, circle and polygon', r.circIn && !r.circOut && r.triIn && !r.triOut, JSON.stringify(r));
  ok('a circle of radius 25 fills a quarter pi of its 50 km box: here pi/4 of the 25 km circle in a 100 km box', Math.abs(r.frac - Math.PI * 625 / 10000) < 0.01, r.frac);
  ok('the mask is built once per grid', r.same);
  ok('the rim: 64 points round a circle, four corners round a box', r.ring === 64 && r.box === '-5,-3 5,-3 5,3 -5,3' && r.map === 64, JSON.stringify(r));
}

console.log('\n3. the rasteriser and the radar marcher stop at the edge');
{
  const r = await p.evaluate(() => {
    const W = 120, H = 120;
    const down = { camX: 0, camY: 0, camZ: 200, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: -1 };
    const n = 60, d = { w: n, h: n, hm: new Float32Array(n * n).fill(1), rgb: new Uint8Array(n * n * 3).fill(200) };
    const count = (px, inside) => {
      let inC = 0, outC = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (px[(y * W + x) * 4 + 3] < 20) continue;
        // screen to zone km: focal H*1.15 at depth ~199
        const kx = (x + 0.5 - W / 2) / (H * 1.15) * 199, ky = -(y + 0.5 - H / 2) / (H * 1.15) * 199;
        if (inside(kx, ky)) inC++; else outC++;
      }
      return { inC, outC };
    };
    const circle = { type: 'circle', cx: 0, cy: 0, r: 25 };
    const plain = _s3dRaster(d, { wKm: 100, hKm: 100 }, down, W, H, 1, 1, 1, { mode: 'flat' });
    const shaped = _s3dRaster(d, { wKm: 100, hKm: 100, shape: circle }, down, W, H, 1, 1, 1, { mode: 'flat' });
    const inC = (x, y) => Math.hypot(x, y) <= 27;
    const rp = count(plain, inC), rs = count(shaped, inC);
    // The marcher: one tilt of strong echo everywhere, the radar in the middle.
    const nR = 300, nA = 720, rows = nA + 2;
    const pack = _r3dLutFor('ref', 0.4);
    let byte = 0; for (let v = 255; v > 0; v--) if (pack.lut[v * 4 + 3] > 0.05) { byte = v; break; }
    const angN = 400;
    const mk = (shape) => ({
      sweeps: [new Uint8Array(rows * nR).fill(byte)], nS: 1, nR, nA, r0: 0, rStep: 0.25, az0: 0, azStep: 0.5, span: 360, full: true,
      angles: new Float32Array([0.5]), angIdx: new Float32Array(angN).fill(0), angFade: new Float32Array(angN).fill(1),
      elMin: -5, elStep: 0.25, sx: 0, sy: 0, colMaxZ: new Float32Array(64 * 64).fill(50), colN: 64, halfX: 50, halfY: 50,
      mask: shape ? _zoneMask({ wKm: 100, hKm: 100, shape }, R3D_MASK_N, R3D_MASK_N) : null, maskN: R3D_MASK_N });
    const prm = { iw: W, ih: H, fine: 0, crisp: 1, exag: 1, stepKm: 0.4, lut: pack.lut, floorRgb: pack.floorRgb, signed: false,
      cam: new Float64Array([0, 0, 200, 1, 0, 0, 0, 1, 0, 0, 0, -1]), minX: -50, maxX: 50, minY: -50, maxY: 50, maxZ: 12,
      light: new Float32Array([0, 0, 1]) };
    const m0 = new Uint8ClampedArray(W * H * 4), m1 = new Uint8ClampedArray(W * H * 4);
    _r3dMarchBand(mk(null), prm, 0, H, m0);
    _r3dMarchBand(mk(circle), prm, 0, H, m1);
    return { plain: rp, shaped: rs, mPlain: count(m0, inC), mShaped: count(m1, inC), byte };
  });
  ok('the ground or cloud tops of a plain box fill the whole box', r.plain.outC > 3 * r.plain.inC, JSON.stringify(r.plain));
  ok('a circle zone draws only the circle', r.shaped.inC > 0.7 * r.plain.inC && r.shaped.outC === 0, JSON.stringify(r.shaped));
  ok('the radar volume of a plain box fills the box', r.mPlain.outC > 3 * r.mPlain.inC, JSON.stringify(r));
  ok('and of a circle zone, only the circle', r.mShaped.inC > 0.9 * r.mPlain.inC && r.mShaped.outC === 0, JSON.stringify(r));
}

console.log('\n4. the Polygon and Radius tools open any 3D view on their shape');
{
  const r = await p.evaluate(async () => {
    temperatureActive = true;
    _polyPts = [L.latLng(34.9, -97.8), L.latLng(34.9, -96.8), L.latLng(35.7, -97.3)];
    const pick = _r3dFromPolygon();
    const items = [...pick.querySelectorAll('button')].map(x => x.textContent);
    pick.querySelector('[data-t="s3d"]').click();
    await new Promise(res => setTimeout(res, 200));
    const s3 = { shape: _s3dZone && _s3dZone.shape, ring: _s3dRect && _s3dRect.getLatLngs()[0].length, gone: !document.querySelector('.zone3d-pick') };
    _s3dClose();
    _radii = [{ lat: 35.33, lng: -97.28, miles: 20 }];
    const pick2 = _r3dFromRadius();
    pick2.querySelector('[data-t="r3d"]').click();
    await new Promise(res => setTimeout(res, 200));
    const r3 = { shape: _r3dZone && _r3dZone.shape, w: _r3dZone && _r3dZone.wKm, ring: _r3dZoneRect && _r3dZoneRect.getLatLngs()[0].length };
    try { _r3dClose(); } catch (e) {}
    const pick3 = _r3dFromRadius();
    pick3.querySelector('[data-t="l3d:temperature"]').click();
    await new Promise(res => setTimeout(res, 200));
    const P = _l3dPanels.temperature;
    const l3 = { shape: P && P.zone && P.zone.shape, ring: P && P.rect && P.rect.getLatLngs()[0].length, mask: P && P.zone ? Array.from(_zoneMask(P.zone, 20, 20)).reduce((a, v) => a + v, 0) : 0 };
    try { P.close(); } catch (e) {}
    return { items, s3, r3, l3, pending: _zonePendingShape };
  });
  ok('the 3D button asks which view: Radar, Satellite, Model and each layer that is on', r.items.join('|') === 'Radar 3D|Satellite 3D|Model 3D|Temperature 3D', r.items.join('|'));
  ok('Satellite 3D opens on the polygon, outlined as the polygon', r.s3.shape && r.s3.shape.type === 'poly' && r.s3.shape.xy.length === 3 && r.s3.ring === 3 && r.s3.gone, JSON.stringify(r.s3));
  ok('Radar 3D opens on the radius as a circle, the box just big enough', r.r3.shape && r.r3.shape.type === 'circle'
     && Math.abs(r.r3.shape.r - 32.19) < 0.05 && Math.abs(r.r3.w - 64.4) < 0.3 && r.r3.ring === 64, JSON.stringify(r.r3));
  ok('a layer 3D panel opens on it too, masked to the circle', r.l3.shape && r.l3.shape.type === 'circle' && r.l3.ring === 64
     && r.l3.mask > 250 && r.l3.mask < 340, JSON.stringify(r.l3));
  ok('the shape is handed over once and not left waiting', r.pending === null);
}

console.log('\n5. Model 3D: a dragged box, and a drawn shape');
{
  const r = await p.evaluate(async () => {
    window._m3dLoadSources = async () => {};
    window._m3dLoad = async () => {};
    _m3dOpenBounds(34, -99, 36, -95);
    await new Promise(res => setTimeout(res, 200));
    const box = { w: _m3d.zone.wKm, h: _m3d.zone.hKm, shape: _m3d.zone.shape, ring: _m3dRect && _m3dRect.getLatLngs()[0].length,
      world: _m3dWorld() };
    _m3dClose();
    _zone3DOpen('m3d', { type: 'circle', lat: 35, lng: -97, km: 300 });
    await new Promise(res => setTimeout(res, 200));
    const circ = { shape: _m3d.zone.shape, ring: _m3dRect && _m3dRect.getLatLngs()[0].length,
      inC: _m3dInside(0, 0), outC: _m3dInside(0.95, 0.95) };
    _m3dClose();
    return { box, circ, closed: !_m3dRect };
  });
  ok('a dragged box keeps its own proportions (wider than tall)', r.box.w > r.box.h * 1.4 && !r.box.shape && r.box.ring === 4
     && r.box.world.ax === 1 && r.box.world.ay < 0.7, JSON.stringify(r.box));
  ok('a drawn circle is kept, outlined, and tells inside from outside', r.circ.shape && r.circ.shape.type === 'circle' && r.circ.ring === 64
     && r.circ.inC && !r.circ.outC, JSON.stringify(r.circ));
  ok('closing takes the outline off the map', r.closed);
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
