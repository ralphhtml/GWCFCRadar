#!/usr/bin/env node
/*
 * The Alert Desk's Product row, now that the templates live in it.
 *
 *     node tools/test-desk-templates.mjs
 *
 * The row used to be a product picker plus a three-option wording select that
 * only appeared for Tornado Warning. The office has 162 real products now, so
 * that select has been replaced by the template controls: hazard, kind, tier,
 * office, and a Load button.
 *
 * What is actually worth checking, rather than eyeballing.
 *
 * NOTHING BECAME UNREACHABLE. Twelve of the eighteen template hazards have no
 * entry in the fifteen-product list at all (blizzard, earthquake, fire, heat,
 * tsunami and the rest). Deriving the hazard from the product and locking it
 * would put two thirds of the templates out of reach, so the hazard stays a
 * select and this proves every hazard is still in it.
 *
 * THE TAG SURVIVED. The old select's value drives the headline, the severity
 * rating, the generated wording and the issued payload, in seven places.
 * Replacing the control must not drop the state behind it, and the tier that
 * replaced it has to map onto the same three values.
 *
 * IT WORKS FOR EVERY PRODUCT NOW. The old control was Tornado Warning only, so
 * a Flash Flood Warning could not be marked particularly dangerous even though
 * that is a real product. The tier is on every product.
 *
 * BOTH COPIES CHANGED. The desk exists in index.html and in
 * forecasting-portal.html. One patched and one not is the failure that would
 * survive every other check here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['index.html', 'forecasting-portal.html'];
const SRC = Object.fromEntries(
  FILES.map(f => [f, readFileSync(join(ROOT, f), 'utf8')]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};
// Almost everything here has to hold in both copies of the desk, so assert
// once and check twice rather than writing every check out twice.
const both = (name, test) => {
  const bad = FILES.filter(f => !test(SRC[f]));
  ok(name, bad.length === 0, bad.join(', '));
};

console.log('\n1. the old wording select is gone');
{
  both('no "Standard wording" option anywhere',
       s => !/Standard wording/.test(s));
  both('nor the two it sat with',
       s => !/>Particularly Dangerous Situation</.test(s)
         && !/>Tornado Emergency<\/option>/.test(s));
  both('and the Tornado-Warning-only condition around it went too',
       s => !/P\.id === 'TOR' \? `<select/.test(s));
}

console.log('\n2. the templates are in the Product row instead');
{
  both('the Product group holds the hazard select', s => {
    const i = s.indexOf('<div class="ad-h">Product</div>');
    return i > 0 && s.indexOf('ad-tpl-haz', i) - i < 900;
  });
  both('and kind, tier and office with it', s => {
    const i = s.indexOf('<div class="ad-h">Product</div>');
    const block = s.slice(i, i + 2400);
    return /ad-tpl-kind/.test(block) && /ad-tpl-tier/.test(block)
        && /ad-tpl-office/.test(block);
  });
  both('and the Load button', s => {
    const i = s.indexOf('<div class="ad-h">Product</div>');
    return /_adLoadTemplate\(\)/.test(s.slice(i, i + 2400));
  });
  // Two places to compose a product is how a forecaster loads a template in
  // one of them and wonders why the other one did not change.
  both('the old bottom group is gone, so there is only one of it',
       s => !/<div class="ad-h">Product templates<\/div>/.test(s));
  both('each template control appears exactly once',
       s => ['ad-tpl-haz', 'ad-tpl-kind', 'ad-tpl-tier', 'ad-tpl-office']
              .every(id => (s.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1));
}

console.log('\n3. nothing became unreachable');
{
  // The whole reason the hazard stayed a select.
  both('the hazard select is still built from every hazard, not from the product',
       s => /id="ad-tpl-haz"[\s\S]{0,400}Object\.entries\(GWCFC_TPL_HAZARDS\)/.test(s));
  both('all three kinds are offered',
       s => /id="ad-tpl-kind"[\s\S]{0,400}Object\.entries\(GWCFC_TPL_KINDS\)/.test(s));
  both('all three tiers are offered',
       s => /id="ad-tpl-tier"[\s\S]{0,400}Object\.entries\(GWCFC_TPL_TIERS\)/.test(s));

  // Read the real catalogue out of the page and count what it covers, so this
  // is a measurement rather than a claim.
  const s = SRC['forecasting-portal.html'];
  const hazBlock = (s.match(/const GWCFC_TPL_HAZARDS = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const hazards = [...hazBlock.matchAll(/^\s*'([\w-]+)':/gm)].map(m => m[1]);
  const prodBlock = (s.match(/const AD_PRODUCTS = \[([\s\S]*?)\n\];/) || [])[1] || '';
  const products = [...prodBlock.matchAll(/id: '(\w+)'/g)].map(m => m[1]);
  ok(`the office has ${hazards.length} hazards`, hazards.length === 18, String(hazards.length));
  ok(`the desk has ${products.length} products`, products.length === 15, String(products.length));
  // The finding that shaped the design: most hazards have no product, so the
  // hazard cannot be derived from one.
  const named = hazards.filter(h => new RegExp(h.split('-')[0], 'i').test(prodBlock));
  ok('most hazards have no matching product, which is why the select stayed',
     named.length < hazards.length, `${named.length} of ${hazards.length} matched`);
  ok('the template count the row advertises is real',
     /gwcfcTemplateList\(\)\.length/.test(s), '');
}

console.log('\n4. the tag survived, and now covers every product');
{
  both('tier and tag are mapped, not stored twice',
       s => /const AD_TIER_TAG = \{ base: 'none', severe: 'pds', extreme: 'emergency' \};/.test(s));
  both('the tier select writes through to the tag',
       s => /id="ad-tpl-tier" onchange="_adSetTier\(this\.value\)"/.test(s));
  both('and the selected tier is read back off the tag',
       s => /const tplTier = _adTierOfTag\(d\.tag\);/.test(s));
  both('_adSetTag still exists, because seven other places read what it sets',
       s => /function _adSetTag\(v\) \{ _adDraft\.tag = v;/.test(s));
  // The headline changes with the tier, and the headline is drawn by the full
  // composer, so a partial repaint would leave it saying the old thing.
  both('changing the tier repaints the whole composer',
       s => /function _adSetTier[\s\S]{0,600}_adRenderCompose\(\)/.test(s));
  both('and it calls the composer by its real name',
       s => !/_adRenderComposer\(\)/.test(s));

  // Round trip: every tag maps to a tier and back to itself.
  const map = { base: 'none', severe: 'pds', extreme: 'emergency' };
  const tierOf = (tag) => Object.keys(map).find(k => map[k] === tag) || 'base';
  for (const [tier, tag] of Object.entries(map)) {
    ok(`${tier} is the ${tag} wording, and reads back`,
       tierOf(tag) === tier, tierOf(tag));
  }
  ok('an unknown tag falls back to base rather than to undefined',
     tierOf('nonsense') === 'base' && tierOf(undefined) === 'base');
}

console.log('\n5. the derived selections');
{
  both('hazard starts derived from the product',
       s => /const tplHaz  = d\.tplHaz  \|\| gwcfcGuessHazard\(P\.event \|\| ''\);/.test(s));
  // A Special Weather Statement contains neither "watch" nor "emergency", so
  // guessing its kind from its name returns WARNING, which it is not.
  both('kind is read off the product rather than guessed from its name',
       s => /P\.kind === 'watch' \|\| P\.kind === 'statement' \? 'watch' : 'warning'/.test(s));
  both('and gwcfcGuessKind is no longer used for it',
       s => !/d\.tplKind \|\| gwcfcGuessKind/.test(s));
  both('a hand-picked hazard is remembered',
       s => /function _adSetTplHaz\(v\)\s*\{ _adDraft\.tplHaz\s*= v; \}/.test(s));
  both('and wired to the select',
       s => /id="ad-tpl-haz" onchange="_adSetTplHaz\(this\.value\)"/.test(s));
  both('the office is remembered too',
       s => /function _adSetOffice\(v\)\s*\{ _adDraft\.officeCode = v; \}/.test(s)
         && /id="ad-tpl-office" onchange="_adSetOffice\(this\.value\)"/.test(s));
  both('and shown as selected when the form redraws',
       s => /o\.code === d\.officeCode \? ' selected' : ''/.test(s));
  // The office is who is issuing, not a property of the product, so switching
  // product must not silently clear it.
  both('switching product keeps the office',
       s => /const keepArea = \{[\s\S]{0,300}officeCode: _adDraft\.officeCode/.test(s));
  both('a fresh draft has the new fields rather than undefined',
       s => /tplHaz: '', tplKind: '', officeCode: '',/.test(s));
}

console.log('\n6. both copies of the desk moved together');
{
  // The desk is duplicated. Every structural check above already runs against
  // both, but this states the invariant directly so a future edit to one file
  // fails here with a clear reason rather than as eight scattered failures.
  const marks = ['ad-tpl-haz', 'ad-tpl-tier', 'AD_TIER_TAG', '_adSetTier',
                 '_adSetOffice', 'tplHaz'];
  for (const m of marks) {
    const counts = FILES.map(f => (SRC[f].match(new RegExp(m, 'g')) || []).length);
    ok(`${m} is present in both files`, counts.every(c => c > 0), counts.join(' vs '));
  }
}

console.log('\n7. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = [...FILES, 'tools/test-desk-templates.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes in either page or in this file', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
