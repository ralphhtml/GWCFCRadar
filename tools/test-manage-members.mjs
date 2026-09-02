#!/usr/bin/env node
/*
 * Manage Members shows who each member actually is.
 *
 *     npm i playwright && node tools/test-manage-members.mjs
 *
 * The panel decides who gets to issue warnings to everybody, so the one thing
 * it has to do is say unambiguously WHO a row is. It did not: both the name
 * and the address ended in text-overflow: ellipsis inside a card capped at
 * 280px, so anything long was cut. Two people called Alex at the same company
 * are told apart by the end of the address, and the end is exactly what an
 * ellipsis eats.
 *
 * Measured rather than eyeballed. A screenshot cannot tell you that a string
 * is one pixel wider than its box; scrollWidth against clientWidth can, and
 * that is the difference between "looks fine on my long name" and "is fine".
 *
 * The old rules are put back mid-test to prove the fix is load-bearing. A
 * test that only checks the new state passes just as happily against a
 * stylesheet where nothing was ever wrong.
 */

import { readdirSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed, skipping. npm i playwright');
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const LEAFLET_STUB = `(() => {
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'getCenter')  return () => ({ lat: 35.3, lng: -97.3 });
      if (k === 'getZoom')    return () => 7;
      if (k === 'hasLayer')   return () => false;
      if (k === 'getPane')    return () => document.createElement('div');
      if (k === 'createPane') return () => document.createElement('div');
      if (k === 'getBounds')  return () => ({ getWest:()=>-100, getEast:()=>-95,
        getNorth:()=>38, getSouth:()=>33, contains:()=>true, pad(){return this;} });
      if (k === 'then') return undefined;
      return chain();
    },
    apply: () => chain(), construct: () => chain(),
  });
  Object.defineProperty(window, 'L',
    { value: chain(), writable: true, configurable: true });
})();`;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      if (!d.startsWith('chromium-')) continue;
      const p = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch { /* let Playwright try its own */ }
  return undefined;
}

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.addInitScript(LEAFLET_STUB);
await page.route('**://**', r =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// Three members chosen to be awkward on purpose: an ordinary one, one whose
// name and address are both long enough to have been cut before, and one with
// no address at all.
const LONG_EMAIL =
  'alexandra.featherstonehaugh@meteorological-services.example.org';
const LONG_NAME = 'Alexandra Featherstonehaugh-Cholmondeley';

await page.evaluate(({ LONG_EMAIL, LONG_NAME }) => {
  _currentUser = { uid: 'owner', email: 'ralphies1005@gmail.com',
                   isAnonymous: false };
  _staffUsers = [
    { uid: 'a1', name: 'Ralph', email: 'ralphies1005@gmail.com',
      avatarImage: '', emoji: '', staffRole: 'owner', forecaster: true },
    { uid: 'b2', name: LONG_NAME, email: LONG_EMAIL,
      avatarImage: '', emoji: '', staffRole: 'moderator', forecaster: false },
    { uid: 'c3', name: '(no name)', email: '',
      avatarImage: '', emoji: '', staffRole: 'member', forecaster: false },
  ];
  // The panel is only laid out when it is actually on screen, and a row that
  // is not laid out reports every width as zero, which reads as "nothing is
  // clipped" whatever the rules say. This is the check passing for the wrong
  // reason, and it cost a run to notice.
  document.getElementById('lqm-profile-overlay').classList.add('lqm-panel-open');
  document.getElementById('lqm-profile-guest').style.display = 'none';
  document.getElementById('lqm-profile-user').style.display = '';
  document.getElementById('lqm-view-profile').classList.remove('open');
  document.getElementById('lqm-view-staff').classList.add('open');
  document.getElementById('lqm-profile-overlay').classList.add('lqm-wide');
  _staffRenderList('');
}, { LONG_EMAIL, LONG_NAME });

// scrollWidth past clientWidth is text wider than its box; scrollHeight past
// clientHeight is text taller than its box. Either one is text the reader
// cannot see, whether or not an ellipsis is drawn to admit it.
const read = () => page.evaluate(() => {
  const cut = (el) => !el ? null : {
    text: el.textContent.trim(),
    cut: el.scrollWidth > el.clientWidth + 1
      || el.scrollHeight > el.clientHeight + 1,
  };
  const rows = [...document.querySelectorAll('.lqm-staff-row')];
  const ov = document.getElementById('lqm-profile-overlay');
  return {
    overlayW: Math.round(ov.getBoundingClientRect().width),
    laidOut: rows.every(r => r.getBoundingClientRect().height > 0),
    rows: rows.map(r => ({
      name: cut(r.querySelector('.lqm-staff-name')),
      email: cut(r.querySelector('.lqm-staff-email')),
      title: r.getAttribute('title') || '',
      h: Math.round(r.getBoundingClientRect().height),
      sideways: r.scrollWidth > r.clientWidth + 1,
    })),
  };
});

console.log('\n1. the panel is really on screen, so the measurements mean something');
const r = await read();
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
ok('three member rows are drawn', r.rows.length === 3, r.rows.length);
ok('and they have real height, not zero', r.laidOut,
   JSON.stringify(r.rows.map(x => x.h)));

console.log('\n2. nothing is cut off');
r.rows.forEach((row, i) => {
  ok(`row ${i + 1}: the name is shown whole`, !row.name.cut, row.name.text);
  ok(`row ${i + 1}: the address is shown whole`, !row.email.cut, row.email.text);
});
ok('the long address is there in full, to its last character',
   r.rows[1].email.text === LONG_EMAIL, r.rows[1].email.text);
ok('and the long name is there in full',
   r.rows[1].name.text === LONG_NAME, r.rows[1].name.text);
ok('the row wrapped rather than growing a sideways scrollbar',
   !r.rows[1].sideways && r.rows[1].h > r.rows[0].h,
   JSON.stringify({ side: r.rows[1].sideways, h: r.rows[1].h }));

console.log('\n3. an account with no address says so, rather than showing a raw id');
ok('it is named as having no email', /no email/i.test(r.rows[2].email.text),
   r.rows[2].email.text);
ok('and the id is still there to identify them by',
   r.rows[2].email.text.includes('c3'), r.rows[2].email.text);

console.log('\n4. the whole identity is on the row itself, for hovering');
ok('name, address and id are all in the tooltip',
   r.rows[1].title.includes(LONG_NAME) && r.rows[1].title.includes(LONG_EMAIL)
   && r.rows[1].title.includes('b2'), r.rows[1].title);

console.log('\n5. the fix is load-bearing: the old rules really did cut it');
{
  const before = await page.evaluate(() => {
    const st = document.createElement('style');
    st.id = '__old';
    // Exactly what was there before: the narrow card and the ellipsis.
    st.textContent = `#lqm-profile-overlay.lqm-wide { max-width: 280px; }
      .lqm-staff-name, .lqm-staff-email {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`;
    document.head.appendChild(st);
    const el = document.querySelectorAll('.lqm-staff-row')[1];
    const n = el.querySelector('.lqm-staff-name');
    const e = el.querySelector('.lqm-staff-email');
    const out = { name: n.scrollWidth > n.clientWidth + 1,
                  email: e.scrollWidth > e.clientWidth + 1 };
    st.remove();
    return out;
  });
  ok('under the old rules the long name was cut', before.name);
  ok('and so was the long address', before.email);
}

console.log('\n6. the wide card belongs to this view and does not leak');
{
  const back = await page.evaluate(() => {
    lqmCloseStaffView();
    return {
      wide: document.getElementById('lqm-profile-overlay')
              .classList.contains('lqm-wide'),
      staffOpen: document.getElementById('lqm-view-staff')
              .classList.contains('open'),
    };
  });
  ok('leaving the members view narrows the card again', !back.wide);
  ok('and the view itself is closed', !back.staffOpen);
}

console.log('\n7. blank identities heal from the sign-in token');
{
  const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('the heal rides every sign-in, not just signup',
     /_profileSelfHeal\(uid, d \|\| \{\}\)/.test(PAGE));
  const heal = await page.evaluate(async () => {
    const writes = [];
    _fbDb = { collection: c => ({ doc: id => ({
      set: (data, opts) => { writes.push({ c, id, data, opts }); return Promise.resolve(); },
    }) }) };
    // An old account: doc empty, token knows the address.
    _currentUser = { uid: 'u9', email: 'casey@example.org',
                     displayName: '', isAnonymous: false };
    _profileSelfHeal('u9', {});
    // A phone signup: the synthetic address becomes a phone number.
    _currentUser = { uid: 'p7', email: 'phone_15551234567@gwcfc-radar.app',
                     displayName: 'Storm Chaser', isAnonymous: false };
    _profileSelfHeal('p7', {});
    // A complete account: nothing to heal, nothing written.
    _currentUser = { uid: 'ok1', email: 'fine@example.org',
                     displayName: 'Fine', isAnonymous: false };
    _profileSelfHeal('ok1', { displayName: 'Fine', email: 'fine@example.org' });
    // An anonymous session: never writes a profile.
    _currentUser = { uid: 'anon', email: null, isAnonymous: true };
    _profileSelfHeal('anon', {});
    await new Promise(r => setTimeout(r, 50));
    _currentUser = { uid: 'owner', email: 'ralphies1005@gmail.com',
                     isAnonymous: false };
    return writes;
  });
  const w9 = heal.find(w => w.id === 'u9');
  const w7 = heal.find(w => w.id === 'p7');
  ok('a blank doc gets its email from the token, plus a derived name',
     w9 && w9.c === 'users' && w9.data.email === 'casey@example.org'
     && w9.data.displayName === 'casey' && w9.opts && w9.opts.merge === true,
     JSON.stringify(w9));
  ok('a phone signup is stored as a phone number, never a fake email',
     w7 && w7.data.phone === '15551234567' && !('email' in w7.data)
     && w7.data.displayName === 'Storm Chaser', JSON.stringify(w7));
  ok('a complete account and an anonymous session write nothing',
     heal.length === 2, JSON.stringify(heal.map(w => w.id)));
  ok('role fields are never part of a heal',
     heal.every(w => !('staffRole' in w.data) && !('forecaster' in w.data)));
}

console.log('\n8. names the accounts never saved are found where they spoke');
{
  const r = await page.evaluate(async () => {
    _fbDb = { collection: name => ({
      get: async () => ({ docs: name === 'chatBridge' ? [
        { id: 'dmpub_c3', data: () => ({ name: 'Quiet Casey', pub: 'x' }) },
        { id: 'state', data: () => ({ last: '1' }) },
      ] : [] }),
      orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [
        { id: 'm1', data: () => ({ uid: 'd4', name: 'Chatty Dana',
                                   source: 'radar', ts: 2 }) },
        { id: 'm2', data: () => ({ uid: 'c3', name: 'Old Casey',
                                   source: 'radar', ts: 1 }) },
      ] }) }) }),
    }) };
    _staffUsers = [
      { uid: 'c3', name: '', email: '', phone: '', avatarImage: '',
        emoji: '', staffRole: 'member', forecaster: false },
      { uid: 'd4', name: '', email: '', phone: '15550001111', avatarImage: '',
        emoji: '', staffRole: 'member', forecaster: false },
      { uid: 'e5', name: 'Named Elle', email: 'elle@example.org', phone: '',
        avatarImage: '', emoji: '', staffRole: 'member', forecaster: false },
    ];
    await _staffFillGaps();
    document.getElementById('lqm-view-staff').classList.add('open');
    _staffRenderList('');
    const rows = [...document.querySelectorAll('.lqm-staff-row')];
    return rows.map(el => ({
      name: el.querySelector('.lqm-staff-name').textContent.trim(),
      who: el.querySelector('.lqm-staff-email').textContent.trim(),
    }));
  });
  const c3 = r.find(x => x.name.startsWith('Quiet Casey'));
  const d4 = r.find(x => x.name.startsWith('Chatty Dana'));
  ok('the Messages directory outranks an older chat name',
     c3 && /\(from Messages directory\)/.test(c3.name), JSON.stringify(r));
  ok('a chat-only speaker gets their latest chat name, marked as such',
     d4 && /\(from chat\)/.test(d4.name), JSON.stringify(d4));
  ok('a phone account shows its number where the email would be',
     d4 && /phone: 15550001111/.test(d4.who), d4 && d4.who);
  ok('a name saved in the profile is untouched by harvesting',
     r.some(x => x.name === 'Named Elle'), JSON.stringify(r.map(x => x.name)));
}

console.log('\n9. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
