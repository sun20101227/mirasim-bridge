'use strict';
// Anthropic Messages  <->  a space agent turn.
//
// `backend: "space"` runs the request inside a managed Mirasim space, so the space
// pool pays for it (lib/space-gateway.js proves that channel). The space speaks
// *agent turns*, not raw model completions, so this file is the honest translation:
//
//   request  : system + messages (+ tools note)  ->  one prompt string
//   response : appendText deltas                 ->  message_start/content_block_*/
//                                                   message_delta/message_stop
//
// What does NOT survive the translation, deliberately and visibly:
//   - tool_use / tool_result blocks. The space agent has its own tools and its own
//     loop; a caller's `tools` array cannot be handed to it. Requests that carry
//     tools still run, the text comes back, but the caller must not expect
//     stop_reason "tool_use". We return "end_turn" and note it in `space.notes`.
//   - `temperature`, `top_p`, `top_k`, `stop_sequences`, `thinking` budgets: the
//     agent has its own sampling policy. They are dropped, not silently honoured.
//   - prompt caching. Every turn carries the agent's own ~19k-token system prompt.
//
// Model ids are passed through untouched: the space accepts both `claude-opus-5-5`
// and `claude-opus-5-5[1m]` and answers with the canonical `[1m]` form (probed
// 2026-11-01). An unsupported id comes back as the space's own 422 text.

const crypto = require('node:crypto');

const MESSAGES_KEYS_DROPPED = ['temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata', 'service_tier'];

/** Anthropic content (string | blocks[]) -> plain text. Non-text blocks are noted, not faked. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[图片已省略：空间回合只接收文本]');
    else if (block.type === 'document') parts.push('[文档已省略：空间回合只接收文本]');
    else if (block.type === 'tool_result') {
      const inner = contentText(block.content);
      if (inner) parts.push(`[工具结果]\n${inner}`);
    } else if (block.type === 'tool_use') parts.push(`[工具调用 ${block.name || ''}]`);
  }
  return parts.join('\n');
}

/**
 * Build the single prompt an agent turn takes.
 *
 * The caller's full message list is flattened each time: the bridge sends
 * `sessionKey: null`, so every request starts a clean agent session and there is no
 * cross-request context to leak. Reusing a sessionKey would save the ~19k-token
 * baseline but requires a caller identity we do not have, so it is opt-in per
 * profile (`space.session_reuse`) and never the default.
 */
