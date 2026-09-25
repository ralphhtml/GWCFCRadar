#!/usr/bin/env node
/*
 * Radar smoothing, product by product (Settings > Radar > Display).
 *
 *     node tools/test-smoothing.mjs
 *
 * A tester asked for smoothing per product instead of one global switch:
 * Single-Site Smoothing with a switch for each product under it, MRMS
 * Smoothing on its own, and a reflectivity filter beside them. Checked: the
 * switches exist and remember; the radar pane smooths exactly when the
 * product on it is one set to smooth, and follows the product as it changes;
 * a real image in the pane really renders smooth or crisp; and the filter
 * slider sets the same reflectivity value filter Radar Colors uses.
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

console.log('\n1. the switches');
let r = await p.evaluate(() => {
  lqmOpenSettings();
  return { fams: [...document.querySelectorAll('#smooth-fams input')].map(x => x.id.replace('smooth-fam-', '') + ':' + x.checked),
           master: document.getElementById('lqm-set-smooth').checked, mrms: document.getElementById('lqm-set-smooth-mrms').checked,
           dimmed: document.getElementById('smooth-fams').classList.contains('off') };
});
ok('a switch per single-site product, reflectivity and accumulation pre-set on',
   r.fams.length === 11 && r.fams.includes('ref:true') && r.fams.includes('acc:true') && r.fams.includes('vel:false'), r.fams.join(' '));
ok('everything crisp out of the box, the product list dimmed until the master is on', !r.master && !r.mrms && r.dimmed, JSON.stringify(r));

console.log('\n2. the pane follows the product');
r = await p.evaluate(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  const pane = map.getPane('radarPane');
  const img = document.createElement('img');
  img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; img.className = 'leaflet-tile';
  img.style.imageRendering = 'pixelated';           // what the tile code stamps
  pane.appendChild(img);
  const state = () => ({ cls: pane.classList.contains('wx-smooth-now'), rend: getComputedStyle(img).imageRendering });
  const out = {};
  _radarSource = 'normal'; currentProduct = 'ref'; _smoothSync();
  out.offRef = state();
  document.getElementById('lqm-set-smooth').click();       // master on
  out.onRef = state();
  currentProduct = 'vel'; await wait(1300);                  // velocity is off
  out.onVel = state();
  document.getElementById('smooth-fam-vel').click();         // turn velocity on
  out.velOn = state();
  currentProduct = 'mrms'; await wait(1300);
  out.mrmsOff = state();
  document.getElementById('lqm-set-smooth-mrms').click();
  out.mrmsOn = state();
  _radarSource = 'l2'; _l3Product = 'cc'; await wait(1300);
  out.l2cc = state();
  _l3Product = 'ref'; await wait(1300);
  out.l2ref = state();
  _radarSource = 'l3'; _l3Product = 'dta'; await wait(1300);
  out.l3acc = state();
  out.saved = JSON.parse(localStorage.getItem('gwcfc_smooth_cfg'));
  img.remove();
  return out;
});
ok('reflectivity with the master off: crisp', !r.offRef.cls && r.offRef.rend === 'pixelated', JSON.stringify(r.offRef));
ok('master on: reflectivity smooths, beating the tile code\'s inline pixelated', r.onRef.cls && r.onRef.rend === 'auto', JSON.stringify(r.onRef));
ok('switch to velocity (not chosen): crisp again, by itself within a second', !r.onVel.cls && r.onVel.rend === 'pixelated', JSON.stringify(r.onVel));
ok('choose velocity: it smooths', r.velOn.cls, JSON.stringify(r.velOn));
ok('MRMS follows its own switch', !r.mrmsOff.cls && r.mrmsOn.cls, JSON.stringify([r.mrmsOff, r.mrmsOn]));
ok('Level 2 correlation coefficient (not chosen): crisp; Level 2 reflectivity: smooth', !r.l2cc.cls && r.l2ref.cls, JSON.stringify([r.l2cc, r.l2ref]));
ok('a Level 3 storm total counts as accumulation', r.l3acc.cls, JSON.stringify(r.l3acc));
ok('and the choices are remembered', r.saved.single && r.saved.mrms && r.saved.fam.vel && r.saved.fam.ref, JSON.stringify(r.saved));

console.log('\n3. the reflectivity filter');
r = await p.evaluate(() => {
  const s = document.getElementById('lqm-set-reffilter');
  s.value = '15'; s.dispatchEvent(new Event('input'));
  const on = { f: _fxFilterFor('ref'), label: document.getElementById('lqm-reffilter-val').textContent };
  s.value = '-30'; s.dispatchEvent(new Event('input'));
  return { on, off: _fxFilterFor('ref'), label: document.getElementById('lqm-reffilter-val').textContent };
});
ok('15 dBZ hides reflectivity below 15, through the Radar Colors filter', r.on.f && r.on.f.min === 15 && r.on.label === '15 dBZ', JSON.stringify(r));
ok('all the way left turns it off', r.off === null && r.label === 'Off', JSON.stringify(r));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
