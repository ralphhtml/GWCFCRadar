#!/usr/bin/env node
/*
 * The comparison split can spin, either way, and hiding the split lines is
 * a switch that stays until pressed again.
 *
 *     node tools/test-cmp-spin.mjs
 *
 * Checked on a live cross-layer split: the spin button turns the lines
 * steadily (and the cut of the panes with them), the direction button
 * flips which way, stopping leaves the lines where they are, and the eye
 * button keeps them hidden well past the old ten seconds until tapped again.
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
ok('the toolbar has a spin button and a direction button',
   /id="cmp-spin" onclick="_cmpToolSpin\(\)"/.test(PAGE) && /id="cmp-spin-dir" onclick="_cmpToolSpinDir\(\)"/.test(PAGE));

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
await p.waitForTimeout(3000);

console.log('\n1. spinning');
const r = await p.evaluate(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  _xcStart();
  await wait(200);
  const line = () => _xcDividerEls.cols[0] && _xcDividerEls.cols[0].style.transform;
  const out = { a0: _xcColRots[0], line0: line() };
  _cmpToolSpin();
  out.on = _cmpSpin.on && document.getElementById('cmp-spin').classList.contains('active');
  await wait(1000);
  out.a1 = _xcColRots[0]; out.line1 = line();
  _cmpToolSpinDir();
  out.dirIcon = document.getElementById('cmp-spin-dir').innerHTML;
  await wait(1000);
  out.a2 = _xcColRots[0];
  _cmpToolSpin();                // stop
  out.stopped = !_cmpSpin.on;
  await wait(400);
  out.a3 = _xcColRots[0];
  await wait(400);
  out.a4 = _xcColRots[0];
  return out;
});
ok('the spin button starts it and lights up', r.on, JSON.stringify(r));
ok('clockwise: the line turns about 24 degrees a second', r.a1 - r.a0 > 15 && r.a1 - r.a0 < 35, JSON.stringify(r));
ok('and the line on the map is redrawn at the new angle', r.line1 && r.line1 !== r.line0, JSON.stringify([r.line0, r.line1]));
ok('the direction button turns it the other way, and its icon says so',
   r.a2 < r.a1 - 10 && /refresh-ccw/.test(r.dirIcon), JSON.stringify(r));
ok('stopping leaves the line where it is', r.stopped && r.a3 === r.a4, JSON.stringify(r));

console.log('\n2. hiding the split lines is a switch');
const h = await p.evaluate(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  const dc = document.getElementById('xc-dividers');
  _cmpToolPeek();
  const hid = dc.classList.contains('cmp-peeking') && document.getElementById('cmp-peek').classList.contains('active');
  await wait(11000);
  const still = dc.classList.contains('cmp-peeking');
  _cmpToolPeek();
  const back = !dc.classList.contains('cmp-peeking') && !document.getElementById('cmp-peek').classList.contains('active');
  _cmpToolPeek();
  _xcOff();
  const reset = !dc.classList.contains('cmp-peeking');
  return { hid, still, back, reset };
});
ok('one tap hides the lines', h.hid, JSON.stringify(h));
ok('they stay hidden past the old ten seconds', h.still, JSON.stringify(h));
ok('another tap brings them back', h.back, JSON.stringify(h));
ok('ending the comparison clears it for the next one', h.reset, JSON.stringify(h));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
