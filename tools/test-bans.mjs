#!/usr/bin/env node
/*
 * Bans: the owner can ban an account, an email, an IP address or a device.
 *
 *     node tools/test-bans.mjs
 *
 *   - Account and email bans are enforced by the database rules as well as
 *     the page; IP and device bans by the page (and NWRchive).
 *   - Manage Members has a Ban button per member (account, email, last IP,
 *     device, with a reason), a list of bans with Unban, and a form to ban
 *     anything by hand.
 *   - The owner can never ban themselves, and is never locked out.
 *   - The parsing server has /whoami, which tells a browser its own IP.
 * The database is an in-memory stand-in and /whoami is answered by the test,
 * so this runs without a network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const NWR = readFileSync(join(ROOT, 'nwrchive.html'), 'utf8');
const SERVE = readFileSync(join(ROOT, 'pi/serve.py'), 'utf8');
const RULES = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
const RULES_TXT = readFileSync(join(ROOT, 'firebase/FIRESTORE_RULES.txt'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 400) + '>' : '')); }
};

console.log('1. Rules and the parsing server');
ok('no em dashes', ![PAGE, NWR, SERVE, RULES, RULES_TXT, readFileSync(fileURLToPath(import.meta.url), 'utf8')]
  .some(t => t.includes(String.fromCharCode(0x2014))));
ok('both rule files are the same rules', RULES_TXT.includes(RULES.trim()));
ok('bans: anyone may look one up, only the owner may list or change them',
   /match \/bans\/\{banId\} \{\s*allow get: if true;\s*allow list, write: if isOwner\(\);\s*\}/.test(RULES));
ok('banned() checks the account and the email off the sign-in token, never the owner',
   /function banned\(\) \{\s*return isSignedIn\(\) && !isOwner\(\) && \(/.test(RULES)
   && /bans\/\$\('uid:' \+ request\.auth\.uid\)/.test(RULES)
   && /bans\/\$\('email:' \+ request\.auth\.token\.email\.lower\(\)\)/.test(RULES));
ok('a banned account cannot post to chat, message, publish or save',
   /!isChatBlocked\(\) && !banned\(\)/.test(RULES)
   && /isForecasterAccount\(\) && !banned\(\)/.test(RULES)
   && (RULES.match(/realAccount\(\) && !banned\(\)/g) || []).length >= 4
   && /request\.auth\.uid == uid && !touchesRoleFields\(\)[\s\S]{0,140}!banned\(\)\);/.test(RULES));
ok('the parsing server answers /whoami from the Cloudflare header',
   /head == "\/whoami"/.test(SERVE) && /CF-Connecting-IP/.test(SERVE));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];

console.log('\n2. The radar app');
{
  const ctx = await b.newContext({ viewport: { width: 1300, height: 850 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
  await p.route('**://**', r => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
    if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
    if (u === 'https://srv.test/whoami') return r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ip":"203.0.113.9"}' });
    return r.abort();
  });
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  const r = await p.evaluate(async () => {
    const out = {};
    const store = {};
    const docRef = (c, id) => ({
      get: async () => ({ exists: (c + '/' + id) in store, data: () => store[c + '/' + id] }),
      set: async (d, o) => { store[c + '/' + id] = (o && o.merge) ? Object.assign({}, store[c + '/' + id], d) : d; },
      delete: async () => { delete store[c + '/' + id]; },
    });
    _fbDb = { collection: (c) => ({
      doc: (id) => docRef(c, id),
      get: async () => ({ docs: Object.keys(store).filter(k => k.startsWith(c + '/'))
        .map(k => ({ id: k.slice(c.length + 1), data: () => store[k] })) }),
    }) };
    window._hdResolveBase = async () => 'https://srv.test';
    _banMyIpPr = null;
    let said = []; window.showToast = (m) => said.push(m);
    let signedOut = 0;
    _fbAuth = { signOut: async () => { signedOut++; } };

    out.ids = _banId('email', ' Foo@Bar.COM ') === 'email:foo@bar.com'
      && _banId('ip', '2001:DB8::1') === 'ip:2001:db8::1'
      && _banId('uid', 'a/b') === 'uid:ab';
    const d1 = _banDeviceId(), d2 = _banDeviceId();
    out.device = d1 === d2 && d1.length >= 8 && localStorage.getItem('gwcfc_device_id') === d1;
    out.ip = (await _banMyIp()) === '203.0.113.9';

    // A clean account signing in: not locked, and its IP and device are noted.
    const mk = (uid, email) => ({ uid, email, isAnonymous: false });
    const u1 = mk('u1', 'one@x.test');
    _currentUser = u1;
    await _banCheckAccount(u1);
    out.clean = !document.getElementById('ban-lockout')
      && store['users/u1'] && store['users/u1'].lastIp === '203.0.113.9' && store['users/u1'].deviceId === d1;

    // The owner bans from Manage Members.
    const owner = mk('own', 'ralphies1005@gmail.com');
    _currentUser = owner;
    _staffUsers = [
      { uid: 'own', name: 'Owner', email: 'ralphies1005@gmail.com', staffRole: 'owner' },
      { uid: 'u2', name: 'Spammer', email: 'Spam@X.test', staffRole: 'member', lastIp: '198.51.100.7', deviceId: 'dev-spam-123' },
    ];
    _staffRenderList('');
    const list = document.getElementById('lqm-staff-list');
    out.banBtn = list.querySelectorAll('.lqm-staff-ban').length === 1;   // not on the owner's row
    staffBanMember('u2');
    const dlg = document.getElementById('lqm-ban-dialog');
    out.dialog = !!dlg && dlg.querySelectorAll('input[type=checkbox]').length === 4
      && dlg.querySelectorAll('input[type=checkbox]:checked').length === 2;   // account and email by default
    dlg.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; });
    document.getElementById('lqm-ban-reason').value = 'spam';
    await staffBanConfirm();
    out.banned = ['bans/uid:u2', 'bans/email:spam@x.test', 'bans/ip:198.51.100.7', 'bans/device:dev-spam-123']
      .every(k => store[k] && store[k].reason === 'spam');
    out.dialogGone = !document.getElementById('lqm-ban-dialog');
    out.tag = /BANNED/.test(list.textContent);
    out.listShown = document.querySelectorAll('#lqm-ban-list .lqm-ban-row').length === 4;

    // Owner cannot ban themselves.
    const before = Object.keys(store).length;
    out.selfRefused = !(await staffBan('email', 'RALPHIES1005@gmail.com', 'x'))
      && !(await staffBan('ip', '203.0.113.9', 'x'))
      && !(await staffBan('device', d1, 'x'))
      && !(await staffBan('uid', 'own', 'x'))
      && Object.keys(store).length === before;

    // Ban anything by hand, then unban it.
    document.getElementById('lqm-ban-type').value = 'ip';
    document.getElementById('lqm-ban-value').value = '192.0.2.44';
    await staffBanManual();
    out.manual = !!store['bans/ip:192.0.2.44'];
    const btn = [...document.querySelectorAll('#lqm-ban-list .lqm-ban-unban')].find(x => x.dataset.id === 'ip:192.0.2.44');
    btn.click();
    await new Promise(res => setTimeout(res, 50));
    out.unban = !store['bans/ip:192.0.2.44'] && document.querySelectorAll('#lqm-ban-list .lqm-ban-row').length === 4;

    // Refused by unpublished rules: it says so.
    said = [];
    const real = _fbDb;
    _fbDb = { collection: () => ({ doc: () => ({ set: async () => { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } }) }) };
    await staffBan('email', 'z@z.test', '');
    out.rulesNote = said.some(m => /publish the latest rules/.test(m));
    _fbDb = real;

    // The banned account signing in is locked out and signed out.
    const u2 = mk('u2', 'spam@x.test');
    _currentUser = u2;
    await _banCheckAccount(u2);
    const lk = document.getElementById('ban-lockout');
    out.locked = !!lk && /banned/.test(lk.textContent) && /spam/.test(lk.textContent) && signedOut === 1;
    out.covers = lk && getComputedStyle(lk).position === 'fixed' && +getComputedStyle(lk).zIndex > 1000000;

    // The owner signing in lifts any lockout.
    _currentUser = owner;
    await _banCheckAccount(owner);
    out.ownerUnlocked = !document.getElementById('ban-lockout');

    // A banned network is turned away before anyone signs in.
    _currentUser = null;
    store['bans/ip:203.0.113.9'] = { type: 'ip', value: '203.0.113.9', reason: '' };
    await _banBootCheck();
    out.ipLocked = !!document.getElementById('ban-lockout');
    _banUnlock();
    delete store['bans/ip:203.0.113.9'];
    store['bans/device:' + d1] = { type: 'device', value: d1 };
    await _banBootCheck();
    out.deviceLocked = !!document.getElementById('ban-lockout') && signedOut === 1;   // device bans do not sign out
    _banUnlock();

    // Rules not published: a lookup refused is treated as not banned.
    _fbDb = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('denied'); } }) }) };
    out.refusedIsClear = (await _banFind([['uid', 'x']])) === null;
    return out;
  });
  ok('ban ids are normalized', r.ids, JSON.stringify(r));
  ok('the device id is made once and kept', r.device, JSON.stringify(r));
  ok('the IP comes from our own parsing server', r.ip, JSON.stringify(r));
  ok('a clean account is not locked, and its IP and device are noted', r.clean, JSON.stringify(r));
  ok('each member row has a Ban button, not the owner row', r.banBtn, JSON.stringify(r));
  ok('the Ban dialog offers account, email, last IP and device', r.dialog, JSON.stringify(r));
  ok('ticking all four bans all four, with the reason', r.banned && r.dialogGone, JSON.stringify(r));
  ok('the member shows BANNED and the bans list fills', r.tag && r.listShown, JSON.stringify(r));
  ok('the owner cannot ban their own account, email, IP or device', r.selfRefused, JSON.stringify(r));
  ok('anything can be banned by hand, and unbanned', r.manual && r.unban, JSON.stringify(r));
  ok('rules not published: it says to publish them', r.rulesNote, JSON.stringify(r));
  ok('a banned account is covered by a full-page lockout and signed out', r.locked && r.covers, JSON.stringify(r));
  ok('the owner is never locked out', r.ownerUnlocked, JSON.stringify(r));
  ok('a banned IP or device is turned away at load', r.ipLocked && r.deviceLocked, JSON.stringify(r));
  ok('a refused lookup is not a ban', r.refusedIsClear, JSON.stringify(r));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n3. NWRchive turns banned accounts away');
{
  const STUB = `
    window.__authCb = null; window.__user = null; window.__bans = {};
    window.firebase = {
      initializeApp() {},
      auth: Object.assign(() => ({
        get currentUser() { return window.__user; },
        onAuthStateChanged(cb) { window.__authCb = cb; setTimeout(() => cb(window.__user), 0); },
        async signInWithEmailAndPassword() {}, async signInWithPopup() {}, async signOut() {},
      }), { GoogleAuthProvider: function () {} }),
      firestore: () => ({ collection: (c) => ({ doc: (id) => ({ get: async () => ({
        exists: c === 'bans' && !!window.__bans[id], data: () => window.__bans[id] }) }) }) }),
    };`;
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.route('**://**', r => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (/firebase-app-compat/.test(u)) return r.fulfill({ contentType: 'application/javascript', body: STUB });
    if (/gstatic\.com\/firebasejs\//.test(u)) return r.fulfill({ contentType: 'application/javascript', body: '' });
    if (/\/whoami$/.test(u)) return r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ip":"198.51.100.7"}' });
    return r.fulfill({ status: 404, body: '' });
  });
  await p.goto('file://' + join(ROOT, 'nwrchive.html') + '#/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => { window.__bans['ip:198.51.100.7'] = { reason: 'abuse' }; window.__user = { uid: 'u9', email: 'n@x.test', isAnonymous: false }; window.__authCb(window.__user); });
  await p.waitForTimeout(600);
  const g = await p.evaluate(() => ({ gate: !document.getElementById('acct-gate').classList.contains('off'), msg: document.getElementById('gate-msg').textContent, app: document.getElementById('app').innerHTML.trim().length }));
  ok('an account on a banned IP is refused, with the reason', g.gate && /banned/.test(g.msg) && /abuse/.test(g.msg) && g.app === 0, JSON.stringify(g));
  await p.evaluate(() => { window.__bans = {}; window.__user = { uid: 'u9', email: 'n@x.test', isAnonymous: false }; window.__authCb(window.__user); });
  await p.waitForTimeout(600);
  ok('the same account unbanned gets in', await p.evaluate(() => document.getElementById('acct-gate').classList.contains('off')));
  ok('no page errors in NWRchive', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
