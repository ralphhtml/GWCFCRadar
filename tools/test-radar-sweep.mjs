#!/usr/bin/env node
/*
 * The broadcast sweep: a TV-style beam rotating over the active
 * single-site radar, toggleable in Settings > Radar.
 *
 *     node tools/test-radar-sweep.mjs
 *
 * The spin is pure CSS on one element; the JS only decides where the
 * disc sits (the same _rcMainSite answer the radar comparison reads, so
 * the beam follows the picture through every source) and how many
 * pixels the radar's picture reaches at the current zoom (the furthest
 * cell actually drawn, or 460 km / 300 km for velocity before one is).
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

console.log('\n1. the pieces are in the page');
{
  ok('the disc spins in CSS, not in JavaScript',
     /@keyframes sweep-spin \{ to \{ transform: rotate\(360deg\); \} \}/.test(PAGE)
     && /animation: sweep-spin [\d.]+s linear infinite;/.test(PAGE));
  ok('a reduced-motion screen keeps the disc but not the spin',
     /prefers-reduced-motion[\s\S]{0,120}\.sweep-disc \{ animation: none/.test(PAGE));
  ok('the beam follows the same site answer the radar comparison reads',
     /_rcMainSite === 'function'\) \? _rcMainSite\(\) : null/.test(PAGE));
  ok('the disc is sized to how far the data really reaches, not a fixed 230 km',
     /\(_sweepKmNow \|\| RADAR_RANGE_KM\) \* 1000 \/ \(111320 \* Math\.cos/.test(PAGE)
     && !/230000 \/ \(111320/.test(PAGE));
  ok('every drawn picture tells the sweep its reach',
     /_sweepNoteRange\(station, product, result && result\.bounds\)/.test(PAGE));
  ok('it sits over the radar and under the alerts',
     /sweepPane/.test(PAGE) && /pn\.style\.zIndex = '402';/.test(PAGE));
  ok('the toggle lives in Settings > Radar and persists',
     /id="lqm-set-sweep"/.test(PAGE)
     && /lqmToggleSetting\('sweep',this\.checked\)/.test(PAGE)
     && /localStorage\.setItem\('gwcfc_sweep', val \? '1' : '0'\)/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-radar-sweep.mjs'), 'utf8').includes(EM));
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
const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 150)));
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
await p.waitForTimeout(4500);

console.log('\n2. the beam lives and dies with the single-site picture');
{
  const r = await p.evaluate(async () => {
    const out = {};
    map.setView([35.33, -97.28], 7, { animate: false });
    currentProduct = 'ref'; _refStation = 'ktlx';   // a single-site picture
    await new Promise(r2 => setTimeout(r2, 1400));  // one sync tick
    const el = document.querySelector('.radar-sweep .sweep-disc');
    out.appeared = !!el;
    out.anim = el ? getComputedStyle(el).animationName : '';
    out.w7 = el ? parseInt(el.style.width, 10) : 0;
    map.setZoom(6, { animate: false });
    _sweepResize();
    out.w6 = el ? parseInt(el.style.width, 10) : 0;
    lqmToggleSetting('sweep', false);
    out.goneAfterToggle = !document.querySelector('.radar-sweep');
    out.stored = localStorage.getItem('gwcfc_sweep');
    lqmToggleSetting('sweep', true);
    out.backOn = !!document.querySelector('.radar-sweep');
    _refStation = null; currentProduct = 'radar';   // back to the mosaic
    await new Promise(r2 => setTimeout(r2, 1400));
    out.goneWithSite = !document.querySelector('.radar-sweep');
    return out;
  });
  ok('the beam appears over the active site, spinning', r.appeared && r.anim === 'sweep-spin',
     JSON.stringify(r));
  ok('one zoom step out halves the disc, so it hugs the real range',
     r.w7 > 0 && Math.abs(r.w6 - r.w7 / 2) <= 2, r.w7 + ' -> ' + r.w6);
  ok('the settings toggle removes it and remembers',
     r.goneAfterToggle && r.stored === '0', JSON.stringify(r));
  ok('and brings it straight back', r.backOn === true);
  ok('no single-site radar, no beam', r.goneWithSite === true);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
