#!/usr/bin/env node
/*
 * Three additions: starring, the export tool's move to Settings, and the
 * full screen button.
 *
 *     node tools/test-star-export-fs.mjs
 *
 * THE EXPORT TOOL WAS NOT BROKEN, IT WAS BLIND. _expActiveSource knew about
 * exactly three layers, and model charts were not one of them, so with a
 * model on screen and nothing else it reported "Nothing on screen to export
 * yet" over a full map. That reads as broken and is the thing worth testing.
 *
 * A STAR HOLDS ENOUGH TO REDO THE THING, not a reference to it. A location
 * keeps its coordinates and a feature keeps its name, because a saved action
 * function does not survive a reload, which is the one moment a saved thing
 * has to work.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x ? '  <' + x + '>' : '')); } };

console.log('\n1. the star button and what it saves');
{
  ok('the button sits opposite the search button',
     /<button id="lqm-search-star"[\s\S]{0,400}<input id="lqm-search-input"/.test(PAGE));
  ok('starred items have their own saved key',
     /const STAR_KEY = 'gwcfc_stars';/.test(PAGE));
  ok('a corrupt list does not cost the page its search box',
     /a corrupt list must not cost the page its search box/.test(PAGE));
  ok('the list is capped', /const STAR_MAX = 40;/.test(PAGE));
  // A saved action function is gone after a reload.
  ok('a location star keeps coordinates, not a function',
     /kind: 'location', label: label,\s*\n\s*lat: loc\.latitude, lng: loc\.longitude/.test(PAGE));
  ok('a feature star is redone by looking its name up in the live catalogue',
     /\.find\(c => c\.label === item\.label\)/.test(PAGE));
  ok('and says so plainly when the feature is gone',
     /That feature is not available any more\./.test(PAGE));
  // Starring a place must not also fly there.
  ok('clicking a star does not fire the row it sits in',
     /function _starRowClick\(ev, encoded\) \{\s*\n\s*ev\.stopPropagation\(\);/.test(PAGE));
  // The result list is rebuilt on every keystroke.
  ok('the item travels with the glyph rather than as an index into a list',
     /encodeURIComponent\(JSON\.stringify\(item\)\)/.test(PAGE));
  ok('stars appear on feature rows and on location rows',
     /const star = _starGlyph\(\{ kind: 'feature'/.test(PAGE)
     && /_starGlyph\(\{ kind: 'location'/.test(PAGE));
  ok('and above recents in the default list, since they were chosen',
     /Stars first: they were chosen, recents merely happened\./.test(PAGE));
  ok('one renderer feeds both lists, so they cannot disagree',
     (PAGE.match(/function _starRenderInto\(dd\)/g) || []).length === 1
     && (PAGE.match(/_starRenderInto\(dd\)/g) || []).length === 3);
}

console.log('\n2. export: moved, and no longer blind to model charts');
{
  ok('it is gone from the tool rail', !/id="tool-export"/.test(PAGE));
  ok('and reachable from Settings',
     /Export Picture or Loop[\s\S]{0,200}_expToggle\(\)/.test(PAGE));
  // The gap that made it look broken.
  ok('model charts are an export source now',
     /return \{ kind: 'model', count: Math\.max\(1, hrs\)/.test(PAGE));
  ok('and there is a frame fetcher for them',
     /if \(src\.kind === 'model'\) \{/.test(PAGE));
  ok('the forecast hour is stepped so a loop is a loop, not one hour repeated',
     /_hdHourIdx = idx;\s*\n\s*try \{ await _hdShow\(\); \}/.test(PAGE));
  ok('the frame count comes from the real hour list',
     /_hdHoursFor\(_hdField\) \|\| \[\]\)\.length/.test(PAGE));
  // One line's worth: the sentence wraps across comment lines.
  ok('why it looked broken is written down',
     /panel said "Nothing on screen to export yet" over a full map/.test(PAGE));
}

console.log('\n3. full screen');
{
  ok('the button is between the timestamp and forward-one-frame',
     /id="anim-time-display"[\s\S]{0,400}id="fullscreen-btn"[\s\S]{0,400}id="step-fwd-btn"/.test(PAGE));
  // Safari only has the webkit spelling, and this runs on iPads.
  ok('both spellings of the API are handled',
     /document\.webkitFullscreenElement/.test(PAGE)
     && /el\.webkitRequestFullscreen/.test(PAGE)
     && /document\.webkitExitFullscreen/.test(PAGE));
  // A refused request is a rejected promise, which surfaces as a page error.
  ok('a refused request is caught rather than left to reject',
     /if \(r && r\.catch\) r\.catch\(\(\) => \{\}\);/.test(PAGE));
  // Escape never goes through the button.
  ok('the button reads the real state rather than counting its own clicks',
     /function _fsSync\(\)[\s\S]{0,200}const on = !!_fsElement\(\);/.test(PAGE));
  ok('and it listens for both change events',
     /addEventListener\('fullscreenchange', _fsSync\)/.test(PAGE)
     && /addEventListener\('webkitfullscreenchange', _fsSync\)/.test(PAGE));
}

console.log('\n4. in a real browser');
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
    const shown = el => !!el && el.getClientRects().length > 0;
    lqmOpenSearch();
    out.starVisible = shown(document.getElementById('lqm-search-star'));
    // Star a place, and check it comes back through the list.
    _stars = [];
    _starToggle({ kind: 'location', label: 'Norman, OK', lat: 35.2, lng: -97.4 });
    out.saved = JSON.parse(localStorage.getItem('gwcfc_stars') || '[]');
    out.btnLit = document.getElementById('lqm-search-star').classList.contains('has');
    _starShowList();
    const rows = document.querySelectorAll('#lqm-search-dropdown .srch-item');
    out.listed = Array.from(rows).map(x => x.querySelector('.si-label').textContent);
    // Starring twice removes it, so the star is a toggle and not a pile.
    _starToggle({ kind: 'location', label: 'Norman, OK', lat: 35.2, lng: -97.4 });
    out.afterUnstar = _stars.length;
    // A label with markup in it must arrive as text, since place names come
    // from a third-party geocoder.
    _stars = [{ kind: 'location', label: '<img src=x onerror=alert(1)>', lat: 1, lng: 2 }];
    _starShowList();
    const first = document.querySelector('#lqm-search-dropdown .srch-item .si-label');
    out.escaped = first.innerHTML.indexOf('<img') === -1
               && first.textContent.indexOf('<img') === 0;
    _stars = []; _starSave();

    out.fsBtn = shown(document.getElementById('fullscreen-btn'));
    out.fsFn = typeof _fsToggle === 'function';
    out.railExport = !!document.getElementById('tool-export');
    out.expFn = typeof _expToggle === 'function';
    // With nothing on screen it should say so rather than throw.
    out.srcNone = _expActiveSource();
    return out;
  });
  await b.close();
  ok('the star button is on screen', r.starVisible);
  ok('starring saves it', r.saved.length === 1 && r.saved[0].label === 'Norman, OK',
     JSON.stringify(r.saved));
  ok('and lights the button', r.btnLit);
  ok('the list shows it back', r.listed.includes('Norman, OK'), r.listed.join(' | '));
  ok('starring the same thing twice removes it', r.afterUnstar === 0,
     String(r.afterUnstar));
  ok('a place name with markup in it is text, not markup', r.escaped);
  ok('the full screen button is on the animbar', r.fsBtn);
  ok('and its toggle exists', r.fsFn);
  ok('export is off the tool rail', r.railExport === false);
  ok('but still callable from Settings', r.expFn);
  ok('with nothing up, the source is null rather than a crash',
     r.srcNone === null, JSON.stringify(r.srcNone));
  ok('no uncaught page errors', errs.length === 0, errs.join(' | '));
}

console.log('\n5. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-star-export-fs.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
