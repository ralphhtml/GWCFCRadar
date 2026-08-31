#!/usr/bin/env node
/*
 * Does the tutorial describe THIS app?
 *
 *     node tools/audit-tutorial.mjs
 *
 * A tutorial is the one piece of an app that can rot without anything
 * breaking: a feature is renamed or removed, the tutorial keeps describing
 * it, and the only person who finds out is somebody following it.
 *
 * So this builds the app's real inventory from a running page (every bubble
 * label, every settings control, every tool button, every panel, every bound
 * shortcut) and then reads the tutorial's own bolded terms back against it.
 * It reports rather than asserts, because judging whether "Alert Timeline
 * Bar" means #alert-timeline is a person's job; finding the fifty candidates
 * is not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2600);

const inv = await p.evaluate(() => {
  const out = { bubbles: [], settings: [], tools: [], panels: [], shortcuts: [], overlays: [] };
  const push = (a, v) => { v = (v || '').trim(); if (v && a.indexOf(v) < 0) a.push(v); };
  // Left menu, every tab.
  try {
    Object.keys(TAB_BUBBLES || {}).forEach(t =>
      (TAB_BUBBLES[t] || []).forEach(x => push(out.bubbles, x.label)));
  } catch (e) {}
  ['RADAR_SUB_BUBBLES', 'RADAR_L2_BUBBLES', 'RADAR_SOURCE_BUBBLES', 'WIND_SUB_BUBBLES',
   'WAVES_SUB_BUBBLES', 'TEMPERATURE_SUB_BUBBLES', 'PRESSURE_SUB_BUBBLES', 'AIR_SUB_BUBBLES']
    .forEach(n => { try { (window[n] || []).forEach(x => push(out.bubbles, x.label)); } catch (e) {} });
  try { (GOES_PRODUCTS || []).forEach(x => push(out.bubbles, x.label)); } catch (e) {}
  // Overlay launcher rows.
  document.querySelectorAll('#overlay-list .lqm-order-name, #ov-list .ov-name')
    .forEach(e => push(out.overlays, e.textContent));
  try { (OVERLAY_ROWS || []).forEach(x => push(out.overlays, x.label)); } catch (e) {}
  // Settings: every label and every category.
  document.querySelectorAll('#lqm-set-content .lqm-settings-lbl')
    .forEach(e => push(out.settings, e.textContent));
  document.querySelectorAll('#lqm-set-content .lqm-settings-category')
    .forEach(e => push(out.settings, e.textContent));
  // Tool rail and toolbars.
  document.querySelectorAll('#right-menu .tool-btn, .dtb-btn, #animbar button')
    .forEach(e => push(out.tools, e.getAttribute('title') || e.textContent));
  // Panels that exist as elements.
  document.querySelectorAll('[id$="-panel"], [id$="-modal"], [id$="-overlay"], [id$="-toolbar"]')
    .forEach(e => push(out.panels, e.id));
  try { (KBD_ACTIONS || []).forEach(a => push(out.shortcuts, a.label)); } catch (e) {}
  return out;
});
await b.close();

// The tutorial's own claims: every bolded term, which is how it names things.
const start = PAGE.indexOf('<div id="tut-modal-body">');
const stop = PAGE.indexOf('id="tut-dialog-footer"', start);
const tut = PAGE.slice(start, stop > 0 ? stop : start + 90000);
const bold = [...tut.matchAll(/<strong>(.*?)<\/strong>/gs)]
  .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
  .filter(t => t && t.length < 44);

const all = [].concat(inv.bubbles, inv.settings, inv.tools, inv.panels,
                      inv.shortcuts, inv.overlays).map(s => s.toLowerCase());
const hay = all.join(' | ');
const norm = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

const seen = new Set(), missing = [];
bold.forEach(t => {
  const n = norm(t);
  if (!n || n.length < 4 || seen.has(n)) return;
  seen.add(n);
  // Prose, not a UI name.
  if (/^(the|a|an|and|or|not|note|tip|new|important|warning|never|always)\b/.test(n)) return;
  if (n.split(' ').length > 6) return;
  if (hay.includes(n)) return;
  // Try the last two words, since the tutorial writes "the Radar bubble".
  const words = n.split(' ');
  for (let k = words.length; k >= 1; k--) {
    const sub = words.slice(0, k).join(' ');
    if (sub.length >= 4 && hay.includes(sub)) return;
  }
  missing.push(t);
});

console.log('\n=== APP INVENTORY ===');
Object.keys(inv).forEach(k => console.log(`  ${k.padEnd(10)} ${inv[k].length}`));
console.log('\n=== TUTORIAL BOLD TERMS: ' + seen.size + ' distinct ===');
console.log('\n=== NOT FOUND IN THE RUNNING APP (' + missing.length + ') ===');
missing.forEach(t => console.log('  ? ' + t));
