#!/usr/bin/env node
/*
 * The forecast popup's chart card: the next 24 hours of one condition,
 * drawn as a line, with pills to pick the condition.
 *
 *     node tools/test-forecast-chart.mjs
 *
 * Open-Meteo is mocked with a synthetic but plausible day, so this runs
 * offline and the numbers on the axis are knowable in advance.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the pieces are in the page');
{
  const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const varsBlock = PAGE.slice(PAGE.indexOf('const FC_CHART_VARS'),
                               PAGE.indexOf('let _fcChartVar'));
  ok('ten conditions are on offer',
     (varsBlock.match(/\{ id: '/g) || []).length === 10);
  ok('one series per chart, hover layer wired',
     /_fcChartRender/.test(PAGE) && /fc-chart-hair/.test(PAGE)
     && /svg\.addEventListener\('pointermove', show\);/.test(PAGE));
  ok('the line wears the app blue, dots ringed in the card colour',
     /stroke="#3A74BD" stroke-width="2"/.test(PAGE)
     && /fill="#3A74BD" stroke="#10151a" stroke-width="2"/.test(PAGE));
  ok('a percentage owns its floor and ceiling',
     /id: 'precip',[^}]*lo: 0, hi: 100/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes in the new work',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-forecast-chart.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const H = 48;
const t0 = new Date('2026-09-21T20:00');
const times = [], temp = [], pp = [];
for (let i = 0; i < H; i++) {
  const d = new Date(+t0 + i * 3600e3);
  times.push(d.toISOString().slice(0, 16));
  temp.push(+(75 + 6 * Math.sin(i / 5)).toFixed(1));
  pp.push(Math.max(0, Math.round(40 * Math.sin(i / 7))));
}
const day = k => new Date(+t0 + k * 86400e3).toISOString().slice(0, 10);
const mock = {
  current: { time: times[0], temperature_2m: temp[0], weather_code: 2, wind_speed_10m: 8,
    wind_direction_10m: 180, relative_humidity_2m: 60, apparent_temperature: temp[0] + 3,
    dew_point_2m: temp[0] - 8, surface_pressure: 1014, cloud_cover: 50, visibility: 24000,
    uv_index: 5, precipitation: 0 },
  daily: { time: [0, 1, 2].map(day), weather_code: [2, 2, 2],
    temperature_2m_max: [85, 84, 83], temperature_2m_min: [72, 71, 70],
    precipitation_sum: [0, 0, 1], wind_speed_10m_max: [12, 14, 10],
    wind_direction_10m_dominant: [180, 190, 170], uv_index_max: [7, 7, 6],
    sunrise: [0, 1, 2].map(k => day(k) + 'T07:05'), sunset: [0, 1, 2].map(k => day(k) + 'T19:12') },
  hourly: { time: times, weather_code: times.map(() => 2), temperature_2m: temp,
    apparent_temperature: temp.map(t => t + 3), precipitation_probability: pp,
    wind_speed_10m: temp.map(() => 8), wind_direction_10m: temp.map(() => 180),
    wind_gusts_10m: temp.map(() => 14), relative_humidity_2m: temp.map(() => 60),
    dew_point_2m: temp.map(t => t - 8), surface_pressure: temp.map(() => 1014),
    cloud_cover: temp.map(() => 50), visibility: temp.map(() => 24000) },
};

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1100, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('open-meteo')) return route.fulfill({
    contentType: 'application/json', body: JSON.stringify(mock) });
  if (url.includes('leaflet') && url.endsWith('.js')) return route.fulfill({
    contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css')) return route.fulfill({
    contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(5000);

console.log('\n2. the card draws, and the pills drive it');
{
  await p.evaluate(() => openForecastModal({ name: 'Testville', lat: 30, lon: -95 }));
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => ({
    title: (document.getElementById('fc-chart-title') || {}).textContent,
    svg: !!document.getElementById('fc-chart-svg'),
    pills: document.querySelectorAll('.fc-chart-pill').length,
    dots: document.querySelectorAll('#fc-chart-svg circle').length,
    yTexts: [...document.querySelectorAll('#fc-chart-svg text')].map(t => t.textContent),
  }));
  ok('the chart opens on Temperature', r.title === 'Temperature', r.title);
  ok('an SVG with a line and about a day of dots', r.svg && r.dots >= 20 && r.dots <= 30,
     String(r.dots));
  ok('all ten pills are there', r.pills === 10, String(r.pills));
  ok('the axis speaks in round numbers',
     r.yTexts.some(t => /^\d+$/.test(t)) && !r.yTexts.some(t => /\d\.\d{2,}/.test(t)),
     r.yTexts.slice(0, 6).join(','));

  const sw = await p.evaluate(() => {
    _fcChartPick('precip');
    const texts = [...document.querySelectorAll('#fc-chart-svg text')].map(t => t.textContent);
    return {
      title: document.getElementById('fc-chart-title').textContent,
      on: document.getElementById('fc-pill-precip').classList.contains('on'),
      hasCeiling: texts.includes('100%'), hasFloor: texts.includes('0%'),
    };
  });
  ok('a pill tap swaps the condition and lights itself',
     sw.title === 'Precip Chance' && sw.on, JSON.stringify(sw));
  ok('the percentage axis runs its full 0 to 100',
     sw.hasFloor && sw.hasCeiling, JSON.stringify(sw));

  const box = await p.evaluate(() => {
    const s = document.getElementById('fc-chart-svg').getBoundingClientRect();
    return { x: s.left + s.width * 0.5, y: s.top + s.height * 0.5 };
  });
  await p.mouse.move(box.x, box.y);
  await p.waitForTimeout(250);
  const tip = await p.evaluate(() => ({
    shown: getComputedStyle(document.getElementById('fc-chart-tip')).display !== 'none',
    text: document.getElementById('fc-chart-tip').textContent,
    hair: document.getElementById('fc-chart-hair').style.display !== 'none',
  }));
  ok('hovering raises the crosshair and a tip with hour and value',
     tip.shown && tip.hair && /^\d{1,2} (AM|PM) · \d+%$/.test(tip.text), tip.text);
  ok('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
