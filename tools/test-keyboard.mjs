#!/usr/bin/env node
/*
 * Keyboard shortcuts: the presets, the rebinding, and the ways a shortcut
 * can go wrong in a way nobody notices until it eats their typing.
 *
 *     node tools/test-keyboard.mjs
 *
 * Four things are worth checking rather than trusting.
 *
 * TYPING IS NOT A SHORTCUT. The chat box, the alert desk's text area and
 * every search field are places where "S" means the letter S. A shortcut
 * layer that does not know this makes the app unusable in a way that reads
 * as "the chat is broken", not as "the shortcuts are wrong".
 *
 * THE BROWSER'S KEYS STAY THE BROWSER'S. Ctrl+T and Cmd+W are worth more to
 * a person than any radar product, so those chords are never claimed.
 *
 * ONE CHORD, ONE ACTION. If two actions can hold the same chord, which one
 * runs depends on the order of an object nobody can see.
 *
 * SHORTCUTS PRESS THE REAL BUTTON. Each one looks its action up in
 * RADAR_SUB_BUBBLES and calls it, rather than reimplementing "switch to
 * velocity". A reimplementation is a second version that drifts the first
 * time either side changes.
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

console.log('\n1. the engine is wired in');
{
  ok('there is an action list', /const KBD_ACTIONS = \[/.test(PAGE));
  ok('and named presets', /const KBD_PRESETS = \{/.test(PAGE));
  ok('bindings are saved under their own key', /const KBD_KEY = 'gwcfc_keys';/.test(PAGE));
  ok('a global keydown listener reads them',
     /document\.addEventListener\('keydown', \(e\) => \{\s*\n\s*if \(_kbdIsTyping\(e\.target\)\) return;/.test(PAGE));
  ok('there is a Keyboard settings category',
     /Keyboard<\/div>/.test(PAGE) && /id="lqm-kbd-preset"/.test(PAGE));
  ok('and a per-action rebinding list', /id="lqm-kbd-list"/.test(PAGE));
}

console.log('\n2. shortcuts press the real button');
{
  // The point: no second implementation of "switch to velocity" to drift.
  ok('a radar action is looked up in the menu it belongs to',
     /RADAR_SUB_BUBBLES\.find\(x => x\.id === a\.sub\)/.test(PAGE));
  ok('and the menu entry\'s own action is what runs',
     /if \(b && typeof b\.action === 'function'\) \{\s*\n\s*b\.action\(\);/.test(PAGE));
  ok('frame stepping goes through stepFrame',
     /if \(typeof a\.step === 'number' && typeof stepFrame === 'function'\)/.test(PAGE));
  ok('and a named function is checked before it is called',
     /if \(a\.fn && typeof window\[a\.fn\] === 'function'\)/.test(PAGE));
  // Storm relative velocity is velocity with the mean motion taken out, not
  // a separate product, so it is reached by switching then flipping.
  ok('storm relative velocity flips the product rather than pretending to be one',
     /if \(a\.srm && typeof _prSetProduct === 'function'\) _prSetProduct\('srvelocity'\);/.test(PAGE));
  ok('a failing action does not take the keyboard down with it',
     /catch \(e\) \{ console\.warn\('shortcut ' \+ a\.id \+ ':', e\); \}/.test(PAGE));
  ok('only a shortcut that really ran swallows the key',
     /if \(_kbdRun\(action\)\) e\.preventDefault\(\);/.test(PAGE));
}

console.log('\n3. typing and the browser are left alone');
{
  ok('inputs, textareas, selects and contenteditable are all excluded',
     /tag === 'input' \|\| tag === 'textarea' \|\| tag === 'select'/.test(PAGE)
     && /t\.isContentEditable === true/.test(PAGE));
  // The one that matters most: without it the chat box stops working.
  ok('the check runs before anything else in the handler',
     /keydown', \(e\) => \{\s*\n\s*if \(_kbdIsTyping\(e\.target\)\) return;/.test(PAGE));
  ok('Ctrl and Meta chords are never claimed',
     /if \(e\.ctrlKey \|\| e\.metaKey\) return;/.test(PAGE));
  ok('and the reason is written down rather than left to be undone later',
     /belong to the browser/i.test(PAGE));
}

console.log('\n4. the chord format');
{
  // Lifted from the page and run, so this tests what ships.
  const src = (PAGE.match(/function _kbdChord\(e\) \{[\s\S]*?\n\}/) || [])[0];
  ok('the chord builder was found', !!src);
  const _kbdChord = new Function('return (' + src + ')')();
  const mk = (o) => _kbdChord(Object.assign(
    { key: 'w', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, o));

  ok('a letter comes back upper-cased', mk({}) === 'W', mk({}));
  ok('shift is written in', mk({ shiftKey: true }) === 'Shift+W');
  // Fixed modifier order is what stops "Alt+Shift+W" and "Shift+Alt+W"
  // becoming two different bindings for one chord.
  ok('modifiers are always in the same order',
     mk({ altKey: true, shiftKey: true }) === 'Alt+Shift+W',
     mk({ altKey: true, shiftKey: true }));
  ok('a named key keeps its name', mk({ key: 'ArrowRight' }) === 'ArrowRight');
  // A bare modifier press must not register, or holding Shift to type a
  // capital would bind or fire something.
  for (const k of ['Shift', 'Control', 'Alt', 'Meta']) {
    ok(`pressing ${k} on its own is not a chord`, mk({ key: k }) === '');
  }
  ok('nothing at all is not a chord', _kbdChord(null) === '' && _kbdChord({}) === '');
}

console.log('\n5. the presets');
{
  const block = (PAGE.match(/const KBD_PRESETS = \{[\s\S]*?\n\};/) || [''])[0];
  ok('there is a GR2Analyst-style set', /gr2:/.test(block));
  ok('a plain single-letter set', /simple:/.test(block));
  // Somebody who wants none should say so once, not unbind fourteen keys.
  ok('and an explicit none, so opting out is one click', /none:/.test(block));
  // The two the request named by name.
  ok('Shift+W is spectrum width, as asked', /sw: 'Shift\+W'/.test(block));
  ok('Shift+S is storm relative velocity, as asked', /srvel: 'Shift\+S'/.test(block));
  ok('every preset carries a note explaining what it is',
     (block.match(/note:/g) || []).length === (block.match(/name:/g) || []).length,
     (block.match(/note:/g) || []).length + ' notes for ' + (block.match(/name:/g) || []).length + ' names');
  // The single-letter set is genuinely riskier and says so rather than
  // being presented as equivalent.
  ok('the risky preset admits its downside',
     /a stray keypress switches the map/.test(block));
}

console.log('\n6. rebinding, and what it cannot do');
{
  ok('binding a chord clears it off whatever held it',
     /Object\.keys\(_kbdBinds\)\.forEach\(k => \{ if \(_kbdBinds\[k\] === chord\) delete _kbdBinds\[k\]; \}\);/.test(PAGE));
  ok('and the reason is stated', /One chord, one action/.test(PAGE));
  ok('editing a key moves you off the preset rather than lying about it',
     /_kbdPreset = 'custom';/.test(PAGE));
  ok('capture swallows the key so binding R does not also switch to reflectivity',
     /e\.stopImmediatePropagation\(\);/.test(PAGE));
  ok('and it listens in the capture phase to get there first',
     /_kbdCapturing[\s\S]{0,900}\}, true\);/.test(PAGE));
  ok('Escape cancels a capture', /if \(e\.key === 'Escape'\) \{ _kbdCapturing = null;/.test(PAGE));
  ok('Backspace clears a binding',
     /if \(e\.key === 'Backspace' \|\| e\.key === 'Delete'\)/.test(PAGE));
  ok('a bare modifier during capture keeps waiting rather than binding nothing',
     /if \(!chord\) return;      \/\/ a bare modifier, keep waiting/.test(PAGE));
  // Space renders as an empty button otherwise, which reads as broken.
  ok('Space is labelled rather than drawn as a blank button',
     /chord === ' ' \? 'Space'/.test(PAGE));
}

console.log('\n7. the first-visit offer');
{
  ok('the welcome offers a set', /_kbdOfferSetup\(\)/.test(PAGE));
  ok('and does it last, after the map and forecast',
     /\}, 4200\);/.test(PAGE));
  ok('nothing is bound until somebody chooses',
     /_kbdBinds = \{\};\s*\n\s*_kbdPreset = null;/.test(PAGE));
  // Matched on one line's worth: the sentence is wrapped across comment
  // lines, so a phrase spanning the wrap matches nothing however true it is.
  ok('and the reason is written down',
     /nobody asked for that switches the radar out from under them/i.test(PAGE));
  // Dismissing is an answer. Not recording it means asking again every visit.
  ok('dismissing is recorded, so the card does not come back every visit',
     /_kbdBinds = \{\}; _kbdPreset = 'none'; _kbdSave\(\);/.test(PAGE));
  ok('the offer is skipped once a choice exists', /if \(_kbdHasChosen\(\)\) return;/.test(PAGE));
  ok('and skipped in screenshot mode',
     /_kbdOfferSetup[\s\S]{0,300}shot-mode/.test(PAGE));
  ok('a corrupt saved setting does not cost the page its keyboard',
     /a corrupt setting must not cost the page its keyboard/.test(PAGE));
}

console.log('\n8. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-keyboard.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
