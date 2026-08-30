#!/usr/bin/env node
/*
 * The satellite time machine, and the satellite colour controls.
 *
 *     node tools/test-sat-time-colors.mjs
 *
 * TIME. The time machine used to drive radar only. Satellite now anchors its
 * frame list at the travelled-to moment, so the playbar scrubs the hours
 * LEADING UP TO that moment, which is what "show me the satellite when the
 * derecho hit" means. The frame builder is lifted out of the page and run at
 * a known moment, because an off-by-one here shows somebody the wrong hour
 * with total confidence.
 *
 * COLOURS. One CSS custom property, --sat-filter, is supposed to reach every
 * satellite surface: the WMS band tiles (via .wx-photo), the Pi composites
 * and the global mosaic (via the satPhotoPane). That claim is tested in a
 * real browser by applying a preset and reading the COMPUTED filter off an
 * element in each place, because a selector list is exactly the kind of
 * thing that rots silently when a new layer arrives in a new pane.
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

console.log('\n1. the frame list anchors at the travelled-to moment');
{
  const src = (PAGE.match(/function _buildGoesFrames\(\) \{[\s\S]*?\n\}/) || [])[0];
  ok('the frame builder was found', !!src);
  const mk = new Function('_tmAt', 'SAT_FRAME_MIN', '_satFrameCount',
    src + '\nreturn _buildGoesFrames();');
  const count = () => 12;
  // Travelled to noon UTC on a known date.
  const at = Date.UTC(2024, 4, 17, 12, 0, 0);
  const frames = mk(at, 10, count);
  ok('twelve frames come back', frames.length === 12, String(frames.length));
  const last = frames[frames.length - 1].time.getTime();
  // The newest frame sits just before the moment (the 20 minute publish lag
  // is part of the builder), never after it.
  ok('the newest frame is AT or BEFORE the moment, never after',
     last <= at, new Date(last).toISOString());
  ok('and within the publish lag of it', at - last <= 30 * 60e3,
     ((at - last) / 60e3) + ' min');
  const first = frames[0].time.getTime();
  ok('the list is the approach to the moment, oldest first',
     first < last && (last - first) === 11 * 10 * 60e3);
  ok('every timeStr is whole-minute UTC for the WMS TIME parameter',
     frames.every(f => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(f.timeStr)));
  // With no travel set, it anchors at the present.
  const live = mk(null, 10, count);
  const liveLast = live[live.length - 1].time.getTime();
  ok('with the machine off it anchors at now',
     Date.now() - liveLast < 45 * 60e3);
}

console.log('\n2. the jump drives satellite, and no longer demands a radar site');
{
  ok('satellite counts as a destination', /function _tmSatActive\(\)/.test(PAGE)
     && /activeLayers\.satellite/.test(PAGE));
  ok('the no-target message asks for either, not radar specifically',
     /Turn on radar or satellite first, then travel to a time\./.test(PAGE));
  ok('a jump rebuilds the satellite frames',
     /if \(sat\) \{[\s\S]{0,700}loadGoesLayer\(\)/.test(PAGE));
  ok('and back-to-live rebuilds them again',
     /_tmLive[\s\S]{0,400}if \(sat\) \{ try \{ loadGoesLayer\(\); \} catch \(e\) \{\} \}/.test(PAGE));
  // The Pi composites keep three days. Promising a picture beyond that would
  // be the one way this feature could lie.
  ok('a Pi composite past its window says so instead of showing the wrong day',
     /Pi composites keep 3 days\. Pick a plain band for older imagery\./.test(PAGE));
  // Matched on one literal's worth: the sentence is split across two
  // concatenated strings in the source, and a phrase spanning the join
  // matches nothing however true it is on screen.
  ok('the modal explains that satellite scrubs the approach to the moment',
     /playbar scrubs the approach/.test(PAGE));
  ok('the PAST badge machinery is shared, not duplicated',
     (PAGE.match(/function _tmSyncBadge\(\)/g) || []).length === 1);
}

/*
 * 2b. THE WAY IN, FROM SATELLITE.
 *
 * The machine drove satellite already, but the only button that opened it
 * lived on the radar row. Travelling to a moment and then looking at
 * satellite meant leaving satellite, entering radar, travelling, leaving
 * again and coming back: five menu moves to use a feature that was already
 * working. The button is on the satellite rows now, at every level, for the
 * same reason the region row is repeated at every level.
 */
