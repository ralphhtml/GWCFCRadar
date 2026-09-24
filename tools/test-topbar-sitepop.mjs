#!/usr/bin/env node
/*
 * Small asks from one message:
 *
 *     node tools/test-topbar-sitepop.mjs
 *
 * The radar site popup gains View Past Radar (loads the site, opens the radar
 * Time Machine) and wears heavy gloss; the logo, account button and search bar
 * can be arranged from Settings, whose colour section is called Themes now;
 * and the satellite product list lost its Compare button.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
ok('the settings section is called Themes', /<use href=#ic-palette><\/use><\/svg> Themes<\/div>/.test(PAGE));
ok('no Compare bubble in the satellite menus', !/_scCompareBubble\(wrap\);/.test(PAGE));
ok('no em dashes in this test', !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));

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
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n2. the radar site popup');
{
  const r = await p.evaluate(async () => {
    const s = NEXRAD_STATIONS.find(x => x.id === 'ktlx');
    _sitePopOpen(s);
    const el = document.getElementById('site-pop');
    const btns = [...el.querySelectorAll('.site-pop-btn b')].map(x => x.textContent);
    const cs = getComputedStyle(el);
    // Watch what the new button does.
    const calls = [];
    const origView = window._siteView, origTm = window._tmOpen;
    window._siteView = (st) => { calls.push('view:' + st.id); return Promise.resolve(); };
    window._tmOpen = (scope) => { calls.push('tm:' + scope); };
    el.querySelector('.site-pop-past').click();
    await new Promise(res => setTimeout(res, 50));
    window._siteView = origView; window._tmOpen = origTm;
    return { btns, blur: cs.backdropFilter || cs.webkitBackdropFilter, shadow: cs.boxShadow, open: el.classList.contains('open'), calls };
  });
  ok('three choices, View Past Radar last', r.btns.join('|') === 'View this site|Compare radar sites|View Past Radar', r.btns.join('|'));
  ok('heavy gloss: a strong blur and the inset sheen', /blur\(24px\)/.test(r.blur) && /inset/.test(r.shadow), `${r.blur} | ${r.shadow.slice(0, 60)}`);
  ok('View Past Radar loads that radar and opens the radar Time Machine, and the popup closes',
     r.calls.join(',') === 'view:ktlx,tm:radar' && !r.open, JSON.stringify(r));
}

console.log('\n3. arranging the top bar');
{
  const r = await p.evaluate(async () => {
    const box = id => { const b = document.getElementById(id).getBoundingClientRect(); return Math.round(b.left + b.width / 2); };
    const before = { acc: box('lqm-profile-btn'), logo: box('logo-wrap'), search: box('top-search-bar') };
    topbarSetSlot('right', 'account');             // swaps with the search bar
    await new Promise(res => setTimeout(res, 50));
    const after = { acc: box('lqm-profile-btn'), logo: box('logo-wrap'), search: box('top-search-bar') };
    const saved = JSON.parse(localStorage.getItem('gwcfc_topbar') || '{}');
    topbarSetSlot('center', 'search');             // swaps with the logo
    await new Promise(res => setTimeout(res, 50));
    const third = { acc: box('lqm-profile-btn'), logo: box('logo-wrap'), search: box('top-search-bar') };
    lqmOpenSettings();
    const sel = ['left', 'center', 'right'].map(s => document.getElementById('lqm-tb-' + s).value);
    return { before, after, third, saved, sel, w: innerWidth };
  });
  const W = r.w;
  ok('by default: account left, logo centre, search right',
     r.before.acc < W / 3 && Math.abs(r.before.logo - W / 2) < 40 && r.before.search > W * 2 / 3, JSON.stringify(r.before));
  ok('account to the right swaps the search bar to the left',
     r.after.acc > W * 2 / 3 && r.after.search < W / 3 && Math.abs(r.after.logo - W / 2) < 40, JSON.stringify(r.after));
  ok('and it is saved', r.saved.left === 'search' && r.saved.center === 'logo' && r.saved.right === 'account', JSON.stringify(r.saved));
  ok('search to the centre swaps the logo out to the left',
     Math.abs(r.third.search - W / 2) < 40 && r.third.logo < W / 3 && r.third.acc > W * 2 / 3, JSON.stringify(r.third));
  ok('the Themes section shows the arrangement', r.sel.join(',') === 'logo,search,account', r.sel.join(','));
  const p2 = await ctx.newPage();
  await p2.route('**://**', r2 => {
    const u = r2.request().url();
    if (u.startsWith('file://')) return r2.continue();
    if (u.includes('leaflet') && u.endsWith('.js')) return r2.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
    if (u.includes('leaflet') && u.endsWith('.css')) return r2.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
    return r2.abort();
  });
  await p2.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(2500);
  const kept = await p2.evaluate(() => [...document.documentElement.classList].filter(c => c.startsWith('tb-')).sort().join(','));
  ok('it comes back after a reload', kept === 'tb-account-right,tb-logo-left,tb-search-center', kept);
  ok('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
