#!/usr/bin/env node
/*
 * Satellite 3D follows a satellite comparison on the map.
 *
 *     node tools/test-sat3d-compare.mjs
 *
 * A tester's screenshot: the map split between two products by the compare
 * divider, a Satellite 3D box drawn across the divider, and the 3D picture
 * showing only one of them. With the Picture on "What the map is showing",
 * each point of the box now wears the product of the pane it sits under.
 * Checked on a real page: the split plan follows the divider, the picture
 * really is painted from both products, moving the divider re-splits it,
 * and with the comparison off the box is one product again.
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
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);

const r = await p.evaluate(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  map.setView([20, -100], 5, { animate: false });
  const A = GOES_PRODUCTS.find(x => x.ch === 'ch13') || GOES_PRODUCTS[0];
  const B = GOES_PRODUCTS.find(x => x.ch === 'ch08' && x.id !== A.id) || GOES_PRODUCTS[1];
  _goesProductId = A.id;
  activeLayers.satellite = true;
  // A two-pane comparison, divider straight down the middle of the screen.
  _scOn = true; _scGrid = { rows: 1, cols: 2 };
  _scColSplits = [50]; _scRowSplits = []; _scColRots = [0]; _scRowRots = [];
  _scSlots = [{ id: 'b', productId: B.id }];
  // A box straddling the middle, the Picture on what the map shows.
  const c = map.getBounds();
  const midLng = map.containerPointToLatLng([600, 400]).lng;
  _s3dZone = { s: 15, n: 25, w: midLng - 6, e: midLng + 6, lat: 20, lng: midLng, wKm: 1200, hKm: 1100 };
  _s3dSkinSel = 'map';
  const d = { w: 40, h: 20, grey: new Uint8Array(800).fill(40) };
  const plan = _s3dCmpPlan(d);
  const out = { products: plan && plan.products.map(x => x && x.id), A: A.id, B: B.id };
  out.leftOwner = plan && plan.owner[10 * 40 + 2];
  out.rightOwner = plan && plan.owner[10 * 40 + 37];
  // Paint: each product a flat colour, so the picture shows who owns what.
  const colours = { [A.id]: [255, 0, 0], [B.id]: [0, 0, 255] };
  const realPx = window._s3dSkinPx;
  window._s3dSkinPx = async (prod, fr, dd) => {
    const n = dd.w * dd.h, px = new Uint8ClampedArray(n * 4), c3 = colours[prod.id] || [0, 255, 0];
    for (let k = 0; k < n; k++) { px[k * 4] = c3[0]; px[k * 4 + 1] = c3[1]; px[k * 4 + 2] = c3[2]; px[k * 4 + 3] = 255; }
    return { px, gapMin: 0 };
  };
  const fr = { t: Date.now(), data: d };
  _s3dFrames = [fr]; _s3dIdx = 0;
  await _s3dSkin(fr, _s3dGen);
  const at = (i, j) => Array.from(d.rgb.slice((j * 40 + i) * 3, (j * 40 + i) * 3 + 3));
  out.leftPx = at(2, 10); out.rightPx = at(37, 10); out.skin = d.skin;
  // Drag the divider far right: the whole box falls in pane A.
  _scColSplits = [95];
  out.afterMove = _s3dCmpPlan(d);
  // Comparison off: one product again.
  _scColSplits = [50]; _scOn = false; _scGrid = null;
  out.off = _s3dCmpPlan(d);
  await _s3dSkin(fr, _s3dGen);
  out.offLeft = at(2, 10); out.offRight = at(37, 10);
  window._s3dSkinPx = realPx;
  return out;
});
ok('a box across the divider is split between both products',
   r.products && r.products.length === 2 && r.products.includes(r.A) && r.products.includes(r.B), JSON.stringify(r));
ok('the left of the box belongs to pane A, the right to pane B',
   r.products && r.products[r.leftOwner] === r.A && r.products[r.rightOwner] === r.B, JSON.stringify(r));
ok('and the 3D picture is really painted that way (A red on the left, B blue on the right)',
   r.leftPx[0] > 200 && r.leftPx[2] < 50 && r.rightPx[2] > 200 && r.rightPx[0] < 50, JSON.stringify([r.leftPx, r.rightPx]));
ok('the readout names both products', / \| /.test(r.skin || ''), r.skin);
ok('with the divider moved off the box, the box is one product', r.afterMove === null, JSON.stringify(r.afterMove));
ok('with the comparison off, one product across the whole box',
   r.off === null && r.offLeft[0] === r.offRight[0] && r.offLeft[2] === r.offRight[2], JSON.stringify([r.offLeft, r.offRight]));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
