'use strict';
// Protocol adapted from cpa-plugin-mirasim (MIT), see THIRD-PARTY-NOTICES.md.
// Only Node built-ins: the Linux service does not need Electron or Claude CLI.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const SEAL_KEY = 'HlyNMMeGXryasYLJuYQ/9ksCD4AYVVy1zXKAtJdpJn4=';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const secret = (value) => typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\s\x00]/.test(value);
const claims = (token) => {
  try { const parsed = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); return isObject(parsed) ? parsed : {}; }
  catch { return {}; }
};
const retryDelay = (value, floor = 30000) => {
  const text = String(value || '');
  const delay = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - Date.now();
  return Number.isFinite(delay) ? Math.max(floor, delay) : floor;
};

// Stop waiting immediately when this caller disconnects, without cancelling a
// credential operation that is also being awaited by another caller.
function waitForShared(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || Error('Request aborted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function canonical(input) {
  const fields = [input.method.toUpperCase(), input.path, String(input.timestamp), input.nonce,
    input.device, input.version, input.credential];
  if (fields.some((s) => typeof s !== 'string' || s.includes('\0'))) throw Error('Invalid signature field');
  const metadata = Object.fromEntries(Object.entries(input.metadata || {}).filter(([, v]) => v !== '')
    .map(([k, v]) => [k.toLowerCase(), v]));
  if (Object.entries(metadata).some(([k, v]) => k.includes('\0') || typeof v !== 'string' || v.includes('\0'))) throw Error('Invalid metadata');
  const text = Object.keys(metadata).sort().map((k) => `${k}:${metadata[k]}`).join('\n');
  return Buffer.from(['mrs-sig-v2', ...fields.slice(0, 6), sha(input.credential), text ? sha(text) : '', sha(input.body || Buffer.alloc(0))].join('\n'));
}

function seal(publicRaw, ephemeralRaw, nonce, plaintext, aad) {
  if (publicRaw.length !== 32 || ephemeralRaw.length !== 32 || nonce.length !== 12) throw Error('Invalid relay seal key/nonce');
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), ephemeralRaw]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), publicRaw]), format: 'der', type: 'spki' });
  const ephemeralPublic = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  const key = crypto.hkdfSync('sha256', shared, ephemeralPublic, 'mrs-seal-v1', 32);
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([ephemeralPublic, nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

// Never follows redirects (a redirect must not receive a bearer token).
function request(url, { method = 'GET', headers = {}, body, signal, headersTimeout = 60000, idleTimeout = 300000, totalTimeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers, signal }, (res) => {
      clearTimeout(timer);
      res.once('end', () => clearTimeout(deadline)); res.once('close', () => clearTimeout(deadline));
      resolve(res);
    });
    const timer = setTimeout(() => req.destroy(Error('relay response headers timeout')), headersTimeout);
    const deadline = totalTimeout > 0 ? setTimeout(() => req.destroy(Error('upstream total timeout')), totalTimeout) : null;
    deadline?.unref();
    timer.unref();
    req.setTimeout(idleTimeout, () => req.destroy(Error('relay idle timeout')));
    req.on('close', () => { clearTimeout(timer); clearTimeout(deadline); });
    req.on('error', reject);
    req.end(body);
  });
}

async function readText(res, limit = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) { res.destroy(); throw Error('relay response exceeds buffer limit'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validateEndpoint(value) {
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error('Invalid relay/auth URL');
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Relay/auth URL requires HTTPS (except loopback tests)');
}

function loadCredential(file) {
  let raw;
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) throw Error('too large');
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  }
  catch { throw Error('Cannot read Mirasim credential JSON; check relay.setting_json and file permissions'); }
  return parseCredential(raw);
}

