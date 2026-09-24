#!/usr/bin/env node
/*
 * Meteograms: right-click the map, "Meteogram here", and a panel like the
 * sounding panel opens with every ensemble member for that point over the
 * next two weeks: a temperature heatmap, daily high and low boxes, a rain
 * plume, wind and CAPE, with a hover readout of the percentiles.
 *
 *     node tools/test-meteogram.mjs
 *
 * Open-Meteo's ensemble API is faked with members whose spread is known, so
 * the percentiles can be checked exactly.
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
  ok('a Meteogram row in the map menu', /_cmMeteogramHere\(\)">\$\{ic\('chart-bar'\)\} Meteogram here/.test(PAGE));
  ok('the panel shares the sounding panel shell', /#snd-panel, #mtg-panel[, ]/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  const a = PAGE.indexOf('// -- METEOGRAMS'), b = PAGE.indexOf('function _cmMeteogramHere');
  ok('no em dashes in the new code or this test', a > 0 && !PAGE.slice(a, b).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-meteogram.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

// 31 members; member m is m-15 degrees off a daily cycle, so the median is
// the cycle itself and the 10th/90th percentiles are exactly -12/+12.
const HOURS = 24 * 10, M = 31;
const times = Array.from({ length: HOURS }, (_, i) => {
  const d = new Date(Date.UTC(2026, 8, 25) + i * 3600e3);
  return d.toISOString().slice(0, 16);
});
const cycle = i => 60 + 10 * Math.sin((i % 24 - 9) / 24 * 2 * Math.PI);
const fake = (withCape) => {
  const hourly = { time: times };
  for (let m = 0; m < M; m++) {
    const suf = m ? '_member' + String(m).padStart(2, '0') : '';
    hourly['temperature_2m' + suf] = times.map((_, i) => +(cycle(i) + (m - 15)).toFixed(2));
    hourly['dew_point_2m' + suf] = times.map((_, i) => 50 + (m - 15) * 0.5);
    hourly['precipitation' + suf] = times.map((_, i) => (i % 24 === 12 ? m / 100 : 0));
    hourly['snowfall' + suf] = times.map(() => 0);
    hourly['wind_speed_10m' + suf] = times.map(() => 10 + (m - 15) * 0.2);
    hourly['wind_gusts_10m' + suf] = times.map(() => 20 + (m - 15) * 0.4);
    if (withCape) hourly['cape' + suf] = times.map((_, i) => m * 100);
  }
  return { timezone_abbreviation: 'CDT', hourly };
};

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
// Returning visitor who has seen the newest What Changed entry, so neither
// the tutorial nor that modal covers the chart being hovered.
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
const asked = [];
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('ensemble-api.open-meteo.com')) {
    asked.push(url);
    // ICON refuses CAPE outright, to prove the retry without it.
    if (url.includes('icon_seamless') && url.includes('cape'))
      return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":true}' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fake(!url.includes('icon_seamless'))) });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
// The mode picker and the What Changed modal cover the page on a first visit.
await p.evaluate(() => ['mode-modal', 'changelog-modal'].forEach(id => { const m = document.getElementById(id); if (m) m.style.display = 'none'; }));

console.log('\n2. opened from the map menu');
{
  await p.evaluate(() => { localStorage.removeItem('gwcfc_mtg_model'); _mtgModel = 'gfs025';
    map.fire('contextmenu', { latlng: L.latLng(35.2, -97.4), originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } }); });
  await p.waitForTimeout(300);
  const row = await p.evaluate(() => [...document.querySelectorAll('#map-ctx-menu .cm-item')].map(x => x.textContent.trim()).find(t => /Meteogram/.test(t)));
  ok('the menu offers it', row === 'Meteogram here', row);
  await p.evaluate(() => [...document.querySelectorAll('#map-ctx-menu .cm-item')].find(x => /Meteogram/.test(x.textContent)).click());
  await p.waitForTimeout(1200);
  const u = new URL(asked[asked.length - 1] || 'http://x');
  ok('asks the ensemble API for the clicked point',
     u.searchParams.get('latitude') === '35.200' && u.searchParams.get('longitude') === '-97.400'
     && u.searchParams.get('models') === 'gfs025' && /temperature_2m/.test(u.searchParams.get('hourly'))
     && u.searchParams.get('temperature_unit') === 'fahrenheit', u.search);
  const st = await p.evaluate(() => {
    const el = document.getElementById('mtg-panel');
    return { open: el.classList.contains('open'), where: el.querySelector('.snd-where').textContent,
      note: el.querySelector('.snd-note').textContent, tabs: [...el.querySelectorAll('.snd-tab')].map(t => t.textContent),
      bg: getComputedStyle(el).backgroundImage.slice(0, 30), pos: getComputedStyle(el).position };
  });
  ok('the panel opens where it was asked', st.open && st.where === '35.20, -97.40', JSON.stringify(st));
  ok('in the sounding panel shell', st.pos === 'fixed' && /gradient/.test(st.bg), st.bg);
  ok('five views', st.tabs.join(',') === 'Temp,Hi / Lo,Precip,Wind,CAPE', st.tabs.join(','));
  ok('says what it is showing', /GEFS, 31 members, 10 days, times in CDT/.test(st.note), st.note);
}

console.log('\n3. the numbers');
{
  const r = await p.evaluate(() => {
    const d = document.getElementById('mtg-panel')._mtg, s = d.stats.temperature_2m[9];
    return { p10: s.p10, p50: s.p50, p90: s.p90, days: d.days.length, hi: d.days[0].hi.p50, hiMax: d.days[0].hi.max,
      qpf: d.qpfStats[d.times.length - 1].p50, members: d.members };
  });
  ok('percentiles are right', Math.abs(r.p50 - 60) < 1e-6 && Math.abs(r.p10 - 48) < 1e-6 && Math.abs(r.p90 - 72) < 1e-6, JSON.stringify(r));
  ok('a high per day per member', r.days === 10 && Math.abs(r.hi - 70) < 0.1 && Math.abs(r.hiMax - 85) < 0.1, JSON.stringify(r));
  ok('the rain plume totals up', Math.abs(r.qpf - 1.5) < 1e-6, r.qpf);
}

console.log('\n4. drawing and the hover readout');
{
  const lit = async () => p.evaluate(() => {
    const cv = document.getElementById('mtg-chart'), g = cv.getContext('2d');
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 20) n++;
    return n;
  });
  for (const tab of ['temp', 'hilo', 'precip', 'wind', 'cape']) {
    await p.evaluate(t => document.querySelector(`#mtg-panel .snd-tab[data-tab="${t}"]`).click(), tab);
    await p.waitForTimeout(150);
    ok(`${tab} draws`, (await lit()) > 3000);
  }
  await p.evaluate(() => document.querySelector('#mtg-panel .snd-tab[data-tab="temp"]').click());
  const hov = async (fx) => {
    const box = await p.evaluate(() => { const r = document.getElementById('mtg-chart').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await p.mouse.move(box.x + box.w * fx, box.y + box.h / 2);
    await p.waitForTimeout(100);
    return p.evaluate(([x, y]) => ({ at: (e => e.id + '.' + e.className)(document.elementFromPoint(x, y)), read: document.querySelector('#mtg-panel .mtg-read').textContent,
      cur: getComputedStyle(document.querySelector('#mtg-panel .mtg-cursor')).display }), [box.x + box.w * fx, box.y + box.h / 2]);
  };
  let h = await hov(0.5);
  ok('hovering shows the percentile breakdown for that hour',
     /Temp 10% \d+ · 25% \d+ · 50% \d+ · 75% \d+ · 90% \d+°F/.test(h.read) && /Dew/.test(h.read) && h.cur === 'block', JSON.stringify(h));
  await p.evaluate(() => document.querySelector('#mtg-panel .snd-tab[data-tab="hilo"]').click());
  h = await hov(0.2);
  ok('and per day on Hi / Lo', /High 10% \d+ · 25% \d+ · 50% 70 · 75% \d+ · 90% \d+°F/.test(h.read) && /Low/.test(h.read), JSON.stringify(h));
  await p.evaluate(() => document.querySelector('#mtg-panel .snd-tab[data-tab="precip"]').click());
  h = await hov(0.99);
  ok('and the rain totals', /Rain total 10% [\d.]+ · 25% [\d.]+ · 50% 1\.50/.test(h.read), h.read);
  await p.evaluate(() => document.querySelector('#mtg-panel .snd-big').click());
  await p.waitForTimeout(300);
  await p.screenshot({ path: process.env.SHOT || '/tmp/meteogram.png' });
  const big = await p.evaluate(() => document.getElementById('mtg-chart').getBoundingClientRect().height);
  ok('expanding makes the chart big', big > 400, big);
  await p.evaluate(() => document.querySelector('#mtg-panel .snd-big').click());
}

console.log('\n5. another ensemble');
{
  asked.length = 0;
  await p.evaluate(() => { const s = document.querySelector('#mtg-panel .snd-src'); s.value = 'icon_seamless'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(1200);
  ok('a model that refuses CAPE is asked again without it', asked.length === 2 && !/cape/.test(asked[1]), asked.join(' | '));
  await p.evaluate(() => document.querySelector('#mtg-panel .snd-tab[data-tab="cape"]').click());
  const r = await p.evaluate(() => ({ note: document.querySelector('#mtg-panel .snd-note').textContent,
    saved: localStorage.getItem('gwcfc_mtg_model'), alert: document.querySelector('#mtg-panel .snd-alert').textContent }));
  ok('and still draws, saying which ensemble', /ICON EPS/.test(r.note) && r.alert === '', JSON.stringify(r));
  ok('the choice is remembered', r.saved === 'icon_seamless');
  await p.keyboard.press('Escape');
  ok('Escape closes it', !(await p.evaluate(() => document.getElementById('mtg-panel').classList.contains('open'))));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
