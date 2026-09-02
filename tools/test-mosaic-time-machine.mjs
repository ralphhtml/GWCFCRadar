#!/usr/bin/env node
/*
 * The radar mosaic's Time Machine.
 *
 *     node tools/test-mosaic-time-machine.mjs
 *
 * The third clock. The Composite menu's MRMS 1 km mosaic only advertises its
 * last few hours, so the archive behind this machine is the NEXRAD national
 * composite Iowa Mesonet has kept every five minutes since November 2010,
 * the same frames the Normal mosaic draws, ending at the travelled moment
 * instead of at now. Driven here in a real browser with the network off.
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

console.log('\n1. the machine is in the page');
{
  ok('the mosaic has its own clock and floor',
     PAGE.includes('let _tmMosaicAt = null;')
     && PAGE.includes('const MOSAIC_FLOOR = Date.UTC(2010, 10, 1);'));
  ok('the frame builder takes a moment to end at',
     PAGE.includes('function _generateL3Frames(count, endMs)')
     && PAGE.includes('_generateL3Frames(_loopFrameCount(), endMs)'));
  ok('a jump with no single site travels the mosaic instead of refusing',
     /if \(!site\) \{[\s\S]{0,400}_tmScope = 'mosaic';\s*return _tmJump\(ms\);/.test(PAGE)
     && !PAGE.includes("showToast('Turn on a radar first, then travel to a time.'"));
  ok('the mosaic branch clears MRMS, turns the mosaic on, and rebuilds at the moment',
     /if \(_tmScope === 'mosaic'\) \{[\s\S]*?_tmMosaicAt = at;[\s\S]*?_clearMrms\(\);[\s\S]*?activeLayers\.nexrad = true;[\s\S]*?await loadNEXRAD\(\);/.test(PAGE));
  ok('it wears its own badge and Back to Live knows it',
     PAGE.includes("['tm-badge-mosaic', 'RADAR MOSAIC', _tmMosaicAt, 'mosaic']")
     && PAGE.includes("['tm-badge', 'tm-badge-mosaic', 'tm-badge-sat', 'tm-badge-htm']")
     && /if \(_tmScope === 'mosaic'\) \{\s*_tmMosaicAt = null;/.test(PAGE));
  ok('the five-minute refresh stands still while travelled',
     /if \(typeof _tmMosaicAt === 'number' && _tmMosaicAt\) return;\s*try \{ loadNEXRAD\(\); \}/.test(PAGE));
  ok('the Composite menu carries the row, and switching radar off clears the clock',
     PAGE.includes('_mosaicTimeMachineBubble(wrap);')
     && PAGE.includes("tm.id = 'sub-mosaic-timemachine';")
     && /function _disableRadar\(\) \{[\s\S]*?_tmMosaicAt = null;/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-mosaic-time-machine.mjs'), 'utf8').includes(EM));
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

const key = ms => {
  const d = new Date(ms), z = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}`;
};

console.log('\n2. the frame builder ends where it is told');
{
  const at = Date.UTC(2021, 3, 27, 22, 33);
  const r = await p.evaluate(at => {
    const f = _generateL3Frames(6, at);
    return { n: f.length, last: f[f.length - 1].tileKey, lastT: f[f.length - 1].time * 1000,
             first: f[0].tileKey, ascending: f.every((x, i) => !i || x.time > f[i - 1].time) };
  }, at);
  ok('six frames, oldest first', r.n === 6 && r.ascending, JSON.stringify(r));
  ok('the newest is the moment floored to its five-minute scan',
     r.last === key(Date.UTC(2021, 3, 27, 22, 30)) && r.lastT === Date.UTC(2021, 3, 27, 22, 30), r.last);
  ok('and the oldest is 25 minutes earlier', r.first === key(Date.UTC(2021, 3, 27, 22, 5)), r.first);
}

console.log('\n3. the Composite menu offers the row, and the modal names the mosaic');
{
  const r = await p.evaluate(() => {
    toggleMrmsSub();           // the row is placed before the Pi is even asked
    const row = document.getElementById('sub-mosaic-timemachine');
    const out = { row: !!row, label: row ? row.textContent.trim() : '' };
    row.click();
    const m = document.getElementById('tm-modal');
    out.open = m.classList.contains('open');
    out.title = m.querySelector('.tm-title').textContent;
    out.min = m.querySelector('#tm-date').min;
    out.note = m.querySelector('.tm-note').textContent;
    out.scope = _tmScope;
    _tmClose();
    return out;
  });
  ok('the Time Machine row sits in the Composite menu', r.row && /Time Machine/.test(r.label), r.label);
  ok('it opens the modal for the RADAR MOSAIC', r.open && /RADAR MOSAIC/.test(r.title) && r.scope === 'mosaic', r.title);
  ok('the archive reaches back to November 2010',
     r.min === '2010-11-01' && /2010/.test(r.note) && /NEXRAD composite/.test(r.note), r.min);
}

console.log('\n4. a jump moves the mosaic, hands MRMS over, and raises the badge');
{
  const at = Date.UTC(2021, 3, 27, 22, 33);
  const r = await p.evaluate(async at => {
    const toasts = [];
    const realToast = window.showToast;
    window.showToast = t => toasts.push(String(t));
    _mrmsActive = true;              // as if the MRMS 1 km mosaic were on screen
    currentProduct = 'mrms';
    _tmScope = 'mosaic';
    await _tmJump(at);
    await new Promise(res => setTimeout(res, 400));
    const last = radarFrames[radarFrames.length - 1];
    const l = _radarLayerPool[currentFrame];
    const out = {
      clock: _tmMosaicAt, mrms: _mrmsActive, nexrad: !!activeLayers.nexrad,
      product: currentProduct, frames: radarFrames.length,
      lastKey: last && last.tileKey, allBefore: radarFrames.every(f => f.time * 1000 <= at),
      // A tile layer names the scan in its URL; when the tiles cannot load
      // (as here, with the network off) the slot falls back to the WMS
      // door, which names the same scan by its ISO time instead.
      url: l ? (l._url || '') : '',
      wmsTime: l && l.wmsParams ? (l.wmsParams.TIME || l.wmsParams.time || '') : '',
      badge: (document.getElementById('tm-badge-mosaic') || {}).textContent || '',
      toasts: toasts.join(' | '),
    };
    window.showToast = realToast;
    return out;
  }, at);
  ok('the clock is set and MRMS handed over to the mosaic, with a word',
     r.clock === at && r.mrms === false && r.nexrad && r.product !== 'mrms'
     && /MRMS keeps only its last few hours/.test(r.toasts), JSON.stringify(r));
  ok('the loop ends at the moment', r.frames > 4 && r.allBefore
     && r.lastKey === key(Date.UTC(2021, 3, 27, 22, 30)), JSON.stringify({ n: r.frames, last: r.lastKey }));
  ok('the frame on screen asks the archive for that scan',
     r.url.includes('nexrad-n0q-' + key(Date.UTC(2021, 3, 27, 22, 30)))
     || r.wmsTime === '2021-04-27T22:30:00Z', r.url + ' ' + r.wmsTime);
  ok('the RADAR MOSAIC PAST badge is up', /RADAR MOSAIC PAST/.test(r.badge) && /2021-04-27 22:3/.test(r.badge), r.badge);
}

console.log('\n5. the radar row\'s machine travels the mosaic when no site is on screen');
{
  const at = Date.UTC(2019, 6, 4, 18, 0);
  const r = await p.evaluate(async at => {
    _tmScope = 'radar';
    await _tmJump(at);
    await new Promise(res => setTimeout(res, 300));
    toggleRadarSub();
    const row = document.getElementById('sub-timemachine');
    return { scope: _tmScope, clock: _tmMosaicAt, site: _tmSite(), lit: row.classList.contains('active'),
             lastKey: radarFrames[radarFrames.length - 1].tileKey };
  }, at);
  ok('with no site the radar scope reroutes to the mosaic',
     r.site === null && r.scope === 'mosaic' && r.clock === at, JSON.stringify(r));
  ok('the loop moved to that moment and the radar row lights its machine',
     r.lastKey === key(at) && r.lit, r.lastKey);
}

console.log('\n6. Back to Live, and switching the radar off, both clear the clock');
{
  const r = await p.evaluate(async () => {
    _tmScope = 'mosaic';
    await _tmLive();
    await new Promise(res => setTimeout(res, 300));
    const out = { clock: _tmMosaicAt, badge: !!document.getElementById('tm-badge-mosaic'),
                  gap: Date.now() - radarFrames[radarFrames.length - 1].time * 1000 };
    await _tmJump(Date.UTC(2020, 0, 1, 12, 0));
    await new Promise(res => setTimeout(res, 200));
    _disableRadar();
    out.afterOff = _tmMosaicAt;
    out.badgeAfterOff = !!document.getElementById('tm-badge-mosaic');
    renderSubBubbles('regular');
    return out;
  });
  ok('live again: no clock, no badge, newest frame within twenty minutes of now',
     r.clock === null && !r.badge && r.gap < 20 * 60000, JSON.stringify(r));
  ok('radar off takes the clock and the badge down with it',
     r.afterOff === null && !r.badgeAfterOff, JSON.stringify(r));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
