#!/usr/bin/env node
/*
 * Direct messages between radar accounts.
 *
 *     node tools/test-dms.mjs
 *
 * The privacy is the Firestore rules, so section 1 reads them the way a
 * reviewer would: membership provable from the thread id alone, anonymous
 * sign-ins shut out, message shape pinned, membership frozen after create.
 * The browser half drives the furniture: the modal, the signed-out answer,
 * the pair-id arithmetic, and the tap-a-chat-name door.
 */

import { readFileSync } from 'node:fs';
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

console.log('\n1. the rules are the privacy');
{
  ok('membership is provable from the thread id alone',
     RULES.includes("request.auth.uid in threadId.split('__')"));
  ok('anonymous sign-ins can never touch mail',
     /match \/dms\/\{threadId\}[\s\S]*?allow read: if realAccount\(\)/.test(RULES));
  ok('a thread id and its members can never disagree',
     RULES.includes("threadId == request.resource.data.members[0] + '__'")
     && RULES.includes('request.resource.data.members[0] < request.resource.data.members[1]'));
  ok('membership is frozen after create',
     RULES.includes('request.resource.data.members == resource.data.members'));
  ok('a message is pinned to its sender and its shape',
     RULES.includes('request.resource.data.from == request.auth.uid')
     && RULES.includes("hasOnly(['from', 'name', 'text', 'ts'])"));
  ok('messages cannot be edited, only taken back by their author',
     /match \/messages\/\{msgId\}[\s\S]*?allow update: if false;[\s\S]*?request\.auth\.uid == resource\.data\.from/.test(RULES));
  ok('the directory row is self-written, name and avatar only',
     RULES.includes("match /dmDirectory/{uid}")
     && RULES.includes("hasOnly(['name', 'nameLower',"));
  ok('and the rules handbook explains the block',
     /DIRECT MESSAGES/.test(RULES_DOC) && /dmDirectory/.test(RULES_DOC));
  ok('the panel and the chat both open the door',
     /_dmOpen\(\)"><svg[^>]*><use href=#ic-mail><\/use><\/svg><span>Messages<\/span>/.test(PAGE)
     && /_dmFromChat\(/.test(PAGE));
  ok('the directory row rides the sign-in',
     /try \{ _dmDirectoryUpsert\(\); \} catch \(e\) \{\}/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here, in the page, or in the rules',
     !PAGE.includes(EM) && !RULES.includes(EM) && !RULES_DOC.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-dms.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'),
             { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);

console.log('\n2. the furniture works, signed out and in');
{
  const r = await p.evaluate(() => {
    const out = {};
    out.pair = _dmPairId('zeta', 'alpha');
    out.pairSame = _dmPairId('alpha', 'zeta');
    _dmOpen();
    out.open = document.getElementById('dm-modal').classList.contains('open');
    out.note = document.getElementById('dm-note').textContent;
    _dmClose();
    out.closed = !document.getElementById('dm-modal').classList.contains('open');
    return out;
  });
  ok('the pair id is order-blind, lower uid first',
     r.pair === 'alpha__zeta' && r.pairSame === r.pair, r.pair);
  ok('opening Messages signed out asks for a sign-in, honestly',
     r.open && /Sign in/i.test(r.note), r.note.slice(0, 60));
  ok('and close means close', r.closed);
}

console.log('\n3. a chat name is the door to a conversation');
{
  const r = await p.evaluate(() => {
    const out = {};
    const hits = [];
    const orig = window._dmFromChat;
    window._dmFromChat = i => hits.push(i);
    _chatMsgs = [
      { name: 'Storm Fan', uid: 'uidOther', source: 'radar', text: 'hi', ts: Date.now() },
      { name: 'Bridge Bot', source: 'discord', text: 'relay', ts: Date.now() },
    ];
    _chatRender();
    const names = [...document.querySelectorAll('#lqm-chat-msgs .chat-name')];
    out.able = names[0] && names[0].classList.contains('dm-able');
    out.discordPlain = names[1] && !names[1].classList.contains('dm-able');
    if (names[0]) names[0].click();
    out.hits = hits.slice();
    window._dmFromChat = orig;
    _chatMsgs = [];
    return out;
  });
  ok('a radar author’s name is tappable', r.able);
  ok('a Discord relay’s is not: there is no account behind it',
     r.discordPlain);
  ok('tapping it heads for that person’s thread',
     r.hits.length === 1 && r.hits[0] === 0, JSON.stringify(r.hits));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
