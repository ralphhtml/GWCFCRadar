#!/usr/bin/env node
/*
 * The satellite is opt-in, and its time machine is its own.
 *
 *     node tools/test-sat-opt-in.mjs
 *
 * Two behaviours, both changed on request and both the kind that silently
 * regress, so they are pinned against the running page.
 *
 * ONE: tapping the Satellite bubble used to switch the ABI layer on before
 * anything was chosen, so browsing the menu meant already wearing a layer.
 * Now the bubble only opens the menu; the first product picked is the on
 * switch, and tapping the product that is already showing is the off switch,
 * the same bargain every radar pill keeps.
 *
 * TWO: the time machine was one clock driving radar and satellite together,
 * so travelling one dragged the other into the past uninvited. Now each row
 * opens the machine for its own layer, each layer keeps its own moment, and
 * each travelled layer wears its own named PAST badge.
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

console.log('\n1. the source keeps the two promises');
{
  const bubble = (PAGE.match(/\{ id: 'satellite',[^\n]*\},/) || [''])[0];
  ok('the Satellite bubble only opens the menu',
     /toggleSatelliteSub\(\)/.test(bubble) && !/loadGoesLayer/.test(bubble)
     && !/activeLayers\.satellite = true/.test(bubble), bubble.slice(0, 120));
  ok('picking a product is the on switch',
     /function _setGoesProduct[\s\S]{0,1600}activeLayers\.satellite = true;[\s\S]{0,300}loadGoesLayer\(\)/.test(PAGE));
  ok('tapping the showing product is the off switch',
     /_goesProductId === p\.id\) \{\s*\n\s*_disableSatellite\(\);/.test(PAGE));
  ok('the two clocks are separate variables',
     /let _tmAt = null;/.test(PAGE) && /let _tmSatAt = null;/.test(PAGE));
  ok('each row opens the machine for its own layer',
     /_tmOpen\('radar'\)/.test(PAGE) && /_tmOpen\('sat'\)/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-sat-opt-in.mjs'), 'utf8').includes(EM));
}

console.log('\n2. in a real browser');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('  playwright is not installed, skipping');
} else {
  const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.on('dialog', d => d.dismiss().catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
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
  await p.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

  const r = await p.evaluate(async () => {
    const out = {};
    const tick = ms => new Promise(res => setTimeout(res, ms));

    // ONE: the bubble opens the menu and turns nothing on.
    renderSubBubbles('regular');
    document.getElementById('sub-satellite').click();
    await tick(80);
    out.menuOpened = document.getElementById('sub-bubbles').dataset.mode === 'satellite';
    out.stillOffAfterBubble = activeLayers.satellite === false
      && goesFrames.length === 0;

    // Picking a product turns the layer on, frames and all.
    _setGoesProduct('ch13');
    await tick(120);
    out.onAfterPick = activeLayers.satellite === true;
    out.framesAfterPick = goesFrames.length > 0;

    // Tapping the same product again turns it off.
    const prod = GOES_PRODUCTS.find(x => x.id === _goesProductId);
    const pill = _goesProductBubble(prod);
    document.body.appendChild(pill);
    pill.click();
    await tick(80);
    out.offAfterSecondTap = activeLayers.satellite === false;
    pill.remove();

    // TWO: the machines are independent. Radar first, with the archive
    // fetch stubbed so no network is needed to prove the plumbing.
    _setGoesProduct('ch13');           // satellite back on
    await tick(80);
    const shows = [];
    _l3BucketShow = async (site, at) => { shows.push([site, at]); };
    _prBucketSite = 'KTLX';
    const radarMoment = Date.UTC(2024, 4, 17, 12, 0);
    _tmOpen('radar');
    out.radarTitle = document.querySelector('#tm-modal .tm-title').textContent;
    await _tmJump(radarMoment);
    out.radarJumped = _tmAt === radarMoment;
    out.radarShowCalled = shows.length === 1 && shows[0][1] === radarMoment;
    out.satUnmoved = _tmSatAt === null;
    // The satellite's frame list stays anchored at NOW, not at 2024.
    const liveLast = goesFrames[goesFrames.length - 1].time.getTime();
    out.satFramesStillLive = Date.now() - liveLast < 45 * 60e3;

    // Now travel the satellite, and only the satellite.
    const satMoment = Date.UTC(2023, 4, 20, 21, 30);
    _tmOpen('sat');
    out.satTitle = document.querySelector('#tm-modal .tm-title').textContent;
    await _tmJump(satMoment);
    await tick(120);
    out.satJumped = _tmSatAt === satMoment;
    out.radarUnmoved = _tmAt === radarMoment;
    out.noExtraRadarShow = shows.length === 1;
    const pastLast = goesFrames[goesFrames.length - 1].time.getTime();
    out.satFramesAtMoment = pastLast <= satMoment
      && satMoment - pastLast <= 30 * 60e3;

    // Both badges up, each naming its layer, stacked rather than overlapped.
    const rb = document.getElementById('tm-badge');
    const sb = document.getElementById('tm-badge-sat');
    out.badges = {
      radar: rb ? rb.textContent : '',
      sat: sb ? sb.textContent : '',
      stacked: rb && sb
        && rb.getBoundingClientRect().top !== sb.getBoundingClientRect().top,
    };

    // The satellite badge sends only the satellite back to live.
    sb.click();
    await tick(120);
    out.satBackLive = _tmSatAt === null && _tmAt === radarMoment;
    out.satBadgeGone = !document.getElementById('tm-badge-sat');
    out.radarBadgeStays = !!document.getElementById('tm-badge');

    // Turning the satellite off clears its clock entirely.
    _tmOpen('sat');
    await _tmJump(satMoment);
    _disableSatellite();
    out.clockClearedOnDisable = _tmSatAt === null
      && !document.getElementById('tm-badge-sat');

    // Tidy up.
    _tmScope = 'radar'; _tmAt = null; _tmSyncBadge(); _prBucketSite = null;
    return out;
  });
  await b.close();

  ok('the Satellite bubble opens the menu', r.menuOpened);
  ok('and turns nothing on by itself', r.stillOffAfterBubble);
  ok('picking a product turns the layer on', r.onAfterPick);
  ok('with a real frame list', r.framesAfterPick);
  ok('tapping the showing product turns it off', r.offAfterSecondTap);

  ok('the radar machine names itself', /RADAR/.test(r.radarTitle), r.radarTitle);
  ok('travelling the radar moves the radar', r.radarJumped && r.radarShowCalled);
  ok('and leaves the satellite clock alone', r.satUnmoved);
  ok('the satellite frames stay live while only the radar travelled',
     r.satFramesStillLive);
  ok('the satellite machine names itself', /SATELLITE/.test(r.satTitle), r.satTitle);
  ok('travelling the satellite moves the satellite', r.satJumped);
  ok('and leaves the radar clock alone', r.radarUnmoved && r.noExtraRadarShow);
  ok('the satellite frames anchor at its own moment', r.satFramesAtMoment);
  ok('each travelled layer wears its own named badge',
     /RADAR PAST/.test(r.badges.radar) && /SATELLITE PAST/.test(r.badges.sat),
     JSON.stringify(r.badges).slice(0, 120));
  ok('stacked, not printed through each other', r.badges.stacked);
  ok('the satellite badge returns only the satellite to live',
     r.satBackLive && r.satBadgeGone && r.radarBadgeStays);
  ok('turning satellite off returns its clock to live too',
     r.clockClearedOnDisable);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
