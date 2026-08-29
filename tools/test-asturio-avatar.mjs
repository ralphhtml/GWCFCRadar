#!/usr/bin/env node
/*
 * The Asturio bot's picture, and the fact that it is the radar's own logo.
 *
 *     node tools/test-asturio-avatar.mjs
 *
 * The bot used to wear a stylised mark: the app's colours drawn as a lit iris
 * with Matrix rain behind it. It looked good and it was not the logo, so
 * somebody who knows this site by its red, gold and cyan rings did not
 * recognise the bot as belonging to it. The avatar is now built from
 * assets/img/asturio-logo.png, the exact file the AI panel header displays.
 *
 * Three things are worth checking rather than eyeballing.
 *
 * IT IS REALLY THE SITE'S LOGO. Not a redraw, not an approximation: the
 * generator reads the same file the page does, and the page really does
 * display that file. Either half drifting is the failure this catches, and a
 * string search for a colour would not catch it because a lookalike would
 * use the same colours.
 *
 * THE PIXELS ARE RIGHT. Discord crops avatars to a circle and shows them at
 * about forty pixels in a message list. So the corners have to be
 * transparent, the rim has to be there to give it an edge on a light theme,
 * and the middle has to be the logo rather than an empty disc. These are
 * read out of the rendered PNG rather than inferred from the source that
 * made it.
 *
 * THE GENERATOR IS DETERMINISTIC. A generator whose output moves on every run
 * cannot live in a repository: every rebuild shows as a diff and nobody can
 * tell a real change from noise.
 *
 * The upload path is checked for the thing that actually goes wrong with it:
 * Discord rate limits avatar changes hard, so a bot that re-uploads on every
 * restart gets refused and then cannot change it when it matters.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGO = join(ROOT, 'assets', 'img', 'asturio-logo.png');
const PNG  = join(ROOT, 'assets', 'img', 'asturio-ai-512.png');
const GEN  = join(ROOT, 'tools', 'make-asturio-avatar.mjs');
const BOT  = join(ROOT, 'services', 'bot', 'asturio-bot.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

// Decoding a PNG without a dependency: hand it to the browser that is already
// here for rendering, and read the pixels back off a canvas.
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* checked below */ }

console.log('\n1. the picture exists and is the shape Discord takes');
{
  ok('the source logo is in the repo', existsSync(LOGO));
  ok('and the avatar built from it', existsSync(PNG));
  const png = readFileSync(PNG);
  ok('the avatar is really a PNG',
     png[0] === 0x89 && png.toString('latin1', 1, 4) === 'PNG');
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  ok(`it is square, ${w} by ${h}`, w === h, w + 'x' + h);
  ok('at 512, which is the size Discord stores', w === 512, String(w));
  ok('and small enough to upload',
     png.length < 2 * 1024 * 1024, (png.length / 1024).toFixed(0) + ' KB');
  // Colour type 6 is RGBA. Without an alpha channel the corners could not be
  // transparent and Discord's circular crop would show a square behind it.
  ok('with an alpha channel, so it can be a circle', png[25] === 6, String(png[25]));
}

console.log('\n2. it is built from the SITE\'S logo, not a lookalike');
{
  const gen = readFileSync(GEN, 'utf8');
  const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('the generator reads the logo file rather than drawing its own mark',
     /asturio-logo\.png/.test(gen), '');
  // The other half, and the one that would actually rot: the page has to
  // still be displaying that same file. If the site changes which image it
  // shows, this fails and the avatar gets rebuilt from the new one.
  ok('and the page displays that same file',
     /assets\/img\/asturio-logo\.png/.test(page), '');
  // Checked as "emits no drawing primitives" rather than "never says the
  // word Matrix", because the header explains what it used to do and that
  // explanation is worth keeping. Prose mentioning the old mark is fine; a
  // glyph table or an SVG path builder still in here would not be.
  ok('nothing is drawn by hand any more, so the two cannot disagree',
     !/<text |<polygon |<circle |[゠-ヿ]/.test(gen), '');
  // The stylised mark's SVG was the source of the old picture. With the
  // avatar now made from a raster logo, a vector copy would only be a second
  // version to drift.
  ok('the retired stylised SVG is gone rather than left to rot',
     !existsSync(join(ROOT, 'assets', 'img', 'asturio-ai.svg')), '');
}

