#!/usr/bin/env node
/*
 * State, county and province line colour and thickness.
 *
 *     node tools/test-border-style.mjs
 *
 * WHY AUTO IS THE DEFAULT. A single fixed colour is wrong half the time:
 * white lines disappear on the Light and Topo basemaps and black lines
 * disappear on Dark. Auto reads the basemap and flips, so somebody who never
 * opens this section still gets borders they can see on every map style. The
 * thing worth testing is therefore not that a setting is stored but that
 * changing the BASEMAP changes the colour, and that having chosen a fixed
 * colour stops that from happening.
 *
 * WHY THE STORED VALUE IS THE WORD 'auto'. Storing the colour auto resolved
 * to would freeze today's answer into the saved setting, and the lines would
 * silently stop following the basemap from then on. Every saved value is
 * either the word or a plain #rrggbb, and anything else is treated as auto,
 * because this string is written into a canvas stroke style.
 *
 * WHAT IS ACTUALLY MEASURED. The style Leaflet would draw with, read back off
 * the real layer objects after the real setter functions ran, rather than the
 * config the setters were handed. A setter that saves correctly and never
 * reaches the map is the failure this feature would actually have.
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

console.log('\n1. the shape of it, in the source');
{
  ok('there is a saved style, under its own key',
     /const MB_STYLE_KEY = 'gwcfc_mb_style';/.test(PAGE));
  ok('all three line types are covered',
     /_mbCfg = \{[\s\S]{0,400}state:[\s\S]{0,200}province:[\s\S]{0,200}county:/.test(PAGE));
  ok('and all three default to auto',
     (PAGE.match(/color: 'auto', weight: MB_BASE\./g) || []).length === 3);
  ok('the layers ask for the live style rather than a frozen table',
     /style: \(\) => _mbStyleFor\(kind\)/.test(PAGE)
     && /style: \(\) => _mbStyleFor\('county'\)/.test(PAGE));
  // Rebuilding to change a colour would re-download a megabyte of geometry
  // on every drag of the thickness slider.
  ok('a change restyles in place instead of rebuilding the layer',
     /function _mbRestyle\(\)[\s\S]{0,400}layer\.setStyle\(_mbStyleFor\(k\)\)/.test(PAGE));
  ok('the basemap switch tells the borders to re-read auto',
     /function setMapType[\s\S]{0,900}_mbAutoSync\(\)/.test(PAGE));
  ok('there is a way back to the shipped look',
     /function mbResetBorderStyle\(\)/.test(PAGE));
}

console.log('\n2. what a corrupt or hostile saved value can do');
{
  const src = (PAGE.match(/function _mbCleanColor\(c\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('the cleaner was found', !!src);
  const clean = new Function(src + '\nreturn _mbCleanColor;')();
  ok('a plain hex colour is kept', clean('#FF9500') === '#ff9500');
  ok('the word auto is kept', clean('auto') === 'auto');
  // This string ends up as a canvas stroke style. Anything that is not one of
  // the two shapes above falls back to auto rather than being passed through.
  for (const bad of ['red', 'rgb(1,2,3)', '#fff', '#12345g', 'url(x)',
                     'javascript:alert(1)', '</style><script>', null, undefined,
                     '#ff9500;background:url(//x)', 42, {}, []]) {
    ok('rejects ' + JSON.stringify(bad), clean(bad) === 'auto', String(clean(bad)));
  }
}

console.log('\n3. thickness is clamped to something drawable');
{
  const src = (PAGE.match(/function _mbClampWeight\(v\) \{[\s\S]*?\n\}/) || [''])[0];
  const mins = (PAGE.match(/const MB_WEIGHT_MIN = ([\d.]+), MB_WEIGHT_MAX = (\d+);/) || []);
  const clamp = new Function('MB_WEIGHT_MIN', 'MB_WEIGHT_MAX',
    src + '\nreturn _mbClampWeight;')(parseFloat(mins[1]), parseFloat(mins[2]));
  ok('a normal value passes through', clamp('2.5') === 2.5);
  ok('zero becomes the minimum, not an invisible line', clamp(0) === 0.2);
  ok('a negative becomes the minimum', clamp(-9) === 0.2);
  ok('an absurd value is capped', clamp(9999) === 6);
  // A slider that has never been touched, or a setting that lost its number.
  ok('nonsense falls back to something visible', clamp('wide') === 1);
  ok('and so does nothing at all', clamp(undefined) === 1 && clamp(null) === 1);
}

/*
 * 3b. EVERY ZOOM LEVEL.
 *
 * County lines used to be refused below zoom 6. The stated reason was that
 * three thousand shapes at low zoom would be slow, and that was assumed
 * rather than measured. It is false, and the arithmetic is worth keeping
 * because the temptation to put the floor back will return.
 *
 * Leaflet's smoothFactor is a Douglas-Peucker tolerance in PIXELS, so zooming
 * out simplifies every outline automatically: the further away a county is
 * drawn, the fewer points survive. Measured over the real file, all 3221
 * counties come to 13,633 drawn points at zoom 3, against 31,175 at zoom 6
 * where the layer was already allowed. The floor made the map worse at low
 * zoom and saved nothing.
 */
