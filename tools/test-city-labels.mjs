#!/usr/bin/env node
/*
 * City names never overlap, and there are more of them.
 *
 *     node tools/test-city-labels.mjs
 *
 * A tester's screenshot: "Arlington" and its reading drawn over another
 * name. Names are now placed biggest first and a name whose box (with room
 * for the reading line under it) would touch one already placed is left out.
 * With overlaps impossible the population floor is lower and the cap higher,
 * so more names fit wherever there is room.
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
const p = await b.newPage({ viewport: { width: 1300, height: 850 } });
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
  // A crowded metro: Dallas-Fort Worth, with towns packed close together,
  // including a long reading under a name.
  const towns = [
    ['Dallas', 32.78, -96.80, 1300000], ['Fort Worth', 32.75, -97.33, 950000],
    ['Arlington', 32.74, -97.11, 400000], ['Plano', 33.02, -96.70, 290000],
    ['Irving', 32.81, -96.95, 250000], ['Garland', 32.91, -96.64, 240000],
    ['Grand Prairie', 32.75, -97.00, 200000], ['Mesquite', 32.77, -96.60, 150000],
    ['McKinney', 33.20, -96.64, 200000], ['Frisco', 33.15, -96.82, 200000],
    ['Denton', 33.21, -97.13, 140000], ['Carrollton', 32.95, -96.89, 130000],
    ['Richardson', 32.95, -96.73, 120000], ['Lewisville', 33.05, -96.99, 110000],
    ['Allen', 33.10, -96.67, 105000], ['Mansfield', 32.56, -97.14, 75000],
    ['Euless', 32.84, -97.08, 60000], ['Bedford', 32.84, -97.14, 49000],
    ['Hurst', 32.82, -97.17, 40000], ['Grapevine', 32.93, -97.08, 50000],
  ];
  _mbCityFeats = towns.map(t => ({ name: t[0], lat: t[1], lng: t[2], pop: t[3] }))
    .sort((a, b) => b.pop - a.pop);
  _mbOn.cities = true;
  window._cityGazetteerVisible = async () => null;
  window._mbCityValues = () => 'Air Quality Alert';
  map.setView([32.85, -96.95], 9, { animate: false });
  _mbCityRefresh();
  await wait(1500);
  const els = [...document.querySelectorAll('#map .mb-city')];
  const boxes = els.map(e => e.getBoundingClientRect());
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], c = boxes[j];
    if (a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top) overlaps++;
  }
  const names = els.map(e => e.firstChild.textContent);
  const reading = els[0] && els[0].querySelector('.mb-city-data').textContent;
  // Zoomed in, more of them fit.
  map.setView([32.85, -96.95], 11, { animate: false });
  _mbCityRefresh();
  await wait(300);
  const moreNames = document.querySelectorAll('#map .mb-city').length;
  return { n: els.length, overlaps, names, reading, moreNames };
});
ok(`no two names overlap, readings included (${r.n} placed)`, r.n > 3 && r.overlaps === 0, JSON.stringify(r));
ok('the biggest places win the space', r.names[0] === 'Dallas' && r.names.includes('Fort Worth'), JSON.stringify(r.names));
ok('the reading under a name is still there', /Air Quality/.test(r.reading || ''), r.reading);
ok('zooming in makes room for more names', r.moreNames > r.n, JSON.stringify(r));
ok('more names are allowed than before (cap and floor)', /const MB_CITY_CAP = 400;/.test(PAGE) && /if \(z <= 9\) return 3000;/.test(PAGE));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
