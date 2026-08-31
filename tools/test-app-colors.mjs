#!/usr/bin/env node
/*
 * App Colors: recolouring the app's own chrome.
 *
 *     node tools/test-app-colors.mjs
 *
 * The whole of this app's chrome is already drawn from CSS custom properties,
 * so recolouring it is overriding those on :root rather than touching a single
 * rule. Three things about that are worth holding down.
 *
 * IT APPLIES BEFORE THE FIRST PAINT. A saved theme applied from a normal
 * script means everybody sees the shipped red and then a flash to their own
 * colours, so the loader runs immediately after the stylesheet.
 *
 * EVERY VALUE IS REBUILT, NEVER TRUSTED. These strings come out of storage or
 * off somebody's clipboard and end up inside a CSS declaration, which is a
 * place a stray url() or semicolon does real damage.
 *
 * THE DEFAULT THEME IS THE ABSENCE OF OVERRIDES. Writing the shipped values
 * back as overrides would look identical and then quietly stop following any
 * future change to the stylesheet.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x ? '  <' + x + '>' : '')); } };

console.log('\n1. it runs before anything is drawn');
{
  const styleEnd = PAGE.indexOf('</style>', PAGE.indexOf(':root {'));
  const loader = PAGE.indexOf('window.THEME_KEY');
  const body = PAGE.indexOf('<body');
  ok('the loader sits right after the stylesheet',
     loader > styleEnd && loader - styleEnd < 1500, String(loader - styleEnd));
  ok('and before the page exists', loader < body, loader + ' vs ' + body);
  ok('a corrupt saved theme does not cost the page its stylesheet',
     /a corrupt theme must never cost the page its stylesheet/.test(PAGE));
}

console.log('\n2. nothing reaches CSS without being rebuilt');
{
  const clean = (PAGE.match(/window\._themeClean = function \(c\) \{[\s\S]*?\n\};/) || [''])[0];
  const surf = (PAGE.match(/window\._themeSurfaceCss = function \(sf\) \{[\s\S]*?\n\};/) || [''])[0];
  ok('both helpers were found', !!clean && !!surf);
  // Both helpers hang off window, so the scope they run in has to have one.
  const C = new Function('window', clean + '\nreturn window._themeClean;')({});
  ok('a plain hex passes', C('#A1B2C3') === '#a1b2c3');
  for (const bad of ['red', '#fff', 'rgb(1,2,3)', 'url(x)', '#12345g', null, 42,
                     '#ff0000;background:url(//evil)', 'var(--x)', '']) {
    ok('rejects ' + JSON.stringify(bad), C(bad) === null, String(C(bad)));
  }
  const S = new Function('window', clean + '\n' + surf
    + '\nreturn window._themeSurfaceCss;')({});
  ok('a solid becomes a one-colour gradient, so one property holds either',
     S({ type: 'solid', color: '#ff0000', angle: 180 })
       === 'linear-gradient(180deg, #ff0000 0%, #ff0000 100%)',
     S({ type: 'solid', color: '#ff0000', angle: 180 }));
  ok('three stops are spread evenly',
     S({ type: 'grad', angle: 90, stops: ['#000000', '#888888', '#ffffff'] })
       === 'linear-gradient(90deg, #000000 0.0%, #888888 50.0%, #ffffff 100.0%)',
     S({ type: 'grad', angle: 90, stops: ['#000000', '#888888', '#ffffff'] }));
  ok('a bad stop is dropped rather than passed through',
     S({ type: 'grad', angle: 0, stops: ['#000000', 'url(x)'] }) === null);
  ok('one stop is not a gradient', S({ type: 'grad', stops: ['#000000'] }) === null);
  ok('the angle is clamped to a real angle',
     /Math\.max\(0, Math\.min\(360, parseInt\(sf\.angle, 10\) \|\| 180\)\)/.test(PAGE));
  ok('and a property name has to look like one',
     (PAGE.match(/\/\^--\[a-z0-9-\]\+\$\//g) || []).length >= 2);
}

console.log('\n3. the editor');
{
  ok('it is its own settings card, which is what earns it a tab',
     /data-cat="app-colors"/.test(PAGE));
  ok('twelve colours and five surfaces',
     (PAGE.match(/\{ v: '--/g) || []).length >= 17);
  ok('surfaces can be solid or gradient',
     /<option value="grad"/.test(PAGE) && /<option value="solid"/.test(PAGE));
  ok('with two to four stops', /Math\.max\(2, Math\.min\(4, parseInt\(n, 10\) \|\| 2\)\)/.test(PAGE));
  ok('and an angle', /themeSetSurface\(\\'' \+ t\.v \+ '\\', \{ angle: this\.value \}\)/.test(PAGE)
     || /angle: this\.value/.test(PAGE));
  ok('four named themes ship', /const THEME_PRESETS = \{[\s\S]{0,80}gwcfc:/.test(PAGE)
     && ['midnight', 'slate', 'storm'].every(k => new RegExp('\\n  ' + k + ':').test(PAGE)));
  // A preset that only moved the accent would leave a blue theme on a red panel.
  ok('a preset changes surfaces as well as colours, not just the accent',
     /midnight:[\s\S]{0,900}surfaces: \{[\s\S]{0,200}--grad-panel/.test(PAGE));
  ok('applying a preset deep copies it', /stops: sf\.stops\.slice\(\)/.test(PAGE));
  ok('the default preset CLEARS overrides rather than writing them back',
     /_themeClearProps\(\);/.test(PAGE)
     && /they would then stop following any future change to the stylesheet/.test(PAGE));
  ok('there is an import and an export', /function themeExport\(\)/.test(PAGE)
     && /function themeImport\(\)/.test(PAGE));
  ok('an imported theme is rebuilt field by field, not trusted wholesale',
     /Rebuilt field by field rather than trusted wholesale/.test(PAGE));
  ok('and only known properties survive it',
     /const known = new Set\(THEME_TOKENS\.map/.test(PAGE)
     && /const knownS = new Set\(THEME_SURFACES\.map/.test(PAGE));
  ok('the panel is redrawn when Settings opens',
     /_themeRender === 'function'[\s\S]{0,60}_themeRender\(\)/.test(PAGE));
  // Map data colours are a different question and stay where they are.
  ok('it says why radar and model colours are not in here',
     /those stand for measurements rather than/.test(PAGE));
}

console.log('\n4. recolouring a real page');
let chromium;
try { ({ chromium } = await import('playwright')); } catch {}
if (!chromium) { console.log('  playwright is not installed, skipping'); }
else {
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => {
    const out = {};
    const root = document.documentElement;
    const read = v => getComputedStyle(root).getPropertyValue(v).trim();
    out.shippedAccent = read('--accent');
    lqmOpenSettings();
    out.rows = document.querySelectorAll('#lqm-theme-tokens .lqm-settings-row').length;
    out.surfaceBlocks = document.querySelectorAll('#lqm-theme-surfaces .lqm-theme-block').length;

    themeApplyPreset('midnight');
    out.midAccent = read('--accent');
    out.midPanel = read('--grad-panel');
    // The real test of "it recoloured the app": something on screen changed.
    const btn = document.querySelector('.lqm-settings-btn');
    out.btnBg = btn ? getComputedStyle(btn).backgroundImage.slice(0, 40) : '';

    themeSetToken('--accent', '#00ff00');
    out.customAccent = read('--accent');
    themeSetSurface('--grad-raise', { type: 'solid', color: '#123456' });
    out.solidRaise = read('--grad-raise');

    // Round trip through the text box.
    themeExport();
    const text = document.getElementById('lqm-theme-io').value;
    themeReset();
    out.afterReset = read('--accent');
    document.getElementById('lqm-theme-io').value = text;
    themeImport();
    out.afterImport = read('--accent');

    // A hostile paste.
    document.getElementById('lqm-theme-io').value = JSON.stringify({
      tokens: { '--accent': 'red;background:url(//evil)', '--not-a-token': '#ffffff' },
      surfaces: { '--grad-panel': { type: 'grad', stops: ['url(x)', 'javascript:1'] } } });
    themeImport();
    out.hostileStatus = document.getElementById('lqm-theme-io-status').textContent;
    out.accentAfterHostile = read('--accent');
    out.styleAttr = root.getAttribute('style') || '';

    themeReset();
    out.finalAccent = read('--accent');
    return out;
  });
  await b.close();

  ok('the token rows render', r.rows === 12, String(r.rows));
  ok('and one block per surface', r.surfaceBlocks === 5, String(r.surfaceBlocks));
  ok('a preset changes the accent', r.midAccent === '#5ec8ff', r.midAccent);
  ok('and the panel gradient with it',
     /1c2947/.test(r.midPanel), r.midPanel);
  ok('a real button on screen picks up the new surface',
     /gradient/.test(r.btnBg), r.btnBg);
  ok('a custom colour applies', r.customAccent === '#00ff00', r.customAccent);
  ok('a surface can be made solid',
     r.solidRaise === 'linear-gradient(180deg, #123456 0%, #123456 100%)', r.solidRaise);
  ok('reset really goes back to the shipped colour',
     r.afterReset === r.shippedAccent, r.afterReset + ' vs ' + r.shippedAccent);
  ok('a theme survives the copy out and paste in round trip',
     r.afterImport === '#00ff00', r.afterImport);
  // The point of rebuilding an imported theme rather than trusting it.
  ok('a hostile paste is refused, not applied',
     /Nothing usable/.test(r.hostileStatus), r.hostileStatus);
  ok('and nothing of it reached the style attribute',
     !/url\(|javascript:/.test(r.styleAttr), r.styleAttr.slice(0, 120));
  ok('reset clears back to shipped once more', r.finalAccent === r.shippedAccent);
  ok('no uncaught page errors', errs.length === 0, errs.join(' | '));
}

console.log('\n5. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-app-colors.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
