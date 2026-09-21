#!/usr/bin/env node
/*
 * Export: a centred card, not a toolbar, and it saves the VIEW.
 *
 *     node tools/test-export-tool.mjs
 *
 * History: the old exporter was a draggable toolbar that fetched only the
 * raw data image - a transparent radar frame with no map under it - so the
 * file it saved looked like nothing, and model-only screens said "nothing
 * on screen". The redesign does two things:
 *   - it opens as a modal card (#export-modal / #export-card) with two big
 *     choices, Save Picture and Save Loop, instead of a strip of tool
 *     buttons
 *   - it captures the WHOLE view: every visible img/canvas/svg in the
 *     Leaflet panes composited in stacking order at its on-screen spot
 *     (_expComposeView), and the loop export steps through whatever
 *     _animSource() says the animation bar is playing, so every playable
 *     source exports, models included.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the card replaced the toolbar in the page');
{
  ok('the modal and card exist', /id="export-modal"/.test(PAGE) && /id="export-card"/.test(PAGE));
  ok('the old toolbar id is gone completely', !/export-toolbar/.test(PAGE));
  ok('the two choices read as sentences, not tool buttons',
     /Save Picture/.test(PAGE) && /Save Loop/.test(PAGE)
     && /exactly as you see it/.test(PAGE));
  ok('the loop export reads _animSource, the same list the bar plays',
     /_expLoopInfo/.test(PAGE) && /const src = _animSource\(\);/.test(PAGE));
  ok('the compose walks the leaflet panes in stacking order',
     /_expComposeView/.test(PAGE) && /\.leaflet-pane/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-export-tool.mjs'), 'utf8').includes(EM));
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**://**', route => {
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
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

console.log('\n2. the modal opens, closes, and closes from the scrim');
{
  const r = await page.evaluate(() => {
    const modal = document.getElementById('export-modal');
    const closedStart = !modal.classList.contains('open');
    _expToggle();
    const opened = modal.classList.contains('open')
      && getComputedStyle(modal).display === 'flex';
    const status = document.getElementById('export-status').textContent;
    document.getElementById('export-close').click();
    const closedByX = !modal.classList.contains('open');
    _expToggle();
    modal.click();   // the scrim itself: event.target === modal
    const closedByScrim = !modal.classList.contains('open');
    return { closedStart, opened, status, closedByX, closedByScrim };
  });
  ok('starts closed', r.closedStart);
  ok('toggling opens it as a centred flex modal', r.opened);
  ok('opening fills in the status line', r.status.length > 0, r.status);
  ok('the close button closes it', r.closedByX);
  ok('clicking the scrim closes it too', r.closedByScrim);
}

console.log('\n3. the status and buttons follow what the animation bar is playing');
{
  const r = await page.evaluate(() => {
    const orig = window._animSource;
    const read = () => ({
      status: document.getElementById('export-status').textContent,
      pngDisabled: document.getElementById('export-png-btn').disabled,
      videoDisabled: document.getElementById('export-video-btn').disabled,
    });
    window._animSource = () => null;
    _expRefreshStatus();
    const nothing = read();
    window._animSource = () => ({
      id: 'stub', times: [1, 2, 3, 4, 5].map(t => new Date(t)), idx: 2, first: 2 });
    _expRefreshStatus();
    const three = { ...read(), info: _expLoopInfo() };
    window._animSource = () => ({
      id: 'stub', times: [new Date()], idx: 0, first: 0 });
    _expRefreshStatus();
    const one = read();
    window._animSource = orig;
    _expRefreshStatus();
    return { nothing, three, one };
  });
  ok('with nothing looping the picture still saves, the loop does not',
     !r.nothing.pngDisabled && r.nothing.videoDisabled
     && /nothing is looping/i.test(r.nothing.status), JSON.stringify(r.nothing));
  ok('_expLoopInfo counts frames past the source\'s own first index',
     r.three.info.count === 3 && r.three.info.first === 2 && r.three.info.idx === 2,
     JSON.stringify(r.three.info));
  ok('a playing loop enables the loop download and says how many frames',
     !r.three.videoDisabled && /3 frames/.test(r.three.status), JSON.stringify(r.three));
  ok('a single frame is not a loop', r.one.videoDisabled, JSON.stringify(r.one));
}

console.log('\n4. the compose really captures what is on screen, where it is');
{
  const r = await page.evaluate(async () => {
    const pane = map.getPanes().overlayPane;
    const mk = (color, left) => {
      const c = document.createElement('canvas');
      c.width = 60; c.height = 60;
      const g = c.getContext('2d');
      g.fillStyle = color; g.fillRect(0, 0, 60, 60);
      c.style.cssText = `position:absolute;left:${left}px;top:140px;width:60px;height:60px;`;
      pane.appendChild(c);
      return c;
    };
    const shown = mk('#ff00ff', 140);
    const hidden = mk('#00ff00', 260);
    hidden.style.display = 'none';
    const out = await _expComposeView(new Map());
    const rect = map.getContainer().getBoundingClientRect();
    const scale = out.width / rect.width;
    const at = (el, dx, dy) => {
      const cr = el.getBoundingClientRect();
      return Array.from(out.getContext('2d').getImageData(
        Math.round((cr.left - rect.left + dx) * scale),
        Math.round((cr.top - rect.top + dy) * scale), 1, 1).data);
    };
    const mid = at(shown, 30, 30);
    // the hidden square's spot, measured from the shown one 120px over
    const ghost = at(shown, 150, 30);
    shown.remove(); hidden.remove();
    return { w: out.width, h: out.height, mid, ghost };
  });
  ok('the output canvas has real size', r.w > 100 && r.h > 100, r.w + 'x' + r.h);
  ok('a visible canvas lands at its on-screen spot',
     r.mid[0] === 255 && r.mid[1] === 0 && r.mid[2] === 255, JSON.stringify(r.mid));
  ok('a hidden element is left out', !(r.ghost[1] === 255 && r.ghost[0] === 0),
     JSON.stringify(r.ghost));
}

console.log('\n5. Save Picture downloads the view as a PNG');
{
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => _expDownloadPng()),
  ]);
  const filename = download.suggestedFilename();
  ok('a PNG downloads named gwcfc-view-*.png',
     /^gwcfc-view-\d+\.png$/.test(filename), filename);
  const status = await page.evaluate(() =>
    document.getElementById('export-status').textContent);
  ok('and the status says so', /picture saved/i.test(status), status);
}

console.log('\n6. Save Loop without MediaRecorder falls back to a numbered sequence');
{
  await page.evaluate(() => {
    window.__origCanRecord = _expCanRecordVideo;
    window.__origAnimSource = window._animSource;
    window.__seeks = [];
    window.__origSeekFrame = window.seekFrame;
    window.seekFrame = (i) => { window.__seeks.push(i); };
    _expCanRecordVideo = () => false;   // force the fallback deterministically
    window._animSource = () => ({
      id: 'stub', times: [1, 2, 3, 4].map(t => new Date(t)), idx: 3, first: 1 });
  });
  const downloads = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));
  await page.evaluate(() => _expDownloadVideo());
  await page.waitForTimeout(1200);
  page.removeAllListeners('download');
  const seeks = await page.evaluate(() => {
    const s = window.__seeks;
    _expCanRecordVideo = window.__origCanRecord;
    window._animSource = window.__origAnimSource;
    window.seekFrame = window.__origSeekFrame;
    return s;
  });
  ok('one PNG per loop frame downloads, numbered in order',
     downloads.length === 3
     && /frame-001\.png$/.test(downloads[0])
     && /frame-002\.png$/.test(downloads[1])
     && /frame-003\.png$/.test(downloads[2]),
     JSON.stringify(downloads));
  ok('it seeks from the source\'s first frame and puts the loop back after',
     seeks.length === 4 && seeks[0] === 1 && seeks[2] === 3 && seeks[3] === 3,
     JSON.stringify(seeks));
}

console.log('\n7. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
