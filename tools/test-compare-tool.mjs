#!/usr/bin/env node
/*
 * The Compare tool on the tool rail: one menu bar, like the Polygon tool's,
 * for every comparison. Same layer is radar beside radar or satellite
 * beside satellite; Cross layer puts a different map layer in each pane
 * (radar | satellite, for one) by cutting each layer's own pane down to the
 * panes it was given, along the same shared split lines.
 *
 *     node tools/test-compare-tool.mjs
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

console.log('\n1. the page carries the tool and its menu bar');
{
  ok('a Compare button on the tool rail', /<button class="tool-btn" id="tool-compare" onclick="toggleCompareTool\(\)"/.test(PAGE));
  ok('a menu bar with Same layer and Cross layer, Radar and Satellite, split, rotate, peek, end and close',
     ['cmp-mode-same', 'cmp-mode-cross', 'cmp-radar', 'cmp-sat', 'cmp-grid', 'cmp-rotate', 'cmp-peek', 'cmp-end', 'cmp-close']
       .every(id => PAGE.includes(`id="${id}"`)));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes in this test', !readFileSync(join(ROOT, 'tools/test-compare-tool.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) { console.log('playwright is not installed, skipping'); process.exit(fail ? 1 : 0); }

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
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
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n2. the button opens the menu bar like the Polygon tool, and closing keeps the comparison');
{
  const r = await p.evaluate(async () => {
    document.getElementById('tool-compare').click();
    const open = { bar: document.getElementById('cmp-toolbar').classList.contains('visible'),
                   btn: document.getElementById('tool-compare').classList.contains('active'),
                   tool: activeTool, disabled: document.getElementById('cmp-end').disabled };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const esc = { bar: document.getElementById('cmp-toolbar').classList.contains('visible'), tool: activeTool };
    const corner = ['rc-rotate-btn', 'sc-rotate-btn', 'rc-peek-btn', 'sc-peek-btn', 'rc-grid-btn', 'sc-grid-btn']
      .map(id => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'none'; });
    return { open, esc, corner };
  });
  ok('the button lights and the bar opens', r.open.bar && r.open.btn && r.open.tool === 'compare', JSON.stringify(r.open));
  ok('with nothing running, the split controls are greyed out', r.open.disabled);
  ok('Escape closes the bar, like every tool', !r.esc.bar && r.esc.tool == null, JSON.stringify(r.esc));
  ok('the old floating corner buttons are gone from the map', r.corner.every(d => d === 'none'), r.corner.join(','));
}

console.log('\n3. Same layer: radar beside radar, satellite beside satellite');
{
  const r = await p.evaluate(async () => {
    document.getElementById('tool-compare').click();
    const out = {};
    // No single radar on screen: it says what to do instead of failing silently.
    let toast = ''; const realT = window.showToast; window.showToast = (m) => { toast = m; };
    const realMain = _rcMainSite;
    window._rcMainSite = () => null;
    document.getElementById('cmp-radar').click();
    out.noSite = { on: _rcOn, toast };
    window._rcMainSite = () => 'ktlx';
    document.getElementById('cmp-radar').click();
    await new Promise(res => setTimeout(res, 50));
    out.radarOn = { on: _rcOn, lit: document.getElementById('cmp-radar').classList.contains('active') };
    _cmpToolbarRefresh();
    out.noSplitYet = document.getElementById('cmp-grid').disabled && !document.getElementById('cmp-end').disabled;
    _rcAddSite('kinx');
    _cmpToolbarRefresh();
    document.getElementById('cmp-grid').click();
    out.quad = { grid: { ..._rcGrid }, label: document.getElementById('cmp-grid').textContent };
    document.getElementById('cmp-rotate').click();
    out.rotated = { ..._rcGrid };
    document.getElementById('cmp-radar').click();
    out.radarOff = _rcOn;
    window._rcMainSite = realMain;
    // Satellite.
    activeLayers.satellite = true;
    document.getElementById('cmp-sat').click();
    out.satOn = { on: _scOn, lit: document.getElementById('cmp-sat').classList.contains('active') };
    document.getElementById('cmp-end').click();
    out.ended = { rc: _rcOn, sc: _scOn };
    activeLayers.satellite = false;
    window.showToast = realT;
    return out;
  });
  ok('Radar with no single radar on screen says to tap a radar first', !r.noSite.on && /radar site pill/.test(r.noSite.toast),
     JSON.stringify(r.noSite));
  ok('Radar starts the radar comparison from the radar on screen', r.radarOn.on && r.radarOn.lit, JSON.stringify(r.radarOn));
  ok('until a second radar joins there is no split, so only End is live', r.noSplitYet);
  ok('the split button grows it to a quad and says so', r.quad.grid.rows * r.quad.grid.cols === 4 && r.quad.label === 'Quad',
     JSON.stringify(r.quad));
  ok('rotate transposes it', r.rotated.rows === r.quad.grid.cols && r.rotated.cols === r.quad.grid.rows, JSON.stringify(r.rotated));
  ok('Radar again ends it', r.radarOff === false);
  ok('Satellite starts the satellite comparison', r.satOn.on && r.satOn.lit, JSON.stringify(r.satOn));
  ok('End stops everything', !r.ended.rc && !r.ended.sc, JSON.stringify(r.ended));
}

console.log('\n4. Cross layer: a different layer in each pane, cut along the split');
{
  const r = await p.evaluate(async () => {
    const out = {};
    // Stand-ins for what the radar and satellite draw, filling their panes,
    // hit-testable so the cut can be felt from the screen.
    const fill = (pane, id) => {
      const d = document.createElement('div');
      d.id = id;
      d.style.cssText = 'position:absolute;left:-10000px;top:-10000px;width:30000px;height:30000px;pointer-events:auto;';
      map.getPane(pane).appendChild(d);
    };
    fill('radarPane', 'xt-radar'); fill('satPhotoPane', 'xt-sat'); fill('modelPane', 'xt-model');
    const rc = map.getContainer().getBoundingClientRect();
    const at = (fx, fy) => [rc.left + rc.width * fx, rc.top + rc.height * fy];
    const hits = (fx, fy) => document.elementsFromPoint(...at(fx, fy)).map(e => e.id).filter(id => /^xt-/.test(id));
    document.getElementById('cmp-mode-cross').click();
    out.start = { on: _xcOn, cells: _xcCells.slice(), lines: document.querySelectorAll('#xc-dividers .rc-divider').length,
                  labels: Array.from(document.querySelectorAll('#xc-labels .xc-label')).map(e => e.textContent),
                  selects: document.querySelectorAll('#cmp-cells select').length,
                  crossLit: document.getElementById('cmp-mode-cross').classList.contains('active') };
    out.left = hits(0.25, 0.5); out.right = hits(0.75, 0.5);
    // Turn the split line: the cut follows it.
    _xcColRots[0] = 35; _xcUpdateClips();
    out.tiltTopRight = hits(0.56, 0.08); out.tiltBottomLeft = hits(0.44, 0.92);
    _xcColRots[0] = 0; _xcUpdateClips();
    // Pane B shows model charts instead: satellite is left alone again.
    const sel = document.querySelectorAll('#cmp-cells select')[1];
    sel.value = 'models'; sel.dispatchEvent(new Event('change'));
    out.swapped = { right: hits(0.75, 0.5), satClip: map.getPane('satPhotoPane').style.clipPath };
    sel.value = 'satellite'; sel.dispatchEvent(new Event('change'));
    // The Inspector reads the layer of the pane it is over.
    activeLayers.satellite = true; activeLayers.nexrad = true;
    const rowsL = _inspRowsAt(map.containerPointToLatLng([rc.width * 0.25, rc.height * 0.5]), ...at(0.25, 0.5), false).map(x => x.label);
    const rowsR = _inspRowsAt(map.containerPointToLatLng([rc.width * 0.75, rc.height * 0.5]), ...at(0.75, 0.5), false).map(x => x.label);
    activeLayers.satellite = false; activeLayers.nexrad = false;
    out.insp = { rowsL, rowsR };
    out.presence = JSON.stringify(_presenceSummary());
    // A quad gives four panes, four pickers.
    document.getElementById('cmp-grid').click();
    out.quad = { cells: _xcCells.length, selects: document.querySelectorAll('#cmp-cells select').length,
                 label: document.getElementById('cmp-grid').textContent };
    // Back to Same layer: the cross split ends and every cut is put back.
    document.getElementById('cmp-mode-same').click();
    out.after = { on: _xcOn, radarClip: map.getPane('radarPane').style.clipPath, satClip: map.getPane('satPhotoPane').style.clipPath,
                  lines: document.querySelectorAll('#xc-dividers .rc-divider').length, left: hits(0.25, 0.5), right: hits(0.75, 0.5) };
    ['xt-radar', 'xt-sat', 'xt-model'].forEach(id => document.getElementById(id).remove());
    deactivateTool();
    return out;
  });
  ok('Cross layer starts a double split of radar and satellite, with a picker per pane',
     r.start.on && r.start.cells.join(',') === 'radar,satellite' && r.start.lines === 1 && r.start.selects === 2 && r.start.crossLit,
     JSON.stringify(r.start));
  ok('each pane is labelled with its layer', /^A · Radar/.test(r.start.labels[0] || '') && /^B · Satellite/.test(r.start.labels[1] || ''),
     JSON.stringify(r.start.labels));
  ok('radar shows only in pane A and satellite only in pane B',
     r.left.includes('xt-radar') && !r.left.includes('xt-sat') && r.right.includes('xt-sat') && !r.right.includes('xt-radar'),
     JSON.stringify([r.left, r.right]));
  ok('layers not in the split are untouched', r.left.includes('xt-model') && r.right.includes('xt-model'));
  ok('a turned split line turns the cut with it', r.tiltTopRight.includes('xt-radar') && r.tiltBottomLeft.includes('xt-sat'),
     JSON.stringify([r.tiltTopRight, r.tiltBottomLeft]));
  ok('choosing another layer for a pane swaps it in, and the old one is uncut',
     r.swapped.right.includes('xt-model') && !r.swapped.right.includes('xt-radar') && r.swapped.satClip === '',
     JSON.stringify(r.swapped));
  ok('the Inspector reads radar in the radar pane and satellite in the satellite pane',
     r.insp.rowsL.includes('Radar') && !r.insp.rowsL.some(l => /^Satellite/.test(l))
     && r.insp.rowsR.some(l => /^Satellite/.test(l)) && !r.insp.rowsR.includes('Radar'), JSON.stringify(r.insp));
  ok('Discord says which layers are being compared', /Comparing layers: Radar vs Satellite/.test(r.presence), r.presence);
  ok('the split button makes a quad with four panes and four pickers', r.quad.cells === 4 && r.quad.selects === 4
     && r.quad.label === 'Quad', JSON.stringify(r.quad));
  ok('Same layer ends the cross split and puts every layer back whole', !r.after.on && r.after.radarClip === ''
     && r.after.satClip === '' && r.after.lines === 0 && r.after.left.includes('xt-sat') && r.after.right.includes('xt-radar'),
     JSON.stringify(r.after));
}

ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
