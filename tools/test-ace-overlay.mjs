#!/usr/bin/env node
/*
 * The ACE overlay: cards on every basin, tags on the storms that are up, and
 * the cumulative chart panel, per region and for each hemisphere and the
 * globe.
 *
 *     node tools/test-ace-overlay.mjs
 *
 * The parsing server is faked with a real ace.json the pipeline built
 * (tools/fixtures/ace-sample.json).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const ACE = readFileSync(join(ROOT, 'tools/fixtures/ace-sample.json'), 'utf8');
const D = JSON.parse(ACE);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the pieces');
ok('an ACE pill in the overlay list', /id="op-ace" data-ovid="ace"/.test(PAGE));
ok('its description says what ACE is', /'ace':\s+'ACE \(Accumulated Cyclone Energy\)/.test(PAGE));
ok('the parsing server builds it hourly', /gwcfc-ace\.timer/.test(readFileSync(join(ROOT, 'pi/install.sh'), 'utf8')));
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  const u = new URL(url);
  if (u.host === 'pi.test' && u.pathname === '/ace/ace.json')
    return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: ACE });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);
await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; _hdBase = 'http://pi.test'; map.setView([15, -100], 3, { animate: false }); });

console.log('\n2. on the map');
const r = await p.evaluate(async () => {
  toggleOverlayPill('ace');
  for (let i = 0; i < 40 && !document.querySelector('.ace-basin-card'); i++) await new Promise(res => setTimeout(res, 100));
  return { on: _aceOn, pill: document.getElementById('op-ace').classList.contains('active'),
    cards: [...document.querySelectorAll('.ace-basin-card')].map(c => c.textContent.replace(/\s+/g, ' ').trim()),
    tags: [...document.querySelectorAll('.ace-storm-tag')].map(t => t.textContent),
    panel: getComputedStyle(document.getElementById('ace-controls')).display };
});
ok('the pill turns it on and the panel opens', r.on && r.pill && r.panel === 'flex', JSON.stringify(r));
ok('a card on each of the seven basins', r.cards.length === 7, r.cards.join(' | '));
const na = D.regions.NA;
ok('with its own ACE', r.cards.some(c => c.includes('North Atlantic') && c.includes(na.ace >= 100 ? na.ace.toFixed(0) : na.ace.toFixed(1))), r.cards[0]);
const live = Object.values(D.regions).flatMap(x => (x.storms || []).filter(s => s.active));
ok(`a tag on every storm that is up now (${live.length})`, r.tags.length === live.length, r.tags.join(' | '));

console.log('\n3. the panel');
const panel = (k) => p.evaluate(async (k) => {
  _acePick(k);
  const head = document.getElementById('ace-head').textContent;
  const paths = [...document.querySelectorAll('#ace-chart path')].map(x => x.getAttribute('stroke') || x.getAttribute('fill'));
  const rows = document.querySelectorAll('#ace-storms tr').length;
  return { head, paths, rows, tabs: document.querySelectorAll('#ace-tabs button').length,
    active: document.querySelector('#ace-tabs button.active').textContent };
}, k);
let q = await panel('EP');
ok('a tab for each basin, each hemisphere and the globe', q.tabs === 10);
ok('East Pacific: its season, its ACE and its normal', q.head.includes('East Pacific') && q.head.includes('2026')
   && q.head.includes(D.regions.EP.ace.toFixed(0)) && /Normal by now/.test(q.head), q.head);
ok('and its rank since 1980', new RegExp(`of ${D.regions.EP.of} seasons since 1980`).test(q.head), q.head);
ok('the cumulative chart: this season, the normal, its range and last season',
   q.paths.includes('#ffc400') && q.paths.includes('#6fa8ff') && q.paths.includes('rgba(255,255,255,0.8)')
   && q.paths.includes('rgba(255,255,255,0.12)'), q.paths.join(','));
ok('its storms ranked by ACE', q.rows === Math.min(25, D.regions.EP.storms.length), q.rows);
q = await panel('GL');
ok('Global: the cumulative total for the whole world', q.head.includes('Global') && q.head.includes(D.regions.GL.ace.toFixed(0)), q.head);
ok('and every basin\'s storms ranked together', q.rows > 10, q.rows);
q = await panel('SH');
ok('the southern hemisphere runs July to June', q.head.includes('2026-27'), q.head);
await p.evaluate(() => _acePick('EP'));
await p.screenshot({ path: process.env.SHOT || '/tmp/ace-overlay.png' });

console.log('\n4. tapping a basin card opens its chart');
q = await p.evaluate(async () => {
  const card = [...document.querySelectorAll('.ace-basin-card')].find(c => c.textContent.includes('West Pacific'));
  card.closest('.leaflet-marker-icon').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(res => setTimeout(res, 100));
  return { region: _aceRegion, head: document.getElementById('ace-head').textContent };
});
ok('the West Pacific card shows the West Pacific', q.region === 'WP' && q.head.includes('West Pacific'), JSON.stringify(q));

console.log('\n5. off');
q = await p.evaluate(() => { toggleOverlayPill('ace'); return { on: _aceOn, cards: document.querySelectorAll('.ace-basin-card').length,
  panel: getComputedStyle(document.getElementById('ace-controls')).display }; });
ok('everything comes down', !q.on && q.cards === 0 && q.panel === 'none', JSON.stringify(q));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
