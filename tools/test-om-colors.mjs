#!/usr/bin/env node
/*
 * Settings > Open-Meteo Colors: custom colour scales for the five layers
 * drawn from Open-Meteo's live grids (Waves, Air, Wind, Temperature,
 * Pressure).
 *
 *     node tools/test-om-colors.mjs
 *
 * Checked here: the settings tab and every product in its picker; the
 * built-in colours until something is edited; an edited colour is what the
 * layer paints (and the Inspector reads); editing repaints a layer that is
 * on without refetching it; values, add, remove, invert and presets; it is
 * saved and comes back after a reload; and Back to Normal, for one product
 * or all of them.
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
  ok('a Settings group of its own', /data-cat="omcolors"[\s\S]{0,300}Open-Meteo Colors/.test(PAGE));
  ok('all five layers read their scale through the override',
     ["_omScale('waves:'", "_omScale('air:'", "_omScale('temperature:'", "_omScale('pressure'", "_omScale('wind'"]
       .every(t => PAGE.includes(t)));
  ok('no em dashes in the new code or this test',
     !PAGE.slice(PAGE.indexOf('// -- OPEN-METEO COLORS'), PAGE.indexOf('function _omUiResetAll')).includes(String.fromCharCode(0x2014))
     && !readFileSync(join(ROOT, 'tools/test-om-colors.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));
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
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
const boot = async () => {
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
};
await boot();
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n2. the Settings tab and its picker');
{
  const r = await p.evaluate(() => {
    lqmOpenSettings();
    // The rail names each tab after its section's heading.
    const tab = [...document.querySelectorAll('#lqm-set-rail .lqm-set-tab')].find(t => /Open-Meteo Colors/.test(t.textContent));
    if (tab) tab.click();
    const group = document.getElementById('lqm-om-field').closest('.lqm-settings-group');
    const sel = document.getElementById('lqm-om-field');
    return { shown: group && !group.hidden, tab: tab ? tab.textContent.trim() : null,
             opts: [...sel.options].map(o => o.value), stops: document.querySelectorAll('#lqm-om-stops .lqm-grad-stop').length,
             toggle: document.getElementById('lqm-om-colors-on').checked,
             preview: document.getElementById('lqm-om-preview').style.background };
  });
  ok('Settings has an Open-Meteo Colors tab, and it opens', r.shown && /Open-Meteo Colors/.test(r.tab), JSON.stringify(r));
  ok('every product of the five layers is in the picker', r.opts.length === 13
     && ['waves:wave-height', 'air:us-aqi', 'temperature:dew-point', 'wind', 'pressure'].every(k => r.opts.includes(k)), r.opts.join(','));
  ok('it starts on the built-in colours, written out as editable stops', r.stops >= 5 && r.toggle === false, JSON.stringify(r));
  ok('with a preview bar', /linear-gradient/.test(r.preview), r.preview);
}

console.log('\n3. an edited colour is what the layer paints, and the layer repaints');
{
  const r = await p.evaluate(() => {
    const before = _temperatureColorFor('air-temp', -20);
    // A temperature layer that is on, with its numbers already fetched.
    temperatureActive = true;
    _temperatureProduct = 'air-temp';
    _temperatureAllGrids = { cols: TEMPERATURE_COLS, rows: TEMPERATURE_ROWS,
      grids: { temperature_2m: new Array(TEMPERATURE_COLS * TEMPERATURE_ROWS).fill(-20),
               apparent_temperature: new Array(TEMPERATURE_COLS * TEMPERATURE_ROWS).fill(-20),
               dew_point_2m: new Array(TEMPERATURE_COLS * TEMPERATURE_ROWS).fill(-20) } };
    let paints = 0;
    const real = _paintAndShowTemperature;
    window._paintAndShowTemperature = function (...a) { paints++; return real.apply(this, a); };
    _omUiPick('temperature:air-temp');
    _omUiColor(0, '#00ff00');
    const after = _temperatureColorFor('air-temp', -20);
    const other = _temperatureColorFor('dew-point', 20);
    window._paintAndShowTemperature = real;
    const insp = _inspTemperatureRow({ lat: 0, lng: 0 });
    return { before, after, other, paints, on: document.getElementById('lqm-om-colors-on').checked,
             stored: JSON.parse(localStorage.getItem('gwcfc_om_colors') || '{}') };
  });
  ok('the lowest temperature now paints the colour picked', r.after.join() === '0,255,0' && r.before.join() !== '0,255,0',
     JSON.stringify([r.before, r.after]));
  ok('editing turns custom colours on', r.on === true);
  ok('other products keep their own colours', r.other.join() !== '0,255,0', JSON.stringify(r.other));
  ok('the temperature layer on the map repainted, with no refetch', r.paints === 1, String(r.paints));
  ok('and it is saved on this device', r.stored['temperature:air-temp'] && r.stored['temperature:air-temp'].on === true);
}

console.log('\n4. values, add, remove, invert, presets');
{
  const r = await p.evaluate(() => {
    const n0 = _omUiStops().length;
    _omUiAddStop();
    const n1 = _omUiStops().length;
    _omUiRemove(1);
    const n2 = _omUiStops().length;
    _omUiValue(0, -40);
    const lowV = _omUiStops()[0].v;
    const first = _omUiStops()[0].c, last = _omUiStops()[_omUiStops().length - 1].c;
    _omUiInvert();
    const inv = [_omUiStops()[0].c, _omUiStops()[_omUiStops().length - 1].c];
    _omUiPreset('grayscale');
    const pre = _omUiStops();
    const def = _omDef('temperature:air-temp');
    const whiteAtTop = _temperatureColorFor('air-temp', def.max).join();
    return { n0, n1, n2, lowV, first, last, inv, preLen: pre.length, preLo: pre[0].v, preHi: pre[pre.length - 1].v,
             defLo: def.min, defHi: def.max, whiteAtTop };
  });
  ok('+ Color adds a stop, x removes one', r.n1 === r.n0 + 1 && r.n2 === r.n0, JSON.stringify(r));
  ok('a stop\'s starting value can be typed', r.lowV === -40, String(r.lowV));
  ok('Invert swaps the ends', r.inv[0] === r.last && r.inv[1] === r.first, JSON.stringify(r));
  ok('a preset spreads across this product\'s own range', r.preLen === 5 && r.preLo === r.defLo && r.preHi === r.defHi, JSON.stringify(r));
  ok('and paints with it (white at the top of Grayscale)', r.whiteAtTop === '255,255,255', r.whiteAtTop);
}

console.log('\n5. kept across a reload');
await boot();
{
  const r = await p.evaluate(() => ({ top: _temperatureColorFor('air-temp', _omDef('temperature:air-temp').max).join(),
                                      pick: _omUiKey }));
  ok('the custom colours come back after a reload', r.top === '255,255,255', r.top);
  ok('and the editor reopens on the same product', r.pick === 'temperature:air-temp', r.pick);
}

console.log('\n6. off, and Back to Normal');
{
  const r = await p.evaluate(() => {
    lqmOpenSettings();
    const builtIn = _colorScale(_omDef('temperature:air-temp').max, TEMP_SCALE).join();
    const tog = document.getElementById('lqm-om-colors-on');
    tog.checked = false; tog.dispatchEvent(new Event('change'));
    const off = _temperatureColorFor('air-temp', _omDef('temperature:air-temp').max).join();
    tog.checked = true; tog.dispatchEvent(new Event('change'));
    const onAgain = _temperatureColorFor('air-temp', _omDef('temperature:air-temp').max).join();
    _omUiPick('wind'); _omUiColor(0, '#123456');
    const windCustom = _windColorFor(0).join();
    _omUiPick('temperature:air-temp');
    _omUiReset();
    const reset = _temperatureColorFor('air-temp', _omDef('temperature:air-temp').max).join();
    const windStill = _windColorFor(0).join();
    _omUiResetAll();
    const windBack = _windColorFor(0).join();
    return { builtIn, off, onAgain, reset, windCustom, windStill, windBack,
             windBuiltIn: _colorScale(0, WIND_SPEED_SCALE).join(), stored: localStorage.getItem('gwcfc_om_colors') };
  });
  ok('switching Custom Colors off paints the built-in scale, and on brings yours back',
     r.off === r.builtIn && r.onAgain === '255,255,255', JSON.stringify(r));
  ok('Back to Normal (this layer) resets only that product', r.reset === r.builtIn && r.windStill === r.windCustom, JSON.stringify(r));
  ok('Back to Normal (all layers) resets everything', r.windBack === r.windBuiltIn && r.stored === '{}', JSON.stringify(r));
}

ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
