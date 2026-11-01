'use strict';
// Space inference over the Mirasim cloud gateway.
//
// Mirasim keeps two credit ledgers (see lib/space-credit.js). /v1/limits describes
// the personal one; a managed space (`space-316be`) has its own pool that the relay
// charges only when the turn runs INSIDE that space. There is exactly one channel
// that does that from outside, and it is not an HTTP route:
//
//   1. POST /v2/gateway/session  {nodeId, idleSleep:1}   -> a short-lived gateway JWT
//   2. wss://relay.mirasim.ai/v2/gateway/ws
//        first frame: {type:'gatewayAuth', token, nodeId, wake:1, idleSleep:1}
//   3. {type:'prompt', clientRef, agent, model, prompt, workdir, route:'cloud'}
//        -> {type:'accepted', clientRef, sessionKey}
//        -> {type:'session', sessionKey, patch:{set:{phase:'streaming'}}}
//        -> {type:'session', sessionKey, patch:{appendText:'…'}}      (repeated)
//        -> {type:'session', sessionKey, patch:{set:{phase:'done', usage:{…}}}}
//
// Measured 2026-11-01 against space-316be: one haiku turn moved
// /v2/machines/space-316be/credit from {balance:1122, used:128} to
// {balance:1121, used:129} while /v1/limits (personal) did not move at all.
//
// Things that are NOT available on this channel, all probed:
//   - POST /v2/machines/<node>/credit/keys -> 403 {"error":"trial_space"} (trial
//     spaces may not mint API keys, so the 4963 local gateway has no default key)
//   - /v2/gateway/model/v1/messages -> 401 turn capability missing
//   - spaceCreditOnly:true on a gateway prompt -> refused; only a program running
//     on the machine itself may ask for a space-only turn
//   - gatewayModelRoster is gateway->host only; sending it closes the socket (1008)
//
// The turn is an AGENT turn (Claude Code running in the space), not a raw model
// completion: the prompt is what a person would type, and the answer is the
// agent's final text. Tool use is the agent's own business and is not surfaced as
// Anthropic tool_use blocks. That is a real semantic difference from `backend:
// relay`, and it is the price of the space pool paying for it.

const crypto = require('node:crypto');

const DEFAULT_WORKDIR = '/data/ws';
const SESSION_MARGIN_MS = 60 * 1000;      // remint this long before the JWT expires
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CONNECT_TIMEOUT_MS = 20 * 1000;

const rid = () => crypto.randomBytes(8).toString('hex').slice(0, 12);

/** Patch fields we understand. Unknown ones are ignored, never invented. */
function emptyTurn() {
  return { text: '', reasoning: '', phase: null, usage: null, error: null, model: null, effort: null, toolCalls: 0 };
}

class SpaceGateway {
  /**
   * @param {object} options
   * @param {(path: string, init?: object) => Promise<{status: number, json: any}>} options.mint
   *        performs the authenticated POST to /v2/gateway/session. Supplied by the
   *        caller so this module never needs to know how the relay authenticates.
   * @param {string} options.nodeId  the managed space (`space-…`)
   * @param {string} options.gatewayUrl  wss://relay.mirasim.ai/v2/gateway/ws
   */
  constructor({ mint, nodeId, gatewayUrl, workdir = DEFAULT_WORKDIR, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS }) {
    this.mint = mint;
    this.nodeId = nodeId;
    this.gatewayUrl = gatewayUrl;
    this.workdir = workdir;
    this.turnTimeoutMs = turnTimeoutMs;
    this.socket = null;
    this.session = null;
    this.sessionExpires = 0;
    this.caps = null;
    this.connecting = null;
    this.turns = new Map();        // clientRef -> {turn, resolve, reject, timer, onDelta}
    this.bySessionKey = new Map(); // sessionKey -> clientRef of the turn that is still open
    this.closedWith = '';
    this.catalog = null;
  }

  get connected() { return Boolean(this.socket && this.socket.readyState === 1); }

  /** Mint a gateway JWT. Kept separate so the bridge can pre-warm it. */
  async mintSession() {
    const res = await this.mint(`/v2/gateway/session`, { nodeId: this.nodeId, idleSleep: 1 });
    if (res.status !== 200) {
      const detail = typeof res.json?.error === 'string' ? res.json.error : `HTTP ${res.status}`;
      throw Object.assign(Error(`网关会话获取失败（${detail}）`), { status: res.status, space: true });
    }
    const body = res.json;
    if (typeof body?.session !== 'string' || !body.session) throw Error('网关会话响应缺少 session');
    const claims = decodeClaims(body.session);
    const exp = Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : Date.now() + 10 * 60 * 1000;
    this.session = body.session;
    this.sessionExpires = exp;
    this.gatewayUrl = typeof body.gatewayUrl === 'string' && body.gatewayUrl ? body.gatewayUrl : this.gatewayUrl;
    return body;
  }

