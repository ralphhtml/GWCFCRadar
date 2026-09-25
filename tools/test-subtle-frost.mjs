#!/usr/bin/env node
/*
 * Every frosted surface is subtle frost. Nothing is heavy.
 *
 *     node tools/test-subtle-frost.mjs
 *
 * Heavy frost was a strong 24px blur over a thin (about 60 percent) fill;
 * subtle is the app's glass level (--glass-blur, 8px, and --glass-a-panel,
 * 84 percent). By request every panel and popup that wore heavy frost now
 * wears subtle. Checked in the source (no strong blur and no heavy thin fill
 * left anywhere) and on a real page (the computed blur of the shared panel
 * shell, the alerts, EAS and forecast panels, the 3D panels, the outlook
 * controls).
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

const strong = [...PAGE.matchAll(/blur\((1[4-9]|[2-9]\d)px\)/g)].map(m => m[0]);
ok('no strong blur (14px or more) anywhere in the page', strong.length === 0, strong.join(' '));
const thin = [...PAGE.matchAll(/rgba\((22,26,32|24,28,34|20,24,30|6,8,12|6,9,13|5,7,10),\s*0\.[5-7]\d\)/g)].map(m => m[0]);
ok('none of the heavy recipe\'s thin dark fills are left', thin.length === 0, thin.join(' '));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1300, height: 850 } });
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

const r = await p.evaluate(() => {
  document.documentElement.setAttribute('data-glass', 'subtle');
  const probe = (tag, attrs) => {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => k === 'class' ? (el.className = v) : el.setAttribute(k, v));
    el.style.display = 'block';
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const out = { blur: cs.backdropFilter || cs.webkitBackdropFilter, bg: cs.backgroundImage };
    el.remove();
    return out;
  };
  return {
    shell: probe('div', { class: 'gw-shell' }),
    alerts: probe('div', { id: 'alerts-panel' }),
    eas: probe('div', { id: 'eas-panel' }),
    forecast: probe('div', { id: 'forecast-panel' }),
    r3d: probe('div', { id: 'r3d-panel' }),
    spc: probe('div', { id: 'spc-controls' }),
    lvl: probe('div', { id: 'lvl-dock' }),
    subtleBlur: getComputedStyle(document.documentElement).getPropertyValue('--glass-blur').trim(),
  };
});
// (The level slider is a bare slider with no frost at all, by request.)
const names = ['shell', 'alerts', 'eas', 'forecast', 'r3d', 'spc'];
const heavy = names.filter(n => !/blur\(8px\)/.test(r[n].blur || ''));
ok(`the subtle blur is ${r.subtleBlur}, and every sampled surface wears it`, r.subtleBlur === '8px' && heavy.length === 0,
   heavy.map(n => n + ': ' + r[n].blur).join(' | '));
const thinBg = names.filter(n => /,\s*0\.[5-7]\d\)/.test(r[n].bg || '') && !/0\.84/.test(r[n].bg || ''));
ok('and the subtle fill, not the thin heavy one', thinBg.length === 0, thinBg.map(n => n + ': ' + r[n].bg).join(' | '));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
