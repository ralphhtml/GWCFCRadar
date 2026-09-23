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
const asked = { index: [], frame: [], wms: [] };
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
  if (url.includes('mesonet.agron.iastate.edu') && /REQUEST=GetMap/i.test(url) && /SRS=EPSG:4326/.test(url)) {
    asked.wms.push(url);
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

console.log('\n8. nothing above threw');
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
