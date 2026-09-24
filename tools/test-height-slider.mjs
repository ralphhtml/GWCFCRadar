#!/usr/bin/env node
/*
 * The height slider: Temperature, Wind and Pressure can read the air above
 * the ground at Open-Meteo's pressure levels, picked on a small elevator of
 * notches that sits right under the left-hand menu while one of them is on.
 *
 *     node tools/test-height-slider.mjs
 *
 * Checked here, with Open-Meteo stubbed: the ground query is unchanged; a
 * level asks for that level's fields in the hourly shape and paints them; the
 * colours aloft are measured against the standard atmosphere; Pressure aloft
 * is geopotential height in decametres; Wind gets an 80 m step; Feels Like and
 * the Jet Stream lock the slider; the Inspector names the level; the choice
 * is saved and comes back after a reload; and the slider leaves with the
 * last layer.
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
  ok('levels for all three layers', /const LVL_STEPS = \{[\s\S]{0,300}temperature:[\s\S]{0,200}wind:[\s\S]{0,200}pressure:/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes in the new code or this test',
     !PAGE.slice(PAGE.indexOf('// -- HEIGHT SLIDER'), PAGE.indexOf('// -- TEMPERATURE LAYER')).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-height-slider.mjs'), 'utf8').includes(EM));
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
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });

// Open-Meteo, faked: every place gets the same numbers, each field its own.
const VALUES = {
  temperature_2m: 70, apparent_temperature: 72, dew_point_2m: 50,
  temperature_500hPa: -6, dew_point_500hPa: -30, temperature_850hPa: 45, dew_point_850hPa: 30,
  wind_speed_10m: 10, wind_direction_10m: 180, wind_speed_80m: 20, wind_direction_80m: 190,
  wind_speed_850hPa: 35, wind_direction_850hPa: 250, wind_speed_250hPa: 120, wind_direction_250hPa: 270,
  pressure_msl: 1013, surface_pressure: 1000, geopotential_height_500hPa: 5700,
};
const asked = [];
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('api.open-meteo.com')) {
    asked.push(url);
    const u = new URL(url);
    const n = u.searchParams.get('latitude').split(',').length;
    const cur = (u.searchParams.get('current') || '').split(',').filter(Boolean);
    const hr = (u.searchParams.get('hourly') || '').split(',').filter(Boolean);
    const stamp = new Date().toISOString().slice(0, 13) + ':00';
    const one = () => {
      const o = {};
      if (cur.length) o.current = Object.fromEntries(cur.map(f => [f, VALUES[f] ?? null]));
      if (hr.length) {
        o.hourly = { time: ['2000-01-01T00:00', stamp] };
        hr.forEach(f => { o.hourly[f] = [-999, VALUES[f] ?? null]; });
      }
      return o;
    };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(Array.from({ length: n }, one)) });
  }
  return route.abort();
});
const boot = async () => {
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
};
await boot();
ok('the page boots clean', errs.length === 0, errs[0]);

const last = () => asked[asked.length - 1] || '';
const dock = () => p.evaluate(() => {
  const d = document.getElementById('lvl-dock');
  if (!d) return null;
  return { open: d.classList.contains('open') && getComputedStyle(d).display !== 'none',
           cols: [...d.querySelectorAll('.lvl-col')].map(c => ({ id: c.dataset.layer, locked: c.classList.contains('locked'),
             active: (c.querySelector('.lvl-notch.active') || {}).dataset?.lvl,
             notches: [...c.querySelectorAll('.lvl-notch')].map(n => n.dataset.lvl) })) };
});
const click = async (layer, lvl) => {
  // Clicked through the page: the first-visit mode picker covers the map here.
  await p.evaluate(([l, v]) => document.querySelector(`#lvl-dock .lvl-notch[data-layer="${l}"][data-lvl="${v}"]`).click(), [layer, String(lvl)]);
  await p.waitForTimeout(900);
};

console.log('\n2. temperature');
{
  ok('no slider while nothing is on', !(await dock())?.open);
  asked.length = 0;
  await p.evaluate(() => { temperatureActive = true; _temperatureProduct = 'air-temp'; _loadTemperatureLayer(); });
  await p.waitForTimeout(1200);
  ok('the ground reading asks exactly what it always did',
     /current=temperature_2m,apparent_temperature,dew_point_2m&temperature_unit=fahrenheit/.test(last()) && !/hourly/.test(last()), last().slice(-120));
  let d = await dock();
  ok('the slider appears with the layer', d && d.open && d.cols.length === 1 && d.cols[0].id === 'temperature', JSON.stringify(d));
  ok('left to right, ground to jet stream, on the ground',
     d && d.cols[0].notches.join(',') === 'sfc,1000,925,850,700,500,300,250' && d.cols[0].active === 'sfc', JSON.stringify(d?.cols[0]));
  asked.length = 0;
  await click('temperature', 500);
  ok('500 mb asks for that level in the hourly shape',
     /hourly=temperature_500hPa,dew_point_500hPa&forecast_days=1&temperature_unit=fahrenheit/.test(last()), last().slice(-120));
  const r = await p.evaluate(() => {
    const row = _inspTemperatureRow({ lat: 30, lng: -90 });
    const std = _temperatureColorFor('air-temp', -6).join(',');
    const ground59 = _colorScale(59, TEMP_SCALE).join(',');
    return { v: _temperatureGridCache.grid.find(x => x != null), label: row.label, value: row.value, std, ground59,
             saved: localStorage.getItem('gwcfc_om_level'), lvl: _temperatureAllGrids.level };
  });
  ok('and paints what came back', r.v === -6 && r.lvl === 500, JSON.stringify(r));
  ok('the Inspector names the level and keeps the real number', /500 mb/.test(r.label) && /-6|-21/.test(String(r.value)), `${r.label} ${r.value}`);
  ok('a normal day at 500 mb gets the ordinary-day colour, not deep purple', r.std === r.ground59, `${r.std} vs ${r.ground59}`);
  ok('the choice is saved', JSON.parse(r.saved).temperature === 500, r.saved);
  d = await dock();
  ok('the notch moves', d.cols[0].active === '500');
  await p.evaluate(() => { _temperatureProduct = 'feels-like'; });
  await p.waitForTimeout(800);
  d = await dock();
  ok('Feels Like only exists at the ground: locked on Sfc', d.cols[0].locked && d.cols[0].active === 'sfc', JSON.stringify(d.cols[0]));
  asked.length = 0;
  await click('temperature', 850);
  ok('and a locked slider asks for nothing', asked.length === 0, asked[0]);
  await p.evaluate(() => { _temperatureProduct = 'air-temp'; });
}

console.log('\n3. wind');
{
  asked.length = 0;
  await p.evaluate(() => { windActive = true; _windProduct = 'wind-surface'; _loadWindLayer(); });
  await p.waitForTimeout(1200);
  ok('the ground wind is the old 10 m query', /current=wind_speed_10m,wind_direction_10m/.test(last()), last().slice(-100));
  let d = await dock();
  ok('two columns now, wind with its 80 m step',
     d.cols.length === 2 && d.cols[1].id === 'wind' && d.cols[1].notches.includes('80m'), JSON.stringify(d.cols.map(c => c.id)));
  await click('wind', '80m');
  ok('80 m', /current=wind_speed_80m,wind_direction_80m/.test(last()), last().slice(-100));
  await click('wind', 850);
  ok('850 mb in the hourly shape', /hourly=wind_speed_850hPa,wind_direction_850hPa&forecast_days=1/.test(last()), last().slice(-100));
  const r = await p.evaluate(() => ({ v: _windGridCache.grid.find(x => x != null), row: _inspWindRow({ lat: 30, lng: -90 }) }));
  ok('and paints it, the Inspector naming the level', r.v === 35 && /850 mb/.test(r.row.label), JSON.stringify(r));
  await p.evaluate(() => { _windProduct = 'wind-jet'; _loadWindLayer(); });
  await p.waitForTimeout(1200);
  d = await dock();
  ok('the Jet Stream product is 250 mb: locked there', d.cols[1].locked && d.cols[1].active === '250', JSON.stringify(d.cols[1]));
  ok('and still reads 250 mb', /hourly=wind_speed_250hPa/.test(last()), last().slice(-100));
  await p.evaluate(() => { _windProduct = 'wind-surface'; _loadWindLayer(); });
  await p.waitForTimeout(1200);
  ok('back to Surface Winds, the 850 mb choice is still there', /wind_speed_850hPa/.test(last()), last().slice(-100));
}

console.log('\n4. pressure becomes heights aloft');
{
  asked.length = 0;
  await p.evaluate(() => { pressureActive = true; _pressureProduct = 'sea-level'; _loadPressureLayer(); });
  await p.waitForTimeout(1200);
  ok('sea level is the old query', /current=pressure_msl,surface_pressure/.test(last()), last().slice(-100));
  await click('pressure', 500);
  ok('500 mb asks for its geopotential height', /hourly=geopotential_height_500hPa&forecast_days=1/.test(last()), last().slice(-100));
  const r = await p.evaluate(() => ({ row: _inspPressureRow({ lat: 30, lng: -90 }), v: _pressureGridCache.grid.find(x => x != null),
    mid: _pressureColorFor('sea-level', 5475).join(','), midRef: _colorScale(1005, PRESSURE_SCALE).join(',') }));
  ok('in decametres, the way 500 mb charts are labelled', r.v === 5700 && r.row.value === '570' && /dam/.test(r.row.unit) && /500 mb height/.test(r.row.label), JSON.stringify(r.row));
  ok('each level spread across the whole colour scale', r.mid === r.midRef, `${r.mid} vs ${r.midRef}`);
  const d = await dock();
  ok('three columns, one per layer', d.cols.map(c => c.id).join(',') === 'temperature,wind,pressure');
}

console.log('\n5. placement, reload, leaving');
{
  const slid = await p.evaluate(() => {
    const r = document.querySelector('#lvl-dock .lvl-range[data-layer="pressure"]');
    const box = document.getElementById('lvl-dock').getBoundingClientRect();
    r.value = String(LVL_STEPS.pressure.indexOf(300)); r.dispatchEvent(new Event('input'));
    const preview = r.closest('.lvl-col').querySelector('.lvl-ft').textContent, still = _omLevel.pressure;
    r.dispatchEvent(new Event('change'));
    return { type: r.type, wide: box.width > box.height * 0.6 || document.querySelectorAll('#lvl-dock .lvl-col').length > 2,
             preview, still, after: _omLevel.pressure };
  });
  ok('each layer is a plain horizontal slider', slid.type === 'range' && slid.wide, JSON.stringify(slid));
  ok('dragging previews the level and releasing picks it', /300 mb, ~30,000 ft/.test(slid.preview) && slid.still === 500 && slid.after === 300, JSON.stringify(slid));
  await p.waitForTimeout(600);
  await p.evaluate(() => _lvlSet('pressure', 500));
  await p.waitForTimeout(600);
  const box = await p.evaluate(() => {
    const a = document.getElementById('lvl-dock').getBoundingClientRect();
    const r = document.getElementById('sub-bubbles').getBoundingClientRect();
    return { left: a.left, top: a.top, bottom: a.bottom, h: innerHeight, menuLeft: r.left, menuRight: r.right, menuBottom: r.bottom };
  });
  ok('it sits on screen, right under the left-hand menu (or beside it when the menu is long)',
     box.top >= 0 && box.bottom <= box.h
     && ((Math.abs(box.left - box.menuLeft) < 2 && box.top >= box.menuBottom) || box.left >= box.menuRight), JSON.stringify(box));
  await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; });
  await p.screenshot({ path: process.env.SHOT || '/tmp/height-slider.png' });
  await boot();
  const lv = await p.evaluate(() => ({ ..._omLevel }));
  ok('the levels come back after a reload', lv.temperature === 850 || lv.temperature === 500, JSON.stringify(lv));
  ok('every layer keeps its own', lv.wind === 850 && lv.pressure === 500, JSON.stringify(lv));
  await p.evaluate(() => { temperatureActive = true; _temperatureProduct = 'air-temp'; });
  await p.waitForTimeout(800);
  ok('shown again when a layer comes on', (await dock()).open);
  await p.evaluate(() => { temperatureActive = false; });
  await p.waitForTimeout(800);
  ok('and gone with the last layer', !(await dock()).open);
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
