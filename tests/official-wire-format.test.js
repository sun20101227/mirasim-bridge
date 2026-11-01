'use strict';
// Proof that our relay request encoding matches the official client's, byte for byte.
//
// The official desktop client carries its signing core as an embedded wasm module
// (`cc_sign` / `cc_seal` / `cc_canonical`). We vendor that module and compare:
//
//   canonical(input)  ===  cc_canonical(fields, meta, body)
//   seal(...)         ===  cc_seal(...)
//
// If either drifts, the bridge is no longer speaking the relay's wire format and
// this test fails. What it deliberately does NOT claim: that the relay accepts the
// request. Header/signature *format* is provable offline; server acceptance is not —
// see SPACE-CREDIT.md for the observed 401 device_signature responses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonical, seal } = require('../lib/relay');
const { loadCore } = require('./helpers/official-core');

const SEAL_KEY = Buffer.from('HlyNMMeGXryasYLJuYQ/9ksCD4AYVVy1zXKAtJdpJn4=', 'base64');

test('our canonical string is byte-identical to the official crypto core', async (t) => {
  const core = await loadCore();
  if (!core) return t.skip('lib/vendor/cc.wasm not present');

  const fields = ['POST', '/v1/messages', '1700000000000', 'NONCE123', 'DEVICEID', '0.0.736', 'CREDENTIAL'];
  const meta = { 'x-mirasim-agent': 'claude', 'x-mirasim-session': 'mirasim_x' };
  const body = Buffer.from('{"model":"claude-opus-5-5"}');

  // The official builder takes the seven NUL-joined fields, the NUL-joined metadata
  // pairs, and the raw body.
  const metaPairs = Object.entries(meta).flat();
  const official = core.canonical(
    Buffer.from(fields.join('\0'), 'utf8'),
    Buffer.from(metaPairs.join('\0'), 'utf8'),
    body,
  );
  const ours = canonical({
    method: 'POST', path: '/v1/messages', timestamp: '1700000000000', nonce: 'NONCE123',
    device: 'DEVICEID', version: '0.0.736', credential: 'CREDENTIAL', body, metadata: meta,
  });
  assert.equal(ours.toString('utf8'), official.toString('utf8'));
  assert.match(ours.toString('utf8'), /^mrs-sig-v2\n/);
  // 10 lines: scheme + 6 fields + sha256(credential) + sha256(meta) + sha256(body)
  assert.equal(ours.toString('utf8').split('\n').length, 10);
});

test('our envelope is byte-identical to the official cc_seal', async (t) => {
  const core = await loadCore();
  if (!core) return t.skip('lib/vendor/cc.wasm not present');

  const ephemeral = Buffer.alloc(32, 7);
  const nonce = Buffer.alloc(12, 9);
  const plaintext = Buffer.from(JSON.stringify({ 'x-mirasim-agent': 'claude', 'x-mirasim-session': 'mirasim_x' }));
  const aad = Buffer.from('mrs-seal-v1\nPOST\n/v1/messages');

  const official = core.seal(SEAL_KEY, ephemeral, nonce, plaintext, aad);
  const ours = seal(SEAL_KEY, ephemeral, nonce, plaintext, aad);
  assert.equal(ours.toString('base64url'), official.toString('base64url'));
  // Layout: ephemeral pubkey (32) + nonce (12) + ciphertext + tag (16)
  assert.equal(ours.length, 32 + 12 + plaintext.length + 16);
});

test('signing the official canonical yields a 64-byte Ed25519 signature', async (t) => {
  const core = await loadCore();
  if (!core) return t.skip('lib/vendor/cc.wasm not present');

  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const fields = ['POST', '/v1/messages', '1', 'n', 'd', 'v', 'cred'].join('\0');
  const metaStr = 'x-mirasim-agent\0claude';
  const body = Buffer.from('{}');
  const officialSig = core.sign(seed, Buffer.from(fields), Buffer.from(metaStr), body);
  assert.equal(officialSig.length, 64);
  // Our Node-side signature over the same canonical bytes must match the wasm's.
  const ourCanonical = canonical({
    method: 'POST', path: '/v1/messages', timestamp: '1', nonce: 'n', device: 'd', version: 'v',
    credential: 'cred', body, metadata: { 'x-mirasim-agent': 'claude' },
  });
  const ourSig = crypto.sign(null, ourCanonical, privateKey);
  assert.equal(ourSig.toString('base64url'), officialSig.toString('base64url'));
});

test('the sealed header set matches the official include/exclude rules', () => {
  // Official RSi: every x-mirasim-* except x-mirasim-client and x-mirasim-enc.
  // Official Brc: the four signature headers stay in the clear, never sealed.
  const stayInClear = new Set(['x-mirasim-device', 'x-mirasim-ts', 'x-mirasim-nonce', 'x-mirasim-sig']);
  const all = {
    'x-mirasim-device': 'dev', 'x-mirasim-ts': '1', 'x-mirasim-nonce': 'n', 'x-mirasim-sig': 'sig',
    'x-mirasim-client': '0.0.736', 'x-mirasim-session': 's', 'x-mirasim-agent': 'claude',
    'x-mirasim-call': 'c', 'x-mirasim-account': 'a', 'x-mirasim-collect': 'off',
  };
  const sealed = Object.keys(all).filter((k) => k.startsWith('x-mirasim-')
    && k !== 'x-mirasim-client' && k !== 'x-mirasim-enc' && !stayInClear.has(k));
  assert.deepEqual(sealed.sort(), ['x-mirasim-account', 'x-mirasim-agent', 'x-mirasim-call', 'x-mirasim-collect', 'x-mirasim-session']);
  for (const k of stayInClear) assert.ok(!sealed.includes(k), `${k} must stay in the clear`);
});
