#!/usr/bin/env node
/*
 * Manage Members can block an account from the live chat, and it actually
 * holds - both in the page and at the database.
 *
 *     node tools/test-chat-block.mjs
 *
 * Three layers, all checked here:
 *   1. The toggle in Manage Members writes chatBlocked onto that account's
 *      own document, the same protected-field pattern staffRole and
 *      forecaster already use (owner-only, never self-writable).
 *   2. The live chat composer reads it back for the SIGNED-IN account and
 *      closes itself off - disabled input, a plain-English reason - rather
 *      than leaving a button that will just fail on click.
 *   3. The Firestore rule itself refuses a chat message from a blocked
 *      account, which is the part that actually matters: the composer
 *      being disabled only stops the normal page, not someone writing to
 *      Firestore directly.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const RULES = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
const RULES_DOC = readFileSync(join(ROOT, 'firebase/FIRESTORE_RULES.txt'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the rules protect the field, and enforce the block');
{
  ok('chatBlocked cannot be self-written - it is a protected role field',
     /hasAny\(\[[\s\S]{0,200}'chatBlocked', 'chatBlockedBy', 'chatBlockedAt'/.test(RULES));
  ok('a fresh account cannot create itself already blocked (or unblocked)',
     /!\('chatBlocked' in request\.resource\.data\)/.test(RULES));
  ok('isChatBlocked() reads the SIGNED-IN account\'s own document',
     /function isChatBlocked\(\)[\s\S]{0,250}request\.auth\.uid\)\)\.data\.chatBlocked == true/.test(RULES));
  ok('a radar-sourced chat message is refused for a blocked account',
     /source == 'radar'[\s\S]{0,150}!isChatBlocked\(\)/.test(RULES));
  ok('the paste-into-console file carries the same three things',
     RULES_DOC.includes("'chatBlocked', 'chatBlockedBy', 'chatBlockedAt'")
     && RULES_DOC.includes('function isChatBlocked()')
     && /source == 'radar'[\s\S]{0,150}!isChatBlocked\(\)/.test(RULES_DOC));
}

console.log('\n2. the page has the toggle and the composer-side gate');
{
  ok('Manage Members carries a Block chat checkbox per row',
     /onchange="staffSetChatBlock\('\$\{u\.uid\}', this\.checked, this\)"/.test(PAGE));
  ok('the owner\'s own row cannot be blocked',
     /isOwnerRow \? 'disabled' : \(u\.chatBlocked \? 'checked' : ''\)/.test(PAGE));
  ok('staffSetChatBlock writes all three fields owner-side',
     /async function staffSetChatBlock\(uid, on, el\)[\s\S]{0,600}chatBlocked: !!on[\s\S]{0,200}chatBlockedBy[\s\S]{0,150}chatBlockedAt/.test(PAGE));
  ok('the composer disables itself and says why when blocked',
     /_chatSyncComposer\(\)[\s\S]{0,900}You are blocked from chat/.test(PAGE));
  ok('chatSend() refuses to even try once the account is known to be blocked',
     /async function chatSend\(\)[\s\S]{0,400}_chatBlockedSelf[\s\S]{0,150}return;/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM) && !RULES.includes(EM) && !RULES_DOC.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-chat-block.mjs'), 'utf8').includes(EM));
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

console.log('\n3. toggling it in Manage Members writes the right document');
{
  const r = await p.evaluate(async () => {
    const calls = [];
    _currentUser = { uid: 'owner', email: 'ralphies1005@gmail.com', isAnonymous: false };
    _fbDb = { collection: (name) => ({ doc: (id) => ({ set: async (data, opts) => {
      calls.push({ name, id, data, opts });
    } }) }) };
    window.firebase = { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TS' } } };
    _staffUsers = [
      { uid: 'owner-uid', name: 'Ralph', email: 'ralphies1005@gmail.com',
        avatarImage: '', emoji: '', staffRole: 'owner', forecaster: true, chatBlocked: false },
      { uid: 'rowdy-uid', name: 'Rowdy Member', email: 'rowdy@example.org',
        avatarImage: '', emoji: '', staffRole: 'member', forecaster: false, chatBlocked: false },
    ];
    document.getElementById('lqm-profile-overlay').classList.add('lqm-panel-open', 'lqm-wide');
    document.getElementById('lqm-view-profile').classList.remove('open');
    document.getElementById('lqm-view-staff').classList.add('open');
    _staffRenderList('');
    const rows = Array.from(document.querySelectorAll('.lqm-staff-row'));
    const ownerRow = rows.find(r => r.title.startsWith('Ralph'));
    const memberRow = rows.find(r => r.title.startsWith('Rowdy'));
    const ownerBox = ownerRow.querySelector('.lqm-staff-block input');
    const memberBox = memberRow.querySelector('.lqm-staff-block input');
    const before = { ownerDisabled: ownerBox.disabled, memberChecked: memberBox.checked };
    memberBox.checked = true;
    await staffSetChatBlock('rowdy-uid', true, memberBox);
    return { before, calls, memberNowChecked: memberBox.checked, rec: _staffUsers.find(u => u.uid === 'rowdy-uid') };
  });
  ok('the owner\'s own checkbox is disabled', r.before.ownerDisabled, JSON.stringify(r.before));
  ok('the target member started unblocked', !r.before.memberChecked, JSON.stringify(r.before));
  ok('exactly one write happened, to the right account\'s document',
     r.calls.length === 1 && r.calls[0].name === 'users' && r.calls[0].id === 'rowdy-uid',
     JSON.stringify(r.calls));
  ok('it set chatBlocked true and recorded who did it',
     r.calls[0].data.chatBlocked === true && r.calls[0].data.chatBlockedBy === 'ralphies1005@gmail.com',
     JSON.stringify(r.calls[0]));
  ok('the in-memory record and the checkbox both reflect it', r.rec.chatBlocked === true && r.memberNowChecked,
     JSON.stringify(r));
}

console.log('\n4. a blocked account\'s own composer closes itself off');
{
  const closed = await p.evaluate(() => {
    _currentUser = { uid: 'blocked-uid', email: 'blocked@example.org', isAnonymous: false };
    _chatBlockedSelf = true;
    _chatSyncComposer();
    const input = document.getElementById('lqm-chat-input');
    const btn = document.getElementById('lqm-chat-send');
    return {
      inputDisabled: input.disabled,
      btnDisabled: btn.disabled,
      status: document.getElementById('lqm-chat-status')?.innerHTML
        || document.querySelector('#lqm-chat-overlay [id*="status" i]')?.innerHTML || '',
    };
  });
  ok('the message box is disabled', closed.inputDisabled, JSON.stringify(closed));
  ok('the send button is disabled', closed.btnDisabled, JSON.stringify(closed));

  const reopened = await p.evaluate(() => {
    _chatBlockedSelf = false;
    _chatSyncComposer();
    const input = document.getElementById('lqm-chat-input');
    return { inputDisabled: input.disabled };
  });
  ok('and it opens back up once the flag clears (e.g. a fresh sign-in)',
     !reopened.inputDisabled, JSON.stringify(reopened));
}

console.log('\n5. chatSend() itself refuses, not just the disabled button');
{
  const r = await p.evaluate(async () => {
    let addCalled = false;
    _currentUser = { uid: 'blocked-uid', email: 'blocked@example.org',
                      isAnonymous: false, displayName: 'Blocked Person' };
    _fbDb = { collection: () => ({ add: async () => { addCalled = true; } }) };
    _chatBlockedSelf = true;
    const input = document.getElementById('lqm-chat-input');
    if (input) { input.disabled = false; input.value = 'hello anyway'; }
    await chatSend();
    return { addCalled };
  });
  ok('calling chatSend() directly (bypassing the disabled UI) still sends nothing',
     !r.addCalled, JSON.stringify(r));
  ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await p.close();
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
