#!/usr/bin/env node
/*
 * Does the tutorial describe THIS app?
 *
 *     node tools/audit-tutorial.mjs            # the report
 *     node tools/audit-tutorial.mjs --json     # the inventory, for a diff
 *
 * A tutorial is the one piece of an app that can rot without anything
 * breaking: a feature is renamed or removed, the tutorial keeps describing
 * it, and the only person who finds out is somebody following it.
 *
 * THE FIRST VERSION OF THIS TOOL WAS WRONG, and wrong in the direction that
 * matters. It built its inventory by reading a handful of JavaScript
 * constants (TAB_BUBBLES, GOES_PRODUCTS, the settings labels) and never
 * opened a single menu. So every name that only exists once something is
 * clicked, every overlay pill, every model in the Models panel, every radar
 * source row, read as "not in the app" and got dismissed as noise. Seventy
 * real names sat in that noise.
 *
 * This version DRIVES THE PAGE. It clicks the overlay launcher, every bubble
 * in the left menu, every sub-bubble those open, every Settings tab, and the
 * panels behind the Models bubble, and it harvests the text that is actually
 * painted on screen at each step. What comes out is what a person would see,
 * which is the only fair thing to hold a tutorial to.
 *
 * It reports rather than asserts: judging whether "Alert Timeline Bar" means
 * #alert-timeline is a person's job. Finding the candidates is not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const JSON_OUT = process.argv.includes('--json');

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
p.on('dialog', d => d.dismiss().catch(() => {}));
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

const inv = await p.evaluate(async () => {
  const out = {
    bubbles: [], subBubbles: [], overlays: [], settings: [], settingsTabs: [],
    tools: [], panels: [], shortcuts: [], models: [], misc: []
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const push = (a, v) => {
    v = (v || '').replace(/\s+/g, ' ').trim();
    if (v && v.length < 60 && a.indexOf(v) < 0) a.push(v);
  };
  // Only what a person could actually read: zero-size or display:none text
  // is in the DOM but is not in the app.
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden'
        && parseFloat(s.opacity || '1') > 0.05;
  };
  const harvest = (root, into) => {
    (root || document).querySelectorAll(
      '.sub-bubble, .ov-pill, .lqm-settings-lbl, .lqm-settings-category, ' +
      '.mdl-name, .mdl-row, .lqm-label, .sub-label, .bubble-label, ' +
      'button, .pill, .chip, .tab, .seg-btn'
    ).forEach(e => {
      if (!shown(e)) return;
      const t = e.getAttribute('data-label') || e.textContent || e.getAttribute('title');
      push(into, t);
    });
  };

  // ── 1. the left menu, top level ────────────────────────────────────────
  document.querySelectorAll('#sub-bubbles .sub-bubble')
    .forEach(e => { if (shown(e)) push(out.bubbles, e.textContent); });
  try { (BASE_BUBBLES || []).forEach(x => push(out.bubbles, x.label)); } catch (e) {}

  // ── 2. every bubble's sub-rows, one level down ─────────────────────────
  // These are the names that only exist after a tap, which is exactly what
  // the old audit could not see.
  const openers = [
    'toggleRadarSub', 'toggleSatelliteSub', 'toggleWindSub', 'toggleWavesSub',
    'toggleTemperatureSub', 'togglePressureSub', 'toggleAirSub', 'toggleMrmsSub',
    'toggleModelsSub', 'toggleRadarSourceSub', 'toggleL2Sub'
  ];
  for (const fn of openers) {
    try {
      if (typeof window[fn] !== 'function') continue;
      window[fn]();
      await wait(180);
      document.querySelectorAll('#sub-bubbles .sub-bubble')
        .forEach(e => { if (shown(e)) push(out.subBubbles, e.textContent); });
    } catch (e) {}
  }
  // The lists behind those rows, read directly, so a row that needs data
  // loaded before it paints still counts.
  ['RADAR_SUB_BUBBLES', 'RADAR_L2_BUBBLES', 'RADAR_SOURCE_BUBBLES',
   'WIND_SUB_BUBBLES', 'WAVES_SUB_BUBBLES', 'TEMPERATURE_SUB_BUBBLES',
   'PRESSURE_SUB_BUBBLES', 'AIR_SUB_BUBBLES', 'MRMS_GROUPS', 'GOES_PRODUCTS',
   'SAT_KINDS', 'BASE_BUBBLES']
    .forEach(n => {
      try {
        const v = window[n];
        if (Array.isArray(v)) v.forEach(x => push(out.subBubbles, x && (x.label || x.name)));
        else if (v && typeof v === 'object')
          Object.values(v).forEach(g => (Array.isArray(g) ? g : [])
            .forEach(x => push(out.subBubbles, x && (x.label || x.name))));
      } catch (e) {}
    });

  // ── 3. the overlay launcher, opened ────────────────────────────────────
  try { toggleOverlayLauncher(); } catch (e) {}
  await wait(220);
  document.querySelectorAll('#overlay-pills-row .ov-rowname')
    .forEach(e => push(out.overlays, e.textContent));
  // The tooltip on each pill is the one-line description the app itself
  // gives the layer, so it is part of what the app says about itself.
  document.querySelectorAll('#overlay-pills-row .ov-pill').forEach(e => {
    const t = (e.getAttribute('title') || '').split(' - ')[0];
    push(out.overlays, t);
  });
  try { toggleOverlayLauncher(); } catch (e) {}

  // ── 4. Settings, every tab ─────────────────────────────────────────────
  try { lqmOpenSettings(); } catch (e) {}
  await wait(400);
  document.querySelectorAll('#lqm-set-content .lqm-settings-category')
    .forEach(e => push(out.settingsTabs, e.textContent));
  document.querySelectorAll('.lqm-set-tab, #lqm-set-rail .lqm-set-tab')
    .forEach(e => push(out.settingsTabs, e.textContent));
  // Walk the rail so per-tab controls that only render on demand are seen.
  const tabs = Array.from(document.querySelectorAll('#lqm-set-rail .lqm-set-tab'));
  for (const t of tabs) {
    try { t.click(); await wait(150); } catch (e) {}
    document.querySelectorAll('#lqm-set-content .lqm-settings-lbl')
      .forEach(e => { if (shown(e)) push(out.settings, e.textContent); });
    document.querySelectorAll('#lqm-set-content .lqm-settings-btn')
      .forEach(e => { if (shown(e)) push(out.settings, e.textContent); });
  }
  document.querySelectorAll('#lqm-set-content .lqm-settings-lbl')
    .forEach(e => push(out.settings, e.textContent));
  try { lqmCloseSettings(); } catch (e) {
    try { document.getElementById('lqm-settings-modal').style.display = 'none'; } catch (e2) {}
  }

  // ── 5. the model panels ────────────────────────────────────────────────
  ['MODELS_SUB_BUBBLES', 'HD_FIELDS', 'HD_MODELS', 'PR_MODELS', 'SPAG_MODELS',
   'ENS_MODELS', 'MODEL_LIST', 'AIC_MODELS']
    .forEach(n => {
      try {
        const v = window[n];
        if (Array.isArray(v)) v.forEach(x => push(out.models, x && (x.label || x.name || x.id)));
        else if (v && typeof v === 'object')
          Object.keys(v).forEach(k => push(out.models,
            (v[k] && (v[k].label || v[k].name)) || k));
      } catch (e) {}
    });
  for (const fn of ['openRunModelsPanel', 'openSpaghettiModelsPanel',
                    'openAiCyclonesPanel']) {
    try {
      if (typeof window[fn] !== 'function') continue;
      window[fn]();
      await wait(500);
      harvest(document, out.models);
      const close = fn.replace('open', 'close');
      if (typeof window[close] === 'function') window[close]();
      await wait(120);
    } catch (e) {}
  }

  // ── 6. the tool rail, the toolbars, the animation bar ──────────────────
  document.querySelectorAll('#right-menu .tool-btn').forEach(e =>
    push(out.tools, (e.getAttribute('title') || '').split(' , ')[0]));
  // The map style menu carries its names as bare text, no title attribute,
  // so nothing else here would see it.
  document.querySelectorAll('#map-style-menu .right-bubble')
    .forEach(e => push(out.tools, e.textContent));
  document.querySelectorAll('.dtb-btn, #animbar button, #anim-bar button')
    .forEach(e => push(out.tools, e.getAttribute('title') || e.textContent));
  document.querySelectorAll('.dtb-label').forEach(e => push(out.tools, e.textContent));

  // ── 7. the logo quick menu and the search bar ──────────────────────────
  try { lqmOpenMenu(); } catch (e) {}
  await wait(300);
  document.querySelectorAll('#logo-quick-menu .lqm-label')
    .forEach(e => push(out.misc, e.textContent));
  document.querySelectorAll('#lqm-search-star, #lqm-search-btn, #lqm-nav-btn')
    .forEach(e => push(out.misc, e.getAttribute('title') || e.getAttribute('aria-label')));

  // ── 8. panels that exist, and the shortcuts that are bound ─────────────
  document.querySelectorAll('[id$="-panel"], [id$="-modal"], [id$="-toolbar"], [id$="-overlay"]')
    .forEach(e => push(out.panels, e.id));
  try { (KBD_ACTIONS || []).forEach(a => push(out.shortcuts, a.label)); } catch (e) {}

  // ── 9. anything else with a title attribute that is on screen now ──────
  document.querySelectorAll('[title]').forEach(e => {
    if (!shown(e)) return;
    push(out.misc, (e.getAttribute('title') || '').split(' - ')[0].split(' , ')[0]);
  });
  return out;
});
await b.close();

// ── the tutorial's own claims: every bolded term ────────────────────────
const start = PAGE.indexOf('<div id="tut-modal-body">');
const stop = PAGE.indexOf('function openTutorial', start);
const tut = PAGE.slice(start, stop > 0 ? stop : start + 90000);
const bold = [...tut.matchAll(/<strong>(.*?)<\/strong>/gs)]
  .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
  .filter(t => t && t.length < 44);

// BOTH SIDES GET THE SAME TREATMENT. Normalising only the tutorial's terms
// was a bug that made "PM2.5" read as missing: the term became "pm25" while
// the inventory still held "pm2.5⠿" (the drag handle rides along in the
// row's textContent), and one never contains the other.
const norm = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const all = [].concat(inv.bubbles, inv.subBubbles, inv.overlays, inv.settings,
                      inv.settingsTabs, inv.tools, inv.panels, inv.shortcuts,
                      inv.models, inv.misc).map(norm);
const hay = all.join(' | ');

const seen = new Set(), missing = [];
bold.forEach(t => {
  const n = norm(t);
  if (!n || n.length < 4 || seen.has(n)) return;
  seen.add(n);
  if (/^(the|a|an|and|or|not|note|tip|new|important|warning|never|always)\b/.test(n)) return;
  if (n.split(' ').length > 6) return;
  if (hay.includes(n)) return;
  const words = n.split(' ');
  for (let k = words.length; k >= 1; k--) {
    const sub = words.slice(0, k).join(' ');
    if (sub.length >= 4 && hay.includes(sub)) return;
  }
  missing.push(t);
});

if (JSON_OUT) {
  console.log(JSON.stringify(inv, null, 1));
} else {
  console.log('\n=== WHAT THE RUNNING APP ACTUALLY SHOWS ===');
  Object.keys(inv).forEach(k => console.log(`  ${k.padEnd(13)} ${inv[k].length}`));
  console.log('\n=== TUTORIAL BOLD TERMS: ' + seen.size + ' distinct ===');
  console.log('\n=== CLAIMED BY THE TUTORIAL, NOT FOUND ON SCREEN (' + missing.length + ') ===');
  missing.forEach(t => console.log('  ? ' + t));
}
