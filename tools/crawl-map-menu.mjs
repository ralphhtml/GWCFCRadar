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
const SETTLE_MS = 700;          // how long a tap gets to open a new row
// A row this long is a list of things (stations, runs, members), not a menu
// of layers: its entries are listed but not each walked into.
const LIST_ROW = 40;

const { chromium } = await import('playwright');
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];

async function freshPage() {
  // ignoreHTTPSErrors: behind a proxy that re-signs connections, the rows the
// page fills from the network would otherwise come up empty.
  const p = await (await b.newContext({ viewport: { width: 1280, height: 860 }, ignoreHTTPSErrors: true })).newPage();
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
  await ready(p);
  return p;
}
// Every path is tapped from a freshly loaded page, the way a ?menu= link
// always is: tapped with an earlier pick still on, a row can toggle that
// pick off instead of opening (a sea temperature source does exactly that).
async function fresh(p) {
  await p.reload({ waitUntil: 'domcontentloaded' });
  await ready(p);
}
async function ready(p) {
  await p.waitForFunction(() => typeof _menuPlay === 'function' && document.querySelector('#sub-bubbles .sub-bubble'), null, { timeout: 30000 });
  // A few rows are only shown after the parsing server answers (a sea
  // temperature source's fields). This walks the menu, not the data, so
  // the loading step is stood in for and the next row appears regardless.
  await p.evaluate(() => {
    if (typeof _sstEnable === 'function') {
      window._sstEnable = async (src, v) => { _sstSource = src; _sstVariant = v; _sstOn = true; };
    }
  });
  // The page's own start-up redraws the main menu once or twice as things
  // finish loading, and with the network on that can land seconds in, in
  // the middle of a tap sequence. Wait until the menu has been left alone
  // for a while before tapping anything.
  await p.evaluate(() => new Promise(done => {
    const wrap = document.getElementById('sub-bubbles');
    let last = Date.now();
    const mo = new MutationObserver(() => { last = Date.now(); });
    mo.observe(wrap, { childList: true });
    const t0 = Date.now();
    const tick = () => {
      if (Date.now() - last > 2500 || Date.now() - t0 > 15000) { mo.disconnect(); done(); }
      else setTimeout(tick, 200);
    };
    tick();
  }));
}

// The labels of the row on screen now, and whether it is a sub-row.
// Not layers: a notice ("No parsing server radar yet", "Reading the parsing
// server..."), or the Time Machine button, which opens the time panel.
// (Kept as a string for the page, where the test runs.)
const SKIP_SRC = String.raw`^(No\b.*\byet|Reading\b.*|Time Machine)$`;
// Entries that are a notice rather than something to tap
// ("No parsing server radar yet") are left out.
const row = p => p.evaluate(src => { const SKIP = new RegExp(src, 'i'); return ({
  labels: _menuRowItems().map(x => x.label).filter(l => !SKIP.test(l)),
  sub: !!document.querySelector('#sub-bubbles .sb-back'),
}); }, SKIP_SRC);
const sig = r => r.labels.join('\u0001');

const leaves = [];
// Tap to a row and wait for it to be the one on screen: some rows are built
// only after something loads, and reading too soon reads the parent's row.
async function reach(p, path, notSig) {
  await fresh(p);
  await p.evaluate(path => _menuPlay(path), path);
  let here = await row(p), prev = null;
  const t0 = Date.now();
  // Until it is not the parent's row, and has stopped changing.
  while ((sig(here) === notSig || !here.labels.length || sig(here) !== prev) && Date.now() - t0 < 4000) {
    prev = sig(here);
    await p.waitForTimeout(200);
    here = await row(p);
  }
  return here;
}
async function walk(p, path, depth, seen, parentSig) {
  const here = await reach(p, path, parentSig);
  if (!here.labels.length) return;
  const mySig = sig(here);
  console.log(`  ${path.join(' > ')}  (${here.labels.length})`);
  if (here.labels.length > LIST_ROW) {
    for (const label of here.labels) leaves.push([...path, label]);
    return;
  }
  for (const label of here.labels) {
    const next = [...path, label];
    await fresh(p);
    const r = await p.evaluate(path => _menuPlay(path), next);
    if (!r.ok) continue;
    // Give the tap time to open a row (some wait on something loading).
    let after = await row(p);
    const t0 = Date.now();
    while (sig(after) === mySig && Date.now() - t0 < SETTLE_MS) {
      await p.waitForTimeout(100);
      after = await row(p);
    }
    // A row that still lists what was tapped is this same menu redrawn (a
    // pick lit up, an entry added), not a new one.
    // And a row holding the main bubbles is the menu falling back to its
    // top (a row that could not load), never a sub-menu.
    const opened = after.sub && after.labels.length && sig(after) !== mySig
      && !after.labels.includes(label) && !seen.has(sig(after))
      && after.labels.filter(l => TOPS.has(l)).length < 2;
    if (opened && depth < MAX_DEPTH) {
      await walk(p, next, depth + 1, new Set([...seen, mySig]), mySig);
    } else if (!opened) {
      leaves.push(next);
    }
  }
}

const home = await freshPage();
const tops = (await row(home)).labels;
const TOPS = new Set(tops);
await home.context().close();
// CRAWL_ONLY=Wind,Waves walks just those, for checking one menu.
const only = (process.env.CRAWL_ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
for (const top of tops.filter(t => !only.length || only.includes(t))) {
  console.log(`\n${top}`);
  const p = await freshPage();
  try { await walk(p, [top], 1, new Set(), sig(await row(p))); }
  catch (e) { console.warn(`\n  ${top}: ${String(e).slice(0, 160)}`); }
  await p.context().close();
  save();
}
await b.close();

save();
// One path per leaf, in menu order, no repeats. Saved after each main
// bubble too, so a long walk keeps what it has found so far.
function save() {
  const seenPath = new Set();
  const paths = leaves.map(l => l.join(' > ')).filter(x => !seenPath.has(x) && seenPath.add(x));
  writeFileSync(OUT, JSON.stringify({ generated: 'tools/crawl-map-menu.mjs', count: paths.length, layers: paths }, null, 1) + '\n');
  console.log(`${paths.length} layer paths -> ${OUT}`);
}
