#!/usr/bin/env node
/*
 * Every panel can be resized, the way Asturio's window can.
 *
 *     node tools/test-panel-resize.mjs
 *
 * Checked: nothing gets a grip while no panel is open; opening panels (a
 * floating one, one centred in a backdrop, one built on the fly) gives each
 * a grip on its bottom-right corner; a real mouse drag makes the panel
 * bigger with the corner following the pointer; the size comes back after a
 * reload; and a double-click on the grip puts the panel back exactly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 400) + '>' : '')); }
};
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const p = await ctx.newPage();
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
const load = async () => {
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
};
await load();

const grips = () => p.evaluate(() => [..._prGrips].filter(([el, g]) => g.classList.contains('on'))
  .map(([el, g]) => { const r = el.getBoundingClientRect(), q = g.getBoundingClientRect();
    return { id: el.id || el.parentElement.id + '>', w: Math.round(r.width), h: Math.round(r.height),
             corner: Math.abs(q.right - r.right) <= 1 && Math.abs(q.bottom - r.bottom) <= 1, gx: q.x + 9, gy: q.y + 9 }; }));

console.log('\n1. which panels get a grip');
await p.evaluate(() => { document.querySelectorAll('.lqm-panel-open').forEach(x => x.classList.remove('lqm-panel-open')); });
await p.waitForTimeout(900);
let g = await grips();
ok('with the panels closed, no grips anywhere', g.length === 0, JSON.stringify(g.map(x => x.id)));

await p.evaluate(() => lqmOpenSettings());
await p.waitForTimeout(1000);
g = await grips();
const set = g.find(x => x.id === 'lqm-settings-overlay');
ok('Settings gets a grip, on its bottom-right corner', set && set.corner, JSON.stringify(g));
ok('Asturio is left to its own grip', !g.some(x => x.id === 'lqm-ai-overlay'));

console.log('\n2. dragging');
await p.mouse.move(set.gx, set.gy);
await p.mouse.down();
await p.mouse.move(set.gx - 60, set.gy - 120, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(200);
let after = (await grips()).find(x => x.id === 'lqm-settings-overlay');
ok('dragging the corner resizes Settings, the corner following the pointer',
   after && Math.abs(after.w - (set.w - 60)) <= 4 && Math.abs(after.h - (set.h - 120)) <= 4 && after.corner, JSON.stringify([set, after]));
ok('and the size is saved by the panel\'s id', await p.evaluate(() => !!JSON.parse(localStorage.getItem('gwcfc_panel_sizes'))['lqm-settings-overlay']));

await load();
await p.evaluate(() => lqmOpenSettings());
await p.waitForTimeout(1000);
let back = (await grips()).find(x => x.id === 'lqm-settings-overlay');
ok('after a reload Settings opens at the saved size', back && Math.abs(back.w - after.w) <= 2 && Math.abs(back.h - after.h) <= 2, JSON.stringify([after, back]));

await p.mouse.dblclick(back.gx, back.gy);
await p.waitForTimeout(900);
let reset = (await grips()).find(x => x.id === 'lqm-settings-overlay');
ok('double-clicking the grip puts it back to normal', reset && Math.abs(reset.w - set.w) <= 2 && Math.abs(reset.h - set.h) <= 2
   && !(await p.evaluate(() => JSON.parse(localStorage.getItem('gwcfc_panel_sizes') || '{}')['lqm-settings-overlay'])), JSON.stringify([set, reset]));
await p.evaluate(() => { document.querySelectorAll('.lqm-panel-open').forEach(x => x.classList.remove('lqm-panel-open')); });

console.log('\n3. a panel centred in a backdrop, and one made on the fly');
await p.evaluate(() => {
  const bd = document.createElement('div');
  bd.id = 'zz-test-modal';
  bd.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);z-index:9000';
  bd.innerHTML = '<div style="width:400px;height:300px;background:#222;border-radius:12px"></div>';
  document.body.appendChild(bd);
});
await p.waitForTimeout(1000);
g = await grips();
const card = g.find(x => x.id === 'zz-test-modal>');
ok('the backdrop is skipped and the card inside gets the grip', card && card.corner && card.w === 400 && !g.some(x => x.id === 'zz-test-modal'), JSON.stringify(g));
await p.mouse.move(card.gx, card.gy);
await p.mouse.down();
await p.mouse.move(card.gx + 100, card.gy + 60, { steps: 10 });
const mid = await p.evaluate(() => { const r = document.querySelector('#zz-test-modal > div').getBoundingClientRect(); return { right: r.right, bottom: r.bottom, w: r.width }; });
await p.mouse.up();
ok('a centred card grows so its corner stays under the pointer', Math.abs(mid.right - (card.gx + 9 + 100)) <= 6 && Math.abs(mid.bottom - (card.gy + 9 + 60)) <= 6,
   JSON.stringify([card, mid]));
await p.evaluate(() => document.getElementById('zz-test-modal').remove());
await p.waitForTimeout(900);
ok('when a panel is removed its grip goes too', await p.evaluate(() => ![..._prGrips.keys()].some(el => !el.isConnected)
   && document.querySelectorAll('.panel-grip').length === _prGrips.size));

console.log('\n4. a phone');
const ph = await ctx.newPage();
await ph.setViewportSize({ width: 390, height: 800 });
ph.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await ph.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  return r.abort();
});
await ph.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await ph.waitForTimeout(3500);
const phoneGrips = await ph.evaluate(() => [..._prGrips].filter(([el, g]) => g.classList.contains('on')).map(([el]) => el.id));
ok('a phone at rest shows no stray grips', phoneGrips.length === 0, phoneGrips.join(','));

ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
