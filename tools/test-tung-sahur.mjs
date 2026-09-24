#!/usr/bin/env node
/*
 * Searching "tung tung tung sahur" floods the screen with the GIF.
 *
 *     node tools/test-tung-sahur.mjs [screenshot.png]
 *
 * The GIF is the site's own copy, shown as plain images; Tenor's embed
 * script is never loaded. The flood never takes a click, and ends by itself,
 * on Esc, or on a click.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};
ok('the GIF is in the site\'s own files', existsSync(join(ROOT, 'assets/img/tung-tung-sahur.webp')));
ok('no Tenor script anywhere in the page', !/tenor\.com\/embed\.js/.test(PAGE));
ok('no em dashes in this test', !readFileSync(join(ROOT, 'tools/test-tung-sahur.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = [], outside = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (/tenor/.test(url)) outside.push(url);
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);

const r = await p.evaluate(async () => {
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const out = {};
  out.match = ['tung tung tung sahur', 'Tung Tung Tung Sahur!', 'tungtungtungsahur', 'tung tung sahur']
    .map(q => TUNG_RE.test(q));
  out.miss = ['tungsten', 'sahur', 'tung tung tung'].map(q => TUNG_RE.test(q));
  const inp = document.getElementById('lqm-search-input');
  inp.value = 'tung tung tung sahur';
  inp.dispatchEvent(new Event('input'));
  lqmSearchInput(inp.value);
  await sleep(3300);
  const box = document.getElementById('tung-flood');
  out.count = box ? box.querySelectorAll('img.tung-one').length : 0;
  out.banner = box && box.querySelector('.tung-banner') && box.querySelector('.tung-banner').textContent;
  out.clickThrough = box && getComputedStyle(box).pointerEvents === 'none';
  out.loaded = box ? [...box.querySelectorAll('img')].some(i => i.complete && i.naturalWidth > 0) : false;
  return out;
});
await p.screenshot({ path: process.argv[2] || '/tmp/tung.png' });
ok('the phrase is recognised however it is typed', r.match.every(Boolean), JSON.stringify(r.match));
ok('and other searches are not', r.miss.every(x => !x), JSON.stringify(r.miss));
ok('the screen floods with copies of the GIF', r.count >= 40 && r.loaded, JSON.stringify(r));
ok('with the banner, and the map still takes clicks through it', r.banner === 'TUNG TUNG TUNG SAHUR' && r.clickThrough);
await p.keyboard.press('Escape');
await p.waitForTimeout(800);
ok('Esc clears it', await p.evaluate(() => !document.getElementById('tung-flood')));
ok('nothing was asked of Tenor', outside.length === 0, outside[0]);
ok('no page errors', errs.length === 0, errs[0]);
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
