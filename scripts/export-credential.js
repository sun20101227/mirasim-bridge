#!/usr/bin/env node
'use strict';
// Export this user's Mirasim credential for a headless server. No secrets printed.
// mrs1 is the desktop setting format: nonce(12) + GCM tag(16) + ciphertext.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function readMasterKey(settingsFile) {
  for (const value of [process.env.MIRASIM_SECRET_KEY, process.env.MIRASIM_APP_SECRET_KEY]) {
    if (/^[0-9a-f]{64}$/i.test(value || '')) return Buffer.from(value, 'hex');
  }
  let value;
  try {
    const opts = { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] };
    if (process.platform === 'win32') {
      // Read only the app's own secret.key. Keep it off the command line/logs.
      const script = "$ErrorActionPreference='Stop'; $s=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }";
      value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { ...opts, input: fs.readFileSync(path.join(path.dirname(settingsFile), 'secret.key'), 'utf8') });
    } else if (process.platform === 'darwin') {
      value = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'mirasim', '-a', 'config-secret-key', '-w'], opts);
    } else {
      value = execFileSync('secret-tool', ['lookup', 'service', 'mirasim', 'account', 'config-secret-key'], opts);
    }
  } catch { throw Error('Cannot read Mirasim master key. Export on the originally logged-in machine as the same user, or provide MIRASIM_SECRET_KEY.'); }
  if (!/^[0-9a-f]{64}$/i.test(value.trim())) throw Error('Invalid Mirasim master key');
  return Buffer.from(value.trim(), 'hex');
}

function decode(value, key) {
  if (typeof value !== 'string' || !value.startsWith('mrs1:')) return value;
  if (!key || key.length !== 32) throw Error('Encrypted credential requires Mirasim master key');
  try {
    const packed = Buffer.from(value.slice(5), 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
    cipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]).toString('utf8');
  } catch { throw Error('Cannot decrypt Mirasim credential (wrong machine/user/master key)'); }
}

function portable(raw, key) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Credential must be a JSON object');
  if (raw.type === 'mirasim') {
    return { type: 'mirasim', storage_version: 1, access_token: decode(raw.access_token, key),
      refresh_token: decode(raw.refresh_token, key), device_private_key: decode(raw.device_private_key, key), expired: raw.expired };
  }
  return { auth: { token: decode(raw.auth?.token, key), refreshToken: decode(raw.auth?.refreshToken, key), exp: raw.auth?.exp,
    userId: raw.auth?.userId, name: raw.auth?.name }, device: { privateKey: decode(raw.device?.privateKey, key) } };
}

function exportCredential(input, output) {
  input = path.resolve(input); output = path.resolve(output);
  if (input === output) throw Error('Export destination must differ from the desktop setting file');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw Error('Cannot read credential JSON; check the input file'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Credential must be a JSON object');
  const encrypted = [raw.auth?.token, raw.auth?.refreshToken, raw.device?.privateKey,
    raw.access_token, raw.refresh_token, raw.device_private_key].some((s) => typeof s === 'string' && s.startsWith('mrs1:'));
  const key = encrypted ? readMasterKey(input) : null;
  try {
    const out = portable(raw, key);
    const token = out.auth?.token || out.access_token;
    const refresh = out.auth?.refreshToken || out.refresh_token;
    const pem = out.device?.privateKey || out.device_private_key;
    if (typeof token !== 'string' || typeof refresh !== 'string' || !token || !refresh || !pem || /[\r\n\0]/.test(token + refresh)) throw Error('Export requires valid access token, refresh token and device private key');
    let signer;
    try { signer = crypto.createPrivateKey(pem); } catch { throw Error('Exported device key is invalid'); }
    if (signer.asymmetricKeyType !== 'ed25519') throw Error('Exported device key must be Ed25519');
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, JSON.stringify(out, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } finally { key?.fill(0); }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const get = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    if (args.includes('--help')) {
      console.log('node scripts/export-credential.js [--settings FILE] --out NEW_FILE\nRun on the originally logged-in machine. Exports only auth and device credentials; does not overwrite files.');
    } else {
      const out = get('--out');
      if (!out || out.startsWith('--')) throw Error('--out NEW_FILE is required');
      exportCredential(get('--settings') || path.join(os.homedir(), '.mirasim', 'setting.json'), out);
      console.log('Portable credential exported (contains live secrets; upload only to your own server).');
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { decode, portable, exportCredential };
