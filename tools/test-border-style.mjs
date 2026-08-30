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
