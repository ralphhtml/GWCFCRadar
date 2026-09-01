#!/usr/bin/env node
/*
 * The NWS bubble: RTMA and NDFD, out of the Models list.
 *
 *     node tools/test-nws-bubble.mjs
 *
 * The contract: a ninth bubble in the left menu opens a source row (Right
 * Now = RTMA, Forecast = NDFD), each source opens its full variable list,
 * and picking a variable drives the same Run Models engine that always
 * rendered them - so runs, hours and playback still work. Meanwhile the
 * Models dropdown no longer OFFERS either one (hidden options remain so the
 * dropdown can display the bubble's choice), and the Pi picker filters RTMA
 * out of its dynamic list.
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
  ok('the bubble is in the column, before Models',
     /id: 'nws',[\s\S]{0,120}toggleNwsSub/.test(PAGE));
  ok('the Models dropdown no longer offers NDFD in the open list',
     /<option value="ndfd" hidden>/.test(PAGE)
     && !/<optgroup label="Map Charts">[\s\S]{0,600}<option value="ndfd">/.test(PAGE));
  ok('and keeps a hidden RTMA entry so the dropdown can display it',
     /<option value="pi:rtma" hidden>/.test(PAGE));
  ok('the Pi picker filters RTMA out of its dynamic list',
     /Object\.keys\(mods\)\.filter\(k => k !== 'rtma'\)/.test(PAGE));
  ok('every source has an info description',
     /'nws-rtma':/.test(PAGE) && /'nws-ndfd':/.test(PAGE) && /\n  nws: {2,}'/.test(PAGE));
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

console.log('\n2. the bubble opens sources, the sources open variables');
{
  const r = await p.evaluate(() => {
    const out = {};
    out.inColumn = !!document.getElementById('sub-nws');
    toggleNwsSub();
    const labels = () => [...document.querySelectorAll('#sub-bubbles .sb-label')]
      .map(x => x.textContent);
    out.sources = labels();
    document.getElementById('sub-nws-ndfd').click();
    out.ndfdRow = labels();
    // Every NDFD product the WMS publishes, not a curated cut.
    out.ndfdCount = SEV_PRODUCTS.ndfd.length;
    document.getElementById('sub-nws-ndfd').click();   // fold it back up
    document.getElementById('sub-nws-rtma').click();
    out.rtmaRow = labels();
    return out;
  });
  ok('the NWS bubble is in the column', r.inColumn);
  ok('it opens with the two sources and a way back',
     r.sources.includes('Back') && r.sources.includes('Right Now')
     && r.sources.includes('Forecast'), JSON.stringify(r.sources));
  ok('Forecast unfolds every NDFD variable',
     r.ndfdCount >= 10
     && r.ndfdRow.filter(l => !['Back', 'Right Now', 'Forecast'].includes(l)).length === r.ndfdCount,
     `${r.ndfdCount} vs ${JSON.stringify(r.ndfdRow)}`);
  ok('Right Now unfolds the RTMA variables',
     r.rtmaRow.filter(l => !['Back', 'Right Now', 'Forecast'].includes(l)).length >= 8,
     JSON.stringify(r.rtmaRow));
}

console.log('\n3. picking a variable drives the Run Models engine');
{
  const r = await p.evaluate(async () => {
    const out = {};
    await _nwsPick('ndfd', 'pop12');
    out.section = _sevSection;
    out.varr = _sevVar;
    out.panelOpen = typeof _runModelsPanelIsOpen === 'function'
      ? _runModelsPanelIsOpen() : null;
    const sel = document.getElementById('sev-model-sel');
    out.dropdownShows = sel ? sel.value : '';
    // The open list must not offer them, but the hidden options let the
    // dropdown display the bubble's choice.
    out.ndfdHidden = !!sel.querySelector('option[value="ndfd"][hidden]');
    out.rtmaHidden = !!sel.querySelector('option[value="pi:rtma"][hidden]');
    return out;
  });
  ok('the section lands on NDFD', r.section === 'ndfd', r.section);
  ok('with the picked variable', r.varr === 'pop12', r.varr);
  ok('and the Run Models panel opens to hold the time controls',
     r.panelOpen === true, String(r.panelOpen));
  ok('the dropdown displays the choice through its hidden option',
     r.dropdownShows === 'ndfd' && r.ndfdHidden, r.dropdownShows);
  ok('and RTMA keeps its hidden entry too', r.rtmaHidden);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
