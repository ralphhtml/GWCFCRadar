#!/usr/bin/env node
/*
 * The thirty "your site looks vibecoded" tells, checked against this app.
 *
 *     node tools/test-vibecoded-sweep.mjs
 *
 * The list is a real one going round, and it is worth taking seriously,
 * but most of it describes a SaaS LANDING PAGE and this is a weather map.
 * Mechanically "fixing" all thirty would have made the app worse: magenta is
 * the National Weather Service's own colour for a Hurricane Warning, not a
 * neon accent, and a bevel highlight on a toggle knob is not a radial orb.
 *
 * So this file does two jobs, and keeps them apart.
 *
 * PART ONE is the things that were genuinely wrong and are now fixed, held
 * so they cannot come back: there were no legal pages at all, and a handful
 * of UI emoji had escaped the sprite system the rest of the app uses.
 *
 * PART TWO is the tells this app never had, held so they cannot arrive: no
 * Lucide, no Inter/Geist/Space Grotesk, no fake testimonials, no bento grid,
 * no "it's not X, it's Y", no pricing tiers, no em dashes.
 *
 * Deliberately NOT asserted, with the measurement that settled each one:
 *
 *   gradients (114) and shadows (261)  every one is the app's own bevel
 *       lighting system in its own red palette, two-stop and vertical. That
 *       is a skeuomorphic style, chosen, not a rainbow smear.
 *   backdrop-filter (40)  glass over a moving map is legibility, not
 *       decoration, and it is already switched off on touch devices for GPU.
 *   border-radius  the commonest values are 6, 8 and 10 px. Tight, not the
 *       pill-shaped softness the list is describing.
 *   radial-gradient (7)  bead highlights on knobs and bullets, plus one
 *       vignette scrim. No background orbs anywhere.
 *   magenta #ff00ff (15)  Hurricane Warning, Tsunami Watch, SPC HIGH risk
 *       and extreme fire weather. Agency colour codes. Changing them would
 *       make the map wrong.
 *   white backgrounds (6)  a slider thumb, a toggle knob, an image viewer
 *       letterbox, a lower-third flag and a colour swatch. Not a page.
 *   three cards in a row  the grid is auto-fill minmax(260px, 1fr), so it
 *       reflows. It is three on a wide screen because three fit.
 *   no skeleton loaders  every wait in this app says what it is waiting
 *       for ("Loading MRMS...", "Loading VEL..."). A shimmering grey
 *       rectangle would be less information, not more.
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

console.log('\n1. the two that were genuinely missing: TOS and privacy policy');
{
  ok('there is a legal page at a real, linkable URL',
     existsSync(join(ROOT, 'legal.html')));
  const L = existsSync(join(ROOT, 'legal.html'))
    ? readFileSync(join(ROOT, 'legal.html'), 'utf8') : '';
  ok('it covers privacy', /Privacy/i.test(L) && /id="collect"/.test(L));
  ok('and terms of use', /id="terms"/.test(L) && /Terms of use/i.test(L));

  // A policy is only worth anything if it is SPECIFIC. Boilerplate that could
  // describe any app describes none, so these are the things this app in
  // particular does with data, and each must be named.
  [['location', /Locate/.test(L) && /navigation/i.test(L)],
   ['what stays on the device', /never leaves your device|on your device only/i.test(L)],
   ['Firebase, by name', /Firebase/.test(L)],
   ['the AI assistant sending your question on', /Gemini|Asturio/.test(L)],
   ['Cloud Capture posts being public', /public to everyone/i.test(L)],
   ['that videos stay on the device', /stays on the device/i.test(L)],
   ['how to get your data deleted', /deleted on request|can be deleted/i.test(L)],
   ['that there are no analytics', /no analytics/i.test(L)],
   ['the safety disclaimer', /NOAA Weather Radio/.test(L)]]
    .forEach(([what, cond]) => ok('  it names ' + what, cond));

  ok('the page is reachable from Credits',
     /href="legal\.html"[^>]*>[\s\S]{0,200}Privacy Policy/.test(PAGE));
  ok('and from the tutorial',
     /Privacy &amp; Terms<\/h3>/.test(PAGE));
  // The moment somebody hands over an email address is the moment the notice
  // is actually useful, so it is under the button rather than only in a menu.
  ok('and from the sign-up button, where consent actually happens',
     /auth-legal-note[\s\S]{0,300}legal\.html/.test(PAGE));
  ok('the sign-up note says an account is optional',
     /works without one/.test(PAGE));
}

console.log('\n2. emoji: every UI glyph goes through the icon sprite');
{
  // _eicon turns a glyph into an <svg><use href="#ic-..."> from the sprite.
  // A glyph the map does not know is handed back as the raw character, so
  // "is it in the map" is exactly "does it render as an icon".
  const map = JSON.parse(
    (PAGE.match(/const EMOJI_ICON_MAP = (\{.*?\});/s) || [])[1] || '{}');
  const need = {
    '\u{1F3C1}': 'flag', '↻': 'refresh-cw', '↺': 'refresh-ccw',
    '↖': 'arrow', '↗': 'arrow', '←': 'arrow',
    '→': 'arrow', '↑': 'arrow',
    '\u{1F6A8}': 'siren', '⛔': 'blocked', '\u{1F327}': 'cloud-rain',
    '\u{1F697}': 'car', '✅': 'check', '⚠️': 'warning',
    '\u{1F4FB}': 'radio',
  };
  const missing = Object.entries(need).filter(([g, s]) => map[g] !== s);
  ok('every glyph the UI now emits is in the map', missing.length === 0,
     missing.map(([g]) => g).join(' '));
  const slugs = [...new Set(Object.values(need))];
  const noSym = slugs.filter(s => !PAGE.includes(`id="ic-${s}"`));
  ok('and every one points at a symbol that exists', noSym.length === 0,
     noSym.join(', '));

  ok('turn-by-turn arrows are sprite glyphs, not raw dingbats',
     !/return '⬅'/.test(PAGE) && !/return '➡'/.test(PAGE)
     && !/return '⬆'/.test(PAGE));
  ok('the turn readout paints an icon rather than a character',
     /a\.innerHTML = _eicon\(arrow/.test(PAGE));
  ok('so does the navigation button',
     /ico\.innerHTML = \(_navNavOn && _navLastArrow\)/.test(PAGE));
  ok('so do the road report pins',
     /_eicon\(R\.emoji, '1\.1em'\)/.test(PAGE));
  ok('and the popped-out alert window headers',
     /_eicon\(spec\.icon\)/.test(PAGE));

  // Two places emoji are CORRECT and must survive a zealous sweep.
  ok('the avatar picker keeps its emoji, because that is the feature',
     /'\u{1F985}','\u{1F426}'/u.test(PAGE));
  ok('and the Discord feedback embed keeps its own, since it is not this UI',
     /const typeEmoji = \{ Bug:/.test(PAGE));
}

console.log('\n3. the tells this app never had, held so they stay that way');
{
  const files = ['index.html', 'legal.html'];
  const all = files.map(f => readFileSync(join(ROOT, f), 'utf8')).join('\n');

  ok('no Lucide icons', !/lucide/i.test(all));
  ok('no Inter, Geist or Space Grotesk',
     !/font-family:[^;}]*(Inter|Geist|Space Grotesk)/i.test(all));
  ok('the typeface is the one this app chose',
     /--display:\s*'Comfortaa'/.test(PAGE));
  ok('no fake testimonials',
     !/testimonial|loved by \d|trusted by \d/i.test(all));
  ok('no bento grid', !/bento/i.test(all));
  ok('no "it is not X, it is Y" copy',
     !/[Ii]t.s not (just )?[a-z ]{2,30}, it.s a/.test(all));
  ok('no pricing tiers', !/pricing tier|\/mo\b|per month|Most popular/i.test(all));
  ok('no decorative terminal window',
     !/class="[^"]*terminal-window/.test(all));

  const EM = String.fromCharCode(0x2014);
  const bad = ['index.html', 'legal.html', 'pi/gfs_pipeline.py',
               'tools/test-vibecoded-sweep.mjs']
    .filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes anywhere', bad.length === 0, bad.join(', '));

  // Not purple-and-black, which is the palette the list is really pointing at.
  ok('the palette is this app\'s own, not purple on black',
     /--bg:\s*#5a0000/.test(PAGE) && /--accent:\s*#e8b800/.test(PAGE));
}

console.log('\n4. in a real browser');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('  playwright is not installed, skipping');
} else {
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.on('dialog', d => d.dismiss().catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 160)));

  await p.goto('file://' + join(ROOT, 'index.html'),
               { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);
  const app = await p.evaluate(() => {
    const svg = g => /^<svg/.test(_eicon(g));
    return {
      arrows: ['\u{1F3C1}', '↻', '↺', '↖', '←',
               '↗', '→', '↑'].filter(g => !svg(g)),
      reports: Object.entries(NAV_REPORT_TYPES)
        .filter(([, v]) => !svg(v.emoji)).map(([k]) => k),
      legal: [...document.querySelectorAll('a[href^="legal.html"]')].length,
      // The map is the product, so the page itself must not scroll.
      scrolls: document.body.scrollWidth > window.innerWidth + 1,
    };
  });
  ok('every turn arrow resolves to an icon', app.arrows.length === 0,
     app.arrows.join(' '));
  ok('every road report type resolves to an icon', app.reports.length === 0,
     app.reports.join(', '));
  ok('the legal page is linked from the app', app.legal >= 3, String(app.legal));
  ok('the page does not scroll sideways', !app.scrolls);

  await p.goto('file://' + join(ROOT, 'legal.html'),
               { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(500);
  const leg = await p.evaluate(() => ({
    sections: [...document.querySelectorAll('section[id]')].map(s => s.id),
    toc: [...document.querySelectorAll('nav.toc a')].map(a => a.getAttribute('href')),
    height: document.body.scrollHeight,
    bg: getComputedStyle(document.body).backgroundColor,
    back: !!document.querySelector('a[href="index.html"]'),
    sideways: document.body.scrollWidth > window.innerWidth + 1,
  }));
  ok('the legal page has all its sections', leg.sections.length === 9,
     leg.sections.join(', '));
  ok('every contents link points at one that exists',
     leg.toc.every(h => leg.sections.includes(h.slice(1))),
     leg.toc.filter(h => !leg.sections.includes(h.slice(1))).join(', '));
  ok('it is a real read, not a two-line placeholder', leg.height > 3000,
     String(leg.height));
  ok('it wears the app\'s palette rather than a white template',
     leg.bg === 'rgb(90, 0, 0)', leg.bg);
  ok('and there is a way back to the radar', leg.back);
  ok('it does not scroll sideways either', !leg.sideways);
  ok('nothing threw on either page', errs.length === 0,
     errs.slice(0, 3).join(' | '));
  await b.close();
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
