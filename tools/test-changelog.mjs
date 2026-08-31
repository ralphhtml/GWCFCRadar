#!/usr/bin/env node
/*
 * The changelog that replaced the update bar.
 *
 *     node tools/test-changelog.mjs
 *
 * The contract: a returning visitor sees the "WHAT CHANGED" card once per
 * new entry and never again after dismissing it; a brand-new visitor never
 * sees it at all (their clock starts at the newest entry); and the full
 * history is always a tap away behind the Updates button in the account
 * panel. Also held here: the update bar is really gone, and so is the
 * compass circle that used to park itself on top of the logo.
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

console.log('\n1. the source keeps the shape of the feature');
{
  const ids = [...PAGE.matchAll(/\{ id: '(\d{4}-\d{2}-\d{2}-[a-z])', date: '/g)]
    .map(m => m[1]);
  ok('the changelog has entries with dated ids', ids.length >= 5,
     String(ids.length));
  ok('every id is unique (the seen-check depends on it)',
     new Set(ids).size === ids.length, ids.join(','));
  ok('the update bar is gone from markup, styles and CLAUDE.md',
     !/id="update-bar"/.test(PAGE) && !/APP_LATEST_UPDATE/.test(PAGE)
     && !/#update-bar \{/.test(PAGE)
     && !readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').includes('#update-bar'));
  ok('CLAUDE.md now teaches the changelog instead',
     /APP_CHANGELOG/.test(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')));
  ok('the Updates button sits in the account panel menu',
     /lqmCloseProfile\(\);_clOpen\(\)/.test(PAGE)
     && /<span>Updates<\/span>/.test(PAGE));
  ok('the compass circle is retired in CSS, not by deleting its JS',
     /#map-compass\.visible \{ display: none; \}/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-changelog.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });

const errsAll = [];
async function boot(initStorage) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('dialog', d => d.dismiss().catch(() => {}));
  p.on('pageerror', e => errsAll.push(String(e).slice(0, 180)));
  if (initStorage) {
    await p.addInitScript(seed => {
      for (const [k, v] of Object.entries(seed)) {
        try { localStorage.setItem(k, v); } catch (e) {}
      }
    }, initStorage);
  }
  await p.route('**://**', route => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('leaflet') && url.endsWith('.js'))
      return route.fulfill({ contentType: 'application/javascript',
        body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
    if (url.includes('leaflet') && url.endsWith('.css'))
      return route.fulfill({ contentType: 'text/css',
        body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
    return route.abort();
  });
  await p.goto('file://' + join(ROOT, 'index.html'),
               { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4200);
  return p;
}

console.log('\n2. a returning visitor is told what changed, exactly once');
{
  // Been here before (tutorial seen, mode chosen), but never saw any
  // changelog entry: the card should open on its own.
  const p = await boot({ gwcfc_tutorial_seen: '1', gwcfc_mode: 'expert' });
  // The card waits for the loading screen to finish its exit plus a beat
  // for the welcome flight, so it lands around the five-second mark: wait
  // for it rather than sampling a fixed instant.
  await p.waitForSelector('#changelog-modal.open', { timeout: 9000 })
    .catch(() => {});
  const r = await p.evaluate(() => {
    const m = document.querySelector('#changelog-modal.open');
    return {
      open: !!m,
      head: m ? m.querySelector('.mode-head').textContent : '',
      entries: m ? m.querySelectorAll('.cl-entry').length : 0,
      newBadge: m ? !!m.querySelector('.cl-entry .cl-new') : false,
      listScrolls: m
        ? getComputedStyle(m.querySelector('.cl-list')).overflowY === 'auto'
        : false,
    };
  });
  ok('the card opens on its own', r.open);
  ok('under the WHAT CHANGED head', /WHAT CHANGED/.test(r.head), r.head);
  ok('with the full history listed', r.entries >= 5, String(r.entries));
  ok('and a NEW badge on the unseen newest entry', r.newBadge);
  ok('the list scrolls instead of stretching the card', r.listScrolls);

  const after = await p.evaluate(() => {
    _clClose();
    const seen = localStorage.getItem('gwcfc_changelog_seen');
    _clMaybeOpen();
    return {
      seen,
      newestId: APP_CHANGELOG[0].id,
      reopened: !!document.querySelector('#changelog-modal.open'),
    };
  });
  ok('dismissing it marks the newest entry seen',
     after.seen === after.newestId, `${after.seen} vs ${after.newestId}`);
  ok('so it will not open itself again', !after.reopened);
  await p.close();
}

console.log('\n3. a brand-new visitor is never greeted with history');
{
  const p = await boot(null);
  const r = await p.evaluate(() => ({
    changelog: !!document.querySelector('#changelog-modal.open'),
    picker: !!document.querySelector('#mode-modal.open'),
  }));
  ok('the first visit shows the mode question, not the changelog',
     r.picker && !r.changelog, JSON.stringify(r));
  // Answering the question is what starts their clock: the newest id is
  // recorded as seen, so their next visit is quiet too.
  const r2 = await p.evaluate(() => {
    _modePick('expert');
    return { seen: localStorage.getItem('gwcfc_changelog_seen'),
             newest: APP_CHANGELOG[0].id };
  });
  ok('choosing a mode marks the changelog seen', r2.seen === r2.newest,
     `${r2.seen} vs ${r2.newest}`);
  await p.close();
}

console.log('\n4. the history stays reachable, and the black bubble is gone');
{
  const p = await boot({ gwcfc_tutorial_seen: '1', gwcfc_mode: 'expert',
                         gwcfc_changelog_seen: 'up-to-date-sentinel' });
  const r = await p.evaluate(() => {
    // Their seen id is stale but fake: the auto-open already ran at boot.
    // What matters here is the manual path: the account panel's Updates
    // button must open the same card on demand.
    _clClose();
    document.getElementById('lqm-profile-btn').click();
    const btns = [...document.querySelectorAll('#lqm-panel-menu .lqm-pm-btn')];
    const upd = btns.find(b => b.textContent.trim() === 'Updates');
    if (upd) upd.click();
    const m = document.querySelector('#changelog-modal.open');
    const out = {
      hasUpdates: !!upd,
      opens: !!m,
      entries: m ? m.querySelectorAll('.cl-entry').length : 0,
    };
    // And the compass: force the rotated state and make sure nothing paints
    // where the logo lives.
    const c = document.getElementById('map-compass');
    if (c) c.classList.add('visible');
    out.compassHidden = !c || getComputedStyle(c).display === 'none';
    return out;
  });
  ok('the panel menu has an Updates button', r.hasUpdates);
  ok('and it opens the changelog on demand', r.opens);
  ok('with the whole history', r.entries >= 5, String(r.entries));
  ok('the compass circle stays hidden even when the map is rotated',
     r.compassHidden);
  ok('and nothing threw across all three boots', errsAll.length === 0,
     errsAll.slice(0, 3).join(' | '));
  await p.close();
}

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
