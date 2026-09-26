#!/usr/bin/env node
/*
 * Deleting accounts, and NOAA Weather Radio recordings behind an account.
 *
 *     node tools/test-accounts-nwr.mjs
 *
 *   - The owner can delete any member from Manage Members, and anyone can
 *     delete their own account. A web page cannot remove someone else's
 *     sign-in, so a marker (deletedAccounts/{uid}) is left and that account's
 *     own browser deletes the sign-in and signs out the next time it opens.
 *   - Recording NOAA Weather Radio in the radar app (Rec, and AUTO) needs a
 *     GWCFC account; listening does not.
 *   - NWRchive, the recordings archive, opens only for a signed-in GWCFC
 *     account, and loads nothing before one.
 * The database is replaced by an in-memory stand-in, and on NWRchive the
 * Firebase scripts by a small stub, so this runs without a network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const NWR = readFileSync(join(ROOT, 'nwrchive.html'), 'utf8');
const RULES = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
const RULES_TXT = readFileSync(join(ROOT, 'firebase/FIRESTORE_RULES.txt'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 400) + '>' : '')); }
};
ok('no em dashes', ![PAGE, NWR, RULES, RULES_TXT, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));
ok('the rules know deleted accounts, in both rule files',
   [RULES, RULES_TXT].every(r => /match \/deletedAccounts\/\{uid\}/.test(r)
     && /!exists\(\/databases\/\$\(database\)\/documents\/deletedAccounts\/\$\(uid\)\)/.test(r)
     && /allow delete: if isOwner\(\) \|\| \(isSignedIn\(\) && request\.auth\.uid == uid\);/.test(r)));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];

console.log('\n1. Deleting accounts in the radar app');
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
    return r.abort();
  });
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  const r = await p.evaluate(async () => {
    const out = {};
    // An in-memory database: store['coll/id'] = data.
    const store = {};
    const db = { collection: (c) => ({ doc: (id) => ({
      get: async () => ({ exists: (c + '/' + id) in store, data: () => store[c + '/' + id] }),
      set: async (d) => { store[c + '/' + id] = d; },
      delete: async () => { delete store[c + '/' + id]; },
    }) }) };
    _fbDb = db;
    let said = []; const st = window.showToast; window.showToast = (m) => said.push(m);
    const mkUser = (uid, extra) => Object.assign({ uid, isAnonymous: false, email: uid + '@x.test',
      metadata: { lastSignInTime: new Date().toUTCString() }, providerData: [{ providerId: 'password' }],
      deleted: false, delete: async function () { this.deleted = true; } }, extra || {});
    _fbAuth = { signOut: async () => { out.signedOut = true; } };

    // A deleted account signing in: its sign-in is deleted, nothing is loaded.
    let loaded = 0; const lp = window._loadUserPrefs; window._loadUserPrefs = () => { loaded++; };
    store['deletedAccounts/gone1'] = { by: 'owner' };
    const gone = mkUser('gone1');
    out.removed = await _acctCheckRemoved(gone);
    out.goneDeleted = gone.deleted;
    out.goneToast = said.some(m => /has been deleted/.test(m));
    _onSignedIn(gone); await new Promise(res => setTimeout(res, 50));
    out.goneNotLoaded = loaded === 0;
    // An ordinary account signing in carries on as before.
    const fine = mkUser('fine1');
    out.fineRemoved = await _acctCheckRemoved(fine);
    _onSignedIn(fine); await new Promise(res => setTimeout(res, 50));
    out.fineLoaded = loaded === 1;
    window._loadUserPrefs = lp;

    // The owner deletes a member from Manage Members.
    window._isOwner = () => true;
    _currentUser = mkUser('owner1', { email: 'owner@x.test' });
    _staffUsers = [
      { uid: 'owner1', name: 'Owner', staffRole: 'owner', email: 'owner@x.test' },
      { uid: 'mem1', name: 'Member One', email: 'm1@x.test' },
      { uid: 'mem2', name: 'Member Two', email: 'm2@x.test' },
    ];
    store['users/mem1'] = { name: 'Member One' }; store['dmDirectory/mem1'] = { name: 'Member One' };
    const host = document.getElementById('lqm-staff-list');
    _staffRenderList('');
    const rows = [...host.querySelectorAll('.lqm-staff-row')];
    out.ownerRowNoDelete = !rows[0].querySelector('.lqm-staff-del') && rows.slice(1).every(r => r.querySelector('.lqm-staff-del'));
    window.confirm = () => false;
    out.cancelKeeps = (await staffDeleteAccount('mem1')) === false && 'users/mem1' in store;
    window.confirm = () => true;
    out.deleted = await staffDeleteAccount('mem1');
    out.marker = store['deletedAccounts/mem1'] && store['deletedAccounts/mem1'].by === 'owner';
    out.profileGone = !('users/mem1' in store) && !('dmDirectory/mem1' in store);
    out.listUpdated = !_staffUsers.some(u => u.uid === 'mem1') && host.querySelectorAll('.lqm-staff-row').length === 2;
    out.ownerSafe = (await staffDeleteAccount('owner1')) === false;
    // Refused by rules not yet published: says what to do.
    const realSet = db.collection; _fbDb = { collection: () => ({ doc: () => ({ set: async () => { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } }) }) };
    said = [];
    await staffDeleteAccount('mem2');
    out.rulesNote = said.some(m => /FIRESTORE_RULES/.test(m));
    _fbDb = db;

    // Someone deletes their own account.
    window._isOwner = () => false;
    const me = mkUser('me1');
    _currentUser = me;
    store['users/me1'] = { name: 'Me' };
    window.prompt = () => 'nope';
    out.wrongWord = (await authDeleteMyAccount()) === false && 'users/me1' in store && !me.deleted;
    window.prompt = () => 'DELETE';
    out.selfDeleted = await authDeleteMyAccount();
    out.selfMarker = store['deletedAccounts/me1'] && store['deletedAccounts/me1'].by === 'self';
    out.selfGone = !('users/me1' in store) && me.deleted;
    out.panelButton = !!document.querySelector('.lqm-profile-delete-btn');
    window.showToast = st;
    return out;
  });
  ok('a deleted account that signs in has its sign-in deleted, with a note', r.removed && r.goneDeleted && r.goneToast, JSON.stringify(r));
  ok('and nothing of it is loaded or saved', r.goneNotLoaded, JSON.stringify(r));
  ok('an ordinary account signs in as before', r.fineRemoved === false && r.fineLoaded, JSON.stringify(r));
  ok('Manage Members has Delete on every row but the owner\'s', r.ownerRowNoDelete, JSON.stringify(r));
  ok('cancelling the confirm keeps the account', r.cancelKeeps, JSON.stringify(r));
  ok('deleting leaves the marker and removes the profile and messages entry', r.deleted && r.marker && r.profileGone, JSON.stringify(r));
  ok('the member leaves the list; the owner cannot be deleted', r.listUpdated && r.ownerSafe, JSON.stringify(r));
  ok('rules not yet published: it says to publish them', r.rulesNote, JSON.stringify(r));
  ok('the account panel has Delete my account', r.panelButton, JSON.stringify(r));
  ok('it asks for DELETE to be typed, and anything else deletes nothing', r.wrongWord, JSON.stringify(r));
  ok('deleting yourself removes the profile and the sign-in, marker first', r.selfDeleted && r.selfMarker && r.selfGone, JSON.stringify(r));

  console.log('\n2. Recording NOAA Weather Radio needs an account');
  const n = await p.evaluate(async () => {
    const out = {};
    let said = []; const st = window.showToast; window.showToast = (m) => said.push(m);
    let modal = 0; const om = window.openAuthModal; window.openAuthModal = () => { modal++; };
    let panel = 0; const op = window._nwrOpenRecPanel; window._nwrOpenRecPanel = () => { panel++; throw new Error('stop-here'); };
    _currentUser = null;
    out.guest = (await _nwrStartRecord('kec61', 'https://x.test/s', 'Test')) === false;
    out.guestModal = modal === 1 && said.some(m => /needs a GWCFC account/.test(m)) && panel === 0;
    said = []; modal = 0;
    await _nwrStartRecord('kec61', 'https://x.test/s', 'Test', true);
    await _nwrStartRecord('kec61', 'https://x.test/s', 'Test', true);
    out.autoQuiet = modal === 0 && said.length === 0;     // said once already, within the minute
    _nwrNeedAcctSaid = 0;
    await _nwrStartRecord('kec61', 'https://x.test/s', 'Test', true);
    out.autoSaysOnce = said.length === 1 && modal === 0;
    _currentUser = { uid: 'u1', isAnonymous: true };
    out.anonRefused = (await _nwrStartRecord('kec61', 'https://x.test/s', 'Test')) === false;
    _currentUser = { uid: 'u1', isAnonymous: false };
    try { await _nwrStartRecord('kec61', 'https://x.test/s', 'Test'); } catch (e) {}
    out.signedInProceeds = panel === 1;
    window.showToast = st; window.openAuthModal = om; window._nwrOpenRecPanel = op;
    _currentUser = null;
    return out;
  });
  ok('a guest pressing Rec is asked to sign in, and nothing records', n.guest && n.guestModal, JSON.stringify(n));
  ok('AUTO never throws a sign-in box, and says so at most once a minute', n.autoQuiet && n.autoSaysOnce, JSON.stringify(n));
  ok('a guest (anonymous) session does not count as an account', n.anonRefused, JSON.stringify(n));
  ok('a signed-in account records as before', n.signedInProceeds, JSON.stringify(n));
  ok('no page errors in the radar app', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n3. NWRchive opens only for a GWCFC account');
{
  // A stand-in for the three Firebase scripts: just enough auth and database.
  const STUB = `
    window.__authCb = null; window.__user = null; window.__deleted = {};
    window.firebase = {
      initializeApp() {},
      auth: Object.assign(() => ({
        get currentUser() { return window.__user; },
        onAuthStateChanged(cb) { window.__authCb = cb; setTimeout(() => cb(window.__user), 0); },
        async signInWithEmailAndPassword(e, p) {
          if (p !== 'right') { const x = new Error('bad'); x.code = 'auth/invalid-credential'; throw x; }
          window.__user = { uid: 'u-' + e, email: e, displayName: 'Tester', isAnonymous: false, delete: async () => {} };
          window.__authCb(window.__user);
        },
        async signInWithPopup() {},
        async signOut() { window.__user = null; window.__authCb(null); },
      }), { GoogleAuthProvider: function () {} }),
      firestore: () => ({ collection: () => ({ doc: (id) => ({ get: async () => ({ exists: !!window.__deleted[id] }) }) }) }),
    };`;
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errs = [], nwrHits = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.route('**://**', r => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (/gstatic\.com\/firebasejs\/.*firebase-app-compat/.test(u)) return r.fulfill({ contentType: 'application/javascript', body: STUB });
    if (/gstatic\.com\/firebasejs\//.test(u)) return r.fulfill({ contentType: 'application/javascript', body: '' });
    if (/pythonsden/.test(u)) { nwrHits.push(u); return r.fulfill({ status: 404, body: '' }); }
    return r.abort();
  });
  await p.goto('file://' + join(ROOT, 'nwrchive.html') + '#/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  const g1 = await p.evaluate(() => ({
    gate: !document.getElementById('acct-gate').classList.contains('off'),
    form: document.getElementById('gate-form').style.display !== 'none',
    msg: document.getElementById('gate-msg').textContent,
    app: document.getElementById('app').innerHTML.trim().length,
  }));
  ok('signed out: the sign-in card covers the page, and the archive is empty', g1.gate && g1.form && g1.app === 0 && /GWCFC account/.test(g1.msg), JSON.stringify(g1));
  ok('nothing is fetched from the recordings server before sign-in', nwrHits.length === 0, nwrHits.join(' '));
  await p.evaluate(() => { location.hash = '#/about'; });
  await p.waitForTimeout(300);
  ok('changing the page address does not get round it', await p.evaluate(() => document.getElementById('app').innerHTML.trim().length) === 0);
  await p.fill('#gate-email', 'a@b.test'); await p.fill('#gate-pass', 'wrong');
  await p.click('.gate-btn:not(.alt)');
  await p.waitForTimeout(200);
  ok('a wrong password is said plainly', /do not match/.test(await p.textContent('#gate-err')));
  await p.fill('#gate-pass', 'right');
  await p.click('.gate-btn:not(.alt)');
  await p.waitForTimeout(800);
  const g2 = await p.evaluate(() => ({
    gate: !document.getElementById('acct-gate').classList.contains('off'),
    who: document.getElementById('acct-who').textContent,
    app: document.getElementById('app').innerHTML.trim().length,
  }));
  ok('signed in: the card goes, the archive loads, and the nav says who', !g2.gate && g2.app > 0 && /Tester/.test(g2.who), JSON.stringify(g2));
  ok('and only now is the recordings server asked', nwrHits.length > 0, String(nwrHits.length));
  await p.evaluate(() => acctSignOut());
  await p.waitForTimeout(300);
  const g3 = await p.evaluate(() => ({
    gate: !document.getElementById('acct-gate').classList.contains('off'),
    app: document.getElementById('app').innerHTML.trim().length,
  }));
  ok('signing out locks it again and clears the page', g3.gate && g3.app === 0, JSON.stringify(g3));
  // A guest session from the radar app does not count; a deleted account is refused.
  await p.evaluate(() => { window.__user = { uid: 'anon', isAnonymous: true }; window.__authCb(window.__user); });
  await p.waitForTimeout(200);
  ok('a guest session does not open it', await p.evaluate(() => !document.getElementById('acct-gate').classList.contains('off')));
  await p.evaluate(() => { window.__deleted['gone'] = true; window.__user = { uid: 'gone', email: 'g@x', isAnonymous: false, delete: async () => { window.__goneDeleted = true; } }; window.__authCb(window.__user); });
  await p.waitForTimeout(300);
  const g4 = await p.evaluate(() => ({ gate: !document.getElementById('acct-gate').classList.contains('off'), msg: document.getElementById('gate-msg').textContent, del: !!window.__goneDeleted }));
  ok('a deleted account is refused, and its sign-in is deleted', g4.gate && /deleted/.test(g4.msg) && g4.del, JSON.stringify(g4));
  ok('no page errors in NWRchive', errs.length === 0, errs.join(' | '));
  await ctx.close();

  // No accounts at all (Firebase unreachable): it stays closed and says why.
  const ctx2 = await b.newContext();
  const p2 = await ctx2.newPage();
  await p2.route('**://**', r => r.request().url().startsWith('file://') ? r.continue() : r.abort());
  await p2.goto('file://' + join(ROOT, 'nwrchive.html'), { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1500);
  const g5 = await p2.evaluate(() => ({ gate: !document.getElementById('acct-gate').classList.contains('off'), msg: document.getElementById('gate-msg').textContent }));
  ok('with the account system unreachable it stays closed and says why', g5.gate && /could not load/.test(g5.msg), JSON.stringify(g5));
  await ctx2.close();
}
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
