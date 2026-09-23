#!/usr/bin/env node
/*
 * Satellite 3D: cloud tops in relief, drawn on a zone, with no WebGL.
 *
 *     node tools/test-sat-3d.mjs
 *
 * The parsing server is stubbed: /sat/cth/index and /sat/cth/frame answer with a
 * synthetic anvil (a round cloud 11 km tall in the middle of the box, clear
 * ground around it) that drifts east scan by scan. Checks that the map
 * menu's drawing opens this panel (not Radar 3D), that the frames land on
 * the one animation bar, that the software rasterizer really draws a
 * surface with the cloud standing above the ground and the nearest thing
 * winning, that the product on the map is draped over it when there is
 * one, that Radar inside borrows Radar 3D's volume without the two panels
 * cancelling each other, and that closing hands everything back.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the page carries the panel, the menu row and the doors');
{
  ok('a Satellite 3D panel of its own', PAGE.includes('id="s3d-panel"')
     && /<span class="xs-title">Satellite 3D<\/span>/.test(PAGE));
  ok('the map menu has a row for it, beside Radar 3D\'s',
     /_cmSat3DDraw\(\)[^\n]*Draw a 3D satellite zone/.test(PAGE));
  ok('it asks the parsing server\'s cloud-top doors', PAGE.includes('/sat/cth/index?') && PAGE.includes('/sat/cth/frame?'));
  ok('it has a Radar inside switch and a height stretch', PAGE.includes('id="s3d-radar"') && PAGE.includes('id="s3d-exag"'));
  ok('no WebGL anywhere in it', !/getContext\(['"]webgl/.test(PAGE));
  ok('the changelog announces it', /id: '2026-09-23-b'[^\n]*\n[^\n]*Satellite 3D/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  const a = PAGE.indexOf('// -- Satellite 3D -'), b = PAGE.indexOf('(function _r3dWireInfo');
  ok('no em dashes in the feature or this test', a > 0 && b > a && !PAGE.slice(a, b).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-sat-3d.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

// -- The stubbed parsing server -------------------------------------------------------
const GW = 60, GH = 40;
const T0 = Date.UTC(2026, 8, 23, 18, 1, 17);
const frameTimes = [0, 1, 2, 3, 4, 5].map(i => T0 + i * 300000);
const asked = { index: [], frame: [], wms: [], arcIndex: [], arcFrame: [] };
let wmsDown = false;              // the WMS has nothing (a travelled moment)
let piDown = false;               // the parsing server cannot be reached at all
let piBusyOnce = 0;               // answer the next N scan lists with a bare 503
let ch13Split = false;            // the map's Clean IR: cold cloud left, warm ground right
function synthFrame(t) {
  const shift = (t - T0) / 300000;                 // the anvil drifts a cell east a scan
  const h = Buffer.alloc(GW * GH * 2), g = Buffer.alloc(GW * GH);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const d = Math.hypot(i - (GW / 2 + shift), j - GH / 2);
    const k = j * GW + i;
    const m = d < 10 ? Math.round(11000 * Math.cos(d / 10 * Math.PI / 2) + 2000) : 0;
    h.writeUInt16LE(m, k * 2);
    g[k] = m ? 200 : 60;
  }
  return { w: GW, h: GH, heights: h.toString('base64'), ir: g.toString('base64'),
           source: 'acha+ir', a: 70000, b: -250, pairs: 900, tsfc: 295, t };
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// A picture whose left half is one colour and right half another.
function png2(w, h, left, right) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = x < w / 2 ? left : right, o = y * (w * 4 + 1) + 1 + x * 4;
    raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = c[3];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 4 + 1) + 1 + x * 4;
    raw[o] = rgba[0]; raw[o + 1] = rgba[1]; raw[o + 2] = rgba[2]; raw[o + 3] = rgba[3];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const CORS = { 'Access-Control-Allow-Origin': '*' };

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
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
  if (piDown && url.startsWith('https://pi.test/')) return route.abort('connectionrefused');
  if (url.startsWith('https://pi.test/sat/cth/index') && piBusyOnce > 0) {
    piBusyOnce--; asked.index.push(url);
    return route.fulfill({ status: 503, headers: CORS, body: '' });
  }
  if (ch13Split && url.includes('mesonet.agron.iastate.edu') && /ch13/.test(url) && /REQUEST=GetMap/.test(url)) {
    asked.wms.push(url);
    // White is the coldest IR shade (-100 C), dark grey is warm ground.
    return route.fulfill({ headers: CORS, contentType: 'image/png',
      body: png2(40, 20, [235, 235, 235, 255], [40, 40, 40, 255]) });
  }
  if (url.startsWith('https://pi.test/sat/cth/index')) {
    asked.index.push(url);
    return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({
      post: 'east', sector: 'conus', bucket: 'noaa-goes19', bounds: [[0, 0], [1, 1]],
      frames: frameTimes.map((t, i) => ({ t, stamp: 's' + i, key: 'ABI-L2-CMIPC/k' + i + '.nc' })) }) });
  }
  if (url.startsWith('https://pi.test/sat/cth/frame')) {
    asked.frame.push(url);
    const i = +(/k(\d)\.nc/.exec(decodeURIComponent(url)) || [0, 0])[1];
    return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify(synthFrame(frameTimes[i])) });
  }
  if (url.startsWith('https://pi.test/sat/archive/index')) {
    asked.arcIndex.push(url);
    return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({
      bucket: 'noaa-goes19', bounds: [[20, -110], [50, -80]],
      frames: [{ t: T0, stamp: 'a', key: 'ABI-L2-CMIPC/arc.nc' }] }) });
  }
  if (url.startsWith('https://pi.test/sat/archive/frame')) {
    asked.arcFrame.push(url);
    return route.fulfill({ headers: CORS, contentType: 'image/png', body: png(8, 8, [30, 60, 230, 255]) });
  }
  if (url.includes('mesonet.agron.iastate.edu') && /REQUEST=GetMap/i.test(url) && /SRS=EPSG:4326/.test(url)) {
    asked.wms.push(url);
    if (wmsDown) return route.fulfill({ status: 404, headers: CORS, body: 'no' });
    return route.fulfill({ headers: CORS, contentType: 'image/png', body: png(8, 8, [230, 30, 30, 255]) });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => { _hdBase = 'https://pi.test'; });

console.log('\n2. the menu row draws a zone, and the zone opens Satellite 3D');
{
  const r = await p.evaluate(async () => {
    map.setView([36.1, -95.9], 7);
    await new Promise(res => setTimeout(res, 200));
    _cmOpen({ latlng: L.latLng(36.1, -95.9) });
    const row = Array.from(document.querySelectorAll('#map-ctx-menu .cm-item'))
      .find(el => /Draw a 3D satellite zone/i.test(el.textContent));
    if (row) row.click();
    const drawing = { on: _r3dDrawOn, target: _r3dDrawFor };
    const c = map.getContainer(), rc = c.getBoundingClientRect();
    const ev = (type, xy) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: 9, clientX: rc.left + xy[0], clientY: rc.top + xy[1], button: 0, bubbles: true, cancelable: true }));
    ev('pointerdown', [480, 300]); ev('pointermove', [600, 380]); ev('pointerup', [640, 400]);
    const la = map.containerPointToLatLng([480, 300]), lb = map.containerPointToLatLng([640, 400]);
    const out = { row: !!row, drawing, s3d: _s3dOn, r3d: _r3dOn, zone: _s3dZone && { ..._s3dZone },
                  want: { s: lb.lat, w: la.lng, n: la.lat, e: lb.lng },
                  rect: !!(_s3dRect && map.hasLayer(_s3dRect)), after: _r3dDrawFor,
                  open: document.getElementById('s3d-panel').classList.contains('open') };
    return out;
  });
  ok('the row exists and starts a drawing aimed at Satellite 3D', r.row && r.drawing.on && r.drawing.target === 's3d',
     JSON.stringify(r.drawing));
  ok('the drag opened Satellite 3D, not Radar 3D', r.s3d && !r.r3d && r.open);
  ok('the zone is the box that was dragged', r.zone && Math.abs(r.zone.n - r.want.n) < 0.01
     && Math.abs(r.zone.w - r.want.w) < 0.01 && Math.abs(r.zone.s - r.want.s) < 0.01 && Math.abs(r.zone.e - r.want.e) < 0.01,
     JSON.stringify(r));
  ok('the zone is outlined on the map', r.rect);
  ok('the drawing tool goes back to meaning Radar 3D afterwards', r.after === 'r3d');
}

console.log('\n3. the scans land on the animation bar, newest first then the rest');
{
  await p.waitForFunction(() => _s3dFrames.length === 6, null, { timeout: 20000 }).catch(() => {});
  const r = await p.evaluate(() => ({
    n: _s3dFrames.length, idx: _s3dIdx, t: _s3dFrames.map(f => f.t),
    src: _animSource(), ready: _animationReady(),
    status: document.getElementById('s3d-status').textContent,
    where: document.getElementById('s3d-where').textContent,
    top: _s3dFrames[_s3dIdx] && _s3dFrames[_s3dIdx].data.maxKm,
  }));
  ok('all six scans loaded, oldest first', r.n === 6 && r.t.every((t, i) => !i || t > r.t[i - 1]), JSON.stringify(r.t));
  ok('the newest is on screen', r.idx === 5);
  ok('the bar knows them as Satellite 3D\'s frames', r.src.id === 's3d' && r.src.times.length === 6 && r.ready);
  ok('the index and every frame asked for the drawn box', asked.index.length >= 1
     && /south=[\d.]+&west=-[\d.]+&north=[\d.]+&east=-[\d.]+/.test(asked.index[0])
     && asked.frame.length >= 6 && asked.frame.every(u => /bucket=noaa-goes19/.test(u) && /sector=conus/.test(u)));
  ok('the status says where the heights came from and how tall', /NOAA cloud-top heights \+ IR/.test(r.status)
     && /tops to 43 kft/.test(r.status), r.status);
  ok('the header names the satellite and the box', /GOES-East/.test(r.where) && /CONUS/.test(r.where) && /km/.test(r.where), r.where);
  const s = await p.evaluate(() => { stepFrame(-1); const a = _s3dIdx; seekFrame(1); const b2 = _s3dIdx;
    stepFrame(1); return { a, b: b2, c: _s3dIdx }; });
  ok('stepping and seeking the bar moves the scans', s.a === 4 && s.b === 1 && s.c === 2, JSON.stringify(s));
}

console.log('\n4. the rasterizer draws the surface, cloud above ground, nearest wins');
{
  const r = await p.evaluate(async () => {
    _s3dSetFrame(5);
    _s3dCam = { yaw: 0, pitch: 0.12, dist: 400 };      // low, from the south
    _s3dExagSel = '20';
    _s3dDirty = false; _s3dRender(); await _s3dRenderIdle(15000);
    const cv = document.getElementById('s3d-canvas'), ctx = cv.getContext('2d');
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    // Bright is cloud (grey 200 lit), dim is ground (grey 60). Where does
    // each reach up the picture?
    let brightTop = cv.height, dimTop = cv.height, bright = 0, dim = 0;
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i], row = (i >> 2) / cv.width | 0;
      if (px[i] === px[i + 1] && px[i + 1] === px[i + 2]) {
        if (v > 110) { bright++; if (row < brightTop) brightTop = row; }
        else if (v > 18 && v < 60) { dim++; if (row < dimTop) dimTop = row; }
      }
    }
    // The pure rasterizer on a 3 by 3 plate: a tall middle cell must hide
    // the ground behind it from a camera looking straight across.
    const d = { w: 3, h: 3, hm: new Float32Array([0, 0, 0, 0, 5, 0, 0, 0, 0]),
                rgb: new Uint8Array(27).fill(50) };
    for (let c = 0; c < 3; c++) d.rgb[4 * 3 + c] = 250;
    const z = { wKm: 30, hKm: 30 };
    const cam = { yaw: 0, pitch: 0.5, dist: 60 };
    const saved = _s3dCam; _s3dCam = cam; _s3dExagSel = '1';
    const v = _s3dCamBasis();
    const out = _s3dRaster(d, z, v, 64, 48, 1, 1, 1);
    _s3dCam = saved;
    let covered = 0, peak = 0;
    for (let i = 0; i < out.length; i += 4) { if (out[i + 3]) covered++; if (out[i] > peak) peak = out[i]; }
    return { bright, dim, brightTop, dimTop, covered, peak, h: cv.height };
  });
  ok('both cloud and ground are drawn', r.bright > 500 && r.dim > 500, JSON.stringify(r));
  ok('the cloud stands up above the ground on screen', r.brightTop < r.dimTop - 10, JSON.stringify(r));
  ok('a tiny plate is covered by its triangles and its peak is lit bright', r.covered > 100 && r.peak > 150,
     JSON.stringify(r));
  const o = await p.evaluate(async () => {
    const cv = document.getElementById('s3d-canvas'), rc = cv.getBoundingClientRect();
    const y0 = _s3dCam.yaw;
    const ev = (type, x) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 3, clientX: rc.left + x,
      clientY: rc.top + 100, button: 0, bubbles: true }));
    ev('pointerdown', 100); ev('pointermove', 180); ev('pointerup', 180);
    const fast = _s3dFast;
    await new Promise(res => setTimeout(res, 400));
    await _s3dRenderIdle(15000);
    return { turned: _s3dCam.yaw - y0, fast, settled: !_s3dFast };
  });
  ok('dragging the picture orbits, drawn coarse while moving and fine after', o.turned > 0.5 && o.fast && o.settled,
     JSON.stringify(o));
}

console.log('\n5. the product on the map is draped over the relief');
{
  const r = await p.evaluate(async () => {
    const was = activeLayers.satellite;
    activeLayers.satellite = true;
    _goesProductId = 'ch13';
    const fr = _s3dFrames[_s3dIdx];
    _s3dSkin(fr, _s3dGen);
    await new Promise(res => setTimeout(res, 800));
    activeLayers.satellite = was;
    return { skin: fr.data.skin, r: fr.data.rgb[0], g: fr.data.rgb[1],
             status: document.getElementById('s3d-status').textContent };
  });
  ok('the satellite service was asked for exactly this box in lat/lon', asked.wms.length >= 1
     && /BBOX=-[\d.]+,[\d.]+,-[\d.]+,[\d.]+/.test(asked.wms[0]) && /TIME=2026-09-23T18:2\d:00Z/.test(asked.wms[0]),
     asked.wms[0]);
  ok('its colours replaced the grey', r.skin === 'Clean IR' && r.r > 200 && r.g < 60, JSON.stringify(r));
  ok('and the status names the product', /^Clean IR/.test(r.status), r.status);
}

console.log('\n5b. ANY satellite product drapes: every channel, composite and global mosaic');
{
  const r = await p.evaluate(async () => {
    const menu = Array.from(document.querySelectorAll('#s3d-skin option')).map(o => o.value);
    const z = _s3dZone;
    // The parsing server's composite and mosaic pictures, stood in for by
    // pictures drawn here: left half green, right half magenta, covering a
    // box bigger than the zone, so the crop has to find the zone inside it.
    const piCalls = [];
    const real = _goesPiFramesFor;
    const pic = (() => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 100;
      const x = c.getContext('2d');
      x.fillStyle = 'rgb(20,200,40)'; x.fillRect(0, 0, 100, 100);
      x.fillStyle = 'rgb(220,20,220)'; x.fillRect(100, 0, 100, 100);
      return c.toDataURL();
    })();
    const midLng = (z.w + z.e) / 2, spanLng = z.e - z.w, spanLat = z.n - z.s;
    // Centred on the zone's middle so the colour change falls on its middle.
    const bounds = [[z.s - spanLat, midLng - spanLng], [z.n + spanLat, midLng + spanLng]];
    window._goesPiFramesFor = async (product, region) => {
      piCalls.push(product.id + '@' + region);
      return [{ time: new Date(_s3dFrames[_s3dIdx].t), url: pic, bounds }];
    };
    const fr = _s3dFrames[_s3dIdx];
    const results = {};
    for (const prod of GOES_PRODUCTS) {
      _s3dSkinSel = prod.id;
      _s3dPiFrameMemo.clear();
      await _s3dSkin(fr, _s3dGen);
      const d = fr.data, row = Math.floor(d.h / 2);
      const L = row * d.w + 2, R = row * d.w + d.w - 3;
      results[prod.id] = { skin: d.skin, left: [d.rgb[L * 3], d.rgb[L * 3 + 1], d.rgb[L * 3 + 2]],
                           right: [d.rgb[R * 3], d.rgb[R * 3 + 1], d.rgb[R * 3 + 2]] };
    }
    _s3dSkinSel = 'ir';
    await _s3dSkin(fr, _s3dGen);
    const ir = { skin: fr.data.skin, grey: fr.data.rgb[0] === fr.data.rgb[1] && fr.data.rgb[1] === fr.data.rgb[2] };
    // A composite with no picture over the zone at all: said, and the grey stays.
    window._goesPiFramesFor = async () => [];
    _s3dSkinSel = 'rgb-dust'; _s3dPiFrameMemo.clear();
    await _s3dSkin(fr, _s3dGen); _s3dSayFrame();
    const miss = { skin: fr.data.skin, status: document.getElementById('s3d-status').textContent };
    window._goesPiFramesFor = real;
    return { menu, ids: GOES_PRODUCTS.map(p => p.id), results, piCalls, ir, miss };
  });
  ok('the Picture menu offers every satellite product there is, plus the map\'s and plain infrared',
     r.ids.every(id => r.menu.includes(id)) && r.menu.includes('map') && r.menu.includes('ir'),
     r.ids.filter(id => !r.menu.includes(id)).join(','));
  const failed = r.ids.filter(id => !r.results[id] || !r.results[id].skin);
  ok(`all ${r.ids.length} products drape over the relief`, failed.length === 0, failed.join(','));
  const comps = r.ids.filter(id => /^rgb-|^glb-/.test(id));
  ok('a composite or mosaic is cropped to the zone: its left half on the left, right half on the right',
     comps.every(id => { const x = r.results[id]; return x.left[1] > 150 && x.left[0] < 80 && x.right[0] > 150 && x.right[1] < 80; }),
     JSON.stringify(r.results[comps[0]]));
  ok('composites come from the sector the heights came from, the mosaic from its worldwide one',
     r.piCalls.includes('rgb-airmass@east') && r.piCalls.includes('glb-ir@global'), r.piCalls.slice(0, 3).join(' '));
  ok('Infrared picks the heights\' own grey scan', r.ir.skin === null && r.ir.grey, JSON.stringify(r.ir));
  ok('a product with nothing over the zone says so and keeps the grey', r.miss.skin === null
     && /Infrared \(no Dust here\)/.test(r.miss.status), r.miss.status);
}
{
  // A plain channel the WMS no longer holds (a travelled moment): NOAA's
  // archive on the parsing server fills in.
  wmsDown = true;
  const r = await p.evaluate(async () => {
    const fr = _s3dFrames[_s3dIdx];
    _s3dSkinSel = 'ch09';
    await _s3dSkin(fr, _s3dGen);
    const out = { skin: fr.data.skin, b: fr.data.rgb[2], r: fr.data.rgb[0] };
    _s3dSkinSel = 'map';
    return out;
  });
  wmsDown = false;
  ok('when the WMS has nothing, the channel comes from NOAA\'s archive instead',
     r.skin === 'Mid Water Vapor' && r.b > 180 && r.r < 80 && asked.arcIndex.some(u => /band=9/.test(u))
     && asked.arcFrame.length >= 1, JSON.stringify(r) + ' ' + asked.arcIndex[0]);
}

console.log('\n6. Radar inside borrows Radar 3D\'s volume, and neither cancels the other');
{
  const r = await p.evaluate(async () => {
    const realFetch = _fetchVolumeDirect, realBuild = _r3dBuildFrame;
    let aliveFn = null, asked = null;
    window._fetchVolumeDirect = async (site) => { asked = site; return new ArrayBuffer(16); };
    window._r3dBuildFrame = async (buf, layer, sitePos, zone, token, onTilt, alive) => {
      aliveFn = alive;
      const site = { x: 0, y: -80 };
      const xs = [], ys = [], zs = [], vs = [], rs = [], segs = [];
      [0.5, 1.5, 2.4, 3.4, 4.5, 6, 8, 10].forEach(a2 => {
        const start = xs.length;
        for (let x = -20; x <= 20; x += 2) for (let y = -20; y <= 20; y += 2) {
          const s2 = Math.hypot(x - site.x, y - site.y);
          xs.push(x); ys.push(y); zs.push(_xsBeamHeightKm(s2, a2, 0)); vs.push(60); rs.push(2, s2 * 0.00873);
        }
        segs.push({ start, end: xs.length, angle: a2 });
      });
      return _r3dFinishFrame({ xs, ys, zs, vs, rs, site }, segs, null, segs.length);
    };
    const box = document.getElementById('s3d-radar');
    box.checked = true; box.dispatchEvent(new Event('change'));
    for (let i = 0; i < 100 && !_s3dRadar; i++) await new Promise(res => setTimeout(res, 50));
    const alpha = _s3dAlpha;
    const aliveBefore = aliveFn ? aliveFn() : null;
    _r3dToken++;                                         // Radar 3D's own cancel must not touch it
    const aliveAfterR3d = aliveFn ? aliveFn() : null;
    _s3dCam = { yaw: 0.6, pitch: 0.5, dist: 300 };
    _s3dDirty = false; _s3dRender(); await _s3dRenderIdle(20000);
    const cv = document.getElementById('s3d-canvas');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let colour = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 60) colour++;
    const status = document.getElementById('s3d-status').textContent;
    const presence = _presenceSummary();
    window._fetchVolumeDirect = realFetch; window._r3dBuildFrame = realBuild;
    const z = _s3dZone, near = _r3dNearestStation(z.lat, z.lng);
    return { want: String(near.id).toLowerCase(), asked, radar: !!_s3dRadar, site: _s3dRadar && _s3dRadar.site, alpha, aliveBefore, aliveAfterR3d,
             colour, status, presence: JSON.stringify(presence), aliveFn: !!aliveFn,
             aliveRef: (window.__s3dAlive = aliveFn, 1) };
  });
  ok('the nearest radar\'s whole volume was fetched', r.asked === r.want && r.radar && r.site === r.want, JSON.stringify(r));
  ok('the clouds went see-through when the radar came on', r.alpha <= 0.6, String(r.alpha));
  ok('the build is cancelled by Satellite 3D\'s own test, not Radar 3D\'s token', r.aliveFn && r.aliveBefore === true
     && r.aliveAfterR3d === true);
  ok('the storm\'s colours show through the clouds', r.colour > 300, String(r.colour));
  const W = String(r.want).toUpperCase();
  ok('the status and the Discord line mention the radar', r.status.includes('radar ' + W)
     && /Satellite 3D/.test(r.presence) && r.presence.includes(W), r.status + ' / ' + r.presence);
}

console.log('\n7. closing hands everything back; opening Radar 3D closes this');
{
  const r = await p.evaluate(async () => {
    _s3dClose();
    const closed = { on: _s3dOn, rect: !!_s3dRect, src: _animSource().id,
                     open: document.getElementById('s3d-panel').classList.contains('open'),
                     alive: window.__s3dAlive ? window.__s3dAlive() : null };
    _s3dOpenBounds(35.5, -97, 36.5, -95.5);
    const opened = _s3dOn;
    _r3dOpenBounds(35.5, -97, 36.5, -95.5);
    const swapped = { s3d: _s3dOn, r3d: _r3dOn };
    _r3dClose();
    const tooBig = _s3dOpenBounds(10, -130, 40, -60);
    const tiny = _s3dOpenBounds(35, -96, 35.01, -95.99);
    return { closed, opened, swapped, tooBig, tiny, on: _s3dOn };
  });
  ok('closing takes the panel, the outline and the bar away', !r.closed.on && !r.closed.rect && !r.closed.open
     && r.closed.src !== 's3d', JSON.stringify(r.closed));
  ok('and stops any radar still being built for it', r.closed.alive === false);
  ok('opening Radar 3D closes Satellite 3D (one owns the bar at a time)', r.opened && !r.swapped.s3d && r.swapped.r3d);
  ok('a box bigger than the parsing server will build, or a sliver, is refused', r.tooBig === false && r.tiny === false && !r.on);
}

console.log('\n7b. a busy parsing server is asked again, not given up on');
{
  piBusyOnce = 1;
  const before = asked.index.length;
  await p.evaluate(() => { _s3dOpenBounds(35.5, -97, 36.5, -95.5); });
  await p.waitForFunction(() => _s3dFrames.length === 6, null, { timeout: 30000 }).catch(() => {});
  const r = await p.evaluate(() => ({ n: _s3dFrames.length, src: _s3dFrames[0] && _s3dFrames[0].data.source,
    status: document.getElementById('s3d-status').textContent }));
  ok('one bare 503, then the retry loads all six scans from the parsing server',
     asked.index.length - before === 2 && r.n === 6 && r.src === 'acha+ir', JSON.stringify(r));
  await p.evaluate(() => _s3dClose());
}

console.log('\n7c. no parsing server at all: the browser builds the heights from the map\'s infrared');
{
  piDown = true; ch13Split = true;
  await p.evaluate(() => { _s3dOpenBounds(35.5, -97, 36.5, -95.5); });
  await p.waitForFunction(() => _s3dFrames.length === 6, null, { timeout: 40000 }).catch(() => {});
  const r = await p.evaluate(() => {
    const f = _s3dFrames[_s3dFrames.length - 1], d = f && f.data;
    const row = d ? Math.floor(d.h / 2) : 0;
    return { n: _s3dFrames.length, src: d && d.source,
             left: d && d.hm[row * d.w + 2], right: d && d.hm[row * d.w + d.w - 3],
             bar: _animSource().id, times: _s3dFrames.map(x => x.t),
             status: document.getElementById('s3d-status').textContent,
             where: document.getElementById('s3d-where').textContent };
  });
  piDown = false; ch13Split = false;
  ok('six frames were built with no parsing server, straight from the map service', r.n === 6
     && r.src === 'map-ir' && r.bar === 's3d', JSON.stringify(r));
  ok('cold cloud stands tall (about 17 km) and warm ground stays flat', r.left > 14 && r.left <= 18 && r.right === 0,
     r.left + ' / ' + r.right);
  ok('the frames are ten minutes apart, oldest first', r.times.every((t, i) => !i || t - r.times[i - 1] === 600000),
     JSON.stringify(r.times));
  ok('the status says the heights came from the map because the parsing server was offline',
     /parsing server offline/.test(r.status), r.status);
  ok('and still names the satellite and sector', /GOES-East/.test(r.where) && /CONUS/.test(r.where), r.where);
  await p.evaluate(() => _s3dClose());
}

console.log('\n7d. everything Radar 3D has that fits a cloud-top surface');
{
  await p.evaluate(() => { _s3dOpenBounds(35.5, -97, 36.5, -95.5); });
  await p.waitForFunction(() => _s3dFrames.length === 6, null, { timeout: 30000 }).catch(() => {});
  const r = await p.evaluate(async () => {
    const out = {};
    const $ = (id) => document.getElementById(id);
    out.controls = ['s3d-full', 's3d-walk-btn', 's3d-vr-btn', 's3d-info-btn', 's3d-above', 's3d-upto', 's3d-smooth',
                    's3d-mode', 's3d-cut', 's3d-cutpct', 's3d-hunit', 's3d-zoom', 's3d-yaw', 's3d-walk-pad',
                    's3d-rprod', 's3d-rsite'].filter(id => !$(id));
    const d = _s3dFrames[_s3dIdx].data;
    const set = (id, v) => { const el = $(id); el.value = String(v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input')); };
    const cloudy = (hm) => { let n = 0, mx = 0; for (const v of hm) { if (v > 0) n++; if (v > mx) mx = v; } return { n, mx }; };
    const base = cloudy(_s3dShownHeights(d));
    set('s3d-above', 30); const above = cloudy(_s3dShownHeights(d)); const aboveLabel = $('s3d-above-label').textContent;
    set('s3d-above', 0); set('s3d-upto', 20); const upto = cloudy(_s3dShownHeights(d));
    set('s3d-upto', 60); set('s3d-smooth', 100); const sm = _s3dShownHeights(d);
    let jump = 0, jump0 = 0;
    for (let i = 1; i < d.w; i++) { const k = 20 * d.w + i;
      jump = Math.max(jump, Math.abs(sm[k] - sm[k - 1])); jump0 = Math.max(jump0, Math.abs(d.hm[k] - d.hm[k - 1])); }
    set('s3d-smooth', 0);
    out.filters = { base, above, aboveLabel, upto, jump, jump0 };
    // The looks and the cutaway, straight through the rasterizer.
    const z = _s3dZone, v = _s3dCamBasis();
    const count = (px) => { let n = 0, grey = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 3]) { n++; if (px[i] === px[i + 1] && px[i + 1] === px[i + 2]) grey++; } return { n, grey }; };
    const lit = count(_s3dRaster(d, z, v, 200, 120, 10, 1, 1, { mode: 'lit' }));
    const hc = count(_s3dRaster(d, z, v, 200, 120, 10, 1, 1, { mode: 'height' }));
    set('s3d-cut', 'e'); set('s3d-cutpct', 50);
    const cut = count(_s3dRaster(d, z, v, 200, 120, 10, 1, 1, { box: _s3dCutBox(z.wKm / 2, z.hKm / 2) }));
    set('s3d-cut', 'off');
    out.looks = { lit, hc, cut };
    // Units.
    set('s3d-hunit', 'km'); set('s3d-upto', 33);
    out.units = $('s3d-upto-label').textContent;
    set('s3d-hunit', 'kft'); set('s3d-upto', 60);
    // Walk: the pad shows, the orbit bars step aside, W walks forward.
    $('s3d-walk-btn').click();
    const w0 = { ..._s3dWalk };
    const padShown = $('s3d-walk-pad').style.display !== 'none';
    const barsHidden = document.querySelector('#s3d-panel .r3d-cam-zoom').style.display === 'none';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
    await new Promise(res => setTimeout(res, 300));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
    const moved = Math.hypot(_s3dWalk.x - w0.x, _s3dWalk.y - w0.y);
    // VR: two eyes, fullscreen; then back out of both.
    $('s3d-vr-btn').click();
    _s3dDirty = false; _s3dRender(); await _s3dRenderIdle(15000);
    const vr = { on: _s3dVr, full: $('s3d-panel').classList.contains('fullscreen') };
    $('s3d-vr-btn').click(); $('s3d-walk-btn').click();
    $('s3d-panel').classList.remove('fullscreen');
    out.walk = { padShown, barsHidden, moved, vr, off: !_s3dWalk && !_s3dVr };
    // Fullscreen and info.
    $('s3d-full').click(); const full = $('s3d-panel').classList.contains('fullscreen'); $('s3d-full').click();
    let infoText = null; const realInfo = window._ovShowInfo; window._ovShowInfo = (t) => { infoText = t; };
    $('s3d-info-btn').click(); window._ovShowInfo = realInfo;
    out.chrome = { full, info: infoText };
    // Camera bars drive the orbit.
    const y0 = _s3dCam.yaw; set('s3d-yaw', 90); const d0 = _s3dCam.dist; set('s3d-zoom', 900);
    out.bars = { yaw: _s3dCam.yaw - y0, closer: _s3dCam.dist < d0 };
    // Radar pickers.
    out.radar = { products: $('s3d-rprod').options.length, sites: Array.from($('s3d-rsite').options).map(o => o.textContent).slice(0, 3) };
    // You.
    const realU = window._r3dUserLatLng; window._r3dUserLatLng = () => ({ lat: _s3dZone.lat, lng: _s3dZone.lng });
    out.you = _s3dYou(); window._r3dUserLatLng = realU;
    return out;
  });
  ok('every Radar 3D control that fits is here: fullscreen, walk, VR, info, filters, look, cutaway, units, camera bars, radar pickers',
     r.controls.length === 0, r.controls.join(','));
  ok('Tops above hides the low clouds and keeps the tall ones', r.filters.above.n < r.filters.base.n
     && r.filters.above.mx === r.filters.base.mx && r.filters.aboveLabel === '30 kft', JSON.stringify(r.filters));
  ok('Up to shaves the tops at that height', r.filters.upto.mx <= 20 / 3.28084 + 1e-3 && r.filters.upto.n === r.filters.base.n,
     JSON.stringify(r.filters.upto));
  ok('Smoothing turns cliffs into slopes', r.filters.jump < r.filters.jump0 * 0.7, r.filters.jump + ' vs ' + r.filters.jump0);
  ok('Height colours colour the surface; lit keeps the grey picture', r.looks.hc.grey < r.looks.hc.n * 0.2
     && r.looks.lit.grey > r.looks.lit.n * 0.8, JSON.stringify(r.looks));
  ok('the cutaway removes the side it cuts from', r.looks.cut.n < r.looks.lit.n * 0.8, JSON.stringify(r.looks));
  ok('heights read in the chosen unit', r.units === '10 km', r.units);
  ok('Walk shows the pad, hides the orbit bars, and W walks forward', r.walk.padShown && r.walk.barsHidden
     && r.walk.moved > 1, JSON.stringify(r.walk));
  ok('VR goes fullscreen in stereo, and both switch off again', r.walk.vr.on && r.walk.vr.full && r.walk.off,
     JSON.stringify(r.walk));
  ok('fullscreen toggles, and the info button explains the panel', r.chrome.full && /cloud tops/i.test(r.chrome.info || ''),
     JSON.stringify(r.chrome).slice(0, 120));
  ok('the camera bars turn and zoom the orbit', Math.abs(r.bars.yaw) > 0.5 && r.bars.closer, JSON.stringify(r.bars));
  ok('Radar inside offers every radar product and the nearest radars', r.radar.products >= 6
     && /^Nearest/.test(r.radar.sites[0]) && /km/.test(r.radar.sites[1] || ''), JSON.stringify(r.radar));
  ok('You is placed in the zone\'s own frame', r.you && Math.abs(r.you.x) < 0.5 && Math.abs(r.you.y) < 0.5, JSON.stringify(r.you));
  await p.evaluate(() => _s3dClose());
}

console.log('\n7e. the menu row and its new icon');
{
  const r = await p.evaluate(() => {
    _cmOpen({ latlng: map.getCenter() });
    const rows = Array.from(document.querySelectorAll('#map-ctx-menu .cm-item'));
    const row = rows.find(el => /Draw a 3D radar zone/.test(el.textContent));
    const out = { row: !!row, icon: row ? (row.querySelector('use') || {}).getAttribute && row.querySelector('use').getAttribute('href') : null,
                  old: rows.some(el => /^\s*Draw a 3D zone\s*$/.test(el.textContent)),
                  symbol: !!document.getElementById('ic-radar3d') };
    try { _cmClose(); } catch (e) {}
    return out;
  });
  ok('the map menu says Draw a 3D radar zone, with its own new icon', r.row && !r.old && r.symbol
     && /ic-radar3d/.test(r.icon || ''), JSON.stringify(r));
}

console.log('\n7f. both 3D panels follow the comparison pane the zone is drawn over');
{
  const r = await p.evaluate(async () => {
    const rc = map.getContainer().getBoundingClientRect();
    const ll = (fx, fy) => map.containerPointToLatLng([rc.width * fx, rc.height * fy]);
    const box = (fx) => { const a = ll(fx - 0.05, 0.45), b = ll(fx + 0.05, 0.55); return [b.lat, a.lng, a.lat, b.lng]; };
    // Satellite comparison: pane B, on the right, shows Mid Water Vapor.
    activeLayers.satellite = true; _goesProductId = 'ch13';
    _scOn = true; _scSetGrid(1, 2);
    _scSlots.push({ id: 'sfollow', productId: 'ch09', regionId: 'auto', kind: 'wms', layer: null, frames: null, labelEl: null, token: 0 });
    _s3dOpenBounds(...box(0.75)); const right = (_s3dSkinProduct() || {}).id; _s3dClose();
    _s3dOpenBounds(...box(0.25)); const left = (_s3dSkinProduct() || {}).id; _s3dClose();
    _scSlots.length = 0; _scSetGrid(null); _scOn = false; activeLayers.satellite = false;
    // Radar comparison: pane B is KTLX velocity.
    _rcOn = true; _rcSetGrid(1, 2);
    _rcSlots.push({ id: 'rfollow', site: 'ktlx', prodSel: 'vel', kind: 'wms', layer: null, labelEl: null, token: 0 });
    _r3dOpenBounds(...box(0.75));
    const r3d = { station: _r3dStation, product: document.getElementById('r3d-product').value };
    _r3dClose();
    // Satellite 3D's Radar inside, over the same pane.
    let asked = null; const realF = _fetchVolumeDirect;
    window._fetchVolumeDirect = async (site) => { asked = site; throw new Error('stub'); };
    _s3dOpenBounds(...box(0.75));
    _s3dRadarOn = true; await _s3dRadarLoad();
    const inside = { asked, product: _s3dRadarProduct };
    _s3dRadarOn = false; _s3dClose(); _s3dRadarProduct = 'ref';
    window._fetchVolumeDirect = realF;
    _rcSlots.length = 0; _rcSetGrid(null); _rcOn = false;
    return { right, left, r3d, inside };
  });
  ok('Satellite 3D drapes the product of the satellite pane it is drawn over', r.right === 'ch09' && r.left === 'ch13',
     JSON.stringify(r));
  ok('Radar 3D opens on the radar pane\'s own radar and product', r.r3d.station === 'ktlx' && r.r3d.product === 'vel',
     JSON.stringify(r.r3d));
  ok('and Satellite 3D\'s Radar inside uses that radar pane too', r.inside.asked === 'ktlx' && r.inside.product === 'vel',
     JSON.stringify(r.inside));
}

console.log('\n7g. the Time Machine: a jump reloads the zone at that moment, live brings it back');
{
  const r = await p.evaluate(async () => {
    _s3dOpenBounds(35.5, -97, 36.5, -95.5);
    for (let i = 0; i < 100 && _s3dFrames.length < 6; i++) await new Promise(res => setTimeout(res, 100));
    const out = {};
    // The panel's own clock button opens the satellite's Time Machine.
    document.getElementById('s3d-panel').classList.add('fullscreen');
    document.getElementById('s3d-tm-btn').click();
    out.opened = { modal: !!document.querySelector('#tm-modal.open'), scope: _tmScope,
                   leftFull: !document.getElementById('s3d-panel').classList.contains('fullscreen') };
    // Travel. Composites are asked for with the travelled clock in force.
    const piAt = [];
    const realPi = window._goesPiFramesFor;
    window._goesPiFramesFor = async (product) => { piAt.push(_tmSatAt); return []; };
    const T = Date.UTC(2025, 5, 14, 20, 0);
    await _tmJump(T);
    for (let i = 0; i < 100 && (_s3dFrames.length < 6 || !_s3dIndex); i++) await new Promise(res => setTimeout(res, 100));
    out.travel = { at: _tmSatAt, where: document.getElementById('s3d-where').textContent,
                   btnOn: document.getElementById('s3d-tm-btn').classList.contains('on') };
    _s3dSkinSel = 'rgb-airmass';
    await _s3dSkin(_s3dFrames[_s3dIdx], _s3dGen);
    out.piAt = piAt.slice();
    // A plain channel at the travelled moment comes from NOAA's archive
    // first, not the map service.
    const arcBefore = window.__arcCount ? window.__arcCount() : 0;
    _s3dSkinSel = 'ch02';
    await _s3dSkin(_s3dFrames[_s3dIdx], _s3dGen);
    out.chSkin = _s3dFrames[_s3dIdx].data.skin;
    _s3dSkinSel = 'map';
    // Back to live.
    _tmScope = 'sat';
    await _tmLive();
    for (let i = 0; i < 100 && _s3dFrames.length < 6; i++) await new Promise(res => setTimeout(res, 100));
    out.live = { at: _tmSatAt, where: document.getElementById('s3d-where').textContent,
                 btnOn: document.getElementById('s3d-tm-btn').classList.contains('on') };
    window._goesPiFramesFor = realPi;
    try { _tmClose(); } catch (e) {}
    _s3dClose();
    return { out, T };
  });
  const travelled = asked.index.filter(u => /&at=\d+/.test(u));
  const lastIdx = asked.index[asked.index.length - 1];
  ok('the panel\'s clock button opens the satellite Time Machine, leaving fullscreen first',
     r.out.opened.modal && r.out.opened.scope === 'sat' && r.out.opened.leftFull, JSON.stringify(r.out.opened));
  ok('a jump reloads the zone at that moment', travelled.some(u => u.includes('&at=' + r.T)),
     travelled.slice(-1)[0]);
  ok('the header shows the moment and the clock button says it is travelled', /2025-06-14 20:00Z/.test(r.out.travel.where)
     && r.out.travel.btnOn, JSON.stringify(r.out.travel));
  ok('a plain channel at the travelled moment is taken from NOAA\'s archive',
     r.out.chSkin === 'Red Visible' && asked.arcIndex.some(u => /band=2&/.test(u) && u.includes('&at=')),
     String(r.out.chSkin) + ' ' + asked.arcIndex.slice(-1)[0]);
  ok('a composite skin is chosen with the travelled clock in force', r.out.piAt.length && r.out.piAt.every(a => a === r.T),
     JSON.stringify(r.out.piAt));
  ok('back to live reloads without a moment, and the marks clear', !/&at=/.test(lastIdx) && r.out.live.at == null
     && !/Z$/.test(r.out.live.where) && !r.out.live.btnOn, lastIdx + ' ' + JSON.stringify(r.out.live));
}

console.log('\n8. nothing above threw');
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
