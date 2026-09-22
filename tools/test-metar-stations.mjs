#!/usr/bin/env node
/*
 * METAR Stations: a real-instrument overlay, added to the overlay stack the
 * same way every other point overlay here works - a pill with a drag
 * handle and an info button, and a canvas (not markers: this is thousands
 * of stations worldwide, and this app already learned the hard way what
 * eight hundred DOM markers does to a pan). How each station draws is a
 * choice in Settings > Display, the same place every other "how does this
 * look" choice lives, not a floating panel glued to the map.
 *
 *     node tools/test-metar-stations.mjs
 *
 * Five things are worth checking rather than trusting.
 *
 * THE FIELDS ARE THE SERVICE'S OWN. WIND_DIRECT, WIND_SPEED and WIND_GUST
 * are the FeatureServer's real field names (confirmed against its live
 * schema), not a guess, and WIND_SPEED arrives in km/h and has to be
 * converted before it means anything to a wind barb.
 *
 * OUTFIELDS ASKS FOR EVERYTHING, NOT A NAMED LIST. An ArcGIS FeatureServer
 * fails the whole query over a single misnamed outField - this overlay
 * shipped once asking for a plain STATION, which does not exist on this
 * service (the real field is STATION_NAME), and that alone was enough to
 * fail every request and make the entire overlay look broken. Asking for
 * outFields=* cannot be broken by a field this code does not read.
 *
 * A BARB POINTS INTO THE WIND, THE SAME WAY THE WIND BARBS OVERLAY'S DOES.
 * METAR direction is where the wind is FROM; the shared _barbGlyph wants a
 * vector for where it is blowing TOWARD. Get the conversion backwards and
 * every barb on the map points the wrong way while still looking plausible.
 *
 * NOTHING IS INVENTED WHEN A FIELD IS MISSING. A station with no wind
 * reading falls back to a plain dot rather than drawing a barb or a
 * direction tick out of nothing.
 *
 * A CROWDED VIEW DOES NOT TURN INTO NOISE. Two stations that land within a
 * few pixels of each other on screen draw once, not twice on top of each
 * other.
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

console.log('\n1. the overlay is wired in, end to end');
{
  ok('there is a pill for it, with a drag handle',
     /<div class="ov-pill" id="op-metar" data-ovid="metar"[\s\S]{0,300}class="ov-drag" title="Drag to reorder"/.test(PAGE));
  ok('clicking it reaches the toggle',
     /onclick="toggleOverlayPill\('metar'\)"/.test(PAGE));
  ok('the toggle starts and stops the layer',
     /id === 'metar'\) \{\s*\n\s*if \(_metarActive\) _metarStop\(\); else _metarStart\(\);/.test(PAGE));
  ok('the toggle no longer shows a floating picker panel of its own',
     !/metar-controls/.test(PAGE));
  ok('the pill lights up with the layer',
     /op-metar'\);\s*\n\s*if \(pill\) pill\.classList\.toggle\('active', _metarActive\)/.test(PAGE));
  ok('and an explanation in the overlay descriptions, pointing at Settings now',
     /'metar':\s+'Live surface observations/.test(PAGE)
     && /'metar':[\s\S]{0,260}Settings > Display > METAR Station Symbol/.test(PAGE));
  // Every overlay pill gets its info button injected automatically, but
  // only when OV_DESCRIPTIONS actually has an entry for its id - this is
  // the general form of a bug that once shipped for two other overlays
  // (rotation, hail) with no way to tell from the row alone.
  const ovBlock = (PAGE.match(/OV_DESCRIPTIONS = \{[\s\S]*?\n\};/) || [''])[0];
  ok('the info button will actually find that entry',
     new RegExp("'metar':\\s+'").test(ovBlock));
  ok('the style choice lives in Settings > Display, with the real four options',
     /<span class="lqm-settings-lbl">METAR Station Symbol<\/span>\s*\n\s*<select id="lqm-set-metarstyle" class="lqm-settings-select" onchange="_metarPickStyle\(this\.value\)">/.test(PAGE)
     && /id="lqm-set-metarstyle"[\s\S]{0,260}<option value="dot">/.test(PAGE)
     && /id="lqm-set-metarstyle"[\s\S]{0,260}<option value="temp">/.test(PAGE)
     && /id="lqm-set-metarstyle"[\s\S]{0,260}<option value="barb">/.test(PAGE)
     && /id="lqm-set-metarstyle"[\s\S]{0,260}<option value="temp-wind">/.test(PAGE));
  ok('opening Settings syncs that select to the saved style',
     /_metarSyncStyleSelect\(\);/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-metar-stations.mjs'), 'utf8').includes(EM));
}

console.log('\n2. the data: the service\'s own field names, converted honestly');
{
  ok('the fetch asks for every field, so one this code does not read can never break it',
     /outFields=\*&f=geojson&resultRecordCount=9999/.test(PAGE));
  ok('the fetch no longer names a STATION field, which the service does not have',
     !/outFields=TEMP,WIND_DIRECT,WIND_SPEED,WIND_GUST,STATION/.test(PAGE));
  ok('the station name reads the field the service actually has, with an ICAO fallback',
     /name: p\.STATION_NAME \|\| p\.ICAO \|\| null/.test(PAGE));
  ok('WIND_SPEED and WIND_GUST are converted from km\\/h to knots before use',
     /const _METAR_KT_PER_KMH = 0\.539957;/.test(PAGE)
     && /windKt:\s*p\.WIND_SPEED\s*!= null \? p\.WIND_SPEED\s*\* _METAR_KT_PER_KMH : null/.test(PAGE));
  ok('a station missing a field is left null, not guessed at',
     /windDir: p\.WIND_DIRECT != null \? p\.WIND_DIRECT : null/.test(PAGE));
  ok('the existing city-dot consumer of this same fetch is untouched',
     /function _nearestTemp\(lat, lng\) \{\s*\n\s*if \(!_metarStations\?\.length\) return null;/.test(PAGE));
}

console.log('\n3. four symbols, and what each one is allowed to draw');
{
  ok('dot: a filled, stroked circle, colored by temperature',
     /function _metarDrawDot\(ctx, x, y, s\) \{\s*\n\s*ctx\.fillStyle = tempColor\(s\.tempF\);/.test(PAGE));
  ok('temp: the number itself, with a dark halo so it reads over anything',
     /function _metarDrawTemp[\s\S]{0,300}shadowColor = 'rgba\(0,0,0,0\.85\)'/.test(PAGE));
  ok('barb: reuses the exact Wind Barbs glyph rather than a second copy of it',
     /function _metarDrawBarb[\s\S]{0,400}_barbGlyph\(x, y, u, v, s\.windKt, tempColor\(s\.tempF\), s\.lat < 0 \? -1 : 1\)/.test(PAGE)
     || /function _metarDrawBarb[\s\S]{0,400}_barbGlyph\(ctx, x, y, u, v, s\.windKt, tempColor\(s\.tempF\), s\.lat < 0 \? -1 : 1\)/.test(PAGE));
  ok('barb falls back to a plain dot when there is no wind to draw',
     /function _metarDrawBarb\(ctx, x, y, s\) \{\s*\n\s*if \(s\.windDir == null \|\| s\.windKt == null\) \{ _metarDrawDot\(ctx, x, y, s\); return; \}/.test(PAGE));
  ok('barb converts FROM-direction to a TOWARD vector before handing it to the glyph',
     /const u = -Math\.sin\(rad\), v = -Math\.cos\(rad\);/.test(PAGE));
  ok('temp-wind: a colored circle, a direction tick, and the number underneath',
     /function _metarDrawTempWind[\s\S]{0,900}fillText\(Math\.round\(s\.tempF\)/.test(PAGE));
  ok('the dispatcher covers all four styles plus an honest fallback',
     /function _metarSymbol\(ctx, x, y, s\) \{\s*\n\s*if \(_metarStyle === 'temp'\)/.test(PAGE)
     && /else _metarDrawDot\(ctx, x, y, s\);/.test(PAGE));
}

console.log('\n4. a crowded view does not turn into overlapping noise');
{
  ok('symbols closer than the minimum gap are skipped, not stacked',
     /const METAR_MIN_GAP_PX = 26;/.test(PAGE)
     && /dx \* dx \+ dy \* dy < METAR_MIN_GAP_PX \* METAR_MIN_GAP_PX/.test(PAGE));
  ok('stations off screen are skipped before any of that math runs',
     /if \(x < -24 \|\| x > w \+ 24 \|\| y < -24 \|\| y > h \+ 24\) continue;/.test(PAGE));
}

console.log('\n5. it goes quiet during a zoom, the same pattern Wind Barbs uses');
{
  ok('zoomstart hides the canvas rather than redrawing every frame of the gesture',
     /map\.on\('zoomstart', \(\) => \{ if \(_metarCanvas\) _metarCanvas\.style\.visibility = 'hidden'; \}\);/.test(PAGE));
  ok('zoomend brings it back and redraws once, after the gesture settles',
     /map\.on\('zoomend', \(\) => \{\s*\n\s*if \(!_metarCanvas\) return;\s*\n\s*_metarCanvas\.style\.visibility = '';\s*\n\s*if \(_metarActive\) _metarDraw\(\);/.test(PAGE));
}

console.log('\n6. it does not leak when switched off');
{
  ok('the refresh timer is cleared on stop',
     /function _metarStop\(\) \{\s*\n\s*_metarActive = false;\s*\n\s*clearInterval\(_metarRefreshTimer\);/.test(PAGE));
  ok('the canvas is cleared rather than left showing a stale snapshot',
     /_metarStop\(\)[\s\S]{0,260}clearRect\(0, 0, _metarCanvas\.width/.test(PAGE));
  ok('and hidden', /_metarStop\(\)[\s\S]{0,320}display = 'none';/.test(PAGE));
  ok('a redraw after stopping is a no-op',
     /function _metarDraw\(\) \{\s*\n\s*if \(!_metarActive/.test(PAGE));
  ok('a fetch that lands after stopping does not repaint either',
     /await _getMetarStations\(\);\s*\n\s*if \(!_metarActive\) return;/.test(PAGE));
}

console.log('\n7. the style choice is remembered, and the select agrees with it');
{
  ok('the choice is saved under its own key', /const METAR_STYLE_KEY = 'gwcfc_metar_style';/.test(PAGE));
  ok('only a real style is ever accepted, from storage or from a pick',
     /\['dot', 'temp', 'barb', 'temp-wind'\]\.includes\(saved\)/.test(PAGE)
     && /function _metarPickStyle\(style\) \{\s*\n\s*if \(!\['dot', 'temp', 'barb', 'temp-wind'\]\.includes\(style\)\) return;/.test(PAGE));
  ok('picking one redraws immediately if the layer is already on',
     /_metarPickStyle\(style\)[\s\S]{0,220}if \(_metarActive\) _metarDraw\(\);/.test(PAGE));
  ok('picking one syncs the Settings select to match',
     /function _metarPickStyle\(style\)[\s\S]{0,260}_metarSyncStyleSelect\(\);/.test(PAGE));
  ok('the sync function sets the select value, not a set of button classes',
     /function _metarSyncStyleSelect\(\) \{\s*\n\s*const sel = document\.getElementById\('lqm-set-metarstyle'\);\s*\n\s*if \(sel\) sel\.value = _metarStyle;/.test(PAGE));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

console.log('\n8. the drawing, run against a real canvas');
{
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  // Pull the four drawing functions and the dispatcher straight out of the
  // page, so this tests the shipped source rather than a copy of it - same
  // approach test-wind-barbs.mjs uses for _barbGlyph.
  const grab = (name) => (PAGE.match(new RegExp(
    'function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}')) || [])[0];
  const srcDot = grab('_metarDrawDot');
  const srcTemp = grab('_metarDrawTemp');
  const srcBarb = grab('_metarDrawBarb');
  const srcTW = grab('_metarDrawTempWind');
  const srcTempColor = grab('tempColor');
  const srcBarbGlyph = grab('_barbGlyph');
  const calm = Number((PAGE.match(/const BARB_CALM_KT = ([0-9.]+)/) || [])[1]);
  ok('all five source functions were found in the page',
     !!srcDot && !!srcTemp && !!srcBarb && !!srcTW && !!srcTempColor && !!srcBarbGlyph);

  if (srcDot && srcTemp && srcBarb && srcTW && srcTempColor && srcBarbGlyph) {
    const r = await p.evaluate(({ srcDot, srcTemp, srcBarb, srcTW, srcTempColor, srcBarbGlyph, calm }) => {
      const mk = () => {
        const log = [];
        const ctx = {
          save() { log.push(['save']); }, restore() { log.push(['restore']); },
          beginPath() { log.push(['beginPath']); },
          moveTo(x, y) { log.push(['moveTo', x, y]); },
          lineTo(x, y) { log.push(['lineTo', x, y]); },
          closePath() { log.push(['closePath']); },
          stroke() { log.push(['stroke']); }, fill() { log.push(['fill']); },
          arc(x, y, rr) { log.push(['arc', x, y, rr]); },
          fillText(t, x, y) { log.push(['fillText', t, x, y]); },
          translate(x, y) { log.push(['translate', x, y]); },
          rotate(a) { log.push(['rotate', a]); },
          set fillStyle(v) { log.push(['fillStyle', v]); },
          set strokeStyle(v) { log.push(['strokeStyle', v]); },
          set lineWidth(v) {}, set lineCap(v) {}, set font(v) {},
          set shadowColor(v) {}, set shadowBlur(v) { log.push(['shadowBlur', v]); },
        };
        return { ctx, log };
      };
      // eslint-disable-next-line no-eval
      const tempColor = eval('(' + srcTempColor + ')');
      const _barbGlyph = eval('(function(){const BARB_CALM_KT=' + calm + ';return (' + srcBarbGlyph + ');})()');
      const _metarDrawDot = eval('(' + srcDot + ')');
      const _metarDrawTemp = eval('(function(){ const tempColor=arguments[0]; return (' + srcTemp + '); })')(tempColor);
      const _metarDrawBarb = eval(
        '(function(){ const tempColor=arguments[0], _barbGlyph=arguments[1], _metarDrawDot=arguments[2]; return (' + srcBarb + '); })'
      )(tempColor, _barbGlyph, _metarDrawDot);
      const _metarDrawTempWind = eval('(function(){ const tempColor=arguments[0]; return (' + srcTW + '); })')(tempColor);

      const dot = mk(); _metarDrawDot(dot.ctx, 10, 10, { tempF: 70 });
      const temp = mk(); _metarDrawTemp(temp.ctx, 10, 10, { tempF: 72.4 });
      const barbNoWind = mk(); _metarDrawBarb(barbNoWind.ctx, 10, 10, { tempF: 70, windDir: null, windKt: null, lat: 40 });
      const barbWind = mk(); _metarDrawBarb(barbWind.ctx, 10, 10, { tempF: 70, windDir: 270, windKt: 20, lat: 40 });
      const tw = mk(); _metarDrawTempWind(tw.ctx, 10, 10, { tempF: 55, windDir: 90 });
      const twNoWind = mk(); _metarDrawTempWind(twNoWind.ctx, 10, 10, { tempF: 55, windDir: null });

      return {
        dot: { arcs: dot.log.filter(e => e[0] === 'arc').length,
               fills: dot.log.filter(e => e[0] === 'fill').length,
               strokes: dot.log.filter(e => e[0] === 'stroke').length },
        temp: { texts: temp.log.filter(e => e[0] === 'fillText').map(e => e[1]) },
        barbNoWind: { arcs: barbNoWind.log.filter(e => e[0] === 'arc').length,
                      rotates: barbNoWind.log.filter(e => e[0] === 'rotate').length },
        barbWind: { rotates: barbWind.log.filter(e => e[0] === 'rotate').length,
                    fillTexts: barbWind.log.filter(e => e[0] === 'fillText').length },
        tw: { arcs: tw.log.filter(e => e[0] === 'arc').length,
              texts: tw.log.filter(e => e[0] === 'fillText').map(e => e[1]),
              lines: tw.log.filter(e => e[0] === 'lineTo').length },
        twNoWind: { arcs: twNoWind.log.filter(e => e[0] === 'arc').length,
                    lines: twNoWind.log.filter(e => e[0] === 'lineTo').length },
      };
    }, { srcDot, srcTemp, srcBarb, srcTW, srcTempColor, srcBarbGlyph, calm });

    ok('dot draws exactly one filled, stroked circle',
       r.dot.arcs === 1 && r.dot.fills === 1 && r.dot.strokes === 1, JSON.stringify(r.dot));
    ok('temp prints the rounded temperature with a degree sign',
       r.temp.texts.length === 1 && r.temp.texts[0] === '72°', JSON.stringify(r.temp));
    ok('barb with no wind data falls back to the plain dot (a circle, no rotation)',
       r.barbNoWind.arcs === 1 && r.barbNoWind.rotates === 0, JSON.stringify(r.barbNoWind));
    ok('barb with real wind data actually rotates a glyph, not a dot',
       r.barbWind.rotates === 1, JSON.stringify(r.barbWind));
    ok('temp-wind draws its circle, its direction tick, and one label',
       r.tw.arcs === 1 && r.tw.lines === 1 && r.tw.texts.length === 1 && r.tw.texts[0] === '55°',
       JSON.stringify(r.tw));
    ok('temp-wind with no direction skips the tick but keeps the circle and label',
       r.twNoWind.arcs === 1 && r.twNoWind.lines === 0, JSON.stringify(r.twNoWind));
  }
  await b.close();
}

console.log('\n9. live in the browser: toggling the overlay, and the declutter');
{
  const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
  await p.addInitScript(() => {
    try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
  });
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
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4200);

  const r = await p.evaluate(async () => {
    const wait = ms => new Promise(res => setTimeout(res, ms));
    const center = map.getCenter();
    toggleOverlayPill('metar');
    await wait(300);
    const on = {
      active: _metarActive,
      pillLit: document.getElementById('op-metar').classList.contains('active'),
      canvasShown: !!document.getElementById('metar-canvas')
        && getComputedStyle(document.getElementById('metar-canvas')).display !== 'none',
      // Nothing left over from the retired floating panel, this run or any
      // earlier one: no stray element with its old id still in the page.
      noOldPanel: !document.getElementById('metar-controls'),
    };
    // Two stations a few metres apart (well under the declutter gap on
    // screen at any real zoom) plus one placed a fixed 200 screen pixels
    // away - chosen in pixel space rather than degrees so this does not
    // depend on whatever zoom the map happens to boot at - so a redraw
    // proves the crowded pair collapses to one symbol while the clearly
    // separate station still gets its own. Set after the overlay is
    // already on, since _metarStart's own load would otherwise be racing
    // to overwrite this with whatever its (aborted, in this test) fetch
    // settles to.
    const centerPt = map.latLngToContainerPoint(center);
    const farLL = map.containerPointToLatLng([centerPt.x + 200, centerPt.y]);
    _metarStations = [
      { lat: center.lat, lng: center.lng, tempF: 70, windDir: 200, windKt: 15, gustKt: 20, name: 'AAA' },
      { lat: center.lat + 0.0005, lng: center.lng + 0.0005, tempF: 71, windDir: 210, windKt: 12, gustKt: 18, name: 'BBB' },
      { lat: farLL.lat, lng: farLL.lng, tempF: 40, windDir: null, windKt: null, gustKt: null, name: 'CCC' },
    ];
    const realSymbol = _metarSymbol;
    let symbolCalls = 0;
    _metarSymbol = (...args) => { symbolCalls++; return realSymbol(...args); };
    _metarDraw();
    const declutter = { drawnFromThree: symbolCalls };
    _metarSymbol = realSymbol;
    // Style picking, live, through the Settings select rather than a
    // floating panel button.
    lqmOpenSettings();
    const sel = document.getElementById('lqm-set-metarstyle');
    sel.value = 'temp';
    sel.dispatchEvent(new Event('change'));
    const styleOn = {
      style: _metarStyle,
      saved: localStorage.getItem('gwcfc_metar_style'),
      selectAgrees: sel.value === 'temp',
    };
    toggleOverlayPill('metar');
    await wait(150);
    const off = {
      active: _metarActive,
      pillLit: document.getElementById('op-metar').classList.contains('active'),
      canvasShown: getComputedStyle(document.getElementById('metar-canvas')).display !== 'none',
    };
    return { on, declutter, styleOn, off };
  });
  ok('turning it on lights the pill and shows the canvas, with no floating panel',
     r.on.active && r.on.pillLit && r.on.canvasShown && r.on.noOldPanel, JSON.stringify(r.on));
  ok('a real redraw of three stations, two of them crowded, draws two symbols, not three',
     r.declutter.drawnFromThree === 2, JSON.stringify(r.declutter));
  ok('picking a style from the Settings select updates state, storage and the select together',
     r.styleOn.style === 'temp' && r.styleOn.saved === 'temp' && r.styleOn.selectAgrees,
     JSON.stringify(r.styleOn));
  ok('turning it back off drops the pill and the canvas',
     !r.off.active && !r.off.pillLit && !r.off.canvasShown, JSON.stringify(r.off));
  ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close();
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
