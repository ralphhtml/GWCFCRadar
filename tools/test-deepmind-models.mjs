#!/usr/bin/env node
/*
 * DeepMind Models (the panel that was AI Cyclones).
 *
 *     node tools/test-deepmind-models.mjs
 *
 * Checked, with the parsing server faked: the sub-bubble and panel carry the
 * new name; WNV3, DeepMind's newest model, is the default; the Lows button
 * draws an L with the central pressure at every member's storm centre at the
 * playbar hour, deepest first and decluttered; Wind chance counts the members
 * whose 34, 50 or 64 knot wind radii cover each place by that hour, and
 * GenCast (which has no radii) says so; the data terms are on the panel; and
 * every models panel wears heavy frost.
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
{
  const EM = String.fromCharCode(0x2014);
  const a = PAGE.indexOf('// -- DEEPMIND MODELS: LOWS AND WIND CHANCES');
  ok('no em dashes in the new code or this test', a > 0 && !PAGE.slice(a, a + 12000).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-deepmind-models.mjs'), 'utf8').includes(EM));
}

// A storm heading north from 20N 60W, four members a little apart.
const track = (k, withRadii) => Array.from({ length: 9 }, (_, i) => {
  const p = { lat: 20 + i, lon: -60 + k * 0.5, lead: i * 6, mslp: 1000 - 2 * k - 3 * i, wind: 40 + 5 * i + 3 * k };
  if (withRadii) {
    p.rmw = 40;
    p.r34 = [200, 150, 100, 150];
    if (k >= 2 && i >= 4) p.r64 = [60, 50, 40, 50];
  }
  return p;
});
const wnv3 = { tracks: Object.fromEntries([0, 1, 2, 3].map(k => [`unknown|${k}|1`, track(k, true)])) };
const genc = { tracks: Object.fromEntries([0, 1].map(k => [`unknown|${k}|1`, track(k, false)])) };
const FILES = {
  'cyclones/latest.json': { run: '20260923T18', path: '20260923T18/manifest.json' },
  'cyclones/20260923T18/manifest.json': { tracks: { WNV3_ensemble: { variant: 'WNV3', path: 'wnv3.json' }, GENC_ensemble: { variant: 'GENC', path: 'genc.json' } } },
  'cyclones/20260923T18/wnv3.json': wnv3,
  'cyclones/20260923T18/genc.json': genc,
};

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); localStorage.removeItem('gwcfc_cyc_variant'); } catch (e) {} }, CL_ID);
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.startsWith('http://pi.test/')) {
    const f = FILES[new URL(url).pathname.slice(1)];
    return f ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(f) }) : route.fulfill({ status: 404, body: '' });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; _hdBase = 'http://pi.test'; map.setView([24, -59], 5, { animate: false }); });

console.log('\n1. the name');
{
  await p.evaluate(() => toggleModelsSub());
  const r = await p.evaluate(() => ({ rows: [...document.querySelectorAll('#sub-bubbles .sb-label')].map(x => x.textContent),
    title: document.querySelector('#ai-cyclones-panel .models-panel-title').textContent.trim() }));
  ok('the Models sub-bubble is DeepMind Models', r.rows.includes('DeepMind Models') && !r.rows.includes('AI Cyclones'), r.rows.join('|'));
  ok('and so is the panel', r.title === 'DeepMind Models', r.title);
  ok('no AI Cyclones left anywhere a person reads', !/>\s*AI Cyclones\s*</.test(PAGE) && !/label: 'AI Cyclones'/.test(PAGE));
}

console.log('\n2. WNV3, the newest, by default');
{
  await p.evaluate(() => document.getElementById('sub-ai-cyclones').click());
  await p.waitForTimeout(600);
  await p.evaluate(() => _spagCycToggle());
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => ({ v: _cycVariant, on: _cycOn, frames: _cycFrames.join(','),
    opts: [...document.querySelectorAll('#cyc-variant-sel option')].map(o => o.value + ':' + o.textContent) }));
  ok('WNV3 is chosen and drawn', r.on && r.v === 'WNV3' && r.frames === '0,6,12,18,24,30,36,42,48', JSON.stringify(r));
  ok('and named in the picker', r.opts.some(o => /^WNV3:.*64 members/.test(o)), r.opts.join(' | '));
  const terms = await p.evaluate(() => document.getElementById('cyc-terms').textContent);
  ok('the data terms are on the panel', /Experimental research forecasts from Google DeepMind/.test(terms) && /CC BY 4.0/.test(terms), terms);
}

console.log('\n3. Lows (L)');
{
  await p.evaluate(() => { _cycRenderFrame(4); _cycLowsToggle(); });
  await p.waitForTimeout(300);
  let r = await p.evaluate(() => ({ on: _cycLowsOn, drawn: _cycLowsLayer && _cycLowsLayer.drawn, lows: _cycLowsAt(24).map(q => q.mslp),
    lit: document.getElementById('cyc-lows-btn').classList.contains('on') }));
  ok('an L for every member at the playbar hour, deepest first', r.on && r.lit && r.lows.join() === '982,984,986,988', JSON.stringify(r));
  ok('drawn on the map, overlapping ones skipped', r.drawn >= 2 && r.drawn <= 4, r.drawn);
  const px = await p.evaluate(() => { const cv = document.querySelector('.cyc-lows-canvas'), d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++; return n; });
  ok('with ink on the canvas', px > 200, px);
  await p.evaluate(() => _cycRenderFrame(8));
  await p.waitForTimeout(200);
  r = await p.evaluate(() => _cycLowsAt(48).map(q => q.mslp).join());
  ok('and it follows the playbar', r === '970,972,974,976', r);
}

console.log('\n4. Wind chance');
{
  await p.evaluate(() => _cycWindToggle());
  await p.waitForTimeout(500);
  let r = await p.evaluate(() => {
    const G = _cycWindLayer && _cycWindLayer._grid;
    const at = (lat, lon) => { const j = Math.round((lat - G.s) / G.d), i = Math.round((lon - G.w) / G.d); if (j < 0 || j >= G.ny || i < 0 || i >= G.nx) return 0; return G.count[j * G.nx + i] / G.members * 100; };
    return { on: _cycWindOn, members: G && G.members, centre: G && at(24, -59.25), far: G && at(24, -54), edge: G && at(24, -61.9), sel: getComputedStyle(document.getElementById('cyc-wind-kt')).display,
      legend: document.getElementById('cyc-wind-legend').textContent };
  });
  ok('34 kt chance: every member over the middle of the track, none far away', r.on && r.members === 4 && r.centre === 100 && r.far === 0, JSON.stringify(r));
  ok('with the wind speed picker and a legend', r.sel !== 'none' && /Chance of 34 kt winds/.test(r.legend), JSON.stringify(r));
  await p.evaluate(() => { const s = document.getElementById('cyc-wind-kt'); s.value = '64'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(400);
  r = await p.evaluate(() => { const G = _cycWindLayer._grid; let mx = 0; for (const c of G.count) mx = Math.max(mx, c); return { mx, members: G.members }; });
  ok('64 kt: only the two members strong enough', r.mx === 2 && r.members === 4, JSON.stringify(r));
  await p.evaluate(() => _cycRenderFrame(2));
  await p.waitForTimeout(400);
  ok('and before those members reach 64 kt, nothing', await p.evaluate(() => !_cycWindLayer));
  await p.evaluate(() => { _cycRenderFrame(8); _cycWindPick(34); });
  await p.waitForTimeout(400);
  await p.screenshot({ path: process.env.SHOT || '/tmp/deepmind.png' });
}

console.log('\n5. GenCast has no wind radii');
{
  await p.evaluate(() => { _cycWindOn = false; _cycExtrasSync(); });
  await p.evaluate(async () => { await _spagCycVariant('GENC'); });
  await p.waitForTimeout(1500);
  const toasts = [];
  await p.exposeFunction('__toast', m => toasts.push(m));
  await p.evaluate(() => { window.showToast = m => window.__toast(m); _cycWindToggle(); });
  await p.waitForTimeout(200);
  ok('Wind chance explains itself instead of drawing nothing', toasts.some(t => /does not publish wind radii/.test(t)) && !(await p.evaluate(() => _cycWindOn)), toasts.join(' | '));
  ok('Lows still work on GenCast', await p.evaluate(() => _cycLowsAt(_cycUpto()).length === 2));
}

console.log('\n6. heavy frost on every models panel');
{
  const r = await p.evaluate(() => {
    document.documentElement.setAttribute('data-glass', 'subtle');
    const f = id => { const el = document.getElementById(id); if (!el) return 'missing'; const cs = getComputedStyle(el); return (cs.backdropFilter || cs.webkitBackdropFilter || '') + ' ' + cs.backgroundColor; };
    return ['ai-cyclones-panel', 'run-models-panel', 'spaghetti-models-panel'].map(f);
  });
  ok('DeepMind, Run and Spaghetti Models all wear the 24px frost', r.every(x => /blur\(24px\)/.test(x) && /rgba\(0, 0, 0, 0\)/.test(x)), r.join(' | '));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