  async ensureSession() {
    if (this.session && Date.now() < this.sessionExpires - SESSION_MARGIN_MS) return this.session;
    if (!this.mintFlight) this.mintFlight = this.mintSession().finally(() => { this.mintFlight = null; });
    await this.mintFlight;
    return this.session;
  }

  /** Open (or reuse) the socket. Concurrent callers share one connect attempt. */
  async connect() {
    if (this.connected) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connect() {
    await this.ensureSession();
    const ws = new WebSocket(this.gatewayUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close(); } catch { /* already gone */ } reject(Error('网关连接超时')); }, DEFAULT_CONNECT_TIMEOUT_MS);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('网关连接失败')); }, { once: true });
    });
    this.socket = ws;
    ws.addEventListener('message', (event) => this.#onFrame(event));
    ws.addEventListener('close', (event) => this.#onClose(event));
    ws.send(JSON.stringify({ type: 'gatewayAuth', token: this.session, nodeId: this.nodeId, wake: 1, idleSleep: 1 }));
    // The host answers gatewayHostCaps once the auth frame lands; waiting for it is
    // the difference between "socket open" and "the space is actually listening".
    await this.#waitFor(() => this.caps !== null, DEFAULT_CONNECT_TIMEOUT_MS, '网关未返回 gatewayHostCaps');
    return this;
  }

  #waitFor(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (predicate()) { clearInterval(timer); resolve(); return; }
        if (Date.now() >= deadline) { clearInterval(timer); reject(Error(message)); }
      };
      const timer = setInterval(tick, 50);
      tick();
    });
  }

  #onFrame(event) {
    let frame;
    try { frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    switch (frame.type) {
      case 'gatewayHostCaps':
        this.caps = Array.isArray(frame.caps) ? frame.caps : [];
        return;
      case 'catalog':
        // The host's catalog answer does not reliably echo reqId, so any catalog
        // frame while a caller is waiting is that caller's answer.
        if (this.catalogWaiter) {
          this.catalogWaiter.resolve(Array.isArray(frame.models) ? frame.models : []);
        }
        return;
      case 'accepted': {
        const pending = this.turns.get(frame.clientRef);
        if (!pending) return;
        pending.sessionKey = typeof frame.sessionKey === 'string' ? frame.sessionKey : null;
        pending.turn.sessionKey = pending.sessionKey;
        if (pending.sessionKey) this.bySessionKey.set(pending.sessionKey, frame.clientRef);
        if (frame.queued) pending.turn.queued = true;
        return;
      }
      case 'error': {
        // Two shapes: a refusal for our prompt (clientRef present) and a protocol
        // error with no clientRef at all. Only the first belongs to an HTTP caller.
        const pending = frame.clientRef ? this.turns.get(frame.clientRef) : null;
        if (pending) {
          this.#settle(frame.clientRef, {
            error: spaceError(typeof frame.message === 'string' ? frame.message : '网关拒绝了这次请求'),
            code: typeof frame.code === 'string' ? frame.code : null,
          });
        } else if (!frame.clientRef) {
          this.lastProtocolError = typeof frame.message === 'string' ? frame.message : 'gateway error';
        }
        return;
      }
      case 'session': {
        const ref = this.bySessionKey.get(frame.sessionKey);
        const pending = ref ? this.turns.get(ref) : null;
        if (!pending) return;
        const patch = frame.patch || {};
        const turn = pending.turn;
        if (typeof patch.appendText === 'string' && patch.appendText) {
          turn.text += patch.appendText;
          pending.onDelta?.(patch.appendText, 'text');
        }
        if (typeof patch.appendReasoning === 'string' && patch.appendReasoning) {
          turn.reasoning += patch.appendReasoning;
          pending.onDelta?.(patch.appendReasoning, 'reasoning');
        }
        const set = patch.set || {};
        if (typeof set.model === 'string') { turn.model = set.model; pending.onUpdate?.('model', set.model); }
        if (typeof set.effort === 'string') turn.effort = set.effort;
        if (set.usage && typeof set.usage === 'object') turn.usage = set.usage;
        if (Array.isArray(set.toolCalls)) turn.toolCalls = set.toolCalls.length;
        if (typeof set.phase === 'string') {
          turn.phase = set.phase;
          // The HTTP layer opens its SSE stream on this transition rather than on the
          // first appendText: a model that thinks for 30s before its first token would
          // otherwise leave the client with zero bytes on the wire, which many clients
          // treat as a stalled request.
          pending.onUpdate?.('phase', set.phase);
          // The HTTP layer opens its SSE stream on this transition rather than on the
          // first appendText: a model that thinks for 30s before its first token would
          // otherwise leave the client with zero bytes on the wire, which many clients
          // treat as a stalled request.
          pending.onUpdate?.('phase', set.phase);
          if (set.error) {
            // Same wrapper as the error frame: the agent CLI's own text arrives here
            // when the turn failed after it started, so it needs the same reading.
            const text = typeof set.error === 'string' ? set.error : (set.error?.message || '回合失败');
            this.#settle(ref, { error: spaceError(text) });
            return;
          }
          if (set.phase === 'done' || set.phase === 'stopped' || set.phase === 'failed') this.#settle(ref, { done: true });
        }
        return;
      }
      default:
        return;   // snapshot/outbox/turnImages/usage/accounts/relay/... are host chatter
    }
  }

  #onClose(event) {
    this.closedWith = `${event?.code ?? ''} ${event?.reason ?? ''}`.trim();
    this.socket = null;
    this.session = null;
    this.caps = null;
    for (const ref of [...this.turns.keys()]) {
      this.#settle(ref, { error: Error(`网关连接中断（${this.closedWith || 'closed'}）`) });
    }
  }

  #settle(ref, outcome) {
    const pending = this.turns.get(ref);
    if (!pending) return;
    this.turns.delete(ref);
    clearTimeout(pending.timer);
    if (pending.sessionKey) this.bySessionKey.delete(pending.sessionKey);
    if (outcome.error) {
      outcome.error.space = true;
      if (outcome.code) outcome.error.code = outcome.code;
      pending.reject(outcome.error);
    } else pending.resolve(pending.turn);
  }

  /** The space's real model menu, as Claude/Codex/Kimi see it. */
  async getCatalog({ timeoutMs = 15000 } = {}) {
    await this.connect();
    this.catalog = await this.#requestCatalog(timeoutMs);
    return this.catalog;
  }

  #requestCatalog(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.catalogWaiter = null; reject(Error('模型目录请求超时')); }, timeoutMs);
      this.catalogWaiter = { resolve: (m) => { clearTimeout(timer); this.catalogWaiter = null; resolve(m); } };
      this.socket.send(JSON.stringify({ type: 'getCatalog', agent: 'claude', reqId: rid() }));
    });
  }

  /**
   * Run one agent turn in the space.
   *
   * @returns {Promise<{text, reasoning, usage, model, effort, sessionKey, queued}>}
   */
  async runTurn({ prompt, model = null, agent = 'claude', sessionKey = null, workdir = null, effort = null, onDelta = null, onUpdate = null, signal = null, timeoutMs = null }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw Object.assign(Error('prompt 不能为空'), { space: true, status: 400 });
    signal?.throwIfAborted();
    await this.connect();

    const clientRef = rid();
    const turn = emptyTurn();
    const limit = timeoutMs || this.turnTimeoutMs;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#settle(clientRef, { error: Error(`回合超时（${Math.round(limit / 1000)}s）`) }), limit);
      this.turns.set(clientRef, { turn, resolve, reject, timer, onDelta, onUpdate, sessionKey: null });
    });
    const frame = { type: 'prompt', clientRef, agent, prompt, workdir: workdir || this.workdir, route: 'cloud' };
    if (model) frame.model = model;
    if (sessionKey) frame.sessionKey = sessionKey;
    if (effort) frame.effort = effort;
    const abort = () => this.#settle(clientRef, { error: Object.assign(Error('请求已取消'), { aborted: true }) });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.socket.send(JSON.stringify(frame));
      return await result;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  close() {
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
  }
}

function decodeClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8')) || {}; }
  catch { return {}; }
}

/**
 * A refusal from the host, carrying the upstream status when the text names one.
 *
 * The host wraps the agent CLI's own error text. `API Error: 422 model "x" is not
 * supported` is the relay refusing a *model*, i.e. the caller's mistake; anything
 * else is a gateway failure. Deciding that here keeps the HTTP layer from guessing.
 */
function spaceError(message) {
  const error = Object.assign(Error(message), { space: true });
  const status = Number((/(?:^|\b)(?:API )?Error:\s*(\d{3})\b/.exec(message) || [])[1]);
  if (Number.isInteger(status) && status >= 400 && status < 500) error.status = status;
  return error;
}

/**
 * A refusal from the host, carrying the upstream status when the text names one.
 *
 * The host wraps the agent CLI's own error text. `API Error: 422 model "x" is not
 * supported` is the relay refusing a *model*, i.e. the caller's mistake; anything
 * else is a gateway failure. Deciding that here keeps the HTTP layer from guessing.
 */
function spaceError(message) {
  const error = Object.assign(Error(message), { space: true });
  const status = Number((/(?:^|\b)(?:API )?Error:\s*(\d{3})\b/.exec(message) || [])[1]);
  if (Number.isInteger(status) && status >= 400 && status < 500) error.status = status;
  return error;
}

module.exports = { SpaceGateway, DEFAULT_WORKDIR, decodeClaims, spaceError };
