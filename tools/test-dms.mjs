#!/usr/bin/env node
/*
 * Direct messages between radar accounts.
 *
 *     node tools/test-dms.mjs
 *
 * The console rules are frozen, so the privacy is now the cryptography:
 * every thread is sealed in the browser (ECDH key agreement, AES-GCM)
 * before it is stored in collections the published rules already allow.
 * Section 1 pins that shape into the page; section 2 keeps the unpublished
 * dms rules honest as OPTIONAL hardening for later; the browser half
 * drives the furniture and proves the crypto round-trips, rejects
 * tampering, and refuses the wrong key.
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

console.log('\n1. the crypto is the privacy, on rules already published');
{
  ok('threads are sealed blobs in modelCache, named for their pair',
     PAGE.includes("collection('modelCache').doc(threadId)")
     && PAGE.includes("'dmt_' + _dmPairId("));
  ok('the directory (public keys included) rides chatBridge',
     PAGE.includes("doc('dmpub_' + "));
  ok('the sealing is ECDH key agreement into AES-GCM',
     /namedCurve: 'P-256'/.test(PAGE) && /AES-GCM/.test(PAGE));
  ok('the private key lives in the one doc only its owner can read',
     PAGE.includes('dmPriv') && PAGE.includes('dmPeers'));
  ok('nothing points at the unpublished collections any more',
     !PAGE.includes("collection('dms')")
     && !PAGE.includes("collection('dmDirectory')"));
  ok('a changed peer key is detected and surfaced, not silently trusted',
     PAGE.includes('_dmcChanged') && PAGE.includes('_dmcTrust'));
  ok('the sealed field is trimmed under the published 400k cap',
     /length > 280000/.test(PAGE));
  ok('the query sentinels are written as escapes, not invisible bytes',
     PAGE.split('\\uf8ff').length === 3
     && !PAGE.includes(String.fromCharCode(0xf8ff)));
}

console.log('\n2. the unpublished rules stay honest, as optional hardening');
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
     RULES.includes('match /dmDirectory/{uid}')
     && RULES.includes("hasOnly(['name', 'nameLower',"));
  ok('and the handbook says plainly these blocks are not in use yet',
     /DIRECT MESSAGES/.test(RULES_DOC) && /dmDirectory/.test(RULES_DOC)
     && /does NOT currently use/.test(RULES_DOC));
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

console.log('\n3. the furniture works, signed out and in');
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

console.log('\n4. two accounts derive one secret; nobody else opens a word');
{
  const r = await p.evaluate(async () => {
    const out = {};
    const mk = () => crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const pair = (priv, pub) => crypto.subtle.deriveKey(
      { name: 'ECDH', public: pub }, priv,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const A = await mk(), B = await mk(), C = await mk();
    const kAB = await pair(A.privateKey, B.publicKey);
    const kBA = await pair(B.privateKey, A.publicKey);
    const kCB = await pair(C.privateKey, B.publicKey);
    const sealed = await _dmcSeal(kAB, { msgs: [{ text: 'hello from A' }] });
    out.opaque = !sealed.includes('hello') && /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(sealed);
    const opened = await _dmcOpen(kBA, sealed);
    out.roundtrip = !!(opened && opened.msgs && opened.msgs[0].text === 'hello from A');
    out.tampered = (await _dmcOpen(kBA,
      sealed.slice(0, -8) + 'AAAAAAAA')) === null;
    out.wrongKey = (await _dmcOpen(kCB, sealed)) === null;
    return out;
  });
  ok('what is stored is ciphertext, not words', r.opaque);
  ok('the other member derives the same key and reads the message',
     r.roundtrip);
  ok('a tampered blob opens to nothing, never to garbage', r.tampered);
  ok('a third party with their own keys gets nothing', r.wrongKey);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
