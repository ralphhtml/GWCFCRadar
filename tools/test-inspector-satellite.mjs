#!/usr/bin/env node
/*
 * The Inspector reads satellite temperatures exactly.
 *
 *     node tools/test-inspector-satellite.mjs
 *
 * The fixture is a real Iowa Mesonet band 13 picture (the one the map shows)
 * cropped round a hurricane's coldest tops, and the truth is NOAA's own
 * calibrated brightness temperature for the same scan, pixel for pixel.
 * The Inspector turns a colour back into kelvin through Iowa's colour
 * table; this checks it lands within a degree everywhere, including the
 * coldest tops, whose greys are the same colours as warm ground. The old
 * reader sorted colours into five buckets and was off by 21 degrees
 * typically and over 100 at worst.
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

const truth = JSON.parse(readFileSync(join(ROOT, 'tools/fixtures/ir-c13-truth.json'), 'utf8'));
const png = 'data:image/png;base64,' + readFileSync(join(ROOT, 'tools/fixtures/ir-c13-crop.png')).toString('base64');

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
  if (u.startsWith('file://') || u.startsWith('data:')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

const r = await p.evaluate(async ({ truth, png }) => {
  const box = document.createElement('div');
  box.style.cssText = `position:fixed;left:0;top:0;width:${truth.w}px;height:${truth.h}px;z-index:99999`;
  const img = new Image(); img.src = png;
  img.style.cssText = `width:${truth.w}px;height:${truth.h}px;display:block`;
  box.appendChild(img); document.body.appendChild(box);
  await new Promise(res => img.complete ? res() : (img.onload = res));
  const all = [], cold = [], old = [];
  let row = null;
  for (const [x, y, k] of truth.pts) {
    const s = _inspSampleColorFrom(box, x + 0.5, y + 0.5);
    const ex = _inspSatExactC('ch13', s);
    const e = ex ? Math.abs(ex.c - (k - 273.15)) : 999;
    all.push(e);
    if (k < 200) cold.push(e);
    old.push(Math.abs(_inspIrTempC(s.r, s.g, s.b) - (k - 273.15)));
    if (!row && k < 200) row = _inspSatReading('Satellite', s, 'ch13', '');
  }
  box.remove();
  const q = (a, f) => { a = a.slice().sort((m, n) => m - n); return a[Math.min(a.length - 1, Math.floor(a.length * f))]; };
  return { n: all.length, med: q(all, 0.5), p95: q(all, 0.95), max: q(all, 1), coldN: cold.length,
           coldMax: q(cold, 1), oldMed: q(old, 0.5), row };
}, { truth, png });

ok(`every one of ${r.n} points is within a degree of NOAA's own temperature`, r.max <= 1, JSON.stringify(r));
ok('typically within a quarter of a degree', r.med <= 0.25, String(r.med));
ok(`the coldest tops too (${r.coldN} points below 200 K, whose greys double as warm ground)`, r.coldN > 20 && r.coldMax <= 1, JSON.stringify(r));
ok('far better than the old bucket reader', r.oldMed > 10 * Math.max(r.med, 0.1), JSON.stringify([r.oldMed, r.med]));
ok('the Inspector row gives a real temperature, a class and kelvin, not an estimate',
   r.row && !/^≈/.test(r.row.value) && /Extreme Cold Top/.test(r.row.unit) && / K/.test(r.row.unit), JSON.stringify(r.row));

console.log('\n2. a Time Machine picture reads back through the app\'s own ramp');
const arc = await p.evaluate(() => {
  const lut = _goesArcLut('ir');
  const out = [];
  for (const g of [10, 80, 150, 200, 240]) {
    const k = 180 + (1 - g / 255) * 140;
    const c = _inspArcTempC('ir', lut[g * 3], lut[g * 3 + 1], lut[g * 3 + 2]);
    out.push(Math.abs(c - (k - 273.15)));
  }
  return Math.max(...out);
});
ok('within a degree across the scale', arc <= 1, String(arc));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
