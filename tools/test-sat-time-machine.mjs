#!/usr/bin/env node
/*
 * The satellite Time Machine, proven to move the satellite.
 *
 *     node tools/test-sat-time-machine.mjs
 *
 * Three things made it look dead. It refused to travel until a product had
 * been picked, and the Satellite bubble no longer picks one for you; the Pi
 * composites and the global mosaic ignored the travelled moment and showed
 * the newest frames regardless; and a moment the archive does not hold
 * drew blank tiles with no word about it. Each is pinned here in a real
 * browser with the network off and the Pi stubbed.
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

console.log('\n1. the fixes are in the page');
{
  ok('a jump with the satellite off switches it on at the moment',
     PAGE.includes('if (!_tmSatActive()) _setGoesProduct(_goesProductId);')
     && !PAGE.includes("showToast('Pick a satellite product first, then travel to a time.'"));
  ok('the Pi frame list ends at the travelled moment',
     /list = list\.filter\(f => f\.time\.getTime\(\) <= _tmSatAt\);/.test(PAGE));
  ok('an empty travelled list says why, not "not built yet"',
     PAGE.includes('The Pi keeps three days of composites and has none for that moment.'));
  ok('a blank archive moment is watched and reported once',
     /function _goesTmWatch\(layer, graceMs\)/.test(PAGE)
     && PAGE.includes('if (!f.url) _goesTmWatch(l);')
     && PAGE.includes('No satellite imagery is archived for that moment.'));
  ok('the modal tells the truth about what a jump will do',
     /Choose a moment and the satellite switches on there/.test(PAGE));
  ok('a travelled band routes to the Pi archive door, back to July 2017',
     PAGE.includes('const SAT_ARC_FLOOR = Date.UTC(2017, 6, 10);')
     && /function _goesArcOk\(\)/.test(PAGE)
     && PAGE.includes('fetch(`${base}/sat/archive/index?${qs}`')
     && PAGE.includes("if (_goesArcOk()) { _goesApplyFrames([]); _goesLoadArcFrames(); return; }"));
  ok('the menu lights a product only while the layer is on, and a bubble tap flips nothing',
     PAGE.includes('activeLayers.satellite && _goesProductId === p.id')
     && PAGE.includes("el.classList.toggle('active', _getBubbleActive(b.id));")
     && !/renderSubBubbles\(tab\) \{[\s\S]{0,1200}activeBubbles\[b\.id\] = !activeBubbles\[b\.id\]/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-sat-time-machine.mjs'), 'utf8').includes(EM));
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
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n2. a jump with nothing on switches the satellite on, at that moment');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const toasts = [];
    const realToast = window.showToast;
    window.showToast = t => toasts.push(String(t));
    const out = { wasOn: !!activeLayers.satellite };
    _tmOpen('sat');
    out.note = document.querySelector('#tm-modal .tm-note').textContent;
    const moment = Date.now() - 36 * 3600e3;
    await _tmJump(moment);
    await sleep(300);
    out.on = !!activeLayers.satellite;
    out.clock = _tmSatAt;
    out.frames = goesFrames.length;
    const last = goesFrames[goesFrames.length - 1];
    out.lastGap = last ? (moment - last.time.getTime()) / 60000 : null;
    out.allBefore = goesFrames.every(f => f.time.getTime() <= moment);
    out.badge = !!document.getElementById('tm-badge-sat');
    out.closed = !document.getElementById('tm-modal').classList.contains('open');
    out.toasts = toasts;
    window.showToast = realToast;
    return out;
  });
  ok('the modal said the satellite would switch on rather than refusing',
     /switches on there/.test(r.note) && /Clean IR/.test(r.note), r.note.slice(0, 80));
  ok('the satellite was off and the jump turned it on',
     r.wasOn === false && r.on === true, JSON.stringify({ was: r.wasOn, on: r.on }));
  ok('the clock is set and the modal closed',
     r.clock > 0 && r.closed, String(r.clock));
  ok('the loop ends at the travelled moment, within one frame step',
     r.frames > 4 && r.allBefore && r.lastGap !== null && r.lastGap >= 0 && r.lastGap <= 40,
     JSON.stringify({ frames: r.frames, gap: r.lastGap }));
  ok('the PAST badge is up and nobody was told to pick a product first',
     r.badge && !r.toasts.some(t => /Pick a satellite product/.test(t)),
     JSON.stringify(r.toasts));
}

console.log('\n3. the Pi composites end their loop at the moment too');
{
  const r = await p.evaluate(async () => {
    const stamp = ms => {
      const d = new Date(ms), z = n => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}_`
        + `${z(d.getUTCHours())}${z(d.getUTCMinutes())}00`;
    };
    const base = Date.UTC(2026, 8, 1, 0, 0, 0);
    const frames = [];
    for (let i = 0; i < 24; i++) {
      frames.push({ t: stamp(base + i * 3600e3), file: `f${i}.png` });
    }
    const realMan = _goesPiManifest, realBase = _hdBase, realProd = _goesProductId;
    _goesPiManifest = async () => ({ products: { airmass: {
      bounds: [[20, -130], [55, -60]], frames } } });
    _hdBase = 'http://pi.test';
    _goesProductId = 'rgb-airmass';
    const out = {};
    _tmSatAt = null;
    out.liveCount = (await _goesPiFrames()).length;
    _tmSatAt = base + 10 * 3600e3 + 1;
    const cut = await _goesPiFrames();
    out.cutCount = cut.length;
    out.cutAllBefore = cut.every(f => f.time.getTime() <= _tmSatAt);
    out.cutLast = cut.length ? cut[cut.length - 1].timeStr : '';
    _tmSatAt = base - 86400e3;
    out.tooOld = (await _goesPiFrames()).length;
    const toasts = [];
    const realToast = window.showToast;
    window.showToast = t => toasts.push(String(t));
    activeLayers.satellite = true;
    await _goesLoadPiFrames();
    out.toast = toasts.join(' | ');
    window.showToast = realToast;
    _goesPiManifest = realMan; _hdBase = realBase; _goesProductId = realProd;
    _tmSatAt = null;
    return out;
  });
  ok('live, every kept frame is offered', r.liveCount === 24, String(r.liveCount));
  ok('travelled, the loop stops at the moment', r.cutCount === 11 && r.cutAllBefore
     && /_100000$/.test(r.cutLast), JSON.stringify({ n: r.cutCount, last: r.cutLast }));
  ok('a moment older than the Pi keeps gets nothing', r.tooOld === 0, String(r.tooOld));
  ok('and says so, with the fix, instead of "not built yet"',
     /keeps three days of composites and has none for that moment/.test(r.toast)
     && /plain band/.test(r.toast), r.toast.slice(0, 100));
}

console.log('\n4. a moment the WMS archive does not hold is reported once');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const toasts = [];
    const realToast = window.showToast;
    window.showToast = t => toasts.push(String(t));
    const fake = () => {
      const h = {};
      return { on: (ev, fn) => { h[ev] = fn; }, fire: (ev) => h[ev] && h[ev]() };
    };
    _tmSatAt = Date.now() - 86400e3;
    _goesTmWarnedAt = null;
    // Every tile fails, none arrives: the archive has nothing here.
    const a = fake(); _goesTmWatch(a, 60);
    a.fire('tileerror'); a.fire('tileerror'); a.fire('tileerror');
    await sleep(120);
    const warnedOnce = toasts.length;
    // A second frame of the same journey must not nag again.
    const b2 = fake(); _goesTmWatch(b2, 60);
    b2.fire('tileerror');
    await sleep(120);
    const stillOnce = toasts.length;
    // A frame that DID load is a healthy archive, whatever else failed.
    _tmSatAt = Date.now() - 2 * 86400e3; _goesTmWarnedAt = null;
    const c = fake(); _goesTmWatch(c, 60);
    c.fire('tileerror'); c.fire('tileload');
    await sleep(120);
    const healthy = toasts.length;
    // Live (no clock), nothing is watched at all.
    _tmSatAt = null;
    const d = fake(); _goesTmWatch(d, 60);
    d.fire('tileerror');
    await sleep(120);
    window.showToast = realToast;
    return { warnedOnce, stillOnce, healthy, live: toasts.length, text: toasts[0] || '' };
  });
  ok('all tiles failing tells the person what to try',
     r.warnedOnce === 1 && /No satellite imagery is archived for that moment/.test(r.text),
     JSON.stringify(r));
  ok('the same journey is not nagged twice', r.stillOnce === 1, String(r.stillOnce));
  ok('one loaded tile means the archive is fine', r.healthy === 1, String(r.healthy));
  ok('and a live layer is never watched', r.live === 1, String(r.live));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n5. a travelled band asks NOAA\'s archive through the Pi, and falls back honestly');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const out = {};
    const realFetch = window.fetch, realBase = _hdBase;
    _hdBase = 'http://pi.test';
    const calls = [];
    const at = Date.UTC(2023, 4, 30, 12, 33);
    window.fetch = async (url) => {
      calls.push(String(url));
      if (/\/sat\/archive\/index/.test(url)) {
        const frames = [];
        for (let i = 5; i >= 0; i--) {
          frames.push({ t: at - i * 300000, stamp: 's' + i,
            key: `ABI-L2-CMIPC/2023/150/12/OR_ABI-L2-CMIPC-M6C13_G16_s2023150120${i}172_e20231501203556_c20231501204056.nc` });
        }
        return new Response(JSON.stringify({ bucket: 'noaa-goes16',
          bounds: [[14.5, -152.1], [56.8, -52.9]], frames }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    };
    _goesProductId = 'ch13';
    _tmSatAt = at;
    activeLayers.satellite = true;
    _reloadGoesIfActive();
    await sleep(400);
    out.n = goesFrames.length;
    out.piUrls = goesFrames.every(f =>
      /pi\.test\/sat\/archive\/frame\?bucket=noaa-goes16&key=ABI/.test(f.url));
    out.bounds = goesFrames[0] ? JSON.stringify(goesFrames[0].bounds) : '';
    out.ascending = goesFrames.every((f, i) => !i || f.time >= goesFrames[i - 1].time);
    out.indexQs = (calls.find(c => /archive\/index/.test(c)) || '').split('?')[1] || '';
    // NOAA has nothing archived there: the WMS path takes over, with a word.
    const toasts = [];
    const realToast = window.showToast;
    window.showToast = t => toasts.push(String(t));
    window.fetch = async () => new Response('{"error":"none"}', { status: 404 });
    _reloadGoesIfActive();
    await sleep(400);
    out.fallbackN = goesFrames.length;
    out.fallbackWms = goesFrames.every(f => !f.url && f.timeStr);
    out.fallbackToast = toasts.join(' | ');
    window.showToast = realToast;
    window.fetch = realFetch; _hdBase = realBase;
    _tmSatAt = null; _disableSatellite();
    return out;
  });
  ok('the frames come from the Pi archive door, oldest first, with their rectangle',
     r.n === 6 && r.piUrls && r.ascending && /14\.5/.test(r.bounds), JSON.stringify(r));
  ok('the index was asked for band 13, east CONUS, at the moment',
     /post=east&band=13&sector=conus&at=\d+&n=\d+/.test(r.indexQs), r.indexQs);
  ok('with nothing archived the WMS frames take over and the person is told',
     r.fallbackN > 4 && r.fallbackWms && /NOAA has no scan archived/.test(r.fallbackToast),
     JSON.stringify({ n: r.fallbackN, wms: r.fallbackWms, t: r.fallbackToast }));
}

console.log('\n6. tapping Satellite lights nothing until a product is picked');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const out = {};
    _disableSatellite();
    renderSubBubbles('regular');
    document.getElementById('sub-satellite').click();
    await sleep(200);
    out.layerOn = !!activeLayers.satellite;
    const lit = () => [...document.querySelectorAll('#sub-bubbles .sub-bubble.active')]
      .map(el => el.textContent.trim()).filter(t => !/^Back/.test(t));
    out.kindsLit = lit();
    // Find the kind whose categories include the infrared bands.
    let found = false;
    for (const k of [...document.querySelectorAll('#sub-bubbles [data-sat-kind]')]) {
      k.click(); await sleep(150);
      if (document.querySelector('#sub-bubbles [data-sat-cat="ir"]')) { found = true; break; }
      const bk = document.querySelector('#sub-bubbles .sb-back');
      if (bk) { bk.click(); await sleep(150); }
    }
    out.catsLit = lit();
    if (found) {
      document.querySelector('#sub-bubbles [data-sat-cat="ir"]').click();
      await sleep(150);
    }
    out.prodsLit = lit();
    out.stillOff = !activeLayers.satellite;
    const prod = document.querySelector('#sub-bubbles [data-product-id="ch13"]');
    if (prod) { prod.click(); await sleep(200); }
    out.onAfterPick = !!activeLayers.satellite;
    out.prodLitAfterPick = !!(prod && prod.classList.contains('active'));
    _disableSatellite(); renderSubBubbles('regular');
    return out;
  });
  ok('the layer stays off and nothing is lit, three levels down',
     !r.layerOn && r.kindsLit.length === 0 && r.catsLit.length === 0
     && r.prodsLit.length === 0 && r.stillOff, JSON.stringify(r));
  ok('picking a product is what switches it on, and lights it',
     r.onAfterPick && r.prodLitAfterPick, JSON.stringify(r));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
