#!/usr/bin/env node
/*
 * Asturio's window can be resized (tester: "the panel size is fixed, making
 * long chats or code/text previews cramped").
 *
 *     node tools/test-ai-resize.mjs
 *
 * A real mouse drag on the corner grip makes the window bigger, the chat
 * area grows with it, the size is remembered the next time it opens, it is
 * never bigger than the screen, and a double-click puts it back.
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
ok('no em dashes', !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));

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
await p.waitForTimeout(3000);

const box = () => p.evaluate(() => {
  const o = document.getElementById('lqm-ai-overlay').getBoundingClientRect();
  const m = document.getElementById('lqm-ai-messages').getBoundingClientRect();
  return { w: Math.round(o.width), h: Math.round(o.height), msgH: Math.round(m.height) };
});
await p.evaluate(() => lqmOpenAI());
const before = await box();
const g = await p.evaluate(() => { const r = document.getElementById('lqm-ai-resize').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await p.mouse.move(g.x, g.y);
await p.mouse.down();
await p.mouse.move(g.x + 150, g.y + 80, { steps: 8 });
await p.mouse.up();
const after = await box();
ok('dragging the corner makes the window bigger', after.w >= before.w + 140 && after.h >= before.h + 70, JSON.stringify([before, after]));
ok('and the chat area grows with it', after.msgH >= before.msgH + 60, JSON.stringify([before, after]));
await p.evaluate(() => { lqmCloseAI(); lqmOpenAI(); });
const again = await box();
ok('reopened, it keeps that size', Math.abs(again.w - after.w) <= 2 && Math.abs(again.h - after.h) <= 2, JSON.stringify([after, again]));
await p.evaluate(() => { localStorage.setItem('gwcfc_ai_size', JSON.stringify({ w: 5000, h: 5000 })); lqmCloseAI(); lqmOpenAI(); });
const huge = await box();
ok('a saved size bigger than the screen is fitted to it', huge.w <= 1400 && huge.h <= 900, JSON.stringify(huge));
const g2 = await p.evaluate(() => { const r = document.getElementById('lqm-ai-resize').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await p.mouse.dblclick(g2.x, g2.y);
const reset = await box();
ok('double-clicking the grip puts the default size back', Math.abs(reset.w - before.w) <= 2
   && !(await p.evaluate(() => localStorage.getItem('gwcfc_ai_size'))), JSON.stringify([before, reset]));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
