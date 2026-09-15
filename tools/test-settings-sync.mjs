#!/usr/bin/env node
/*
 * Settings (units, opacities, particle look, colors, the toggle switches)
 * follow an account across devices, automatically - no separate "save"
 * button, no need to remember to press it. Every write to a whitelisted
 * localStorage key is mirrored to the account's own Firestore document, and
 * every sign-in pulls that copy back down before the page reads
 * localStorage for a starting value.
 *
 *     node tools/test-settings-sync.mjs
 *
 * Checked here:
 *   1. The whitelist exists and covers the real Settings-panel keys, while
 *      deliberately leaving out device-only things (guest id, GPS tracking
 *      on/off, recent searches, error logs).
 *   2. In a real browser: a whitelisted change schedules a cloud push, a
 *      non-whitelisted one does not, neither does one from a guest or a
 *      signed-out session, pulling a cloud snapshot writes it back into
 *      localStorage without re-triggering a push of itself, units apply
 *      live through the same setter the Settings panel's own dropdowns use,
 *      an empty/missing cloud snapshot never wipes local defaults, sign-in
 *      pulls the snapshot down, and signing out cancels a pending push.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the whitelist covers the real Settings-panel keys');
{
  ok('units are covered by prefix, not listed one at a time',
     /const SETTINGS_SYNC_PREFIXES = \['lqm_unit_', 'gwcfc_sst_ramp_'\];/.test(PAGE));
  ['lqm_radaropacity', 'lqm_windlayeropacity', 'gwcfc_tz', 'lqm_dbltapmenu',
   'lqm_citynamesize', 'gwcfc_ai_speak', 'lqm_smooth'].forEach(k => {
    ok(`'${k}' is in the whitelist`, PAGE.includes(`'${k}'`));
  });
  ok('device-only keys are deliberately left out (GPS tracking on/off)',
     !/SETTINGS_SYNC_KEYS = new Set\(\[[\s\S]{0,1400}'lqm_location'/.test(PAGE)
     && !/SETTINGS_SYNC_KEYS = new Set\(\[[\s\S]{0,1400}'lqm_follow'/.test(PAGE)
     && !/SETTINGS_SYNC_KEYS = new Set\(\[[\s\S]{0,1400}'lqm_gpshud'/.test(PAGE));
  ok('the guest id and error log never sync (they are not settings)',
     !/SETTINGS_SYNC_KEYS = new Set\(\[[\s\S]{0,1400}gwcfc_guest_id/.test(PAGE)
     && !/SETTINGS_SYNC_KEYS = new Set\(\[[\s\S]{0,1400}gwcfc_last_errors/.test(PAGE));
  ok('localStorage.setItem is wrapped once, at boot, to watch for these keys',
     /function _installSettingsSyncWatcher\(\)[\s\S]{0,300}localStorage\.setItem = function/.test(PAGE));
  ok('a whitelisted write schedules a push, everything else is left alone',
     /if \(!_applyingSyncedSettings && _isSyncableSettingKey\(key\)\) _scheduleSettingsSync\(\);/.test(PAGE));
  ok('guests and anonymous sessions are excluded before anything is scheduled',
     /function _scheduleSettingsSync\(\)[\s\S]{0,250}_currentUser\.isAnonymous/.test(PAGE));
  ok('pulling a cloud snapshot only ever touches keys actually present in it',
     /function _applySyncedSettings\(synced\)[\s\S]{0,600}Object\.entries\(synced\)\.forEach/.test(PAGE));
  ok('units reuse the Settings panel\'s own live setter, not a bare localStorage write',
     /if \(k\.indexOf\('lqm_unit_'\) === 0 && typeof setUnitPref === 'function'\)/.test(PAGE));
  ok('_loadUserPrefs pulls the snapshot down before anything else reads localStorage',
     /if \(!d\) return;[\s\S]{0,400}_applySyncedSettings\(d\.syncedSettings\)/.test(PAGE));
  ok('signing out cancels whatever push was still waiting',
     /function _onSignedOut\(\)[\s\S]{0,300}clearTimeout\(_settingsSyncTimer\)/.test(PAGE));
  ok('no em dashes anywhere in the new code or this test',
     !PAGE.slice(PAGE.indexOf('const SETTINGS_SYNC_KEYS'), PAGE.indexOf('function _applySyncedSettings') + 900)
       .includes(String.fromCharCode(0x2014))
     && !readFileSync(join(ROOT, 'tools/test-settings-sync.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET_STUB = `(() => {
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => { if (k === 'then') return undefined; return chain(); },
    apply: () => chain(), construct: () => chain(),
  });
  Object.defineProperty(window, 'L', { value: chain(), writable: true, configurable: true });
})();`;

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      if (!d.startsWith('chromium-')) continue;
      const p = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch {}
  return undefined;
}

const b = await chromium.launch({ executablePath: chromePath() });
const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(LEAFLET_STUB);
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
await p.route('**://**', r =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);

// A tiny fake Firestore: every set() onto users/{uid} is recorded rather
// than sent anywhere, so the debounce and its payload can be inspected.
async function withFakeUser(page, user, fn) {
  return page.evaluate(async ({ user, fnBody }) => {
    const calls = [];
    _currentUser = user;
    _fbDb = { collection: (name) => ({ doc: (id) => ({ set: async (data, opts) => {
      calls.push({ name, id, data, opts });
    } }) }) };
    window.firebase = window.firebase || {};
    window.firebase.firestore = { FieldValue: { serverTimestamp: () => 'SERVER_TS' } };
    // eslint-disable-next-line no-eval
    const fn = eval('(' + fnBody + ')');
    const result = await fn();
    return { calls, result };
  }, { user, fnBody: fn.toString() });
}

console.log('\n2. a whitelisted change, from a real signed-in account, pushes to the cloud');
{
  const r = await withFakeUser(p, { uid: 'u1', isAnonymous: false }, async () => {
    localStorage.setItem('lqm_radaropacity', '0.42');
    const scheduled = !!_settingsSyncTimer;
    // Run the push directly rather than waiting out the real debounce delay.
    clearTimeout(_settingsSyncTimer);
    await _pushSettingsToCloud();
    return { scheduled };
  });
  ok('the write scheduled a push', r.result.scheduled, JSON.stringify(r));
  ok('exactly one write landed, on this account\'s own document',
     r.calls.length === 1 && r.calls[0].name === 'users' && r.calls[0].id === 'u1',
     JSON.stringify(r.calls));
  ok('the pushed snapshot carries the value that was just set',
     r.calls[0].data.syncedSettings && r.calls[0].data.syncedSettings.lqm_radaropacity === '0.42',
     JSON.stringify(r.calls[0]));
}

console.log('\n3. a non-setting key never schedules anything');
{
  const r = await withFakeUser(p, { uid: 'u1', isAnonymous: false }, async () => {
    _settingsSyncTimer && clearTimeout(_settingsSyncTimer);
    _settingsSyncTimer = null;
    localStorage.setItem('gwcfc_guest_id', 'abc123');
    return { scheduled: !!_settingsSyncTimer };
  });
  ok('gwcfc_guest_id is not a setting, so nothing was scheduled',
     !r.result.scheduled, JSON.stringify(r));
}

console.log('\n4. a guest session, or nobody signed in, never syncs');
{
  const anon = await withFakeUser(p, { uid: 'g1', isAnonymous: true }, async () => {
    _settingsSyncTimer && clearTimeout(_settingsSyncTimer);
    _settingsSyncTimer = null;
    localStorage.setItem('lqm_radaropacity', '0.9');
    return { scheduled: !!_settingsSyncTimer };
  });
  ok('an anonymous account does not schedule a push', !anon.result.scheduled, JSON.stringify(anon));

  const signedOut = await p.evaluate(() => {
    _currentUser = null;
    _settingsSyncTimer && clearTimeout(_settingsSyncTimer);
    _settingsSyncTimer = null;
    localStorage.setItem('lqm_radaropacity', '0.3');
    return { scheduled: !!_settingsSyncTimer };
  });
  ok('nobody signed in does not schedule a push either', !signedOut.scheduled, JSON.stringify(signedOut));
}

console.log('\n5. pulling a cloud snapshot writes it back without pushing it right back up');
{
  const r = await withFakeUser(p, { uid: 'u2', isAnonymous: false }, async () => {
    _settingsSyncTimer && clearTimeout(_settingsSyncTimer);
    _settingsSyncTimer = null;
    _applySyncedSettings({ lqm_alertopacity: '0.77', gwcfc_tz: 'America/Chicago' });
    return {
      opacity: localStorage.getItem('lqm_alertopacity'),
      tz: localStorage.getItem('gwcfc_tz'),
      reScheduled: !!_settingsSyncTimer,
    };
  });
  ok('the alert opacity landed in localStorage', r.result.opacity === '0.77', JSON.stringify(r.result));
  ok('the timezone landed too', r.result.tz === 'America/Chicago', JSON.stringify(r.result));
  ok('applying a pulled snapshot did not turn around and schedule a push of it',
     !r.result.reScheduled, JSON.stringify(r.result));
}

console.log('\n6. units apply live through the same setter the Settings panel uses');
{
  const r = await withFakeUser(p, { uid: 'u3', isAnonymous: false }, async () => {
    _settingsSyncTimer && clearTimeout(_settingsSyncTimer);
    _settingsSyncTimer = null;
    _applySyncedSettings({ lqm_unit_wind: 'kt' });
    return { unitsWind: _units.wind, stored: localStorage.getItem('lqm_unit_wind') };
  });
  ok('_units updated immediately, not just localStorage', r.result.unitsWind === 'kt', JSON.stringify(r.result));
  ok('and localStorage itself matches', r.result.stored === 'kt', JSON.stringify(r.result));
}

console.log('\n7. a missing or empty cloud snapshot never wipes local defaults');
{
  const r = await p.evaluate(() => {
    localStorage.setItem('lqm_radaropacity', '0.66');
    _applySyncedSettings(null);
    _applySyncedSettings({});
    _applySyncedSettings(undefined);
    return { still: localStorage.getItem('lqm_radaropacity') };
  });
  ok('the local value is untouched', r.still === '0.66', JSON.stringify(r));
}

console.log('\n8. signing in pulls the cloud snapshot down through _loadUserPrefs');
{
  const r = await p.evaluate(async () => {
    _currentUser = { uid: 'u4', isAnonymous: false };
    _fbDb = { collection: () => ({ doc: () => ({ get: async () => ({
      exists: true,
      data: () => ({ syncedSettings: { lqm_modelopacity: '0.55' } }),
    }) }) }) };
    localStorage.removeItem('lqm_modelopacity');
    await _loadUserPrefs('u4');
    return { modelOpacity: localStorage.getItem('lqm_modelopacity') };
  });
  ok('the synced value from the account\'s document landed locally',
     r.modelOpacity === '0.55', JSON.stringify(r));
}

console.log('\n9. signing out cancels a push that was still waiting');
{
  const r = await withFakeUser(p, { uid: 'u5', isAnonymous: false }, async () => {
    localStorage.setItem('lqm_radaropacity', '0.11');
    const scheduledBefore = !!_settingsSyncTimer;
    _onSignedOut();
    // _onSignedOut tries to sign back in anonymously; that has nothing to
    // read from in this test and is left to fail quietly, which is fine -
    // only the cancelled timer is being checked here.
    return { scheduledBefore, timerAfter: _settingsSyncTimer };
  });
  ok('a push had been scheduled', r.result.scheduledBefore, JSON.stringify(r.result));
  ok('signing out cleared it', r.result.timerAfter === null, JSON.stringify(r.result));
}

ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 5).join(' | '));

await p.close();
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