console.log('\n3. the pixels, read off the rendered file');
if (!chromium) {
  console.log('  playwright is not installed, skipping the pixel checks');
} else {
  const png = readFileSync(PNG).toString('base64');
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await browser.newPage();
  const px = await p.evaluate(async (b64) => {
    const img = new Image();
    await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,' + b64; });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const at = (x, y) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    };
    // Brightest and most saturated pixel in the middle third, which is where
    // the logo's rings are, so "the rings are there" can be a measurement.
    const mid = ctx.getImageData(img.width / 3, img.height / 3,
                                 img.width / 3, img.height / 3).data;
    let maxSat = 0, sample = null, opaque = 0;
    for (let i = 0; i < mid.length; i += 4) {
      if (mid[i + 3] > 200) opaque++;
      const mx = Math.max(mid[i], mid[i + 1], mid[i + 2]);
      const mn = Math.min(mid[i], mid[i + 1], mid[i + 2]);
      const sat = mx - mn;
      if (sat > maxSat) { maxSat = sat; sample = [mid[i], mid[i + 1], mid[i + 2]]; }
    }
    return {
      size: img.width,
      corner: at(3, 3),
      cornerTR: at(img.width - 4, 3),
      rim: at(img.width / 2 | 0, 6),          // top of the disc, on the rim
      centre: at(img.width / 2 | 0, img.height / 2 | 0),
      maxSat, sample, opaqueMiddlePct: Math.round(opaque / (mid.length / 4) * 100),
    };
  }, png);
  await browser.close();

  ok('the corners are transparent, so Discord\'s circle crop is clean',
     px.corner.a < 12 && px.cornerTR.a < 12,
     `${px.corner.a} / ${px.cornerTR.a}`);
  ok('there is a rim, so the picture has an edge on a light theme',
     px.rim.a > 200, String(px.rim.a));
  // The site frames it in gold. Checked as "warm and bright" rather than an
  // exact triple, because the render is antialiased and an exact match would
  // fail on a one-value shift that nobody could see.
  ok('and that rim is the site\'s gold, not a grey outline',
     px.rim.r > 150 && px.rim.g > 110 && px.rim.b < 120,
     `rgb(${px.rim.r},${px.rim.g},${px.rim.b})`);
  ok('the disc is filled, not a hollow ring',
     px.opaqueMiddlePct > 90, px.opaqueMiddlePct + '%');
  // The logo's rings are strongly coloured. A blank dark disc, which is what
  // a failed image load would produce, has almost no saturation at all.
  ok('the logo is actually drawn on it, not a blank disc',
     px.maxSat > 60, `max saturation ${px.maxSat}, sample ${px.sample}`);
  ok('the middle is the app\'s chrome showing through the ring gaps',
     px.centre.a > 200, String(px.centre.a));
}

console.log('\n4. the generator is deterministic');
{
  const before = readFileSync(PNG);
  execFileSync(process.execPath, [GEN], { cwd: ROOT, stdio: 'pipe' });
  const after = readFileSync(PNG);
  ok('running it again produces the same PNG, byte for byte',
     Buffer.compare(before, after) === 0,
     before.length + ' vs ' + after.length);
  ok('and nothing in it reaches for Math.random',
     !/Math\.random/.test(readFileSync(GEN, 'utf8')));
  ok('nor for the clock', !/Date\.now|new Date\(/.test(readFileSync(GEN, 'utf8')));
}

console.log('\n5. the bot wears it, and only uploads when it changes');
{
  const bot = readFileSync(BOT, 'utf8');
  ok('the bot points at the PNG', /asturio-ai-512\.png/.test(bot));
  ok('and sets it on ready', /applyAvatar\(c\.user\)/.test(bot)
     && /setAvatar\(png\)/.test(bot));
  // The failure this guards against: Discord limits avatar changes to a
  // couple an hour, so re-uploading on every restart burns the allowance and
  // then the picture cannot be changed when it needs to be.
  ok('it records what it last sent', /AVATAR_STAMP/.test(bot)
     && /writeFileSync\(AVATAR_STAMP/.test(bot));
  ok('and skips the upload when that has not changed',
     /if \(had === stamp\) return;/.test(bot));
  ok('the stamp is the picture, not the date',
     /createHash\('sha256'\)\.update\(png\)/.test(bot));
  // The point of the hash: replacing the art is what has to trigger a
  // re-upload, and this change replaces the art, so an old stamp must not
  // stop the new picture going up.
  ok('so changing the art is what makes it upload again',
     /replacing\s+\*?\n?\s*\/\/ the art is what triggers a re-upload/.test(bot)
     || /the art is what triggers a re-upload/.test(bot), '');
  ok('a failure to set it is not a failure to run',
     /Avatar not changed this time/.test(bot));
  ok('and a missing picture is not either', /no picture to set/.test(bot));
}

console.log('\n6. the stamp is local state, not source');
{
  const ig = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  ok('the avatar stamp is ignored', /services\/bot\/\.avatar-stamp/.test(ig));
  ok('and no stray gitignore was left in the bot folder',
     !existsSync(join(ROOT, 'services', 'bot', '.gitignore')));
}

console.log('\n7. house rules');
{
  const files = [GEN, BOT, join(ROOT, 'tools', 'test-asturio-avatar.mjs'),
                 join(ROOT, 'services', 'bot', 'README.md')];
  // Built by code point rather than typed. A test that searches for a
  // forbidden character by writing it out contains the character it forbids,
  // and then the repo-wide sweep flags the very file doing the sweeping.
  const EM = String.fromCharCode(0x2014);
  const dashes = files.filter(f => readFileSync(f, 'utf8').includes(EM));
  ok('no em dashes anywhere in the new work, this file included',
     dashes.length === 0, dashes.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
