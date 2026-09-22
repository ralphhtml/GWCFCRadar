#!/usr/bin/env node
/*
 * The Predict button is gone (a typed question carries the whole job now),
 * Asturio can see the exact product every layer is showing rather than
 * just which switches are flipped, and the panel itself is rebuilt on the
 * app's own tokens with subtle frost instead of a bespoke gold-and-red
 * gradient from before that system existed.
 *
 *     node tools/test-ai-panel-redesign.mjs
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

console.log('\n1. the Predict button is gone, not just hidden');
{
  ok('no #lqm-ai-predict button in the markup', !/id="lqm-ai-predict"/.test(PAGE));
  ok('no fxPredict function left calling it', !/function fxPredict\(\)/.test(PAGE));
  ok('_fxForced is gone too, dead now that only one thing sets it',
     !/let _fxForced/.test(PAGE) && !/_fxForced/.test(PAGE));
  ok('a prediction is decided by _fxWantsPrediction alone',
     /const wantsPrediction = _fxWantsPrediction\(text\);/.test(PAGE));
}

console.log('\n2. the wording alone covers what the button used to catch');
{
  ok('a plain "briefing" ask is recognised',
     /if \(\/\\bbrief\(ing\)\?\\b\/\.test\(t\)\) return true;/.test(PAGE));
  ok('"should I be worried" style asks are recognised',
     /should i \(worry\|be worried\|be concerned\|evacuate\|shelter\)/.test(PAGE));
  ok('"am I safe" style asks are recognised',
     /\(am i\|are we\) \(safe\|in danger\|at risk\)/.test(PAGE));
  ok('the word "conditions" alone can trigger it, from the request wording',
     /predict\|forecast\|outlook\|prognos\|conditions/.test(PAGE));
}

console.log('\n3. every product family reaches the prompt, not just the switch name');
{
  ok('the five families are read through _PRODUCT_FAMILIES and their own sub-bubble labels',
     /_PRODUCT_FAMILIES\.forEach\(f => \{/.test(PAGE)
     && /waves: typeof WAVES_SUB_BUBBLES/.test(PAGE)
     && /wind: typeof WIND_SUB_BUBBLES/.test(PAGE));
  ok('satellite is reported only when the layer is actually on',
     /activeLayers\.satellite\s*\n?\s*&& typeof _goesProduct === 'function'/.test(PAGE)
     || /activeLayers !== 'undefined' && activeLayers\.satellite[\s\S]{0,40}_goesProduct === 'function'/.test(PAGE));
  ok('the old unconditional satellite read (reported it even when off) is gone',
     !/if \(typeof _goesProduct === 'function'\) \{\s*\n\s*const g = _goesProduct\(\);\s*\n\s*if \(g\) put\('Satellite', \(g\.label \|\| g\.id \|\| 'on'\)\);/.test(PAGE));
}

console.log('\n4. the panel wears the app\'s own tokens, not a bespoke gradient');
{
  ok('the overlay body is the shared panel slab',
     /#lqm-ai-overlay \{\s*\n\s*background-image: var\(--grad-panel\);/.test(PAGE));
  ok('the header joined the shared panel-lid group',
     /#lqm-ai-header,?\s*\{|#fnv3-tabs, #lqm-ai-header/.test(PAGE));
  ok('the old hand-mixed header gradient is gone from AI\'s own header rule '
     + '(the live chat panel keeps its own copy, untouched, on purpose)',
     !/#lqm-ai-header \{[\s\S]{0,200}rgba\(160,10,10/.test(PAGE));
  ok('the quick chips wear the blue accent, not the alert red',
     /\.ai-chip \{[\s\S]{0,200}color: var\(--accent2\);/.test(PAGE));
  ok('subtle frost is registered for the panel, its tools and its chips',
     /:root\[data-glass\] #lqm-ai-overlay,\s*\n:root\[data-glass\] \.ai-tool,\s*\n:root\[data-glass\] \.ai-chip \{/.test(PAGE));
}

console.log('\n5. the missing button is fixed, not just removed');
{
  ok('lqm-ai-speak (never styled before) now shares .ai-tool with the rest',
     /<button id="lqm-ai-speak" class="ai-tool"/.test(PAGE));
  ok('all four tool buttons share one class', (PAGE.match(/class="ai-tool"/g) || []).length === 4);
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-ai-panel-redesign.mjs'), 'utf8').includes(EM));
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
const p = await b.newPage({ viewport: { width: 900, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
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
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);

console.log('\n6. live in the browser');
{
  const r = await p.evaluate(() => {
    const out = {};
    out.predictGone = !document.getElementById('lqm-ai-predict');
    out.fxPredictGone = typeof fxPredict === 'undefined';
    out.speakStyled = getComputedStyle(document.getElementById('lqm-ai-speak'))
      .backgroundImage.includes('gradient');
    // Light every product family, satellite left off on purpose.
    windActive = true; _windProduct = 'wind-jet';
    wavesActive = true; _wavesProduct = 'sst';
    airActive = true; _airProduct = 'pm25';
    temperatureActive = true; _temperatureProduct = 'feels-like';
    pressureActive = true; _pressureProduct = 'surface';
    activeLayers.satellite = false;
    out.liveState = _aiLiveState();
    out.wantsOrdinary = _fxWantsPrediction('what is the wind in tulsa');
    out.wantsBriefing = _fxWantsPrediction('give me a briefing');
    return out;
  });
  ok('the Predict button and its function are both actually gone',
     r.predictGone && r.fxPredictGone);
  ok('the read-aloud button finally has real styling',
     r.speakStyled, r.speakStyled);
  ['Wind: Jet', 'Waves: Sea', 'Air quality: PM2.5', 'Temperature: Feels', 'Pressure: Surface']
    .forEach(frag => ok(`live state reports "${frag}..."`, r.liveState.includes(frag), r.liveState));
  ok('satellite, switched off, does not appear at all',
     !r.liveState.includes('Satellite'), r.liveState);
  ok('an ordinary question still does not trigger a scan',
     r.wantsOrdinary === false);
  ok('"give me a briefing" does, replacing the button',
     r.wantsBriefing === true);
  ok('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
