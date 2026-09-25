#!/usr/bin/env node
/*
 * The Inspector reads the radar picture that is actually on screen.
 *
 *     node tools/test-inspector-loop.mjs
 *
 * Two faults behind "the Inspector is broken":
 *
 * 1. A single-site radar picture was drawn with latitude spread evenly down
 *    the image, but the map stretches an image overlay evenly in Web
 *    Mercator. Every gate between the edges landed a little north or south
 *    of where it belongs, so the value the Inspector read (from the real
 *    gate) did not match the colour under the crosshair. The picture is now
 *    drawn in Mercator rows. Checked here with a synthetic sweep: every
 *    gate's colour must sit where its latitude says on the map.
 * 2. Playing a loop showed older scans, but the Inspector kept reading the
 *    newest scan's values. An older frame is now read off its own picture,
 *    and a stepped colour scale is reported as its band.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://') || u.startsWith('blob:') || u.startsWith('data:')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

const r = await p.evaluate(async () => {
  const wait = ms => new Promise(res => setTimeout(res, ms));
  // A synthetic sweep: horizontal bands of 2 km, alternating 12 and 22 dBZ,
  // across a box eight degrees tall, like a Level 2 picture.
  const box = [-95, 36, -84, 44.4];
  const quads = [];
  const stepLat = 0.018;
  for (let la = box[1], row = 0; la < box[3]; la += stepLat, row++) {
    const v = row % 2 ? 22 : 12;
    quads.push(box[0], la, box[2], la, box[2], la + stepLat, box[0], la + stepLat, v);
  }
  const mesh = new Float32Array(quads);
  const result = { meshData: mesh, bounds: box, metadata: { timeIso: new Date().toISOString() } };
  const img = _meshToImage(result, 'ref', box);
  map.setView([40.95, -90.2], 9, { animate: false });
  const ov = L.imageOverlay(img.url, img.leafletBounds, { pane: 'radarPane' }).addTo(map);
  await new Promise(res => { const e = ov.getElement(); e.complete ? res() : (e.onload = res); });
  await wait(100);
  const el = ov.getElement(), rr = el.getBoundingClientRect(), c = _inspPixelCanvas(el);
  const mb = map.getContainer().getBoundingClientRect();
  let agree = 0, total = 0;
  for (let gy = -300; gy <= 300; gy += 7) {
    const cx = mb.left + mb.width / 2, cy = mb.top + mb.height / 2 + gy;
    const ll = map.containerPointToLatLng([cx - mb.left, cy - mb.top]);
    const row = Math.floor((ll.lat - box[1]) / stepLat);
    // Skip points within a pixel of a band edge.
    const edge = Math.min(ll.lat - (box[1] + row * stepLat), box[1] + (row + 1) * stepLat - ll.lat);
    if (edge < 0.0035) continue;
    const want = _meshColorFn('ref')(row % 2 ? 22 : 12);
    const d = c.ctx.getImageData(Math.floor((cx - rr.left) / rr.width * c.w), Math.floor((cy - rr.top) / rr.height * c.h), 1, 1).data;
    const got = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    total++; if (got === want) agree++;
  }
  map.removeLayer(ov);
  // The loop reader: an older frame reads off its picture, as a band.
  _l3Overlay = L.imageOverlay(img.url, img.leafletBounds, { pane: 'radarPane' }).addTo(map);
  await new Promise(res => { const e = _l3Overlay.getElement(); e.complete ? res() : (e.onload = res); });
  _lastMeshData = mesh; _lastMeshBounds = box; _lastMeshProduct = 'ref';
  _l2Loop.frames = [{ url: img.url, bounds: img.leafletBounds, time: Date.now() - 600000 },
                    { url: img.url, bounds: img.leafletBounds, time: Date.now(), live: true }];
  _l2Loop.idx = 0; _l2Loop.product = 'ref'; _l2Loop.station = 'kilx';
  // Find a screen point in a 12 dBZ band, away from edges.
  const lat0 = box[1] + Math.round((40.95 - box[1]) / stepLat / 2) * 2 * stepLat + stepLat / 2;
  const pt = map.latLngToContainerPoint([lat0, -90.2]);
  const cx = mb.left + pt.x, cy = mb.top + pt.y;
  const older = _inspRadarMainRow(L.latLng(lat0, -90.2), cx, cy);
  _l2Loop.idx = 1;
  const newest = _inspRadarMainRow(L.latLng(lat0, -90.2), cx, cy);
  return { agree, total, older, newest };
});
ok(`the picture sits where its data is (${r.agree}/${r.total} points on the right band)`, r.total > 50 && r.agree === r.total, JSON.stringify(r));
ok('an older loop frame is read off its own picture, as the colour band it shows', /^10 to 15$/.test(r.older.value) && /dBZ/.test(r.older.unit || ''), JSON.stringify(r.older));
ok('the newest frame still gives the exact decoded value', r.newest.value === '12.00' || /^12(\.0+)?$/.test(r.newest.value), JSON.stringify(r.newest));
ok('the Inspector refreshes on every loop frame and radar frame', /_inspEnabled\) _inspScheduleUpdate\(\);\n  const at = document.getElementById\('anim-time'\);/.test(PAGE)
   && /function showFrame\(idx\) \{\n  \/\/ The Inspector follows/.test(PAGE));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
