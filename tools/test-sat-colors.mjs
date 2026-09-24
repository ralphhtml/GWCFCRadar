#!/usr/bin/env node
/*
 * Every satellite product has colour.
 *
 *     node tools/test-sat-colors.mjs
 *
 * The parsing server draws its archive scans (GOES since 2017, GridSat-B1
 * before) and the global mosaic in plain grey, so a Time Machine trip to
 * Hurricane Andrew on Clean IR came up colourless while the live Clean IR
 * is coloured. The page now colours every grey picture as it arrives, and
 * the live bands Iowa sends grey (visible, shortwave, fire, CO2) get the
 * same ramps through an SVG filter. Pinned here with the parsing server
 * stubbed and a grey test card standing in for its pictures.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

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
  ok('archive pictures are coloured as they are redrawn', /_goesArcEnhance\(ctx, W, H, url\);/.test(PAGE));
  ok('live WMS layers take a ramp', /_goesRampLayer\(layer\);/.test(PAGE) && /_goesRampLayer\(slot\.layer, product\);/.test(PAGE));
  ok('no em dashes in this test', !readFileSync(join(ROOT, 'tools/test-sat-colors.mjs'), 'utf8').includes(EM));
}

// A 256 x 2 grey test card: column g is grey level g, fully opaque.
function greyCard() {
  const W = 256, H = 2;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const o = y * (W * 4 + 1) + 1 + x * 4;
      raw[o] = raw[o + 1] = raw[o + 2] = x; raw[o + 3] = 255;
    }
  }
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let r = 0xffffffff; for (const b of buf) r = t[(r ^ b) & 0xff] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const CARD = greyCard();

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.startsWith('http://pi.test/'))
    return route.fulfill({ contentType: 'image/png', body: CARD, headers: { 'Access-Control-Allow-Origin': '*' } });
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);

// Run one stubbed address through the redraw and read back what it became:
// for each grey level, the colour that came out.
const readBack = (url) => p.evaluate(async (url) => {
  const blob = await _goesMercUrl(url, [[0, -100], [0.001, -90]]);
  if (!blob) return null;
  const img = new Image(); img.src = blob; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const c = cv.getContext('2d'); c.drawImage(img, 0, 0);
  const d = c.getImageData(0, 0, cv.width, 1).data;
  const at = g => [d[g * 4], d[g * 4 + 1], d[g * 4 + 2]];
  let grey = 0;
  for (let g = 0; g < 256; g++) { const [r, gg, bb] = at(g); if (Math.abs(r - gg) < 6 && Math.abs(gg - bb) < 6) grey++; }
  return { grey, cold: at(250), mid: at(160), warm: at(20), bright: at(255), dark: at(0) };
}, url);
const colourful = r => r && r.grey < 200;

console.log('\n2. the Time Machine\'s archive pictures come out coloured');
{
  const gs = await readBack('http://pi.test/sat/archive/frame?bucket=gridsat-b1&key=GRIDSAT-B1.1992.08.24.00.v02r01.nc&band=13&sector=conus&post=east');
  ok('Andrew on Clean IR (GridSat, 1992): the cold tops are coloured', colourful(gs), JSON.stringify(gs));
  ok('and warm ground stays grey, as live Clean IR draws it', gs && Math.abs(gs.warm[0] - gs.warm[2]) < 6, JSON.stringify(gs && gs.warm));
  const gsVis = await readBack('http://pi.test/sat/archive/frame?bucket=gridsat-b1&key=GRIDSAT-B1.1992.08.24.03.v02r01.nc&band=2&sector=conus&post=east');
  ok('GridSat is infrared whatever band was picked, and coloured as infrared', gsVis && JSON.stringify(gsVis.cold) === JSON.stringify(gs.cold), JSON.stringify(gsVis));
  const bands = {};
  for (const band of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
    bands[band] = await readBack(`http://pi.test/sat/archive/frame?bucket=noaa-goes16&key=K${band}.nc&band=${band}&sector=conus&post=east`);
  }
  const grey = Object.entries(bands).filter(([, r]) => !colourful(r)).map(([k]) => k);
  ok('every one of the 16 GOES bands comes out of the archive coloured', grey.length === 0, 'grey: ' + grey.join(','));
  ok('water vapour takes its own ramp, not the infrared one', JSON.stringify(bands[9].mid) !== JSON.stringify(bands[13].mid));
}

console.log('\n3. the global mosaic and the live grey bands');
{
  const r = await p.evaluate(() => {
    _goesUrlRamp.set('http://pi.test/satellite/global/global/vis_x.png', 'vis');
    return true;
  });
  const g = await readBack('http://pi.test/satellite/global/global/vis_x.png');
  ok('a global mosaic picture is coloured', r && colourful(g), JSON.stringify(g));
  const comp = await readBack('http://pi.test/satellite/east/conus/airmass_x.png');
  ok('a composite, colour already, is left as it is', comp && comp.grey === 256, JSON.stringify(comp));
  const live = await p.evaluate(async () => {
    const out = {};
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    for (const id of ['ch02', 'ch07', 'ch12', 'ch16', 'ch13', 'ch09']) {
      _goesProductId = id;
      const l = _makeGoesLayer('2026-09-24T12:00:00Z', 0.85);
      await sleep(30);
      const c = l.getContainer();
      out[id] = { ramped: c.classList.contains('sat-ramped'), filter: c.style.getPropertyValue('--sat-ramp') };
      map.removeLayer(l);
    }
    out.defs = document.querySelectorAll('#sat-ramp-defs filter').length;
    out.tableLen = (document.querySelector('#sat-ramp-vis feFuncR') || { getAttribute: () => '' }).getAttribute('tableValues').split(' ').length;
    return out;
  });
  ok('live visible, shortwave, fire and CO2 get a colour ramp', ['ch02', 'ch07', 'ch12', 'ch16'].every(k => live[k].ramped && /url\(#sat-ramp-/.test(live[k].filter)), JSON.stringify(live));
  ok('live Clean IR and water vapour keep the colour Iowa already gives them', !live.ch13.ramped && !live.ch09.ramped, JSON.stringify(live));
  ok('one filter per ramp, sampled evenly across all 256 greys', live.defs === 3 && live.tableLen === 52, JSON.stringify(live));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
