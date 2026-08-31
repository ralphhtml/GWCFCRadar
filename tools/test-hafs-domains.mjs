#!/usr/bin/env node
/*
 * The hurricane models: every storm, both grids, and a nest that moves.
 *
 *     node tools/test-hafs-domains.mjs
 *
 * THREE THINGS WERE WRONG, and they are separable.
 *
 * ONLY SOME STORMS APPEARED. The storm list came from the Hurricane Center's
 * CurrentStorms.json, which lists the systems NHC is writing advisories on.
 * The hurricane models run on rather more than that: invests, which are areas
 * being watched and may never become anything, and western Pacific systems,
 * which are JTWC's basin and not in NHC's feed at all. Measured against the
 * live bucket: HAFS-A was running seven storms and HAFS-B five, where the old
 * question would have answered two or three. The fix is to ask the model's
 * own output directory, which cannot list a storm it has no data for and
 * cannot miss one it does.
 *
 * ONLY ONE GRID WAS FETCHED. Each storm is published twice, on a wide parent
 * grid and a fine inner nest, and only the parent was being read. Off the
 * real GRIB headers: parent 1681x1361 at 0.06 deg, nest 1001x801 at 0.02.
 * Three times finer per degree, which is most of why a hurricane looked soft.
 *
 * THE NEST MOVES. Its box slid from 280.7 E at f000 to 272.5 E at f072,
 * tracking the storm about eight degrees west across the run. The manifest
 * recorded one rectangle for the whole run, so every frame but the last would
 * have been drawn several hundred kilometres from where it happened. Bounds
 * are per frame now, and there is a switch for whether the map follows the
 * nest or holds still while the storm crosses it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const PIPE = readFileSync(join(ROOT, 'pi/gfs_pipeline.py'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the Pi asks the model, not the Hurricane Center');
{
  ok('there is a bucket listing for the storm list',
     /def _storms_from_bucket\(m, date_str, cyc\)/.test(PIPE));
  ok('it pages, so a cycle with thousands of keys is read whole',
     /NextContinuationToken/.test(PIPE));
  ok('and the paging is capped so a runaway listing cannot hang a build',
     /for _ in range\(20\)/.test(PIPE));
  ok('an id is two digits and a basin letter, invests included',
     /STORM_ID_RE = re\.compile\(r"\^\(\\d\{2\}\)\(\[lecwabsp\]\)\$"\)/.test(PIPE));
  ok('the Hurricane Center is kept as a fallback, not the first answer',
     /def _storms_from_nhc\(\)/.test(PIPE)
     && /ids = _storms_from_bucket\(m, date_str, cyc\)\n\s+where = [\s\S]{0,80}if not ids:\n\s+ids = _storms_from_nhc\(\)/
        .test(PIPE));
  ok('each model gets its own list, since HAFS-A and HAFS-B differ',
     /def active_storms\(m=None, date_str=None, cyc=None\)/.test(PIPE));
  ok('the cache is keyed by model and cycle, not one global list',
     /ck = \(m\.get\("storm_prefix"\)/.test(PIPE));
  ok('HAFS-A and HAFS-B name their own directories',
     /"storm_prefix": "hfsa\/\{date\}\/\{cyc\}\/"/.test(PIPE)
     && /"storm_prefix": "hfsb\/\{date\}\/\{cyc\}\/"/.test(PIPE));
}

console.log('\n2. two grids per storm');
{
  ok('HAFS declares both domains',
     /"domains": \["parent", "storm"\]/.test(PIPE));
  ok('the address carries the domain rather than hard-coding parent',
     /hfsa\.\{domain\}\.atm\.f\{fhr:03d\}/.test(PIPE)
     && !/hfsa\.parent\.atm\.f\{fhr/.test(PIPE));
  ok('a region splits back into its storm and its grid',
     /def split_storm_region\(key\)/.test(PIPE));
  ok('the nest is marked as moving and the parent is not',
     /spec\["moving"\] = \(domain == "storm"\)/.test(PIPE));
  ok('each grid says its own resolution',
     /"domain_res": \{"parent": "6 km parent", "storm": "2 km storm nest"\}/
       .test(PIPE));
  // HWRF publishes different files per nest rather than one name with a word
  // swapped, so the address is a dict. HMON publishes one grid, so it gets
  // one domain and no switch.
  ok('HWRF gives an address per domain', /"raw": \{\n\s+"parent": \[/.test(PIPE));
  ok('and region_spec understands that shape',
     /if isinstance\(raw, dict\):\n\s+spec\["raw"\] = raw\.get\(domain\)/.test(PIPE));
  ok('HMON declares the single grid it actually publishes',
     /"label": "HMON"[\s\S]{0,400}/.test(PIPE)
     && /"domains": \["parent"\],\n\s+"domain_res": \{"parent": "storm following"\}/
        .test(PIPE));
}

console.log('\n3. the moving nest keeps its own bounds per frame');
{
  ok('the Pi records bounds per forecast hour when the domain moves',
     /if m\.get\("moving"\):\n\s+#[\s\S]{0,200}frame_bounds\.setdefault\(fhr, bounds_seen\)/
       .test(PIPE));
  ok('and writes them into the manifest keyed as strings',
     /manifest\["frame_bounds"\] = \{str\(k\): v for k, v in/.test(PIPE));
  ok('the index carries the storm-following extras up to the page',
     /for k in \("storm", "domain", "moving", "region_label"\)/.test(PIPE));
  ok('the page reads a frame\'s own bounds', /function _hdFrameBounds\(fhr\)/.test(PAGE));
  ok('and draws with them rather than the run\'s single rectangle',
     /L\.imageOverlay\(src, _hdFrameBounds\(fhr\) \|\| _hdManifest\.bounds,/.test(PAGE));
  ok('a fixed model still falls back to the run bounds',
     /return _hdManifest \? _hdManifest\.bounds : null;/.test(PAGE));
}

console.log('\n4. follow the storm, or hold still');
{
  ok('the choice is remembered', /HD_FOLLOW_KEY = 'gwcfc_hd_follow'/.test(PAGE));
  ok('following is the default', /localStorage\.getItem\(HD_FOLLOW_KEY\) !== '0'/
       .test(PAGE));
  ok('there is a switch', /function _hdSetFollow\(on\)/.test(PAGE));
  ok('it only ever moves the map for a domain that moves',
     /if \(!_hdFollow \|\| !_hdManifest \|\| !_hdManifest\.moving\) return;/.test(PAGE));
  ok('and only when the nest has actually left the screen',
     /if \(!map\.getBounds\(\)\.contains\(bb\.getCenter\(\)\)\)/.test(PAGE));
  ok('every drawn frame gets the chance to follow',
     /_hdLayer = next;\n\s+_hdFollowFrame\(\);/.test(PAGE));
}

console.log('\n5. the build queue puts real storms first');
{
  ok('there is an ordering for storm regions',
     /def storm_region_cost\(region\)/.test(PIPE));
  ok('invests sort behind named storms',
     /return \(1\.0 if not invest else 3\.0\)/.test(PIPE));
  ok('and the queue uses it instead of the fixed-region table',
     /storm_region_cost\(region\) if m\.get\("per_storm"\)/.test(PIPE));
  ok('dead storms are swept off the card',
     /def prune_dead_storms\(name, m, alive, keep_h=36\.0\)/.test(PIPE));
  ok('with a grace period rather than deleting on one missed cycle',
     /if age_h > keep_h:/.test(PIPE));
}

console.log('\n6. in a real browser');
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

  const r = await p.evaluate(async () => {
    const out = {};
    // A Pi index shaped exactly as the pipeline now writes one: seven storms
    // for HAFS-A, two grids each, and frame bounds on the nest that move.
    const storms = ['04l', '11e', '12e', '94w', '95e', '96w', '97l'];
    const regions = {};
    storms.forEach(s => {
      ['parent', 'storm'].forEach(d => {
        const key = d === 'parent' ? s : `${s}-${d}`;
        regions[key] = {
          label: 'HAFS-A', res: d === 'parent' ? '6 km parent' : '2 km storm nest',
          run: '20260831_06', cycle: '20260831T06:00Z',
          path: `hafs/${key}/20260831_06/manifest.json`,
          fields: ['t2m', 'mslp'], runs: ['20260831_06'],
          storm: s, domain: d, moving: d === 'storm',
          bounds: [[9.6, -81.5], [25.6, -61.5]],
        };
      });
    });
    _hdIndex = { models: { hafs: { label: 'HAFS-A',
                                          res: 'storm following',
                                          regions } } };
    _hdModel = 'hafs';
    _hdOn = true;
    _hdFromPicker = true;

    // Every storm reachable, each listed once.
    _hdRegion = '04l';
    _hdManifest = { bounds: [[9.6, -81.5], [25.6, -61.5]],
                           run: '20260831_06', model: 'hafs' };
    _hdFillRegionPicker();
    const sel = document.getElementById('sev-region-sel');
    out.rows = Array.from(sel.options).map(o => o.value);
    out.labels = Array.from(sel.options).map(o => o.textContent.trim());

    // Both grids offered for the selected storm, parent first.
    _hdFillDomainPicker();
    const wrap = document.getElementById('sev-domain-wrap');
    out.domainShown = getComputedStyle(wrap).display !== 'none';
    out.domainBtns = Array.from(
      document.querySelectorAll('#sev-domain-btns .sev-domain-btn'))
      .map(e => e.textContent.trim());

    // On the nest, Follow appears and can be switched.
    _hdRegion = '04l-storm';
    _hdManifest = {
      moving: true, run: '20260831_06', model: 'hafs',
      bounds: [[9.6, -81.5], [25.6, -61.5]],
      frame_bounds: {
        '0':  [[11.4, -79.3], [27.4, -59.3]],
        '72': [[5.3, -87.5], [21.3, -67.5]],
      },
      fields: { t2m: { hours: [0, 72] } },
    };
    _hdField = 't2m';
    _hdFillDomainPicker();
    out.withNest = Array.from(
      document.querySelectorAll('#sev-domain-btns .sev-domain-btn'))
      .map(e => e.textContent.trim());
    out.activeDomain = (document.querySelector(
      '#sev-domain-btns .sev-domain-btn.active') || {}).textContent;

    // The bounds a frame is actually drawn on.
    out.f000 = _hdFrameBounds(0);
    out.f072 = _hdFrameBounds(72);
    out.unknownHour = _hdFrameBounds(999);   // falls back to the run's

    // The follow switch flips, sticks, and relabels.
    const before = _hdFollow;
    _hdSetFollow(!before);
    out.flipped = _hdFollow !== before;
    out.stored = localStorage.getItem('gwcfc_hd_follow');
    out.labelAfter = (document.querySelector('.sev-follow-btn') || {}).textContent;
    _hdSetFollow(before);

    // Changing storm from the dropdown keeps the grid you were on.
    _hdRegion = '04l-storm';
    let asked = null;
    const real = _hdSetRegion;
    _hdSetRegion = (r) => { asked = r; };
    _hdPickRegion('11e');
    out.keptDomain = asked;
    _hdRegion = '04l';
    _hdPickRegion('11e');
    out.keptParent = asked;
    _hdSetRegion = real;

    // A fixed-domain model must be untouched by all of this.
    _hdIndex.models.gfs = { label: 'GFS', res: '0.25 deg',
      regions: { conus: { label: 'GFS', run: '1', path: 'gfs/conus/1/manifest.json',
                          fields: ['t2m'], runs: ['1'],
                          bounds: [[20, -130], [55, -60]] } } };
    _hdModel = 'gfs';
    _hdRegion = 'conus';
    _hdManifest = { bounds: [[20, -130], [55, -60]] };
    _hdFillDomainPicker();
    out.gfsDomainHidden =
      getComputedStyle(document.getElementById('sev-domain-wrap')).display === 'none';
    out.gfsBounds = _hdFrameBounds(6);
    return out;
  });
  await b.close();

  ok('all seven storms are listed', r.rows.length === 7, r.rows.join(', '));
  ok('each exactly once, keyed by its parent grid',
     r.rows.join(',') === '04l,11e,12e,94w,95e,96w,97l', r.rows.join(','));
  ok('named storms come before invests',
     r.labels[0].startsWith('Storm') && r.labels[6].startsWith('Invest'),
     r.labels.join(' | '));
  ok('an invest is called an invest, not storm ninety-four',
     r.labels.some(l => /^Invest 94W/.test(l)), r.labels.join(' | '));
  ok('the basin is written out', /Atlantic|Pacific/.test(r.labels[0]), r.labels[0]);

  ok('the domain switch is shown for a hurricane model', r.domainShown);
  ok('with both grids, parent first',
     r.domainBtns.slice(0, 2).join(',') === 'Parent,Storm', r.domainBtns.join(','));
  ok('the parent grid offers no Follow, having nothing to follow',
     r.domainBtns.length === 2, r.domainBtns.join(','));
  ok('the nest adds one', r.withNest.length === 3, r.withNest.join(','));
  ok('and the nest reads as the active grid',
     (r.activeDomain || '').trim() === 'Storm', r.activeDomain);

  ok('f000 draws on its own rectangle',
     JSON.stringify(r.f000) === JSON.stringify([[11.4, -79.3], [27.4, -59.3]]),
     JSON.stringify(r.f000));
  ok('f072 draws on a different one, eight degrees west',
     Math.abs(r.f072[0][1] - r.f000[0][1] + 8.2) < 0.01,
     `${r.f000[0][1]} -> ${r.f072[0][1]}`);
  ok('an hour with no recorded box falls back to the run\'s',
     JSON.stringify(r.unknownHour) === JSON.stringify([[9.6, -81.5], [25.6, -61.5]]),
     JSON.stringify(r.unknownHour));

  ok('the follow switch flips', r.flipped);
  ok('and is remembered', r.stored === '0' || r.stored === '1', String(r.stored));
  ok('and says which way it is set now',
     /Fixed|Following/.test(r.labelAfter || ''), r.labelAfter);

  ok('changing storm keeps the nest you were reading',
     r.keptDomain === '11e-storm', String(r.keptDomain));
  ok('and keeps the parent if that is where you were',
     r.keptParent === '11e', String(r.keptParent));

  ok('a fixed-domain model shows no domain switch', r.gfsDomainHidden);
  ok('and still draws on its run bounds',
     JSON.stringify(r.gfsBounds) === JSON.stringify([[20, -130], [55, -60]]),
     JSON.stringify(r.gfsBounds));
  ok('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n7. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'pi/gfs_pipeline.py', 'tools/test-hafs-domains.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
