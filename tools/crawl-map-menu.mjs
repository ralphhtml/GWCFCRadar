#!/usr/bin/env node
/*
 * Walk the site's left menu the way a person would and write down every
 * path through it, for the Discord bot's /map layer option.
 *
 *     node tools/crawl-map-menu.mjs            # writes services/bot/map-menu.json
 *
 * Every layer's menu is built by its own hand-written code on the page
 * (Waves opens a row, SST opens a row of sources, a source opens a row of
 * fields...), so no list in the page says what the whole tree is. This
 * opens the page, taps each bubble through the page's own _menuPlay (the
 * same code a ?menu= link uses to replay a path), and treats a tap that
 * opens a new row as a branch and one that does not as a pick. The paths
 * it finds are exactly the ones a ?menu= link can follow.
 *
 * Rows the page only fills from the network (a live list of stations, say)
 * are walked with whatever the network gives at the time; run it with the
 * network on for the full tree.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'services/bot/map-menu.json');
const MAX_DEPTH = 7;
const SETTLE_MS = 900;          // how long a tap gets to open a new row

const { chromium } = await import('playwright');
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];

async function freshPage() {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
  if (process.env.LEAFLET_DIST) {
    await p.route('**/leaflet*', route => {
      const u = route.request().url();
      if (u.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(process.env.LEAFLET_DIST, 'leaflet.js'), 'utf8') });
      if (u.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: readFileSync(join(process.env.LEAFLET_DIST, 'leaflet.css'), 'utf8') });
      return route.continue();
    });
  }
  // Pictures are not needed to learn the menu, only to draw the map.
  await p.route(/\.(png|jpe?g|webp|gif)(\?|$)/i, r => r.abort());
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof _menuPlay === 'function' && document.querySelector('#sub-bubbles .sub-bubble'), null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  return p;
}

// The labels of the row on screen now, and whether it is a sub-row.
const row = p => p.evaluate(() => ({
  labels: _menuRowItems().map(x => x.label),
  sub: !!document.querySelector('#sub-bubbles .sb-back'),
}));
const sig = r => r.labels.join('\u0001');

const leaves = [];
async function walk(p, path, depth, seen) {
  await p.evaluate(path => _menuPlay(path), path);
  await p.waitForTimeout(150);
  const here = await row(p);
  if (!here.labels.length) return;
  const mySig = sig(here);
  for (const label of here.labels) {
    const next = [...path, label];
    const r = await p.evaluate(path => _menuPlay(path), next);
    if (!r.ok) continue;
    // Give the tap time to open a row (some wait on something loading).
    let after = await row(p);
    const t0 = Date.now();
    while (sig(after) === mySig && Date.now() - t0 < SETTLE_MS) {
      await p.waitForTimeout(100);
      after = await row(p);
    }
    const opened = after.sub && after.labels.length && sig(after) !== mySig && !seen.has(sig(after));
    if (opened && depth < MAX_DEPTH) {
      await walk(p, next, depth + 1, new Set([...seen, mySig]));
    } else if (!opened) {
      leaves.push(next);
      process.stdout.write('.');
    }
    // Back to this row for the next label.
    await p.evaluate(path => _menuPlay(path), path);
    await p.waitForTimeout(80);
  }
}

const home = await freshPage();
const tops = (await row(home)).labels;
await home.context().close();
for (const top of tops) {
  process.stdout.write(`\n${top} `);
  const p = await freshPage();
  try { await walk(p, [top], 1, new Set()); }
  catch (e) { console.warn(`\n  ${top}: ${String(e).slice(0, 160)}`); }
  await p.context().close();
}
await b.close();

// One path per leaf, in menu order, no repeats.
const seenPath = new Set();
const paths = leaves.map(l => l.join(' > ')).filter(x => !seenPath.has(x) && seenPath.add(x));
writeFileSync(OUT, JSON.stringify({ generated: 'tools/crawl-map-menu.mjs', count: paths.length, layers: paths }, null, 1) + '\n');
console.log(`\n\n${paths.length} layer paths -> ${OUT}`);
