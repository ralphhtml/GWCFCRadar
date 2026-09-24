#!/usr/bin/env node
/*
 * ?menu= links pick layers the way a person does, by tapping the menu.
 *
 *     node tools/test-menu-links.mjs
 *
 * The Discord bot's /map layer option sends a menu path
 * ("Waves > Period"), and the page taps each label of it in its own left
 * menu. Pinned here: a path taps through to the pick, a pick already lit is
 * not tapped off again, a label the menu lacks stops the path without
 * touching anything else, and a ?shot= picture keeps what the path switched
 * on instead of stripping it as an unasked-for default.
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
ok('the page reads ?menu=', /'spcday','spchaz','wpcday','fwday','cpctype','menu',/.test(PAGE) && /_menuPlayAll\(p\.get\('menu'\)\)/.test(PAGE));
ok('no em dashes in this test', !readFileSync(join(ROOT, 'tools/test-menu-links.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
async function open(qs) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
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
  await p.goto('file://' + join(ROOT, 'index.html') + (qs || ''), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  return { p, errs };
}

console.log('\n2. tapping through the menu');
{
  const { p, errs } = await open('');
  ok('the page boots clean', errs.length === 0, errs[0]);
  const r = await p.evaluate(async () => {
    const out = {};
    out.play = await _menuPlay('Waves > Period');
    out.on = { waves: wavesActive, product: _wavesProduct };
    out.home = _menuRowItems().map(x => x.label).slice(0, 3);
    // The same pick again: it is lit, so it is not tapped back off.
    out.again = await _menuPlay('waves>PERIOD');
    out.stillOn = wavesActive && _wavesProduct === 'wave-period';
    out.missing = await _menuPlay('Waves > Unicorns', 300);
    out.untouched = wavesActive && _wavesProduct === 'wave-period';
    return out;
  });
  ok('a path taps through to its pick', r.play.ok && r.on.waves && r.on.product === 'wave-period', JSON.stringify(r));
  ok('case and spacing do not matter, and a lit pick stays on', r.again.ok && r.stillOn, JSON.stringify(r));
  ok('a label the menu lacks stops the path and changes nothing', !r.missing.ok && r.missing.missing === 'Unicorns' && r.untouched, JSON.stringify(r.missing));
  await p.context().close();
}

console.log('\n3. a ?shot= picture keeps what the path switched on');
{
  const { p, errs } = await open('?shot=1&z=5&menu=' + encodeURIComponent('Waves>Period'));
  await p.waitForFunction(() => document.body.dataset.shotReady === '1', null, { timeout: 30000 }).catch(() => {});
  const r = await p.evaluate(() => ({ ready: document.body.dataset.shotReady, waves: wavesActive, product: _wavesProduct,
    home: _menuRowItems().map(x => x.label).includes('Waves') }));
  ok('the picture has the layer the path picked', r.ready === '1' && r.waves && r.product === 'wave-period', JSON.stringify(r));
  ok('and the menu is left at its top again', r.home, JSON.stringify(r));
  ok('no page errors along the way', errs.length === 0, errs[0]);
  await p.context().close();
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
