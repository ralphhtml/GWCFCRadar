#!/usr/bin/env node
/*
 * NWS source rows inside the layer bubbles.
 *
 *     node tools/test-nws-bubble.mjs
 *
 * RTMA and NDFD do not get a bubble of their own: they live INSIDE the
 * bubbles that own their subjects - Temperature, Wind, Pressure, Radar,
 * Waves and Air - the way Sea Surface Temperature lives inside Waves.
 * Each bubble gains variable rows; a variable unfolds its sources (RTMA,
 * NDFD); picking one draws straight on the map and joins the bottom
 * animation bar. One source per bubble at a time, tap again to turn off.
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
  ok('every hosting menu appends the rows',
     (PAGE.match(/_nwsAppendRows\(wrap, '/g) || []).length === 6);
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

console.log('\n2. the rows live in their bubbles, variable then source');
{
  const r = await p.evaluate(() => {
    const out = {};
    toggleTemperatureSub();
    out.tempRow = !!document.getElementById('sub-nws-temperature-temp');
    out.noSrcYet = !document.getElementById('sub-nws-temperature-temp-rtma');
    document.getElementById('sub-nws-temperature-temp').click();
    out.rtmaPill = !!document.getElementById('sub-nws-temperature-temp-rtma');
    out.ndfdPill = !!document.getElementById('sub-nws-temperature-temp-ndfd');
    // Max Temp is NDFD-only; unfolding it must not invent an RTMA pill.
    document.getElementById('sub-nws-temperature-maxt').click();
    out.maxtNdfdOnly = !!document.getElementById('sub-nws-temperature-maxt-ndfd')
      && !document.getElementById('sub-nws-temperature-maxt-rtma');
    toggleRadarSub();
    out.radarRows = ['pop12', 'qpf', 'snow', 'wx']
      .every(v => !!document.getElementById('sub-nws-radar-' + v));
    toggleWavesSub();
    out.waveRow = !!document.getElementById('sub-nws-waves-waveh');
    toggleAirSub();
    out.airRows = ['vis', 'sky', 'ceil']
      .every(v => !!document.getElementById('sub-nws-air-' + v));
    return out;
  });
  ok('Temperature carries an NWS Temperature row', r.tempRow);
  ok('sources stay folded until the variable is tapped', r.noSrcYet);
  ok('tapping it unfolds RTMA and NDFD', r.rtmaPill && r.ndfdPill);
  ok('an NDFD-only variable offers only NDFD', r.maxtNdfdOnly);
  ok('Radar gains all four precip forecast rows', r.radarRows);
  ok('Waves gains the NDFD wave height row', r.waveRow);
  ok('Air gains visibility, sky cover and ceiling', r.airRows);
}

console.log('\n3. NDFD draws, loops, and owns the quiet animation bar');
{
  const r = await p.evaluate(async () => {
    const out = {};
    // No radar in this boot, so the bar is free for the forecast to claim.
    await _nwsEnable('radar', 'pop12', 'ndfd');
    out.on = _nwsOn && _nwsOn.src === 'ndfd' && _nwsOn.field === 'pop12';
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
  ok('the layer comes on with its field', r.on);
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
  ok('enabling in another bubble replaces the old layer', sw.movedBubbles);
  ok('picking the bubble\'s Open-Meteo map clears the NWS layer',
     sw.omPickCleared);
  ok('turning it off removes every layer and frees the bar', sw.offMeansOff);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
