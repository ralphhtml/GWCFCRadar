#!/usr/bin/env node
/*
 * Text stays readable on every theme.
 *
 *     node tools/test-legibility.mjs
 *
 * A tester's screenshot: a purple theme where the Settings dropdowns wore
 * near-black text on deep purple and the help text sat grey on grey. The
 * pressable controls had fixed dark ink (right for the default light-blue
 * raised gradient, invisible on a dark one), and a theme's muted colour
 * was never checked against the panels it lands on. The page now measures
 * its own colours after every theme change. Checked here on every shipped
 * preset and on a hand-made purple theme like the one in the screenshot.
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
ok('no control is left with fixed dark ink', !/color: #0b1520/.test(PAGE));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
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

const measure = () => p.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const get = k => cs.getPropertyValue(k).trim();
  const raise = _lgSurface(get('--grad-raise'));
  const sel = document.getElementById('lqm-tb-left') || document.querySelector('.lqm-settings-select');
  const ink = _lgColors(getComputedStyle(sel).color)[0];
  const panels = [_lgSurface(get('--grad-panel')), _lgSurface(get('--grad-surface'))].filter(Boolean);
  const muted = _lgColors(get('--muted'))[0];
  // The best either ink could do on this raised surface: a mid-tone
  // gradient can cap it, and the guard must at least pick the better one.
  const best = Math.max(_lgContrast(raise, [11, 21, 32]), _lgContrast(raise, [255, 255, 255]));
  return { control: _lgContrast(raise, ink), best,
           muted: Math.min.apply(null, panels.map(x => _lgContrast(muted, x))) };
});

const presets = await p.evaluate(() => Object.keys(THEME_PRESETS));
const bad = [];
for (const k of presets) {
  await p.evaluate(key => themeApplyPreset(key), k);
  await p.waitForTimeout(150);
  const m = await measure();
  if (m.control + 0.01 < m.best || m.control < 3 || m.muted < 4.5) bad.push(k + ' ' + JSON.stringify(m));
}
ok(`every preset (${presets.length}): control text and help text read clearly`, bad.length === 0, bad.join(' | '));

// The screenshot: a purple raised gradient and a dim grey muted colour.
await p.evaluate(() => {
  themeReset();
  const r = document.documentElement.style;
  r.setProperty('--grad-raise', 'linear-gradient(180deg, #4a2a8a 0%, #35196e 100%)');
  r.setProperty('--grad-panel', 'linear-gradient(180deg, #3a3a44 0%, #2e2e36 100%)');
  r.setProperty('--grad-surface', 'linear-gradient(180deg, #34343c 0%, #2a2a31 100%)');
  r.setProperty('--muted', '#55555f');
});
await p.waitForTimeout(200);
const m = await measure();
ok('on a purple theme the dropdown text turns light and reads', m.control >= 4.5, JSON.stringify(m));
ok('and the grey help text is lifted until it reads', m.muted >= 4.5, JSON.stringify(m));
// A colour that already reads is left exactly as chosen.
await p.evaluate(() => { themeReset(); document.documentElement.style.setProperty('--muted', '#b8c8d8'); });
await p.waitForTimeout(200);
const kept = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--muted').trim());
ok('a muted colour that already reads is kept as chosen', kept === '#b8c8d8', kept);
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
