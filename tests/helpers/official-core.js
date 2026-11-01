'use strict';
// The relay's crypto core, taken from the official desktop client
// (server-main.cjs constant `ISi`, exported as cc_sign / cc_seal / cc_canonical).
//
// This is the ground truth for "does our request look like the official client's".
// Everything the bridge signs or seals must be byte-identical to what this module
// produces for the same inputs — that is the only part of header compatibility that
// can be proven offline. Whether the relay accepts a given request is a server-side
// decision and is NOT asserted here.
//
// The wasm is vendored at lib/vendor/cc.wasm and loaded lazily; tests skip cleanly if
// the file is absent (e.g. a source-only checkout that stripped binaries).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WASM_PATH = path.join(__dirname, '..', '..', 'lib', 'vendor', 'cc.wasm');
let cached = null;

/** Load the official crypto core, or null when the vendored wasm is not present. */
async function loadCore() {
  if (cached) return cached;
  if (!fs.existsSync(WASM_PATH)) return null;
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(WASM_PATH), {});
  const ex = instance.exports;
  const memory = () => new Uint8Array(ex.memory.buffer);
  const put = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const ptr = ex.cc_alloc(bytes.length);
    memory().set(bytes, ptr);
    return [ptr, bytes.length];
  };
  // The wasm returns a packed i64: high 32 bits = pointer, low 32 bits = length.
  const take = (packed) => {
    const big = BigInt(packed);
    const ptr = Number(big >> 0x20n);
    const len = Number(big & 0xffffffffn);
    if (ptr === 0) return null;
    const out = Buffer.from(memory().slice(ptr, ptr + len));
    ex.cc_free(ptr, len);
    return out;
  };
  cached = {
    exports: Object.keys(ex).sort(),
    canonical(fields, meta, body) {
      return take(ex.cc_canonical(...put(fields), ...put(meta), ...put(body)));
    },
    seal(publicKey, ephemeralPriv, nonce, plaintext, aad) {
      return take(ex.cc_seal(...put(publicKey), ...put(ephemeralPriv), ...put(nonce), ...put(plaintext), ...put(aad)));
    },
    sign(seed, canonical, meta, body) {
      return take(ex.cc_sign(...put(seed), ...put(canonical), ...put(meta), ...put(body)));
    },
  };
  return cached;
}

module.exports = { loadCore, WASM_PATH };
