#!/usr/bin/env node
/*
 * Every layer button, pressed.
 *
 *     node tools/test-layer-buttons.mjs
 *
 * The eight menu bubbles, every product row beneath them three levels deep,
 * and all the overlay pills are driven one by one in a real browser with no
 * network. A row must do one of three honest things when tapped: open a
 * deeper level (with a Back row that is only a Back row), light up (and go
 * dark again on the second tap), or open its modal. The only rows allowed to
 * do none of those are the ones that need the Pi, which is unreachable here
 * and says so in a toast: RTMA, and the Pi-built sea temperature fields.
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

console.log('\n1. the fixes are in the page');
{
  ok('every hand-built Back row is marked as navigation',
     PAGE.split("back.className = 'sub-bubble sb-back';").length >= 7
     && !PAGE.includes("back.className = 'sub-bubble';"));
  ok('the NWS rows attach their own info button, and every one has words',
     /function _nwsAppendRows\([\s\S]*?_makeInfoBtn\(_sbDescribe\(el\)\)/.test(PAGE)
     && ['temperature-temp', 'temperature-dew', 'temperature-maxt', 'temperature-rh',
         'wind-wind', 'wind-gust', 'wind-wdir', 'pressure-pres', 'radar-pop12',
         'radar-qpf', 'radar-snow', 'radar-wx', 'waves-waveh', 'air-vis', 'air-sky',
         'air-ceil'].every(k => PAGE.includes(`'nws-${k}':`)));
  ok('a sea temperature variant can be tapped off, and lights only when drawn',
     PAGE.includes('if (_sstOn && _sstSource === source && _sstVariant === v) {')
     && PAGE.includes("!!_sstOn && x.id === 'sub-sstvar-' + v"));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-layer-buttons.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
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
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n2. every bubble and every row beneath it, three levels deep');
const walk = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wrap = () => document.getElementById('sub-bubbles');
  const all = () => [...wrap().querySelectorAll('.sub-bubble')];
  const isBack = el => el.classList.contains('sb-back');
  const rows = () => all().filter(el => !isBack(el) && !el.classList.contains('sb-note'));
  const label = el => (el.querySelector('.sb-label') || el).textContent.trim();
  const sig = () => rows().map(label).join('|');
  const back = () => all().find(isBack) || null;
  const tm = () => document.getElementById('tm-modal');
  const out = { rows: [], badBacks: [], strayBacks: [], modals: 0 };

  const noteBacks = () => {
    all().forEach(el => {
      if (isBack(el) && el.querySelector('.ov-info-btn, .sb-drag')) out.badBacks.push(label(el));
      if (!isBack(el) && /^Back\b/.test(label(el))) out.strayBacks.push(label(el));
    });
  };

  async function level(path, depth) {
    noteBacks();
    const before = sig();
    const n = rows().length;
    for (let i = 0; i < n; i++) {
      const el = rows()[i];
      if (!el) break;
      const name = path + ' > ' + label(el);
      const id = el.id || '';
      const had = el.classList.contains('active');
      try { el.click(); } catch (e) { out.rows.push({ name, err: String(e).slice(0, 120) }); continue; }
      await sleep(320);
      const r = { name, id, had, navigated: false, lit: null, offAgain: null, modal: false };
      if (tm() && tm().classList.contains('open')) {
        r.modal = true; out.modals++;
        tm().classList.remove('open');
      }
      if (sig() !== before && rows().length && back()) {
        r.navigated = true;
        if (depth < 3) await level(name, depth + 1);
        const bk = back();
        if (bk) { bk.click(); await sleep(220); }
      } else {
        const same = rows()[i];
        r.lit = same ? same.classList.contains('active') : null;
        if (same && r.lit && !had && !/^radar/.test(path)) {
          same.click(); await sleep(220);
          r.offAgain = !(rows()[i] && rows()[i].classList.contains('active'));
        }
      }
      out.rows.push(r);
      if (sig() !== before) { renderSubBubbles('regular'); await sleep(120); return; }
    }
  }

  renderSubBubbles('regular');
  await sleep(150);
  const tops = rows().map(el => el.id.replace(/^sub-/, ''));
  out.tops = tops;
  for (const id of tops) {
    renderSubBubbles('regular');
    await sleep(120);
    const el = document.getElementById('sub-' + id);
    el.click();
    await sleep(450);
    const opened = !!back();
    out.rows.push({ name: id, top: true, opened });
    if (opened) await level(id, 1);
    renderSubBubbles('regular');
    await sleep(120);
  }
  return out;
});
{
  const tops = walk.rows.filter(r => r.top);
  ok('all eight bubbles open their menus',
     walk.tops.length === 8 && tops.every(r => r.opened),
     JSON.stringify(walk.tops) + ' ' + JSON.stringify(tops.filter(r => !r.opened).map(r => r.name)));
  const subs = walk.rows.filter(r => !r.top);
  ok('well over a hundred rows were pressed', subs.length >= 110, String(subs.length));
  ok('none of them threw', subs.every(r => !r.err) && errs.length === 0,
     JSON.stringify(subs.filter(r => r.err).slice(0, 3)) + ' ' + errs.slice(0, 2).join(' | '));
  // A row that neither opened a level, nor lit, nor opened a modal, must be
  // one that needs the Pi: RTMA (id sub-nws-*, or the RTMA choice on a
  // two-source screen) or a Pi-built sea temperature field (sub-sstvar-*).
  const needsPi = r => /^sub-nws-/.test(r.id) || /^sub-sstvar-/.test(r.id)
    || /> RTMA$/.test(r.name) || /^radar > Level 3 >/.test(r.name);
  const dead = subs.filter(r => !r.navigated && !r.lit && !r.modal && !needsPi(r));
  ok('every other row opened a level, lit up, or opened its modal',
     dead.length === 0, JSON.stringify(dead.map(r => r.name).slice(0, 8)));
  const stuck = subs.filter(r => r.offAgain === false);
  ok('and every row that lit went dark again on the second tap',
     stuck.length === 0, JSON.stringify(stuck.map(r => r.name).slice(0, 8)));
  ok('the Time Machine rows open the Time Machine', walk.modals >= 3, String(walk.modals));
  ok('no Back row carries an info button or a drag handle',
     walk.badBacks.length === 0, JSON.stringify(walk.badBacks.slice(0, 5)));
  ok('and no Back row is missing its sb-back mark',
     walk.strayBacks.length === 0, JSON.stringify(walk.strayBacks.slice(0, 5)));
}

console.log('\n3. the radar source row and the NWS rows inside it');
{
  const r = await p.evaluate(() => {
    toggleRadarSub();
    const subs = [...document.querySelectorAll('#sub-bubbles .sub-bubble')]
      .filter(el => !el.classList.contains('sb-back'));
    return {
      labels: subs.map(el => (el.querySelector('.sb-label') || el).textContent.trim()),
      infos: subs.filter(el => el.querySelector('.ov-info-btn')).length,
      nwsWords: subs.filter(el => /^sub-nws-/.test(el.id)).map(el => {
        const btn = el.querySelector('.ov-info-btn');
        if (!btn) return '';
        btn.click();
        const t = document.getElementById('ov-info-tooltip');
        const txt = t ? t.textContent : '';
        btn.click();
        return txt;
      }),
    };
  });
  ok('the sources, the Time Machine and the four NDFD rows are all there',
     ['Normal', 'Level 2', 'Level 3', 'Composite', 'Time Machine', 'Precip Chance',
      'Precip Amount', 'Snow Amount', 'Weather Type']
       .every(l => r.labels.some(x => x.startsWith(l))), JSON.stringify(r.labels));
  ok('every row carries its info button the moment the menu is built',
     r.infos === r.labels.length, `${r.infos} of ${r.labels.length}`);
  ok('and the NWS rows explain themselves in real words, not the fallback',
     r.nwsWords.length === 4 && r.nwsWords.every(t => /NWS forecast/.test(t)
       && !/No description has been written/.test(t)),
     JSON.stringify(r.nwsWords.map(t => t.slice(0, 40))));
}

console.log('\n4. a sea temperature variant row keeps the product-row bargain');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const src = Object.keys(SST_VARIANT_ROW).find(k => (SST_VARIANT_ROW[k] || []).length > 1);
    const realEnable = _sstEnable, realDisable = _sstDisable;
    const out = { src };
    // The Pi has nothing: the row must stay dark.
    _sstEnable = async () => { _sstOn = false; };
    toggleSstVariantSub(src);
    let row = document.querySelector('#sub-bubbles [id^="sub-sstvar-"]');
    row.click(); await sleep(60);
    out.darkWhenNothingDrawn = !row.classList.contains('active');
    // The Pi answers: the row lights, and a second tap turns it off.
    _sstEnable = async (s, v) => { _sstOn = true; _sstSource = s; _sstVariant = v; };
    let disables = 0;
    _sstDisable = () => { disables++; _sstOn = false; };
    toggleSstVariantSub(src);
    row = document.querySelector('#sub-bubbles [id^="sub-sstvar-"]');
    row.click(); await sleep(60);
    out.litWhenDrawn = row.classList.contains('active');
    row.click(); await sleep(60);
    out.offOnSecondTap = !row.classList.contains('active') && disables === 1;
    _sstEnable = realEnable; _sstDisable = realDisable; _sstOn = false;
    renderSubBubbles('regular');
    return out;
  });
  ok('with nothing drawn the row stays dark', r.darkWhenNothingDrawn, JSON.stringify(r));
  ok('with a picture drawn it lights', r.litWhenDrawn, JSON.stringify(r));
  ok('and tapping it again turns the layer off', r.offOnSecondTap, JSON.stringify(r));
}

console.log('\n5. every overlay pill flips, and flips back');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const out = [];
    for (const el of [...document.querySelectorAll('.ov-pill[id^="op-"]')]) {
      const id = el.id.slice(3);
      const start = el.classList.contains('active');
      let err = null;
      try { toggleOverlayPill(id); } catch (e) { err = String(e).slice(0, 100); }
      await sleep(200);
      const a = el.classList.contains('active');
      try { toggleOverlayPill(id); } catch (e) { err = err || String(e).slice(0, 100); }
      await sleep(200);
      const bEnd = el.classList.contains('active');
      out.push({ id, start, flipped: a !== start, restored: bEnd === start, err });
    }
    return out;
  });
  ok('there are dozens of pills', r.length >= 34, String(r.length));
  ok('none threw', r.every(x => !x.err) && errs.length === 0,
     JSON.stringify(r.filter(x => x.err).slice(0, 3)));
  ok('every pill changes state on the first tap',
     r.every(x => x.flipped), JSON.stringify(r.filter(x => !x.flipped).map(x => x.id)));
  ok('and returns to where it started on the second',
     r.every(x => x.restored), JSON.stringify(r.filter(x => !x.restored).map(x => x.id)));
  ok('the three that are on by default started lit',
     ['alerts', 'forecasts', 'fronts'].every(id => r.find(x => x.id === id)?.start === true));
}

console.log('\n6. satellite sector pills and an info button');
{
  const r = await p.evaluate(() => {
    toggleSatelliteSub();
    const pills = [...document.querySelectorAll('#sat-region-row .sat-region-btn')];
    const out = { n: pills.length };
    if (pills.length > 1) {
      pills[1].click();
      out.moved = pills[1].classList.contains('active') && !pills[0].classList.contains('active');
      pills[0].click();
    }
    const info = document.querySelector('#sub-bubbles .ov-info-btn');
    info.click();
    const tip = document.getElementById('ov-info-tooltip');
    out.tipOpen = tip.classList.contains('open') && tip.textContent.length > 20;
    info.click();
    out.tipClosed = !tip.classList.contains('open');
    renderSubBubbles('regular');
    return out;
  });
  ok('the sector row offers several sectors and moves its light on a tap',
     r.n >= 2 && r.moved, JSON.stringify(r));
  ok('an info button opens its explanation and closes it again',
     r.tipOpen && r.tipClosed, JSON.stringify(r));
  ok('and nothing threw along the way', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
