#!/usr/bin/env node
/*
 * Only one radar site's picture is on the map at a time (outside the
 * radar comparison, which is the multi-radar mode).
 *
 *     node tools/test-site-layers.mjs
 *
 * A tester's screenshot: three stations' pictures showing at once after
 * switching sites. Each single-site load built its newest frame first, then
 * rebuilt the pool with the history and dropped the list holding that first
 * layer without taking it off the map, so every station visited left one
 * picture behind. Checked here by switching stations several times and
 * counting the per-station layers still on the map.
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
await p.waitForTimeout(3000);

const r = await p.evaluate(async () => {
  const wait = ms => new Promise(res => setTimeout(res, ms));
  // Every tile "loads" at once, so the hand-over happens the way it does on a
  // good connection.
  window._rsFrames = async () => { const now = Date.now(); return Array.from({ length: 6 }, (_, i) => { const t = now - (5 - i) * 300000; return { iso: new Date(t).toISOString(), time: t / 1000, date: new Date(t) }; }); };
  map.setView([39, -90], 6, { animate: false });
  const sites = ['kilx', 'kiwx', 'kddc', 'klot'];
  const perSite = () => {
    const seen = {};
    map.eachLayer(l => {
      const a = l.options && l.options.attribution;
      const m = a && /^([A-Z]{4}) (SR_BREF|N0Q)/.exec(a);
      if (m) seen[m[1]] = (seen[m[1]] || 0) + 1;
    });
    return seen;
  };
  for (const s of sites) {
    _loadSingleSiteRef(s);
    await wait(400);
    // Pretend the newest frame painted, which is what triggers the hand-over.
    _refSitePool.forEach(l => l && l.fire('load'));
    await wait(300);
  }
  await wait(RS_HANDOVER_MS + 200);
  const after = perSite();
  _clearSingleSiteRef();
  await wait(100);
  return { after, cleared: perSite() };
});
const others = Object.keys(r.after).filter(k => k !== 'KLOT');
ok('after switching through four stations, only the last one has layers on the map',
   others.length === 0 && r.after.KLOT > 0, JSON.stringify(r.after));
ok('and turning the site off leaves none', Object.keys(r.cleared).length === 0, JSON.stringify(r.cleared));
ok('the velocity stand-in layer is taken off the map when the pool takes over',
   /if \(velocityLayer && _velLayerPool\.indexOf\(velocityLayer\) === -1\)/.test(PAGE));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
