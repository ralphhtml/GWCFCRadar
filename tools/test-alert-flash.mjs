#!/usr/bin/env node
/*
 * Flashing warning polygons, and the NWS event number.
 *
 *     node tools/test-alert-flash.mjs
 *
 * The pulse used to run for the first minute after a warning was issued and
 * then stop. That is the wrong minute: a tornado warning is most urgent for
 * the half hour it is valid, and anyone who looked away during that one
 * minute never saw it move at all. Scope is now a setting, and this checks
 * the decision it drives.
 *
 * WATCHES MUST NOT PULSE. This is the check that matters most. A screen where
 * forty things are moving is a screen where nothing stands out, which is the
 * exact opposite of what a flashing polygon is for. So "warning" is tested
 * against the real product names, including the ones that contain the word
 * "watch" nowhere and the ones that are advisories in disguise.
 *
 * THE EVENT NUMBER IS SANITISED AT SOURCE. It reaches innerHTML, and it comes
 * out of a feed. Escaping at the point of printing would have been one more
 * place to forget; the value is cleaned where it is produced instead, and
 * this proves markup cannot survive the trip.
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

// Pull the real functions out of the page and run them, rather than
// reimplementing the decision here and testing the copy.
const lift = (name) => {
  // The space before the brace is optional: some of these are written
  // `function f(p){` and some `function f(p) {`, and requiring one silently
  // finds nothing rather than failing loudly.
  const re = new RegExp('function ' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const src = (PAGE.match(re) || [])[0];
  if (!src) throw new Error('could not find ' + name + ' in index.html');
  return src;
};

const cfg = { scope: 'all', period: 1000, emerFast: true };
const sandbox = new Function('cfg', `
  const _alertFlashCfg = cfg;
  const ALERT_FLASH_MIN_MS = 400, ALERT_FLASH_MAX_MS = 3000;
  ${lift('_alertIsNew')}
  ${lift('_alertIsWarning')}
  ${lift('_alertIsEmergency')}
  ${lift('_alertFlashUntil')}
  ${lift('_alertEventNumber')}
  return { _alertIsWarning, _alertIsEmergency, _alertFlashUntil, _alertEventNumber };
`)(cfg);

const { _alertIsWarning, _alertIsEmergency, _alertFlashUntil, _alertEventNumber } = sandbox;

console.log('\n1. only warnings pulse');
{
  const WARN = ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning',
                'Extreme Wind Warning', 'Snow Squall Warning', 'Hurricane Warning',
                'Storm Surge Warning', 'Winter Storm Warning', 'Tornado Emergency'];
  const QUIET = ['Tornado Watch', 'Severe Thunderstorm Watch', 'Flash Flood Watch',
                 'Hurricane Watch', 'Winter Weather Advisory', 'Wind Advisory',
                 'Special Weather Statement', 'Hazardous Weather Outlook',
                 'Air Quality Alert', 'Beach Hazards Statement', 'Flood Advisory'];
  for (const ev of WARN) ok(`${ev} pulses`, _alertIsWarning({ event: ev }));
  for (const ev of QUIET) ok(`${ev} stays still`, !_alertIsWarning({ event: ev }));
  // "Severe Thunderstorm Watch" contains "Severe", and a substring test on
  // severity rather than on the word "warning" would light every watch up.
  ok('a watch is not caught by the word Severe',
     !_alertIsWarning({ event: 'Severe Thunderstorm Watch' }));
  ok('nothing at all is not a warning',
     !_alertIsWarning({}) && !_alertIsWarning(null) && !_alertIsWarning({ event: '' }));
}

console.log('\n2. emergencies are told apart, so they can pulse faster');
{
  ok('a tornado emergency, by event name',
     _alertIsEmergency({ event: 'Tornado Emergency' }));
  // The real shape: NWS issues these as an ordinary Tornado Warning whose
  // TEXT says emergency. Reading only the event name would miss every one.
  ok('and by the text, which is how NWS actually sends them',
     _alertIsEmergency({ event: 'Tornado Warning',
                         description: '...THIS IS A TORNADO EMERGENCY FOR MOORE...' }));
  ok('a particularly dangerous situation counts too',
     _alertIsEmergency({ event: 'Tornado Warning',
                         description: 'THIS IS A PARTICULARLY DANGEROUS SITUATION' }));
  ok('a flash flood emergency counts',
     _alertIsEmergency({ event: 'Flash Flood Warning',
                         description: 'FLASH FLOOD EMERGENCY FOR WAVERLY' }));
  ok('an ordinary warning does not',
     !_alertIsEmergency({ event: 'Tornado Warning', description: 'A tornado was reported.' }));
  ok('and a missing description does not throw',
     _alertIsEmergency({ event: 'Tornado Warning' }) === false);
}

console.log('\n3. the scope setting decides what is queued');
{
  const old = { event: 'Tornado Warning', sent: new Date(Date.now() - 20 * 60000).toISOString() };
  const fresh = { event: 'Tornado Warning', sent: new Date(Date.now() - 5000).toISOString() };
  const watch = { event: 'Tornado Watch', sent: new Date(Date.now() - 5000).toISOString() };

  cfg.scope = 'all';
  ok('scope all pulses a warning issued twenty minutes ago',
     _alertFlashUntil(old) === Infinity, String(_alertFlashUntil(old)));
  ok('and still refuses a watch', _alertFlashUntil(watch) === 0);

  cfg.scope = 'new';
  ok('scope new pulses one just issued', _alertFlashUntil(fresh) > 0);
  // The behaviour that made the old code wrong.
  ok('and drops the twenty-minute-old one', _alertFlashUntil(old) === 0);

  cfg.scope = 'off';
  ok('scope off pulses nothing at all',
     _alertFlashUntil(old) === 0 && _alertFlashUntil(fresh) === 0);
  cfg.scope = 'all';
}

console.log('\n4. the event number, read from all three shapes NWS uses');
{
  ok('from an eventTrackingNumber parameter',
     _alertEventNumber({ parameters: { eventTrackingNumber: ['0123'] } }) === '0123');
  // P-VTEC is the shape most products actually carry. The ETN is the four
  // digits after the phenomenon and significance codes, not the first four
  // digits in the string, and picking the wrong ones is the classic error.
  ok('from a VTEC string, taking the tracking number and not the date',
     _alertEventNumber({ parameters: {
       VTEC: ['/O.NEW.KTLX.TO.W.0087.250830T2145Z-250830T2230Z/'] } }) === '0087',
     _alertEventNumber({ parameters: { VTEC: ['/O.NEW.KTLX.TO.W.0087.250830T2145Z-250830T2230Z/'] } }));
  ok('a continued VTEC action works the same',
     _alertEventNumber({ parameters: {
       VTEC: ['/O.CON.KOUN.SV.W.0451.000000T0000Z-250830T2300Z/'] } }) === '0451');
  ok('falls back to the WMO identifier',
     _alertEventNumber({ parameters: { WMOidentifier: ['WFUS54 KTLX 302145'] } }).length > 0);
  // Absent is normal, not an error: watches and many advisories carry none.
  ok('absent is empty, not undefined or a crash',
     _alertEventNumber({ parameters: {} }) === '' && _alertEventNumber({}) === ''
     && _alertEventNumber(null) === '');
  ok('a bare string parameter works as well as an array',
     _alertEventNumber({ parameters: { eventTrackingNumber: '0999' } }) === '0999');
}

console.log('\n5. the number cannot carry markup into the popup');
{
  // It reaches innerHTML and it comes out of a feed, so this is the check
  // that matters rather than a nicety.
  const nasty = _alertEventNumber({ parameters: {
    eventTrackingNumber: ['<img src=x onerror=alert(1)>'] } });
  ok('tags are stripped rather than escaped', !/[<>]/.test(nasty), nasty);
  ok('and so are quotes and equals', !/["'=()]/.test(nasty), nasty);
  ok('what survives is only what an event number can be',
     /^[A-Za-z0-9-]*$/.test(nasty), nasty);
  const long = _alertEventNumber({ parameters: {
    eventTrackingNumber: ['9'.repeat(500)] } });
  ok('and it cannot be arbitrarily long', long.length <= 24, String(long.length));
  ok('the popup prints it without a second escaper to forget',
     /EVENT NUMBER<\/div><div class="ap-meta-val">\$\{evNum\}/.test(PAGE));
}

console.log('\n6. the settings are wired and bounded');
{
  ok('there is a scope select', /id="lqm-set-flashscope"/.test(PAGE));
  ok('with all three choices',
     /value="all">Every active warning/.test(PAGE)
     && /value="new">Only newly issued/.test(PAGE)
     && /value="off">Never/.test(PAGE));
  ok('and a speed slider', /id="lqm-set-flashspeed"[\s\S]{0,120}min="400" max="3000"/.test(PAGE));
  ok('and an emergencies-faster toggle', /id="lqm-set-flashemer"/.test(PAGE));
  ok('the controls use classes that exist in the stylesheet',
     /id="lqm-set-flashscope" class="lqm-settings-select"/.test(PAGE)
     && /id="lqm-set-flashspeed"[\s\S]{0,140}class="lqm-slider"/.test(PAGE));
  // A stored period outside the slider range would pulse too fast to read or
  // so slowly it looks broken, and localStorage can hold anything.
  ok('a saved period is clamped on load',
     /Math\.max\(ALERT_FLASH_MIN_MS, Math\.min\(ALERT_FLASH_MAX_MS, p\)\)/.test(PAGE));
  ok('and so is one typed into the setter',
     /Math\.max\(ALERT_FLASH_MIN_MS, Math\.min\(ALERT_FLASH_MAX_MS, n\)\)/.test(PAGE));
  ok('an unknown saved scope falls back rather than disabling the pulse',
     /if \(!\['off', 'new', 'all'\]\.includes\(_alertFlashCfg\.scope\)\) _alertFlashCfg\.scope = 'all';/.test(PAGE));
  ok('a corrupt saved setting does not stop boot',
     /catch \(e\) \{ \/\* a corrupt setting is not worth failing boot over \*\//.test(PAGE));
  ok('changing a control redraws rather than waiting for the next poll',
     /function _alertFlashApply\(\)[\s\S]{0,700}renderAlerts\(_lastAlertFeatures\)/.test(PAGE));
  ok('the saved values are put back into the controls on load',
     /_alertFlashSyncUi\(\);/.test(PAGE) && /function _alertFlashSyncUi\(\)/.test(PAGE));
  // The old single toggle is gone, so it must not still be in the settings
  // key list where it would be restored over the new controls.
  ok('the retired flash toggle left the plain settings list',
     /_LQM_OWN_KEYS = \['crosshair', 'contrast', 'coords', 'compass', 'scale'\]/.test(PAGE));
  ok('and its markup is gone', !/id="lqm-set-flash"/.test(PAGE));
}

console.log('\n7. emergencies really do run at a different rate');
{
  // Two layers with the same period would pulse in lockstep and lose the
  // distinction the faster rate exists to make.
  ok('the tick computes a period per layer, not one shared phase',
     /const per = fast \? base \/ 2 : base;/.test(PAGE));
  ok('and the phase is derived from that per-layer period',
     /const phase = Math\.sin\(\(\(now - start\) % per\) \/ per \* Math\.PI \* 2\)/.test(PAGE));
  ok('the queue records which layers are fast',
     /fast: _alertFlashCfg\.emerFast && _alertIsEmergency\(p\)/.test(PAGE));
  // Infinity as the deadline is what "for as long as it is on the map" means,
  // and the filter has to let it through rather than treating it as expired.
  ok('an Infinity deadline survives the expiry filter',
     /if \(now > o\.until\)/.test(PAGE));
}

console.log('\n8. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-alert-flash.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
