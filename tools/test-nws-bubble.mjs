#!/usr/bin/env node
/*
 * Per-variable source screens, the Sea Surface Temperature way.
 *
 *     node tools/test-nws-bubble.mjs
 *
 * Tap the Waves bubble, tap Wave Height, and what opens is JUST THE
 * SOURCES for wave height: Open-Meteo and NDFD. Same for Air Temp and
 * Dew Point (Open-Meteo / RTMA / NDFD), Surface Winds, Surface Pressure.
 * Variables the bubbles never had (Max Temp, Wind Gusts, the precip
 * forecasts, visibility...) appear as new rows opening the same kind of
 * screen. Tap a source: layer on. Tap the lit one: off. Back walks up.
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

console.log('\n1. the source keeps the shape of the feature');
{
  ok('the standalone NWS bubble is gone from the column',
     !/id: 'nws',[\s\S]{0,60}label: 'NWS'/.test(PAGE));
  ok('six bubbles host the rows instead',
     ['temperature', 'wind', 'pressure', 'radar', 'waves', 'air']
       .every(b => new RegExp(`  ${b}: \\[`).test(PAGE))
     && /const NWS_SRC_VARS = \{/.test(PAGE));
  ok('every hosting menu appends the NWS-only rows',
     (PAGE.match(/_nwsAppendRows\(wrap, '/g) || []).length === 6);
  ok('the shared variables intercept their own existing rows',
     /b\.id === 'wave-height'\) \{ toggleNwsSourceSub\('waves', 'waveh'\)/.test(PAGE)
     && /b\.id === 'air-temp'\) \{ toggleNwsSourceSub\('temperature', 'temp'\)/.test(PAGE)
     && /b\.id === 'dew-point'\) \{ toggleNwsSourceSub\('temperature', 'dew'\)/.test(PAGE)
     && /b\.id === 'wind-surface'\) \{ toggleNwsSourceSub\('wind', 'wind'\)/.test(PAGE)
     && /b\.id === 'surface'\) \{ toggleNwsSourceSub\('pressure', 'pres'\)/.test(PAGE));
  ok('the Models dropdown still does not offer them',
     /<option value="ndfd" hidden>/.test(PAGE)
     && /Object\.keys\(mods\)\.filter\(k => k !== 'rtma'\)/.test(PAGE));
  ok('the animation bar knows the source, everywhere it must agree',
     /_nwsLoopActive\(\)\) \{\s*const n = _nwsLoop\.frames\.length;/.test(PAGE)  // stepFrame
     && /_nwsLoopActive\(\)\) _nwsLoopShow\(idx\);/.test(PAGE)                    // seekFrame
     && /_nwsLoopActive\(\)\) return true;/.test(PAGE)                            // _animationReady
     && /return mk\('nws', _nwsLoop\.frames/.test(PAGE));                          // _animSource
  ok('the Inspector reads the layer honestly',
     /function _inspNwsRow/.test(PAGE) && /_inspNwsRow\(cx, cy\)/.test(PAGE));
  ok('the Pi handshake is warmed when a menu opens, not on the click',
     /_nwsWarm\(\);   \/\/ the Pi handshake starts NOW/.test(PAGE)
     && /function _nwsWarm/.test(PAGE));
  ok('RTMA manifests are fetched in parallel',
     /Promise\.all\(regionNames\.map/.test(PAGE));
  ok('NDFD wave height exists for the Waves bubble',
     /waveheight: 'ndfd\.conus\.waveheight'/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-nws-bubble.mjs'), 'utf8').includes(EM));
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
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1');
        localStorage.setItem('gwcfc_mode', 'expert'); } catch (e) {}
});
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'),
             { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);

console.log('\n2. tap the variable, get just its sources');
{
  const r = await p.evaluate(() => {
    const out = {};
    // Waves -> Wave Height -> Open-Meteo / NDFD, nothing else.
    toggleWavesSub();
    document.getElementById('sub-wave-height').click();
    out.waveSources = {
      om: !!document.getElementById('sub-nwssrc-openmeteo'),
      ndfd: !!document.getElementById('sub-nwssrc-ndfd'),
      rtma: !!document.getElementById('sub-nwssrc-rtma'),
    };
    out.rows = document.querySelectorAll('#sub-bubbles .sub-bubble').length;
    // Back returns to the Waves menu.
    document.querySelector('#sub-bubbles .sub-bubble').click();
    out.backHome = !!document.getElementById('sub-wave-height');
    // Temperature -> Air Temp -> all three sources.
    toggleTemperatureSub();
    document.getElementById('sub-air-temp').click();
    out.tempAllThree = !!document.getElementById('sub-nwssrc-openmeteo')
      && !!document.getElementById('sub-nwssrc-rtma')
      && !!document.getElementById('sub-nwssrc-ndfd');
    // Pressure -> Surface -> Open-Meteo / RTMA.
    togglePressureSub();
    document.getElementById('sub-surface').click();
    out.presTwo = !!document.getElementById('sub-nwssrc-openmeteo')
      && !!document.getElementById('sub-nwssrc-rtma')
      && !document.getElementById('sub-nwssrc-ndfd');
    // Radar gains new rows for the forecasts it never had. One source is
    // not a choice: tapping the row turns the layer on right there, and no
    // source screen ever appears.
    toggleRadarSub();
    out.radarRow = !!document.getElementById('sub-nws-radar-pop12');
    document.getElementById('sub-nws-radar-pop12').click();
    out.radarDirect = !document.getElementById('sub-nwssrc-ndfd')
      && _nwsOn && _nwsOn.v === 'pop12' && _nwsOn.src === 'ndfd';
    out.radarRowLit = document.getElementById('sub-nws-radar-pop12')
      && document.getElementById('sub-nws-radar-pop12').classList.contains('active');
    _nwsDisable();
    // Sky Cover has two sources, so IT still opens the screen.
    toggleAirSub();
    out.airRows = ['vis', 'sky', 'ceil']
      .every(v => !!document.getElementById('sub-nws-air-' + v));
    document.getElementById('sub-nws-air-sky').click();
    out.skyScreen = !!document.getElementById('sub-nwssrc-rtma')
      && !!document.getElementById('sub-nwssrc-ndfd');
    return out;
  });
  ok('Wave Height offers just Open-Meteo and NDFD',
     r.waveSources.om && r.waveSources.ndfd && !r.waveSources.rtma,
     JSON.stringify(r.waveSources));
  ok('and the screen is only Back plus the sources', r.rows === 3,
     String(r.rows));
  ok('Back returns to the Waves menu', r.backHome);
  ok('Air Temp offers all three sources', r.tempAllThree);
  ok('Surface Pressure offers Open-Meteo and RTMA', r.presTwo);
  ok('Radar gains a Precip Chance row', r.radarRow);
  ok('with one source it toggles on directly, no screen',
     r.radarDirect && r.radarRowLit);
  ok('Air gains visibility, sky cover and ceiling rows', r.airRows);
  ok('Sky Cover, with two sources, still opens the screen', r.skyScreen);
}

console.log('\n3. NDFD draws, loops, and owns the quiet animation bar');
{
  const r = await p.evaluate(async () => {
    const wait = ms => new Promise(res => setTimeout(res, ms));
    const out = {};
    // Through the UI: one tap on the single-source row, on the clock.
    toggleRadarSub();
    const t0 = performance.now();
    document.getElementById('sub-nws-radar-pop12').click();
    out.msToOn = performance.now() - t0;
    out.on = _nwsOn && _nwsOn.src === 'ndfd' && _nwsOn.field === 'pop12';
    // The shown frame owns the map (and the bandwidth) alone at first; the
    // other fifteen join a moment later so scrubbing stays instant.
    out.onMapNow = _nwsLayers.filter(l => map.hasLayer(l)).length;
    await wait(1700);
    out.onMapLater = _nwsLayers.filter(l => map.hasLayer(l)).length;
    out.srcLit = true;
    out.frames = _nwsLoop.frames.length;
    out.stepH = (_nwsLoop.frames[1].time - _nwsLoop.frames[0].time) / 3600000;
    out.allFuture = _nwsLoop.frames.every(f => f.time > Date.now() - 3600000);
    out.layerCount = _nwsLayers.length;
    out.paneMade = !!map.getPane('nwsPane');
    out.loopActive = _nwsLoopActive();
    out.animSource = _animSource().id;
    out.ready = _animationReady();
    const startIdx = _nwsLoop.idx;
    stepFrame(1, true);
    out.stepped = _nwsLoop.idx === startIdx + 1;
    seekFrame(5);
    out.sought = _nwsLoop.idx === 5;
    const at = document.getElementById('anim-time');
    out.label = at ? at.textContent : '';
    out.gold = at ? at.style.color : '';
    return out;
  });
  ok('one tap and the layer is on inside the one-second budget',
     r.on && r.msToOn < 1000, r.msToOn + 'ms');
  ok('the shown frame takes the map alone first',
     r.onMapNow === 1, String(r.onMapNow));
  ok('and the whole pool joins moments later for scrubbing',
     r.onMapLater === 16, String(r.onMapLater));
  ok('sixteen frames, three hours apart', r.frames === 16 && r.stepH === 3,
     `${r.frames} x ${r.stepH}h`);
  ok('every frame is a future moment', r.allFuture);
  ok('one WMS layer per frame, in the NWS pane',
     r.layerCount === 16 && r.paneMade);
  ok('the animation bar adopts it', r.loopActive && r.animSource === 'nws'
     && r.ready, r.animSource);
  ok('step and seek both move it', r.stepped && r.sought);
  ok('the readout names NDFD and the valid time, in gold',
     /^NDFD · valid \d\d:\d\d UTC$/.test(r.label) && r.gold === 'rgb(232, 184, 0)',
     r.label);
}

console.log('\n4. the Inspector reads it, swaps clear it, off means off');
{
  const r = await p.evaluate(() => {
    const out = {};
    out.inspRow = (typeof _inspNwsRow === 'function')
      ? _inspNwsRow(window.innerWidth / 2, window.innerHeight / 2) : null;
    // Picking the bubble's Open-Meteo layer clears the NWS layer (the
    // wrapped loader): simulate the Temperature row's own click.
    return out;
  });
  ok('the Inspector row names the source and variable',
     r.inspRow && /NDFD Precip Chance/.test(r.inspRow.label),
     JSON.stringify(r.inspRow));

  const sw = await p.evaluate(async () => {
    const out = {};
    // Tapping the lit single-source row again turns the layer off.
    toggleRadarSub();
    document.getElementById('sub-nws-radar-pop12').click();
    out.srcTapOff = _nwsOn === null;
    // The Open-Meteo row on a shared screen drives the bubble's own layer,
    // and the two sources swap rather than stack.
    toggleNwsSourceSub('waves', 'waveh');
    document.getElementById('sub-nwssrc-openmeteo').click();
    out.omOn = wavesActive === true && _wavesProduct === 'wave-height';
    document.getElementById('sub-nwssrc-ndfd').click();
    await new Promise(res => setTimeout(res, 300));
    out.omSwappedOff = wavesActive === false && _wavesLayer === null
      && _nwsOn && _nwsOn.v === 'waveh';
    document.getElementById('sub-nwssrc-openmeteo').click();
    out.backToOm = wavesActive === true && _nwsOn === null;
    _nwsFamilyOff('waves');
    await _nwsEnable('temperature', 'temp', 'ndfd');
    out.movedBubbles = _nwsOn.bubble === 'temperature';
    temperatureActive = true;
    _loadTemperatureLayer();
    out.omPickCleared = _nwsOn === null;
    temperatureActive = false;
    await _nwsEnable('temperature', 'dew', 'ndfd');
    const before = !!_nwsOn;
    _nwsDisable();
    out.offMeansOff = before && _nwsOn === null && _nwsLayers.length === 0
      && !_nwsLoopActive() && _animSource().id !== 'nws';
    return out;
  });
  ok('tapping the lit row again turns it off', sw.srcTapOff);
  ok('the Open-Meteo row drives the bubble\'s own layer', sw.omOn);
  ok('picking NDFD swaps Open-Meteo off, layer and all', sw.omSwappedOff);
  ok('and picking Open-Meteo back swaps NDFD off', sw.backToOm);
  ok('enabling in another bubble replaces the old layer', sw.movedBubbles);
  ok('picking the bubble\'s Open-Meteo map clears the NWS layer',
     sw.omPickCleared);
  ok('turning it off removes every layer and frees the bar', sw.offMeansOff);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
