#!/usr/bin/env node
/*
 * Radar 3D's Solid surface is a smooth shell, not a pile of gate-sized blocks.
 *
 *     node tools/test-r3d-solid.mjs
 *
 * A round storm cell (values falling off smoothly from a 62 dBZ core) is
 * marched both ways on the same volume: the old on/off look, where every
 * gate is in or out, and the isosurface, where the blended field is cut at
 * Show above and shaded by its own gradient. The isosurface must have far
 * less jagged edge energy across the storm's face.
 */
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); } };
ok('no em dashes', !readFileSync(new URL(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));
const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
const PAGE = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 300)));
await p.route('**://**', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync((process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist') + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync((process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist') + '/leaflet.css', 'utf8') });
  return r.abort(); });
await p.goto(new URL('../index.html', import.meta.url).href, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000);
const shots = await p.evaluate(async () => {
  _r3dOpen('kfws'); _r3dToken++;
  const site = { x: 0, y: -40 };
  const xs = [], ys = [], zs = [], vs = [], rs = [], segs = [];
  [0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10, 12.5].forEach(a2 => {
    const start = xs.length;
    for (let x = -8; x <= 8; x += 0.5) for (let y = -8; y <= 8; y += 0.5) {
      const s2 = Math.hypot(x - site.x, y - site.y);
      const z = _xsBeamHeightKm(s2, a2, 0);
      const d = Math.hypot(x, y) / 6, dz = z / 11;
      const v = 62 * Math.exp(-(d * d + dz * dz) * 1.2);
      if (v < 5) continue;
      xs.push(x); ys.push(y); zs.push(z); vs.push(v); rs.push(0.5, s2 * 0.00873);
    }
    segs.push({ start, end: xs.length, angle: a2 });
  });
  const frame = _r3dFinishFrame({ xs, ys, zs, vs, rs, site }, segs, null, segs.length);
  _r3dFrames = [frame]; _r3dFrameIdx = 0; _r3dQuality = 'fine';
  _r3dCam.yaw = 0.7; _r3dCam.pitch = 0.3; _r3dCam.dist = 45;
  _r3dHeightMaxKft = 60; _r3dFilterPct = 35; _r3dMode = 'solid'; _r3dCutSide = 'off'; _r3dLutCache = null;
  const Pp = _r3dPolarFor(frame, _r3dSpec('ref'));
  const pk2 = _r3dLutFor('ref', 0.3);
  const v = _r3dCamBasis(0);
  const box = _r3dMarchBox(_r3dZone.wKm / 2, _r3dZone.hKm / 2);
  const mk = (iso) => ({ iw: 240, ih: 160, fine: 1, crisp: 0, iso, exag: _r3dExag, stepKm: 0.3,
    cam: new Float64Array([v.camX, v.camY, v.camZ, v.rx, v.ry, v.rz, v.ux, v.uy, v.uz, v.fx, v.fy, v.fz]),
    minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, maxZ: _r3dBoxTopKm() * _r3dExag,
    lut: pk2.lut, floorRgb: pk2.floorRgb, signed: false, light: new Float32Array([0.3, 0.3, 0.9]) });
  const a = new Uint8ClampedArray(240 * 160 * 4), c = new Uint8ClampedArray(240 * 160 * 4);
  _r3dMarchBand(Pp, mk(_r3dIsoByte(pk2.lut, _r3dSpec('ref'))), 0, 160, a);
  _r3dMarchBand(Pp, mk(-1), 0, 160, c);
  let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) diff++;
  // Jaggedness: the share of neighbouring pixels across the storm's face
  // whose brightness jumps sharply (the edges of gate-sized blocks), as
  // opposed to the gentle change of a lit curved surface.
  const jag = (arr) => { let e = 0, n = 0; for (let y = 0; y < 160; y++) for (let x = 1; x < 240; x++) { const i = (y * 240 + x) * 4, j = i - 4; if (arr[i + 3] < 250 || arr[j + 3] < 250 || arr[i + 2] < 120 || arr[j + 2] < 120) continue; if (Math.abs(arr[i + 2] - arr[j + 2]) > 14) e++; n++; } return { e: e / Math.max(1, n), n }; };
  return { iso: _r3dIsoByte(pk2.lut, _r3dSpec('ref')), diff, jn: jag(a), jo: jag(c) };
});
const r = shots;
ok('Solid surface has a threshold to cut at', r.iso > 0, String(r.iso));
ok('the isosurface draws a different picture from the on/off blocks', r.diff > 1000, String(r.diff));
ok('both draw the storm', r.jn.n > 1500 && r.jo.n > 1500, JSON.stringify([r.jn, r.jo]));
ok('and the isosurface is far smoother across its face (less than 70% of the jaggedness)',
   r.jn.e < r.jo.e * 0.7, JSON.stringify([r.jn, r.jo]));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
