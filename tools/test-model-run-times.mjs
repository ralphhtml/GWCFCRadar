#!/usr/bin/env node
/*
 * Model run times: when each model's run comes in, live.
 *
 *     node tools/test-model-run-times.mjs
 *
 * The table from the GWCFC Discord (pettusplots.com model timing), as minutes
 * after each cycle, checked at known moments: which run is coming in, which
 * is next, and that the panel and the Run Models line say so.
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
const p = await b.newPage({ viewport: { width: 1200, height: 800 }, timezoneId: 'America/New_York' });
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
await p.waitForTimeout(2500);

const r = await p.evaluate(() => {
  const M = id => MRT_MODELS.find(m => m.id === id);
  const at = (h, mi) => Date.UTC(2026, 8, 25, h, mi);
  const s = (id, t) => { const x = _mrtStatus(M(id), t); return { live: x.live && x.live.cyc, next: x.next && x.next.cyc, nextStart: x.next && new Date(x.next.start).toISOString().slice(11, 16), liveEnd: x.live && new Date(x.live.end).toISOString().slice(11, 16) }; };
  return {
    gfs0400: s('gfs', at(4, 0)), gfs0600: s('gfs', at(6, 0)),
    ec0530: s('ecmwf', at(5, 30)), ec1200: s('ecmwf', at(12, 0)),
    hrrr1410: s('hrrr', at(14, 10)), hrrr1440: s('hrrr', at(14, 40)),
    hrrrx0100: s('hrrrx', at(1, 0)), nam0200: s('nam', at(2, 0)), nam3_0200: s('nam3', at(2, 0)),
  };
});
ok('GFS at 04:00Z: the 00Z run is coming in, done 05:15Z', r.gfs0400.live === 0 && r.gfs0400.liveEnd === '05:15', JSON.stringify(r.gfs0400));
ok('GFS at 06:00Z: nothing coming in, 06Z starts 09:30Z', r.gfs0600.live == null && r.gfs0600.next === 6 && r.gfs0600.nextStart === '09:30', JSON.stringify(r.gfs0600));
ok('ECMWF at 05:30Z: 00Z coming in, done 07:00Z', r.ec0530.live === 0 && r.ec0530.liveEnd === '07:00', JSON.stringify(r.ec0530));
ok('ECMWF at 12:00Z: the 06Z run is still coming in, done 12:15Z', r.ec1200.live === 6 && r.ec1200.liveEnd === '12:15', JSON.stringify(r.ec1200));
ok('HRRR at 14:10Z: the 13Z run is still coming in (:52 to :25)', r.hrrr1410.live === 13 && r.hrrr1410.liveEnd === '14:25', JSON.stringify(r.hrrr1410));
ok('HRRR at 14:40Z: between runs, 14Z starts 14:52Z', r.hrrr1440.live == null && r.hrrr1440.next === 14 && r.hrrr1440.nextStart === '14:52', JSON.stringify(r.hrrr1440));
ok('the 48 hour HRRR at 01:00Z: 00Z coming in, done 01:50Z', r.hrrrx0100.live === 0 && r.hrrrx0100.liveEnd === '01:50', JSON.stringify(r.hrrrx0100));
ok('NAM and NAM 3 km at 02:00Z: both 00Z coming in', r.nam0200.live === 0 && r.nam3_0200.live === 0 && r.nam0200.liveEnd === '02:45', JSON.stringify([r.nam0200, r.nam3_0200]));

const ui = await p.evaluate(() => {
  mrtOpen();
  const el = document.getElementById('mrt-panel');
  const rows = el.querySelectorAll('.mrt-row').length;
  const txt = el.textContent;
  const sel = document.getElementById('sev-model-sel');
  sel.value = 'pi:gfs'; _mrtLine();
  const line = document.getElementById('mrt-line').textContent;
  mrtClose();
  return { rows, hasLink: /pettusplots\.com/.test(el.innerHTML), txt: txt.slice(0, 200), line, closed: !el.classList.contains('open'),
           btn: !!document.querySelector('#run-models-panel-header .mrt-open-btn') };
});
ok('the panel lists all six models', ui.rows === 6, JSON.stringify(ui));
ok('and links to pettusplots for the rest', ui.hasLink);
ok('the Run Models header has the button that opens it', ui.btn);
ok('the line under the Run picker says what the GFS is doing', /GFS/.test(ui.line) && /(coming in now|starts)/.test(ui.line), ui.line);
ok('the panel closes', ui.closed);
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
