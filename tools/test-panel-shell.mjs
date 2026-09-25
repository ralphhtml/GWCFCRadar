#!/usr/bin/env node
/*
 * One look for every panel and popup (the weather station popup's), except
 * Settings.
 *
 *     node tools/test-panel-shell.mjs
 *
 * Checked: opened panels get the shell, their header, an icon and a single
 * styled X; Settings is left exactly as it was; a header with its own colour
 * keeps it; and every map popup gets the same box and X.
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
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);

const look = (open, sel) => p.evaluate(async ([open, sel]) => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  eval(open);
  await wait(1000);
  const el = document.querySelector(sel);
  const sh = el && (el.classList.contains('gw-shell') ? el : el.querySelector('.gw-shell'));
  const head = sh && sh.querySelector('.gw-shell-head');
  return {
    shell: !!sh, head: !!head, icon: !!(head && head.querySelector('svg')),
    x: sh ? sh.querySelectorAll('.gw-shell-x').length : 0,
    radius: sh ? getComputedStyle(sh).borderTopLeftRadius : '',
    line: head ? getComputedStyle(head).borderBottomWidth : '',
  };
}, [open, sel]);

console.log('\n1. panels');
for (const [name, open, sel, close] of [
  ['Credits', 'openCredits()', '#credits-modal-panel', 'closeCredits()'],
  ['Feedback', 'openFeedback()', '#feedback-modal', 'closeFeedback()'],
  ['Run Models', 'openRunModelsPanel()', '#run-models-panel', ''],
  ['Live Chat', 'lqmOpenChat()', '#lqm-chat-overlay', ''],
  ['Navigation', '_navOpen()', '#nav-panel', ''],
]) {
  const r = await look(open, sel);
  ok(`${name}: shell, header with an icon, one X, rounded, the accent line`,
     r.shell && r.head && r.icon && r.x >= 1 && r.radius === '14px' && r.line === '2px', JSON.stringify(r));
  await p.evaluate(c => { try { if (c) eval(c); } catch (e) {} document.querySelectorAll('.lqm-panel-open').forEach(x => x.classList.remove('lqm-panel-open')); }, close);
}

console.log('\n2. Settings keeps its own look');
const s = await look('lqmOpenSettings()', '#lqm-settings-overlay');
ok('Settings is not given the shell', !s.shell, JSON.stringify(s));
await p.evaluate(() => { try { lqmCloseSettings(); } catch (e) {} });

console.log('\n3. a coloured header keeps its colour');
const typed = await p.evaluate(async () => {
  const d = document.createElement('div');
  d.id = 'zz-typed-panel';
  d.style.cssText = 'position:fixed;left:100px;top:100px;width:300px;height:200px;z-index:9000';
  d.innerHTML = '<div class="zz-header" style="background:rgb(200,0,0);height:36px">Tornado Warning <button onclick="zzClose()">✕</button></div><div>body</div>';
  document.body.appendChild(d);
  _shScan();
  const h = d.querySelector('.gw-shell-head');
  const out = { typed: h && h.classList.contains('gw-typed'), bg: h && getComputedStyle(h).backgroundColor };
  d.remove();
  return out;
});
ok('a header painted its own colour keeps it', typed.typed && typed.bg === 'rgb(200, 0, 0)', JSON.stringify(typed));

console.log('\n4. map popups');
const pop = await p.evaluate(async () => {
  L.popup().setLatLng(map.getCenter()).setContent('<div>hello</div>').openOn(map);
  await new Promise(res => setTimeout(res, 100));
  _shScan();
  const el = document.querySelector('.leaflet-popup');
  const w = el.querySelector('.leaflet-popup-content-wrapper');
  return { gw: el.classList.contains('gw-pop'), radius: getComputedStyle(w).borderTopLeftRadius };
});
ok('every popup gets the same rounded box', pop.gw && pop.radius === '14px', JSON.stringify(pop));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