console.log('\n3b. nothing is gated by zoom any more');
{
  ok('the county zoom floor is gone entirely',
     !/MB_COUNTY_MIN_ZOOM/.test(PAGE));
  const refresh = (PAGE.match(/function _mbCountyRefresh\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('and nothing in the county refresh compares a zoom to a floor',
     !/getZoom\(\)\s*<\s*MB_/.test(refresh), refresh.slice(0, 120));
  ok('the viewport filter is kept, which is the part that was doing the work',
     /map\.getBounds\(\)\.pad/.test(refresh));
  ok('why the floor was wrong is written down where it used to be',
     /FEWER than the 31,175 at zoom 6/.test(PAGE));
  // The other three were never gated and must not quietly acquire one.
  const admin = (PAGE.match(/async function _mbBuildAdmin1\(kind\) \{[\s\S]*?\n\}/) || [''])[0];
  const coast = (PAGE.match(/function _mbBuildCoast\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('state and province lines have no zoom floor', !/getZoom/.test(admin));
  ok('and neither does the coastline', !/getZoom/.test(coast));
}

/*
 * 3c. THE COASTLINE.
 *
 * State and county lines are political and stop at the national border. The
 * shoreline is the one boundary here that is physical, and on the Dark
 * basemap nothing else shows where the Gulf coast is until weather is drawn
 * over it.
 *
 * TWO DETAIL LEVELS, AND WHY. The 50m file is 1.6 MB and 60,416 points; the
 * 10m file is 10.1 MB and 410,957. Ten megabytes the instant a switch is
 * flipped is not a reasonable thing to spend, and at a continental view it
 * would buy nothing anyone can see. But 50m detail IS visibly wrong up close,
 * and a bay in the wrong place matters when the question is whether a storm
 * is coming ashore. So the coarse file loads immediately and the fine one is
 * fetched once, in the background, only if you zoom in far enough to tell.
 */
console.log('\n3c. the coastline, and its two detail levels');
{
  ok('both files are configured', /coast: \[[\s\S]{0,300}ne_50m_coastline/.test(PAGE)
     && /coastHi: \[[\s\S]{0,300}ne_10m_coastline/.test(PAGE));
  ok('each with a spare host, like every other source here',
     (PAGE.match(/ne_50m_coastline/g) || []).length === 2
     && (PAGE.match(/ne_10m_coastline/g) || []).length === 2);
  ok('the coarse one is what loads first',
     /async function _mbLoadCoast\(\)[\s\S]{0,300}_mbFetch\(MB_SRC\.coast\)/.test(PAGE));
  ok('the fine one is fetched only once a session, win or lose',
     /_mbCoastHiTried = true;/.test(PAGE));
  ok('only while the layer is actually on',
     /_mbCoastMaybeUpgrade[\s\S]{0,400}if \(!_mbOn\.coast/.test(PAGE));
  ok('and only past the zoom where the coarse one is visibly wrong',
     /if \(map\.getZoom\(\) < MB_COAST_HI_ZOOM\) return;/.test(PAGE));
  // A 10 MB fetch that fails must not take the shoreline off the map: the
  // coarse one is still correct at the scale it was drawn for.
  ok('a failed upgrade leaves the coarse coast on screen, and does not shout',
     /catch \(err\) \{[\s\S]{0,400}console\.warn\('map borders \(fine coastline\)/.test(PAGE));
  ok('the upgrade is also checked when the view settles, not only on the switch',
     /_mbCountyRefresh\(\); _mbCityRefresh\(\); _mbCoastMaybeUpgrade\(\);/.test(PAGE));
  ok('there is a switch for it in Settings',
     /id="lqm-set-coastborders"[^>]*onchange="lqmToggleSetting\('coastborders'/.test(PAGE));
  ok('the switch is wired to the layer', /key === 'coastborders'/.test(PAGE)
     && /_toggleBorders\('coast', val\)/.test(PAGE));
  ok('it is findable by searching for shore or coastal',
     /'coastborders', \['coast', 'coastal', 'shore', 'shoreline'/.test(PAGE));
  // It ships off, because 1.6 MB should not be spent on somebody's behalf.
  ok('it ships off, and only an explicit yes turns it on',
     /lqm_coastborders'\); if\(cstVal==='true'\)/.test(PAGE));
  ok('and the markup agrees it is off',
     /id="lqm-set-coastborders" onchange=/.test(PAGE));
}

/*
 * 3d. BORDERS OVER THE MODELS.
 *
 * A model field is opaque across its whole box, so borders underneath it are
 * borders you cannot see, and state lines are most of what makes a
 * temperature chart readable in the first place.
 *
 * THREE THINGS WERE WRONG. Model charts rode in radarPane, so as far as the
 * layer-order control was concerned models and radar were one layer and the
 * borders could not be above one and below the other. The four WMS model
 * renderers named no pane at all, so they landed in Leaflet's default tile
 * pane and could not be ordered against anything. And the comparison slots
 * sat at a flat z of 450, which is above the borders AND above the alert
 * polygons, so turning on a second model buried the state lines and every
 * warning on screen.
 *
 * Models have their own pane now, in the reorderable stack directly under the
 * borders, and the slots hang off wherever that pane currently is.
 */
console.log('\n3d. models are their own layer, under the borders');
{
  ok('there is a model pane', /map\.createPane\('modelPane'\)/.test(PAGE));
  ok('the Pi model charts draw in it, not in the radar pane',
     /opacity: modelOpacity, interactive: false, pane: 'modelPane'/.test(PAGE));
  ok('and all four WMS models are given it too, instead of no pane at all',
     (PAGE.match(/opts\.pane = 'modelPane';/g) || []).length === 4,
     String((PAGE.match(/opts\.pane = 'modelPane';/g) || []).length));
  ok('it is a row in the layer-order control, so it can be moved',
     /\{ id: 'models',\s+pane: 'modelPane'/.test(PAGE));
  ok('and it defaults to sitting directly under the borders',
     /'borders'[\s\S]{0,400}id: 'models'[\s\S]{0,200}id: 'radar'/.test(PAGE));
  ok('the flat 450 that put comparison slots over everything is gone',
     !/zIndex = 450/.test(PAGE));
  ok('slots are restacked from wherever the model pane actually is',
     /function _stackSlotZ\(i\)[\s\S]{0,500}getPane\('modelPane'\)/.test(PAGE));
  ok('and restacked again when the layer order changes',
     /_stackApply[\s\S]{0,900}_sevSyncSlotPaneZ\(\)/.test(PAGE));
  // Rows one apart left nowhere to put the slots between models and borders.
  ok('stack rows are spaced to leave room between them',
     /const MAP_STACK_STEP = 10;/.test(PAGE)
     && /MAP_STACK_TOP_Z - idx \* MAP_STACK_STEP/.test(PAGE));
  // Every saved order predates the models row.
  ok('a row added since an order was saved is inserted, not appended',
     /out\.splice\(Math\.min\(want, out\.length\), 0, id\);/.test(PAGE));
}

console.log('\n4. on a real map, in a real browser');
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
    // Stand-in layers in place of the real GeoJSON, which needs a megabyte of
    // geometry off a CDN. What is being tested is that the setters reach a
    // layer's setStyle at all, so a layer that records what it was given
    // answers the question exactly.
    const mk = () => ({ last: null, setStyle(s) { this.last = s; } });
    _mbLayers.state = mk();
    _mbLayers.county = mk();
    _mbLayers.province = mk();
    _mbLayers.coast = mk();

    mbResetBorderStyle();
    out.startColorDark = _mbStyleFor('state').color;
    out.startWeights = {
      state: _mbStyleFor('state').weight,
      county: _mbStyleFor('county').weight,
      province: _mbStyleFor('province').weight,
    };

    // AUTO, against the basemap. This is the whole claim of the feature.
    currentMapType = 'light';
    _mbAutoSync();
    out.autoOnLight = _mbLayers.state.last && _mbLayers.state.last.color;
    currentMapType = 'topo';
    _mbAutoSync();
    out.autoOnTopo = _mbStyleFor('county').color;
    currentMapType = 'satellite';
    _mbAutoSync();
    out.autoOnSatellite = _mbStyleFor('state').color;
    currentMapType = 'dark';
    _mbAutoSync();
    out.autoOnDark = _mbStyleFor('state').color;

    // A fixed colour, which must then IGNORE the basemap.
    mbSetBorderColor('county', '#ffd400');
    out.countyFixed = _mbLayers.county.last.color;
    currentMapType = 'light';
    _mbAutoSync();
    out.countyStillFixed = _mbStyleFor('county').color;
    // and the ones left on auto still follow it.
    out.stateFollowedAlong = _mbStyleFor('state').color;
    currentMapType = 'dark';

    // Black, asked for by name.
    mbSetBorderColor('state', '#111111');
    out.stateBlack = _mbLayers.state.last.color;

    // Thickness reaches the layer, per kind and independently.
    mbSetBorderWeight('state', 4.2);
    out.stateWeight = _mbLayers.state.last.weight;
    out.countyWeightUnchanged = _mbStyleFor('county').weight;
    mbSetBorderWeight('county', 0);
    out.countyWeightFloor = _mbLayers.county.last.weight;

    // Opacity is deliberately not a control, and must survive every change.
    out.opacities = {
      state: _mbStyleFor('state').opacity,
      county: _mbStyleFor('county').opacity,
      province: _mbStyleFor('province').opacity,
    };
    // Borders never fill, or a county becomes a solid block over the radar.
    out.fills = ['state', 'county', 'province'].map(k => _mbStyleFor(k).fill);

    // It survives a reload: what is written is what a fresh page reads. A
    // fixed colour is stored as the colour.
    out.savedFixed = JSON.parse(localStorage.getItem('gwcfc_mb_style')).state;

    // The panel shows what is in force, including for a colour that is not
    // one of the named options.
    lqmOpenSettings();
    mbSetBorderColor('province', '#123456');
    _mbStyleSyncUi();
    out.uiProvinceSelect = document.getElementById('lqm-mb-province-color').value;
    out.uiProvinceSwatch = document.getElementById('lqm-mb-province-swatch').value;
    out.uiStateSelect = document.getElementById('lqm-mb-state-color').value;
    out.uiStateWeight = document.getElementById('lqm-mb-state-weight').value;
    out.uiStateWeightLabel =
      document.getElementById('lqm-mb-state-weight-val').textContent;
    // The swatch is meaningless next to Auto and is hidden there.
    mbSetBorderColor('state', 'auto');
    _mbStyleSyncUi();
    out.swatchHiddenOnAuto =
      document.getElementById('lqm-mb-state-swatch').style.display === 'none';

    // Reset really returns to the shipped look, in the config and on the map.
    mbResetBorderStyle();
    out.afterResetColor = _mbStyleFor('state').color;
    out.afterResetWeights = {
      state: _mbStyleFor('state').weight,
      county: _mbStyleFor('county').weight,
      province: _mbStyleFor('province').weight,
    };
    out.afterResetOnLayer = _mbLayers.state.last.weight;
    // With everything back on auto, the stored value has to be the WORD.
    // Storing the colour auto happened to resolve to would freeze today's
    // answer and quietly stop following the basemap from the next load on.
    out.savedAuto = JSON.parse(localStorage.getItem('gwcfc_mb_style'));
    // Coast is a full citizen of the style system: its own colour, its own
    // thickness, and reset returns it to the water blue it shipped with
    // rather than to auto, which it never was.
    out.coastReset = _mbStyleFor('coast').color;
    out.coastKinds = MB_KINDS.slice();
    mbSetBorderColor('coast', '#ff9500');
    mbSetBorderWeight('coast', 3);
    out.coastOnLayer = _mbLayers.coast.last;
    out.coastIndependent = _mbStyleFor('state').color;
    return out;
  });
  await b.close();

  ok('auto is white on the Dark basemap', r.autoOnDark === '#ffffff',
     r.autoOnDark);
  ok('and black on Light, which is the ask', r.autoOnLight === '#111111',
     r.autoOnLight);
  ok('black on Topo too', r.autoOnTopo === '#111111', r.autoOnTopo);
  ok('white over Satellite imagery', r.autoOnSatellite === '#ffffff',
     r.autoOnSatellite);
  ok('a fixed colour reaches the layer', r.countyFixed === '#ffd400',
     r.countyFixed);
  ok('and then ignores the basemap, which is why you would fix it',
     r.countyStillFixed === '#ffd400', r.countyStillFixed);
  ok('while a line still on auto follows the basemap alongside it',
     r.stateFollowedAlong === '#111111', r.stateFollowedAlong);
  ok('black is available as a fixed choice as well', r.stateBlack === '#111111',
     r.stateBlack);
  ok('thickness reaches the layer', r.stateWeight === 4.2,
     String(r.stateWeight));
  ok('and is per line type, not one setting for all three',
     r.countyWeightUnchanged === 0.7, String(r.countyWeightUnchanged));
  ok('a zero-width line is floored to something you can see',
     r.countyWeightFloor === 0.2, String(r.countyWeightFloor));
  ok('the tuned opacities are untouched by any of this',
     r.opacities.state === 0.85 && r.opacities.county === 0.42
     && r.opacities.province === 0.7, JSON.stringify(r.opacities));
  ok('borders still never fill', r.fills.every(f => f === false),
     JSON.stringify(r.fills));
  ok('a fixed choice is saved as that colour, and the thickness with it',
     r.savedFixed.color === '#111111' && r.savedFixed.weight === 4.2,
     JSON.stringify(r.savedFixed));
  ok('but auto is saved as the WORD, so a reload still follows the basemap',
     ['state', 'county', 'province']
       .every(k => r.savedAuto[k].color === 'auto'),
     JSON.stringify(r.savedAuto));
  ok('a colour outside the named list reads as Custom in the dropdown',
     r.uiProvinceSelect === 'custom', r.uiProvinceSelect);
  ok('and the swatch is the one telling you which colour that is',
     r.uiProvinceSwatch === '#123456', r.uiProvinceSwatch);
  ok('the swatch is hidden next to Auto, where it would do nothing',
     r.swatchHiddenOnAuto);
  ok('the panel shows the thickness actually in force',
     r.uiStateWeight === '4.2' && r.uiStateWeightLabel === '4.2px',
     r.uiStateWeight + ' / ' + r.uiStateWeightLabel);
  ok('reset returns the colour to auto', r.afterResetColor === '#ffffff'
     && r.uiStateSelect !== undefined, r.afterResetColor);
  ok('and every thickness to the shipped one',
     r.afterResetWeights.state === 1.5 && r.afterResetWeights.county === 0.7
     && r.afterResetWeights.province === 1.2,
     JSON.stringify(r.afterResetWeights));
  ok('with the map told about it, not just the config',
     r.afterResetOnLayer === 1.5, String(r.afterResetOnLayer));
  ok('coast is one of the styled line types, not a special case',
     r.coastKinds.join(',') === 'state,province,county,coast',
     r.coastKinds.join(','));
  ok('reset returns coast to the water blue it shipped with, not to auto',
     r.coastReset === '#7fd4ff', r.coastReset);
  ok('its colour and thickness reach the layer like any other',
     r.coastOnLayer.color === '#ff9500' && r.coastOnLayer.weight === 3,
     JSON.stringify(r.coastOnLayer));
  ok('and changing it leaves the other lines alone',
     r.coastIndependent === '#ffffff', r.coastIndependent);
}

/*
 * 4b. THE STACK, MEASURED OFF THE LIVE PANES.
 *
 * Everything in 3d reads the source. What actually decides which line you can
 * see is the computed z-index of a div, so this reads those instead: with a
 * model on and two comparison slots up, is every border still above every
 * model surface?
 */
console.log('\n4b. the real stacking order, off the live map');
if (!chromium) {
  console.log('  playwright is not installed, skipping');
} else {
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--allow-file-access-from-files'] });
  const p = await b.newPage();
  // Leaflet is served locally: what is under test is the stacking, not a CDN.
  await p.route('**/*', async (r) => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (/leaflet.*\.js|unpkg/.test(u)) {
      return r.fulfill({ status: 200, contentType: 'application/javascript',
        body: readFileSync('/tmp/node_modules/leaflet/dist/leaflet-src.js', 'utf8') });
    }
    if (/\.css/.test(u)) return r.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"type":"FeatureCollection","features":[]}' });
  });
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  const r = await p.evaluate(() => {
    if (typeof map === 'undefined' || !map) return { err: 'no map' };
    if (typeof _mbPanes === 'function') _mbPanes();
    const z = (n) => {
      const q = map.getPane(n);
      return q ? parseInt(getComputedStyle(q).zIndex, 10) : null;
    };
    const out = {};
    out.def = { borders: z('bordersPane'), models: z('modelPane'),
                radar: z('radarPane'), sat: z('satPhotoPane'),
                ocean: z('sstPane'), alerts: z('alertsPane') };
    // Two comparison slots, made the way the real ones are.
    _sevExtraSlots = [{ id: 'zt1' }, { id: 'zt2' }];
    ['zt1', 'zt2'].forEach(id => {
      const n = 'sev-cmp-' + id;
      if (!map.getPane(n)) { map.createPane(n).style.pointerEvents = 'none'; }
    });
    _sevSyncSlotPaneZ();
    out.slots = ['zt1', 'zt2'].map(id => z('sev-cmp-' + id));

    // Reordering must carry the slots with it.
    _stackSave(['radar', 'borders', 'models', 'satellite', 'ocean']);
    out.reordered = { radar: z('radarPane'), borders: z('bordersPane'),
                      models: z('modelPane') };
    out.slotsAfter = ['zt1', 'zt2'].map(id => z('sev-cmp-' + id));

    // An order saved before the models row existed. Appending it would put
    // model charts under the sea temperature.
    localStorage.setItem('gwcfc_map_stack_order',
      JSON.stringify(['borders', 'radar', 'satellite', 'ocean']));
    out.migrated = _stackOrder();
    localStorage.removeItem('gwcfc_map_stack_order');
    _stackApply();
    return out;
  });
  await b.close();

  ok('the map came up', !r.err, r.err);
  if (!r.err) {
    ok('borders are above the models by default',
       r.def.borders > r.def.models, JSON.stringify(r.def));
    ok('models are above radar, satellite and ocean',
       r.def.models > r.def.radar && r.def.radar > r.def.sat
       && r.def.sat > r.def.ocean, JSON.stringify(r.def));
    ok('a comparison slot sits ABOVE the model it is compared with',
       r.slots.every(v => v > r.def.models), JSON.stringify(r.slots));
    ok('and still BELOW the borders, which is what 450 broke',
       r.slots.every(v => v < r.def.borders), JSON.stringify(r.slots));
    ok('and below the alert polygons too',
       r.slots.every(v => v < r.def.alerts), JSON.stringify(r.slots));
    ok('reordering moves the models, and the slots follow them',
       r.slotsAfter.every(v => v > r.reordered.models
                            && v < r.reordered.borders),
       JSON.stringify(r.slotsAfter) + ' vs ' + JSON.stringify(r.reordered));
    ok('an order saved before models existed puts them back in their place',
       r.migrated.join(',') === 'borders,models,radar,satellite,ocean',
       r.migrated.join(','));
  }
}

console.log('\n5. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-border-style.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
