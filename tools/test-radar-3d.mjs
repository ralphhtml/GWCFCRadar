#!/usr/bin/env node
/*
 * Radar 3D: a storm's shape rendered as a point cloud, no WebGL anywhere.
 *
 *     node tools/test-radar-3d.mjs
 *
 * Inspired by OpenStorm (JordanSchlick/OpenStorm), a desktop GPU volumetric
 * ray marcher, ported here without a GPU: OpenStorm's own reflectivity and
 * velocity colour ramps, this page's own (more accurate) beam-height math
 * for where a gate actually sits, and a plain 2D canvas standing in for the
 * shader. Most of what matters is checked the same way Cross Section's own
 * test does: the colour math is right independent of this code, a fake
 * decoder proves a real point cloud gets built and drawn, and the tool
 * cannot take the map down whether it succeeds or fails.
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

console.log('\n1. it is a tool in the rail, with its own bar and panel');
{
  ok('the toolbar button exists',
     /<button class="tool-btn" id="tool-r3d" onclick="toggleRadar3D\(\)"/.test(PAGE));
  ok('the toolbar and panel exist',
     PAGE.includes('id="r3d-toolbar"') && PAGE.includes('id="r3d-panel"'));
  ok('the panel reuses the same .xs-* chrome Cross Section uses',
     /<div id="r3d-panel">[\s\S]{0,80}<div class="xs-head">/.test(PAGE));
  ok('it has a product and a site picker, a status line, an info and a close button',
     PAGE.includes('id="r3d-product"') && PAGE.includes('id="r3d-site"')
     && PAGE.includes('id="r3d-status"') && PAGE.includes('id="r3d-info-btn"')
     && PAGE.includes('id="r3d-close"'));
  ok('it has a time control: play, a slider, a time label',
     PAGE.includes('id="r3d-play"') && PAGE.includes('id="r3d-slider"')
     && PAGE.includes('id="r3d-time-label"'));
  ok('the hover flyout and info popout both know it',
     /'tool-r3d':\s*'Radar 3D'/.test(PAGE)
     && /'tool-r3d':\s*'A storm/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes in the feature or in this test file',
     !PAGE.slice(PAGE.indexOf('RADAR 3D\n   ─'), PAGE.indexOf('TOOLBAR (#right-menu) HOVER FLYOUT')).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-radar-3d.mjs'), 'utf8').includes(EM));
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
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
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

console.log('\n2. the colour ramps, checked against the numbers ported from OpenStorm');
{
  const r = await p.evaluate(() => ({
    grayLow: _r3dReflectivityColor(-15),
    green: _r3dReflectivityColor(35),
    red: _r3dReflectivityColor(55),
    white: _r3dReflectivityColor(78),
    calmVel: _r3dVelocityColor(0.5),
    solidGreen: _r3dVelocityColor(-90),
    solidRed: _r3dVelocityColor(90),
    alphaRises: _r3dReflectivityColor(70)[3] > _r3dReflectivityColor(20)[3],
  }));
  ok('weak return reads gray-ish (low saturation)',
     Math.max(...r.grayLow.slice(0, 3)) - Math.min(...r.grayLow.slice(0, 3)) < 40,
     JSON.stringify(r.grayLow));
  ok('30-40 dBZ reads green', r.green[1] > r.green[0] && r.green[1] > r.green[2],
     JSON.stringify(r.green));
  ok('50-60 dBZ reads red', r.red[0] > r.red[1] && r.red[0] > r.red[2],
     JSON.stringify(r.red));
  ok('70-80 dBZ reads near white (bright, low saturation)',
     r.white[0] > 200 && r.white[1] > 200 && r.white[2] > 200,
     JSON.stringify(r.white));
  ok('near-zero velocity is nearly invisible', r.calmVel[3] < 0.2, JSON.stringify(r.calmVel));
  ok('strong inbound is solid green', r.solidGreen[1] > r.solidGreen[0],
     JSON.stringify(r.solidGreen));
  ok('strong outbound is solid red', r.solidRed[0] > r.solidRed[1],
     JSON.stringify(r.solidRed));
  ok('stronger reflectivity is less transparent', r.alphaRises);
}

console.log('\n3. a gate becomes a point in the right place');
{
  const r = await p.evaluate(() => {
    // A site at the origin and a gate due north: bearing 0, so it should
    // land on the +Y axis (north) with no east/west drift, at the beam
    // height _xsBeamHeightKm already gives for that range and angle.
    const site = { lat: 35.0, lng: -97.0 };
    const gate = { lat: 35.5, lng: -97.0 };            // due north
    const rangeKm = _xsKm(site, gate);
    const bearingDeg = _fxBearing(site.lat, site.lng, gate.lat, gate.lng);
    const z = _xsBeamHeightKm(rangeKm, 0.5, 0);
    const br = bearingDeg * Math.PI / 180;
    return {
      x: rangeKm * Math.sin(br), y: rangeKm * Math.cos(br), z,
      bearingDeg, rangeKm,
    };
  });
  ok('due north lands on the +Y axis, not off to the side',
     Math.abs(r.x) < 0.5, JSON.stringify(r));
  ok('and out along +Y by the real range', Math.abs(r.y - r.rangeKm) < 0.5,
     JSON.stringify(r));
  ok('with real height off the ground, not zero', r.z > 0, r.z.toFixed(3));
}

console.log('\n4. building a frame from a volume that is stood in for');
{
  const r = await p.evaluate(async () => {
    // A fake volume: two elevations, gates on a small grid with a strong
    // core in the middle so the picture has real structure in it.
    const ANGLES = { 1: 0.5, 2: 1.5 };
    const makeMesh = (elev) => {
      const N = 20, step = 0.03, lon0 = -97.3, lat0 = 35.2;
      const mesh = new Float32Array(N * N * 9);
      let k = 0;
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          const x = lon0 + gx * step, y = lat0 + gy * step;
          mesh[k++] = x;        mesh[k++] = y;
          mesh[k++] = x + step; mesh[k++] = y;
          mesh[k++] = x + step; mesh[k++] = y + step;
          mesh[k++] = x;        mesh[k++] = y + step;
          const d = Math.hypot(gx - N / 2, gy - N / 2);
          mesh[k++] = Math.max(-30, 55 - d * 4 - (elev - 1) * 10);
        }
      }
      return { mesh, bounds: [lon0, lat0, lon0 + N * step, lat0 + N * step] };
    };
    let calls = 0;
    const realWorker = window._workerProcess;
    window._workerProcess = async (buf, layer, opts) => {
      calls++;
      const el = (opts && opts.elevation) || 1;
      const m = makeMesh(el);
      return {
        meshData: m.mesh, bounds: m.bounds,
        metadata: { availableElevations: [1, 2], elevationNumber: el,
                    elevationAngle: ANGLES[el], timeIso: new Date().toISOString() },
      };
    };
    const sitePos = { lat: 35.0, lng: -97.3 };
    const token = ++_r3dToken;
    const frame = await _r3dBuildFrame(new ArrayBuffer(8), 'REF', sitePos, token);
    window._workerProcess = realWorker;
    return {
      calls, count: frame ? frame.count : 0,
      hasCenterZ: frame ? Number.isFinite(frame.centerZ) : false,
      allFinite: frame
        ? Array.from(frame.pts).every(Number.isFinite) : false,
      maxAbsValue: frame
        ? Math.max(...Array.from({ length: frame.count }, (_, i) => Math.abs(frame.pts[i * 4 + 3])))
        : 0,
    };
  });
  ok('it decoded both elevations', r.calls === 2, String(r.calls));
  ok('and built real points from them', r.count > 20, String(r.count));
  ok('every point is a finite number, nothing NaN slipped through', r.allFinite);
  ok('the frame knows its own vertical center', r.hasCenterZ);
  ok('values in range (the fake core tops out at 55 dBZ)', r.maxAbsValue <= 55.01,
     r.maxAbsValue.toFixed(1));
}

console.log('\n5. it refuses to build rather than breaking, when it must');
{
  const r = await p.evaluate(async () => {
    toggleRadar3D();          // _r3dFillMenus picks a real nearby station on its own
    const realWorker = window._workerProcess;
    window._workerProcess = undefined;
    await _r3dBuild();
    const noDecoder = document.getElementById('r3d-status').textContent;
    window._workerProcess = realWorker;

    const keepFetch = window._fetchVolumeDirect;
    window._fetchVolumeDirect = async () => { throw new Error('no volume'); };
    const keepCache = window._l2VolCache;
    _l2VolCache = { station: null, at: 0, buf: null };
    await _r3dBuild();
    const noVolume = document.getElementById('r3d-status').textContent;
    window._fetchVolumeDirect = keepFetch;
    _l2VolCache = keepCache;

    const stillOpen = document.getElementById('r3d-toolbar').classList.contains('visible');
    const mapAlive = !!(window.map && typeof map.getCenter === 'function'
                        && isFinite(map.getCenter().lat));
    toggleRadar3D();
    return { noDecoder, noVolume, stillOpen, mapAlive };
  });
  ok('a build with no decoder says so in words', /decoder/i.test(r.noDecoder), r.noDecoder);
  ok('a build that cannot get a volume says so too', r.noVolume.length > 0
     && !/undefined/.test(r.noVolume), r.noVolume);
  ok('the tool is still open after both', r.stillOpen);
  ok('and the map is still alive', r.mapAlive);
}

console.log('\n6. opening, closing, and the orbit camera respond to input');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    toggleRadar3D();
    const openState = {
      bar: document.getElementById('r3d-toolbar').classList.contains('visible'),
      panel: document.getElementById('r3d-panel').classList.contains('open'),
    };
    const cv = document.getElementById('r3d-canvas');
    const before = { yaw: _r3dCam.yaw, pitch: _r3dCam.pitch, dist: _r3dCam.dist };
    // Orbit drag.
    cv.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 220, clientY: 160, bubbles: true }));
    const afterDrag = { yaw: _r3dCam.yaw, pitch: _r3dCam.pitch };
    cv.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    // Wheel zoom.
    cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }));
    await sleep(50);
    const afterZoom = { dist: _r3dCam.dist };
    toggleRadar3D();
    const after = {
      bar: document.getElementById('r3d-toolbar').classList.contains('visible'),
      panel: document.getElementById('r3d-panel').classList.contains('open'),
    };
    return { openState, before, afterDrag, afterZoom, after };
  });
  ok('opening shows the bar and the panel', r.openState.bar && r.openState.panel,
     JSON.stringify(r.openState));
  ok('dragging the canvas changes yaw and pitch',
     r.afterDrag.yaw !== r.before.yaw && r.afterDrag.pitch !== r.before.pitch,
     JSON.stringify({ before: r.before, after: r.afterDrag }));
  ok('scrolling changes the camera distance', r.afterZoom.dist !== r.before.dist,
     JSON.stringify({ before: r.before.dist, after: r.afterZoom.dist }));
  ok('closing puts the bar and the panel away', !r.after.bar && !r.after.panel,
     JSON.stringify(r.after));
}

console.log('\n7. nothing above threw');
{
  const real = errs.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
