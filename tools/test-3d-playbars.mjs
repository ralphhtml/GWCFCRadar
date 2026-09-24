#!/usr/bin/env node
/*
 * Every 3D panel plays on its own playbar, and only that one. The map's
 * animation bar moves the map; it no longer moves any 3D view.
 *
 *     node tools/test-3d-playbars.mjs
 *
 * Radar 3D and Satellite 3D are covered in their own tests. Here: a layer's
 * 3D panel holds its frame when the map's bar moves, and its own playbar
 * steps the layer and reads the new frame in; Model 3D's play button walks
 * the forecast hours on its own.
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

console.log('\n1. the pieces');
{
  const EM = String.fromCharCode(0x2014);
  ok('one shared playbar', /function _p3dPlaybar\(api\)/.test(PAGE));
  ok('the map\'s bar no longer lists the 3D panels as its source', !/return mk\('r3d'/.test(PAGE) && !/return mk\('s3d'/.test(PAGE));
  ok('no em dashes in this test', !readFileSync(join(ROOT, 'tools/test-3d-playbars.mjs'), 'utf8').includes(EM));
}

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
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
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; map.setView([35, -97], 6, { animate: false }); });

console.log('\n2. a layer\'s 3D panel');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    // Three frames of the map's own loop, with a stand-in for drawing them.
    const t0 = Date.UTC(2026, 8, 24, 12) / 1000;
    radarFrames = [0, 1, 2].map(i => ({ time: t0 + i * 600, path: 'x' + i }));
    _firstValidFrame = 0; currentFrame = 2;
    window.showFrame = i => { currentFrame = i; };
    const P = _l3dPanel('waves');
    P.openBounds(34, -99, 36, -95);
    await sleep(200);
    let reads = 0;
    const orig = P.resample.bind(P);
    const realSample = _l3dSampleDrape;
    window._l3dSampleDrape = function () { reads++; return realSample.apply(this, arguments); };
    const out = { hold: P.hold };
    const pb = P.panel.querySelector('.p3d-playbar');
    out.pb = !!pb && pb.previousElementSibling && pb.previousElementSibling.classList.contains('p3d-top');
    out.max = pb.querySelector('.p3d-scrub').max;
    // The map's bar moves: the panel holds its picture.
    reads = 0;
    currentFrame = 0;
    P.resample(false); P.resample(false);
    out.readsWhileHeld = reads;
    out.holding = P.holding();
    // Its own scrubber: the layer goes to that frame and is read in.
    reads = 0;
    const sc = pb.querySelector('.p3d-scrub');
    sc.value = '1'; sc.dispatchEvent(new Event('input'));
    await sleep(600);
    out.afterScrub = { hold: P.hold, map: currentFrame, reads, label: pb.querySelector('.p3d-time').textContent };
    // Its play button walks the frames.
    const seen = new Set();
    pb.querySelector('.p3d-play').click();
    const tA = Date.now();
    while (Date.now() - tA < 3000) { seen.add(P.hold); await sleep(40); }
    pb.querySelector('.p3d-play').click();
    out.seen = [...seen].sort();
    window._l3dSampleDrape = realSample;
    P.close();
    out.closedHold = P.hold;
    return out;
  });
  ok('it has its own playbar under its controls, over the map loop\'s frames', r.pb && r.max === '2', JSON.stringify(r));
  ok('it opens holding the frame the map showed', r.hold === 2, String(r.hold));
  ok('moving the map\'s bar does not move the 3D view', r.holding && r.readsWhileHeld === 0, JSON.stringify(r));
  ok('its own scrubber shows that frame and reads it into 3D', r.afterScrub.hold === 1 && r.afterScrub.map === 1
     && r.afterScrub.reads > 0 && /2\/3$/.test(r.afterScrub.label), JSON.stringify(r.afterScrub));
  ok('its play button walks the frames', r.seen.length >= 3, JSON.stringify(r.seen));
  ok('closing lets go of the frame', r.closedHold === null);
}

console.log('\n3. Model 3D plays its forecast hours');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    window._m3dLoadSources = async () => {};
    let loads = 0;
    window._m3dLoad = async () => { loads++; await sleep(30); };
    await openModel3D(35, -97, {});
    _m3dFollow(true);
    const h = _m3d.q('hour');
    h.value = '0';
    const btn = _m3d.q('play');
    _m3d.q('speed').value = '8'; _m3d.q('speed').dispatchEvent(new Event('input'));
    loads = 0;
    btn.click();
    await sleep(900);
    const mid = { hour: +h.value, loads, playing: _m3d.playing, follow: _m3d.follow };
    btn.click();
    const stopped = !_m3d.playing;
    const at = +h.value;
    await sleep(400);
    return { mid, stopped, still: +h.value === at, speed: _m3d.speed };
  });
  ok('play walks the hours, loading each in turn at the typed speed', r.mid.playing && r.mid.hour >= 6 && r.mid.loads >= 2 && r.speed === 8, JSON.stringify(r));
  ok('playing its own hours stops following the map chart', r.mid.follow === false);
  ok('and it stops where it is', r.stopped && r.still, JSON.stringify(r));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