function parseCredential(raw) {
  if (!isObject(raw)) throw Error('Mirasim credential must be a JSON object');
  const cpa = raw.type === 'mirasim';
  const access = cpa ? raw.access_token : raw.auth?.token;
  const refresh = cpa ? raw.refresh_token : raw.auth?.refreshToken;
  const pem = cpa ? raw.device_private_key : raw.device?.privateKey;
  if ([access, refresh, pem].some((s) => typeof s === 'string' && s.startsWith('mrs1:'))) throw Error('Encrypted mrs1 credential: run scripts/export-credential.js on the originally logged-in machine first (see RELAY.md)');
  if (!secret(access) || (refresh && !secret(refresh))) throw Error('Invalid or missing Mirasim access/refresh token');
  let key;
  try { key = crypto.createPrivateKey(pem); } catch { throw Error('Invalid Mirasim device private key'); }
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Mirasim requires an Ed25519 private key');
  const publicKey = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
  const decoded = claims(access);
  const expires = Number(decoded.exp) * 1000 || (cpa ? Date.parse(raw.expired) : Number(raw.auth?.exp) * 1000) || 0;
  if (!Number.isFinite(expires) || expires < 0) throw Error('Invalid Mirasim credential expiry');
  return { raw, cpa, access, refresh, key, publicKey, expires,
    device: crypto.createHash('sha256').update(publicKey).digest('base64url').slice(0, 22) };
}

function relayAgent(route, body) {
  if (route.startsWith('/v1/responses')) return 'codex';
  let model = '';
  try { const parsed = JSON.parse(body); model = typeof parsed?.model === 'string' ? parsed.model : ''; } catch { /* control request */ }
  if (model.startsWith('deepseek-')) return 'dsh';
  if (model.startsWith('kimi-')) return 'kimi';
  if (model.startsWith('glm-')) return 'zcode';
  return 'claude';
}

class RelayClient {
  constructor(options) {
    this.options = options;
    validateEndpoint(options.url); validateEndpoint(options.auth_url);
    this.credential = loadCredential(options.setting_json);
    this.sealKey = Buffer.from(options.seal_public_key || SEAL_KEY, 'base64');
    if (this.sealKey.length !== 32) throw Error('relay.seal_public_key must decode to 32 bytes');
    this.session = 'mirasim_' + crypto.randomUUID();
    this.ticket = ''; this.ticketExpires = 0; this.ticketRetry = 0; this.ticketQuiet = 0;
    this.refreshRetry = 0; this.forceRefresh = false; this.ready = false;
    this.epoch = 0;
    this.pendingCredential = null;
  }

  async single(name, fn) {
    if (this[name]) return this[name];
    const promise = Promise.resolve().then(fn);
    this[name] = promise;
    try { return await promise; } finally { if (this[name] === promise) this[name] = null; }
  }

