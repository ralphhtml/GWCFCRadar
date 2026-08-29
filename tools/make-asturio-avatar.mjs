#!/usr/bin/env node
/*
 * Builds the Discord bot's picture from the radar's own Asturio logo.
 *
 *     node tools/make-asturio-avatar.mjs
 *
 * WHAT CHANGED AND WHY
 *
 * This used to draw a stylised mark: the app's rings as a lit iris with
 * Matrix rain falling behind them, generated from scratch as an SVG. It was
 * a nice picture and it was not the logo. Somebody who knows the site by its
 * red, gold and cyan rings did not see those rings on the bot, they saw a
 * dark sci-fi disc that happened to use the same colours.
 *
 * So the source of truth is now the file the site itself displays,
 * assets/img/asturio-logo.png, the one in the AI panel header. The bot and
 * the app cannot look like different products any more, because they are
 * showing the same image.
 *
 * WHY IT IS FRAMED RATHER THAN USED AS IT IS
 *
 * The logo is a ring mark on a transparent background, and its middle is
 * transparent too. Uploaded raw, Discord would show whatever is behind it
 * through the centre, which means it looks like a different picture in the
 * light theme than in the dark one, and at the forty pixels a message list
 * gives it, an outline with no edge simply dissolves.
 *
 * The site does not show it raw either. It sits in a gold-rimmed circle on
 * the panel's dark chrome, and that is exactly what is rebuilt here, so the
 * bot's picture is the site's logo presented the way the site presents it.
 *
 * The output is one PNG, at Discord's own 512. There is no SVG any more:
 * with the mark being a raster logo rather than something drawn by code, a
 * vector version would be a wrapper around a bitmap and would only invite
 * the two to drift apart.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_LOGO = join(ROOT, 'assets', 'img', 'asturio-logo.png');
const OUT_PNG  = join(ROOT, 'assets', 'img', 'asturio-ai-512.png');

const S = 512;                 // Discord stores avatars at 512; this is its max

// The site's palette, read from the same values index.html uses, so the
// framing cannot drift away from the app it belongs to.
const INK  = '#0a0f16';        // the panel chrome the logo sits on
const GOLD = '#d4af37';        // the gold of the ring around it in the header
const CYAN = '#008CBA';        // the UI accent, as a faint outer edge

const logo = readFileSync(SRC_LOGO);
const logoUri = 'data:image/png;base64,' + logo.toString('base64');

// The framing, in the proportions the header uses: a disc of chrome, a gold
// rim, and the logo inset far enough that the rim never crowds it.
//
// 78 percent rather than filling the disc, because Discord crops to a circle
// and a mark that runs to the edge of a square loses its corners. The logo is
// wider than it is tall, so `contain` is what keeps it from being stretched.
const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; background:transparent; }
  .face {
    width:${S}px; height:${S}px; border-radius:50%;
    background:
      radial-gradient(circle at 50% 42%, #16202c 0%, ${INK} 62%, #05080c 100%);
    box-sizing:border-box;
    border:${Math.round(S * 0.022)}px solid ${GOLD};
    outline:${Math.round(S * 0.006)}px solid ${CYAN};
    outline-offset:-${Math.round(S * 0.028)}px;
    display:flex; align-items:center; justify-content:center;
    overflow:hidden;
  }
  .face img {
    width:78%; height:78%; object-fit:contain;
    /* A soft lift so the mark reads as lit rather than pasted on, using the
       app's own gold at low opacity rather than a generic drop shadow. */
    filter: drop-shadow(0 0 ${Math.round(S * 0.03)}px rgba(212,175,55,0.35));
  }
</style>
<div class="face"><img src="${logoUri}" alt="Asturio AI"></div>`;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed, so nothing was rendered. '
            + 'Run this again where playwright is available.');
  process.exit(0);
}

// Prefer the browser this environment already has over letting Playwright
// go and download one.
let exe = process.env.CHROME_PATH;
if (!exe) {
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      if (!d.startsWith('chromium-')) continue;
      const p = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(p)) { exe = p; break; }
    }
  } catch { /* fall through to Playwright's own */ }
}

mkdirSync(dirname(OUT_PNG), { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({
  viewport: { width: S, height: S }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
// The image is a data URI, so load has already decoded it, but waiting on
// the element itself means a slow decode can never produce a blank disc.
await page.waitForFunction(() => {
  const i = document.querySelector('img');
  return i && i.complete && i.naturalWidth > 0;
});
// omitBackground keeps the corners outside the disc transparent, so the
// picture is a circle rather than a circle on a black square.
await page.screenshot({ path: OUT_PNG, omitBackground: true });
await browser.close();
console.log('wrote ' + OUT_PNG.replace(ROOT + '/', '')
          + ' from ' + SRC_LOGO.replace(ROOT + '/', ''));