function toPrompt(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(Error('请求体必须是 JSON 对象'), { status: 400 });
  const blocks = [];
  const system = contentText(body.system);
  if (system.trim()) blocks.push(`<system>\n${system.trim()}\n</system>`);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) throw Object.assign(Error('messages 不能为空'), { status: 400 });
  // A single user message is the common case (and the only one an agent turn models
  // exactly). Longer histories are replayed as a transcript, which is what a person
  // would paste into the space anyway.
  const conversational = messages.filter((m) => m && typeof m === 'object' && typeof m.role === 'string');
  if (conversational.length === 1 && conversational[0].role === 'user') {
    const text = contentText(conversational[0].content);
    if (!text.trim()) throw Object.assign(Error('最后一条 user 消息为空'), { status: 400 });
    blocks.push(text);
  } else {
    const lines = conversational.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${contentText(m.content)}`);
    lines.push('Assistant:');
    blocks.push(lines.join('\n\n'));
  }
  return { prompt: blocks.join('\n\n'), notes: dropNotes(body) };
}

function dropNotes(body) {
  const notes = [];
  if (Number.isFinite(body.max_tokens)) notes.push('max_tokens 由空间回合自行决定，已忽略');
  for (const key of MESSAGES_KEYS_DROPPED) if (body[key] !== undefined) notes.push(`${key} 已忽略（空间回合不接收采样参数）`);
  if (Array.isArray(body.tools) && body.tools.length) notes.push('tools 已忽略（空间 agent 使用自己的工具循环，不会返回 tool_use）');
  if (body.tool_choice !== undefined) notes.push('tool_choice 已忽略');
  if (body.thinking !== undefined) notes.push('thinking 已忽略（空间回合的推理不按调用方预算）');
  return notes;
}

/**
 * Space usage -> Anthropic usage.
 *
 * The space reports three numbers and they are NOT interchangeable:
 *   inputTokens        — the fresh part of this turn's input
 *   cachedInputTokens  — the prompt-cache hits
 *   contextUsedTokens  — the whole context after this turn. Measured 2026-11-01:
 *                        one turn reported inputTokens:2, cachedInputTokens:0,
 *                        contextUsedTokens:18873 — so input+cached does NOT add up
 *                        to the context when the agent's own prompt is not billed as
 *                        input. contextUsedTokens is the only honest total, so it is
 *                        what `input_tokens` carries.
 */
function toUsage(usage) {
  const cached = Number.isFinite(usage?.cachedInputTokens) ? usage.cachedInputTokens : 0;
  const fresh = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0;
  const out = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : 0;
  const context = Number.isFinite(usage?.contextUsedTokens) ? usage.contextUsedTokens : null;
  return {
    input_tokens: context ?? fresh + cached,
    output_tokens: out,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    ...(Number.isFinite(usage?.contextWindowTokens) ? { space_context_window: usage.contextWindowTokens } : {}),
  };
}

function messageId() { return 'msg_' + crypto.randomBytes(12).toString('hex'); }

/** Non-streaming Anthropic response. */
function toMessage(turn, requestedModel) {
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model: turn.model || requestedModel || '',
    content: [{ type: 'text', text: turn.text || '' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: toUsage(turn.usage),
    space: {
      session_key: turn.sessionKey || null,
      agent: 'claude',
      effort: turn.effort || null,
      tool_calls: turn.toolCalls || 0,
      queued: Boolean(turn.queued),
    },
  };
}

/**
 * Turn the space's live deltas into Anthropic SSE.
 *
 * Deltas arrive as they stream, so this is a real stream — not a buffered replay.
 * `emit(chunk)` is supplied by the caller so this module never touches `res`.
 */
class MessagesStream {
  /**
   * @param {string|(() => string)} model  the request's model, or a getter for the
   *        served one. A getter is read at the first delta, by which time the host's
   *        `patch.set.model` has already named the model it actually ran.
   */
  constructor(model, emit) {
    this.id = messageId();
    this.#modelSource = model;
    this.model = typeof model === 'function' ? '' : (model || '');
    this.emit = emit;
    this.started = false;
    this.closed = false;
    this.bytes = 0;
    this.pending = '';
    this.coalesceMs = 50;      // 0 disables coalescing (tests that count frames)
  }

  #modelSource;
  #flushTimer = null;

  #send(event, data) { this.emit(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

  /**
   * Open the stream without waiting for the first token.
   *
   * The host spends time before its first token (queueing, agent warm-up, thinking).
   * Writing message_start at that moment, rather than on the first appendText, means
   * the client sees the response begin immediately instead of an idle socket.
   */
  open() { this.#start(); }

  #start() {
    if (this.started) return;
    this.started = true;
    if (typeof this.#modelSource === 'function') this.model = this.#modelSource() || this.model;
    this.#send('message_start', { type: 'message_start', message: {
      id: this.id, type: 'message', role: 'assistant', model: this.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    } });
    this.#send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  }

  /** Called for each `patch.appendText`. */
  /**
   * Buffer a token and flush on a short timer.
   *
   * The host emits one appendText per model chunk, often 1–3 characters. Writing a
   * full SSE frame (`event:` + `data:` + two newlines) for each of them is pure
   * overhead — framing can exceed the payload. Coalescing for `coalesceMs` keeps
   * the stream visibly incremental (50ms is far below the perception threshold)
   * while cutting frame count by an order of magnitude on long answers.
   *
   * `flush()` and `finish()` drain the buffer, so nothing is ever lost or reordered.
   */
  delta(text) {
    if (!text || this.closed) return;
    this.#start();
    this.bytes += Buffer.byteLength(text);
    this.pending += text;
    if (this.coalesceMs <= 0) { this.flush(); return; }
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => { this.#flushTimer = null; this.flush(); }, this.coalesceMs);
    this.#flushTimer.unref?.();
  }

  /** Emit whatever text is buffered as one delta. Safe to call when empty. */
  flush() {
    if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = null; }
    if (!this.pending || this.closed) return;
    const text = this.pending;
    this.pending = '';
    this.#send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  }

  /** Called once with the finished turn. */
  finish(turn) {
    if (this.closed) return;
    this.flush();               // never lose the tail of the answer
    this.#start();
    this.closed = true;
    this.#send('content_block_stop', { type: 'content_block_stop', index: 0 });
    this.#send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: toUsage(turn?.usage) });
    this.#send('message_stop', { type: 'message_stop' });
  }

  /** Called when the turn fails after the stream opened. */
  fail(message, code) {
    if (this.closed) return;
    if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = null; }
    this.pending = '';
    this.closed = true;
    this.#send('error', { type: 'error', error: { type: code === 'timeout' ? 'timeout_error' : 'api_error', message } });
  }
}

module.exports = { toPrompt, toMessage, MessagesStream, toUsage, contentText, messageId };
