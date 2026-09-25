#!/usr/bin/env node
/*
 * Ocean Depth on the site: the parsing server's HYCOM temperatures below the
 * surface, picked with the Ocean column of the height slider.
 *
 *     node tools/test-ocean-depth-slider.mjs
 *
 * A fake parsing server serves the SST index and value-encoded PNGs (the
 * same format pi/sst_pipeline.py writes), one per depth, each holding its own
 * temperature. Checked: the Waves source row offers Ocean Depth; turning it on
 * brings up an Ocean column, surface at the top and 1,000 m at the bottom;
 * stepping down loads that depth's picture and the numbers change with it;
 * each depth is shaded across its own span; the Inspector reads the real
 * temperature in the chosen unit, with no "+" sign (it is not an anomaly);
 * and the column leaves with the layer.
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
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
ok('Ocean Depth is a source under Sea Surf. Temp', /\{ id: 'hycom', label: 'Ocean Depth', pi: true/.test(PAGE));
ok('its seven depths', /hycom: \['t0', 't50', 't100', 't200', 't300', 't500', 't1000'\]/.test(PAGE));
ok('no em dashes in this test', !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

// A value-encoded RGBA PNG: high byte red, low byte green over [lo, hi],
// alpha 0 for land (the first column), exactly as the pipeline writes it.
function valuePng(w, h, valueC, lo, hi) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = buf => { let c = -1; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const q = Math.round((valueC - lo) / (hi - lo) * 65535);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) {
      const o = 1 + x * 4;
      if (x === 0) continue;                           // land
      row[o] = q >> 8; row[o + 1] = q & 255; row[o + 2] = 0; row[o + 3] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const DEPTHS = [0, 50, 100, 200, 300, 500, 1000];
const TEMP = d => +(29 - 20 * (1 - Math.exp(-d / 300))).toFixed(2);
const SHADE = { 0: [-2, 32], 50: [-2, 31], 100: [-2, 30], 200: [-2, 28], 300: [-2, 24], 500: [-2, 18], 1000: [-2, 12] };
const INDEX = { sources: { hycom: { label: 'Ocean depth (HYCOM)', note: 'test', variants: Object.fromEntries(DEPTHS.map(d =>
  ['t' + d, { label: d ? `${d} m deep` : 'Surface', unit: 'C', range: [-4, 36], bounds: [[10, -100], [15, -92]],
              newest: '20260923', frames: ['20260923'], depth: d, shade: SHADE[d] }])) } } };

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
const asked = [];
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js'))
    return r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css'))
    return r.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (u.startsWith('http://pi.test/')) {
    asked.push(u.split('?')[0]);
    if (/\/sst\/index\.json/.test(u)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(INDEX),
      headers: { 'access-control-allow-origin': '*' } });
    const m = u.match(/\/sst\/hycom\/t(\d+)\/20260923\.png/);
    if (m) return r.fulfill({ contentType: 'image/png', body: valuePng(32, 16, TEMP(Number(m[1])), -4, 36),
      headers: { 'access-control-allow-origin': '*' } });
    return r.fulfill({ status: 404, body: '' });
  }
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);

const dock = () => p.evaluate(() => {
  const col = document.querySelector('#lvl-dock.open .lvl-col[data-layer="ocean"]');
  if (!col) return null;
  return { notches: LVL_STEPS.ocean.map(String), active: col.dataset.lvl,
           ft: col.querySelector('.lvl-ft').textContent };
});

console.log('\n2. turning it on');
{
  await p.evaluate(async () => { _hdBase = 'http://pi.test'; _units.temp = 'f'; await _sstEnable('hycom', 't0'); });
  await p.waitForTimeout(900);
  const d = await dock();
  ok('an Ocean column appears on the slider', !!d, JSON.stringify(d));
  ok('surface on the left, 1,000 m on the right',
     d && d.notches.join(',') === '0,50,100,200,300,500,1000', JSON.stringify(d));
  ok('starting at the surface', d && d.active === '0' && /sea surface/.test(d.ft), JSON.stringify(d));
  ok('the surface picture was fetched', asked.some(u => /hycom\/t0\/20260923\.png$/.test(u)), asked.slice(-3).join(' '));
}

console.log('\n3. stepping down');
{
  asked.length = 0;
  await p.evaluate(() => { const r = document.querySelector('#lvl-dock .lvl-range[data-layer="ocean"]');
    r.value = String(LVL_STEPS.ocean.indexOf(500)); r.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(1200);
  const r = await p.evaluate(() => {
    const vals = Array.from(_sstGrid.vals).filter(v => isFinite(v));
    const row = _inspSstRow({ lat: 12.5, lng: -96 });
    const ramp = _sstActiveRamp('hycom', 't500');
    return { variant: _sstVariant, mean: vals.reduce((a, b) => a + b, 0) / vals.length, land: Array.from(_sstGrid.vals).some(v => !isFinite(v)),
             row, rampLo: ramp[0][0], rampHi: ramp[ramp.length - 1][0], saved: JSON.parse(localStorage.getItem('gwcfc_om_level') || '{}').ocean };
  });
  ok('500 m is chosen and its picture fetched', r.variant === 't500' && asked.some(u => /hycom\/t500\/20260923\.png$/.test(u)), r.variant + ' ' + asked.join(' '));
  ok(`the numbers are the water at 500 m (${r.mean.toFixed(2)} C)`, Math.abs(r.mean - TEMP(500)) < 0.01, r.mean);
  ok('land stays land', r.land);
  ok('shaded across 500 m\'s own span (-2 to 18 C), not the surface scale', r.rampLo === -2 && Math.abs(r.rampHi - 18) < 1e-9, `${r.rampLo} ${r.rampHi}`);
  const f = (TEMP(500) * 9 / 5 + 32).toFixed(1);
  ok(`the Inspector reads the real temperature in F (${f}), no plus sign`,
     r.row.value === f && /F/.test(r.row.unit), JSON.stringify(r.row));
  ok('the depth is remembered', r.saved === 500, r.saved);
  const d = await dock();
  ok('the dot moved and its label says how deep', d.active === '500' && /1,641 ft down/.test(d.ft), JSON.stringify(d));
}

console.log('\n4. and away');
{
  await p.evaluate(() => _sstDisable());
  await p.waitForTimeout(900);
  ok('the column leaves with the layer', !(await dock()));
  ok('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));
}

console.log('\nno row of depth buttons: the slider picks the depth');
{
  const r = await p.evaluate(async () => {
    // The depth the slider was last left on.
    _omLevel.ocean = 300;
    let asked = null;
    const real = window._sstEnable;
    window._sstEnable = (src, v) => { asked = src + ':' + v; return Promise.resolve(); };
    toggleSstSourceSub();
    document.getElementById('sub-sstsrc-hycom').click();
    await new Promise(res => setTimeout(res, 50));
    const buttons = document.querySelectorAll('[id^="sub-sstvar-"]').length;
    toggleSstVariantSub('hycom');
    const after = document.querySelectorAll('[id^="sub-sstvar-"]').length;
    window._sstEnable = real;
    return { asked, buttons, after, stillSources: !!document.getElementById('sub-sstsrc-hycom') };
  });
  ok('turning Ocean Depth on starts at the depth the slider was left on', r.asked === 'hycom:t300', JSON.stringify(r));
  ok('and opens no row of depth buttons', r.buttons === 0 && r.after === 0 && r.stillSources, JSON.stringify(r));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