console.log('\n2b. the satellite rows open the time machine themselves');
{
  ok('there is one shared builder, not three copies',
     (PAGE.match(/function _satTimeMachineBubble\(wrap\)/g) || []).length === 1);
  // All three levels, because the moment you want is as likely to occur to
  // you inside a product row as at the top.
  const kinds = (PAGE.match(/function toggleSatelliteSub\(\) \{[\s\S]*?\n\}/) || [''])[0];
  const kind = (PAGE.match(/function _satKindSub\(k\) \{[\s\S]*?\n\}/) || [''])[0];
  const cat = (PAGE.match(/function _satCatSub\(k, c, items\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('the kind row offers it', /_satTimeMachineBubble\(wrap\)/.test(kinds));
  ok('the category row offers it', /_satTimeMachineBubble\(wrap\)/.test(kind));
  ok('and the product row offers it', /_satTimeMachineBubble\(wrap\)/.test(cat));
  // Same _tmAt underneath as the radar button, so travelling from either row
  // moves both pictures. A second piece of state would let the two rows
  // disagree about what time it is.
  ok('it opens the same machine the radar row opens',
     /function _satTimeMachineBubble[\s\S]{0,600}tm\.onclick = \(\) => _tmOpen\(\);/
       .test(PAGE));
  ok('and lights while a past moment is held',
     /function _satTimeMachineBubble[\s\S]{0,300}_tmAt != null \? ' active' : ''/
       .test(PAGE));
  ok('its id does not collide with the radar row button',
     /'sub-sat-timemachine'/.test(PAGE) && /'sub-timemachine'/.test(PAGE));
}

console.log('\n3. the colours, computed in a real browser');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('  playwright is not installed, skipping');
} else {
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  await p.goto('file://' + join(ROOT, 'index.html'),
               { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => {
    const out = {};
    // Stand-ins for the three satellite surfaces, placed exactly where the
    // real layers put themselves.
    const pane = document.createElement('div');
    pane.className = 'leaflet-satPhoto-pane';
    const inPane = document.createElement('img');
    pane.appendChild(inPane);
    document.body.appendChild(pane);
    const wms = document.createElement('div');
    wms.className = 'wx-photo';
    document.body.appendChild(wms);
    const radar = document.createElement('div');
    radar.className = 'leaflet-radar-pane';
    document.body.appendChild(radar);

    const filt = (el) => getComputedStyle(el).filter;
    out.defaultPane = filt(pane);
    // Apply a preset through the real code path.
    _satc = Object.assign({}, SATC_DEFAULTS, SATC_PRESETS.vivid);
    _satcApply();
    out.var = getComputedStyle(document.documentElement)
      .getPropertyValue('--sat-filter').trim();
    out.paneAfter = filt(pane);
    out.wmsAfter = filt(wms);
    out.radarAfter = filt(radar);
    // The tinting path: colorize plus hue must produce sepia + hue-rotate.
    _satc = Object.assign({}, SATC_DEFAULTS, SATC_PRESETS.green);
    _satcApply();
    out.greenVar = getComputedStyle(document.documentElement)
      .getPropertyValue('--sat-filter').trim();
    // And normal must clear the property entirely, not set 'none' forever.
    _satc = Object.assign({}, SATC_DEFAULTS);
    _satcApply();
    out.clearedVar = getComputedStyle(document.documentElement)
      .getPropertyValue('--sat-filter').trim();
    out.paneCleared = filt(pane);
    return out;
  });
  await b.close();

  ok('untouched, the pane has no filter',
     r.defaultPane === 'none', r.defaultPane);
  ok('vivid writes saturate and contrast into the variable',
     /saturate\(1\.6\)/.test(r.var) && /contrast\(1\.15\)/.test(r.var), r.var);
  ok('the Pi composite pane computes that filter',
     /saturate/.test(r.paneAfter), r.paneAfter);
  ok('the WMS band surface computes it too',
     /saturate/.test(r.wmsAfter), r.wmsAfter);
  // Radar is data, not photograph: the satellite tint must never touch it.
  ok('the radar pane is untouched by satellite colours',
     r.radarAfter === 'none', r.radarAfter);
  ok('the tint presets ride sepia plus hue-rotate, in that order',
     /sepia\(1\) hue-rotate\(60deg\)/.test(r.greenVar), r.greenVar);
  ok('back to normal clears the variable rather than pinning none',
     r.clearedVar === '' && r.paneCleared === 'none',
     r.clearedVar + ' / ' + r.paneCleared);
}

console.log('\n4. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-sat-time-colors.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