  async ensureAccess() {
    if (this.pendingCredential) this.persistPending();
    const fresh = loadCredential(this.options.setting_json);
    if (fresh.access !== this.credential.access || fresh.refresh !== this.credential.refresh || fresh.device !== this.credential.device) this.adopt(fresh);
    else this.credential = fresh; // also notice corrected expiry and unrelated settings
    const c = this.credential, now = Date.now();
    const needs = this.forceRefresh || (c.expires && now >= c.expires - 15 * 60000);
    if (!needs) return;
    const usable = () => !this.forceRefresh && (!this.credential.expires || Date.now() < this.credential.expires - 30000);
    if (now < this.refreshRetry) { if (!usable()) throw Error('Mirasim token refresh cooling down'); return; }
    try {
      await this.single('refreshFlight', async () => {
        if (!c.refresh) throw Error('Mirasim refresh token missing; sign in again');
        // Cross-process lock: doctor and serve may run at the same time. Re-read
        // after acquiring it, so a rotating refresh token is never used twice.
        const lock = this.options.setting_json + '.refresh-lock';
        let fd;
        for (let i = 0; i < 50; i++) {
          try { fd = fs.openSync(lock, 'wx', 0o600); break; }
          catch (err) {
            if (err.code !== 'EEXIST') throw Error('Cannot lock credential file for refresh');
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        if (fd === undefined) throw Error('Credential refresh locked; another process is refreshing (or remove stale .refresh-lock after stopping all bridge processes)');
        try {
          const disk = loadCredential(this.options.setting_json);
          if (disk.access !== c.access || disk.refresh !== c.refresh || disk.device !== c.device) { this.adopt(disk); return; }
          const data = Buffer.from(JSON.stringify({ refresh_token: c.refresh }));
          const res = await request(new URL(this.options.auth_url.replace(/\/$/, '') + '/auth/refresh'), {
            method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, body: data,
            headersTimeout: 20000, idleTimeout: 20000, totalTimeout: 20000,
          });
          const raw = await readText(res, 1024 * 1024);
          if (res.statusCode !== 200) {
            this.refreshRetry = Date.now() + retryDelay(res.headers['retry-after']);
            throw Error(`Mirasim token refresh HTTP ${res.statusCode}`);
          }
          let tokens; try { tokens = JSON.parse(raw); } catch { throw Error('Invalid token refresh response'); }
          if (!isObject(tokens) || !secret(tokens.access_token) || (tokens.refresh_token && !secret(tokens.refresh_token))) throw Error('Token refresh response missing valid tokens');
          const expires = Number(claims(tokens.access_token).exp) * 1000 || Date.now() + (Number(tokens.expires_in) || 1800) * 1000;
          if (!Number.isFinite(expires) || expires <= Date.now()) throw Error('Invalid refreshed token expiry');
          const saved = disk.raw;
          if (disk.cpa) Object.assign(saved, { access_token: tokens.access_token, refresh_token: tokens.refresh_token || disk.refresh,
            expired: new Date(expires).toISOString(), last_refresh: new Date().toISOString() });
          else Object.assign(saved.auth, { token: tokens.access_token, refreshToken: tokens.refresh_token || disk.refresh, exp: Math.floor(expires / 1000) });
          // Retain rotated secrets in memory BEFORE attempting disk writes. A
          // transient EACCES/ENOSPC must never cause reuse of the old refresh token.
          this.pendingCredential = { raw: saved, previousAccess: disk.access, previousRefresh: disk.refresh, previousDevice: disk.device };
          this.adopt(parseCredential(saved));
          this.persistPending();
        } finally {
          // Keep the cross-process lock while rotated credentials are waiting to
          // be persisted, so another process cannot reuse the spent refresh token.
          if (this.pendingCredential) this.pendingLock = { fd, file: lock };
          else { fs.closeSync(fd); fs.unlinkSync(lock); }
        }
      });
    } catch (err) {
      this.refreshRetry = Math.max(this.refreshRetry, Date.now() + 30000);
      if (this.pendingCredential) throw err;
      if (!usable()) throw err;
    }
  }

  async profile({ signal } = {}) {
    await waitForShared(this.ensureAccess(), signal);
    const access = this.credential.access;
    const res = await request(new URL(this.options.auth_url.replace(/\/$/, '') + '/auth/me'), {
      headers: { authorization: 'Bearer ' + access }, signal, totalTimeout: 15000 });
    const raw = await readText(res, 128 * 1024);
    if (res.statusCode === 401 && this.credential.access === access) this.forceRefresh = true;
    if (res.statusCode !== 200) throw Error('Mirasim membership query failed');
    return JSON.parse(raw);
  }

  adopt(credential) {
    this.credential = credential; this.epoch++;
    this.ticket = ''; this.ticketExpires = 0; this.ticketRetry = 0;
    this.forceRefresh = false; this.refreshRetry = 0; this.ready = false;
  }

  persistPending() {
    const pending = this.pendingCredential;
    if (!pending) return;
    let current;
    try { current = loadCredential(this.options.setting_json); }
    catch { throw Error('Cannot persist refreshed credential; repair credential file access before restarting'); }
    if (current.access !== pending.previousAccess || current.refresh !== pending.previousRefresh || current.device !== pending.previousDevice) {
      // An administrator/other process replaced the identity while refreshing.
      this.pendingCredential = null; this.adopt(current); this.releasePendingLock(); return;
    }
    const temp = this.options.setting_json + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(pending.raw, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.options.setting_json);
      this.pendingCredential = null;
      this.releasePendingLock();
    } catch {
      throw Error('Cannot persist refreshed credential; fix disk space/permissions before restarting (new token retained in memory)');
    } finally { try { fs.unlinkSync(temp); } catch { /* no temp file */ } }
  }

  releasePendingLock() {
    if (!this.pendingLock) return;
    const lock = this.pendingLock;
    this.pendingLock = null;
    fs.closeSync(lock.fd);
    fs.unlinkSync(lock.file);
  }

  signed(method, route, credential, body, metadata = {}) {
    const c = this.credential;
    const input = { method, path: route, timestamp: String(Date.now()), nonce: crypto.randomBytes(12).toString('base64url'),
      device: c.device, version: this.options.client_version, credential, body, metadata };
    return { ...metadata, 'x-mirasim-device': c.device, 'x-mirasim-ts': input.timestamp,
      'x-mirasim-nonce': input.nonce, 'x-mirasim-sig': crypto.sign(null, canonical(input), c.key).toString('base64url'),
      'x-mirasim-client': input.version, authorization: 'Bearer ' + credential };
  }

  async getTicket() {
    await this.ensureAccess();
    const now = Date.now();
    if (this.ticket && now < this.ticketExpires - 120000) return this.ticket;
    if (now < this.ticketQuiet) return this.credential.access;
    if (now < this.ticketRetry) {
      if (this.ticket && now < this.ticketExpires) return this.ticket;
      throw Error('Mirasim device ticket cooling down');
    }
    return this.single('ticketFlight', async () => {
      const epoch = this.epoch;
      const route = '/v1/device/session';
      const body = Buffer.from(JSON.stringify({ publicKey: this.credential.publicKey, deviceId: this.credential.device }));
      const headers = this.signed('POST', route, this.credential.access, body);
      headers['content-type'] = 'application/json'; headers['content-length'] = body.length;
      try {
        const res = await request(new URL(this.options.url.replace(/\/$/, '') + route), {
          method: 'POST', headers, body, headersTimeout: 20000, idleTimeout: 20000, totalTimeout: 20000,
        });
        const raw = await readText(res, 1024 * 1024);
        if (epoch !== this.epoch) throw Error('Credentials changed while minting ticket; retry with current credentials');
        if ([404, 501].includes(res.statusCode)) {
          this.ticketQuiet = Date.now() + (res.statusCode === 404 ? 60000 : 900000);
          return this.credential.access;
        }
        if (res.statusCode !== 200) {
          if (res.statusCode === 401) this.forceRefresh = true;
          this.ticketRetry = Date.now() + retryDelay(res.headers['retry-after']);
          const err = Error(`Mirasim device ticket HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          throw err;
        }
        let data; try { data = JSON.parse(raw); } catch { throw Error('Invalid device ticket response'); }
        if (!isObject(data) || !secret(data.ticket)) throw Error('Mirasim device ticket missing');
        const at = Number(data.expiresAt);
        const expiry = at > 0 ? (at < 1e12 ? at * 1000 : at) : Date.now() + (Number(data.expiresIn) || 600) * 1000;
        if (!Number.isFinite(expiry) || expiry <= Date.now()) throw Error('Invalid device ticket expiry');
        this.ticket = data.ticket; this.ticketExpires = expiry; this.epoch++;
        this.ticketRetry = 0;
        return this.ticket;
      } catch (err) {
        if (epoch !== this.epoch) throw err;
        this.ticketRetry = Math.max(this.ticketRetry, Date.now() + 30000);
        if (err.status === 401 || err.status === 403) { this.ticket = ''; this.ready = false; }
        if ((!err.status || err.status === 429 || err.status >= 500) && this.ticket && Date.now() < this.ticketExpires) return this.ticket;
        throw err;
      }
    });
  }

  async request({ path: requestPath, method = 'GET', headers = {}, body = Buffer.alloc(0), signal, ...timeouts }) {
    signal?.throwIfAborted();
    const route = requestPath.split('?')[0];
    const control = ['/v1/models', '/v1/limits', '/v1/model-roster'].includes(route);
    const allowed = control ? method === 'GET' : method === 'POST' && ['/v1/messages', '/v1/messages/count_tokens', '/v1/responses', '/v1/responses/compact'].includes(route);
    if (!allowed) throw Error('Unsupported direct relay route');
    const credential = await waitForShared(this.getTicket(), signal);
    signal?.throwIfAborted();
    const epoch = this.epoch;
    const metadata = {};
    if (!control) {
      Object.assign(metadata, { 'x-mirasim-session': this.session, 'x-mirasim-agent': relayAgent(route, body), 'x-mirasim-call': crypto.randomUUID() });
      const decoded = claims(this.credential.access);
      const account = decoded.account_id || decoded.accountId;
      if (typeof account === 'string' && account.length < 512 && !/[\r\n\0]/.test(account)) metadata['x-mirasim-account'] = account;
      if (this.options.collect === false) metadata['x-mirasim-collect'] = 'off';
      if (this.options.locale) metadata['x-mirasim-locale'] = this.options.locale;
    }
    const auth = this.signed(method, route, credential, body, metadata);
    if (!control) {
      const privateHeaders = Object.fromEntries(Object.entries(auth).filter(([k]) => k.startsWith('x-mirasim-') && k !== 'x-mirasim-client').sort(([a], [b]) => a.localeCompare(b)));
      const encrypted = seal(this.sealKey, crypto.randomBytes(32), crypto.randomBytes(12),
        Buffer.from(JSON.stringify(privateHeaders)), Buffer.from(`mrs-seal-v1\n${method}\n${route}`));
      for (const k of Object.keys(privateHeaders)) delete auth[k];
      auth['x-mirasim-enc'] = encrypted.toString('base64url');
    }
    const h = {};
    for (const [key, val] of Object.entries(headers)) {
      const k = key.toLowerCase();
      if (!k.startsWith('x-mirasim-') && !['host', 'authorization', 'x-api-key', 'proxy-authorization', 'content-length', 'connection', 'transfer-encoding'].includes(k)) h[k] = val;
    }
    if (h['anthropic-beta']) {
      h['anthropic-beta'] = String(h['anthropic-beta']).split(',').map((s) => s.trim()).filter((s) => s && s !== 'oauth-2025-04-20').join(',');
      if (!h['anthropic-beta']) delete h['anthropic-beta'];
    }
    Object.assign(h, auth, { 'accept-encoding': 'identity' });
    if (method === 'POST') Object.assign(h, { 'content-type': 'application/json', 'content-length': body.length });
    if (!h['anthropic-version'] && route.startsWith('/v1/messages')) h['anthropic-version'] = '2023-06-01';
    const res = await request(new URL(this.options.url.replace(/\/$/, '') + requestPath), { method, headers: h, body, signal, ...timeouts });
    if ([401, 403].includes(res.statusCode) && epoch === this.epoch) {
      this.ticket = ''; this.ticketQuiet = 0; this.ticketRetry = Date.now() + 30000;
      this.forceRefresh ||= res.statusCode === 401; this.ready = false; this.epoch++;
    }
    return res;
  }
}

module.exports = { RelayClient, canonical, seal, relayAgent, loadCredential, parseCredential, validateEndpoint, readText, request, waitForShared };
