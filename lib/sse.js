'use strict';
const { StringDecoder } = require('node:string_decoder');

const streamError = (code) => Object.assign(Error(code), { code });

function failedEvent(event) {
  return event.type === 'error' || event.type === 'response.failed' || event.error
    || event.response?.error || event.response?.status === 'failed' || event.status === 'failed';
}

// Some relay failures arrive as `data: {\n  "type": "error", ...\n}`:
// only the first JSON line has the SSE prefix. Accept this narrowly for errors;
// a malformed success must never become a successful completion.
function parseEventFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const parts = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
  const data = parts.join('\n');
  if (!data || data === '[DONE]') return data || null;
  const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
  let event;
  try { event = JSON.parse(data); }
  catch {
    if (parts.length !== 1 || data.trim() !== '{') throw streamError('upstream_stream_invalid_json');
    const json = lines.filter(line => !/^(event:|id:|retry:|:)/.test(line))
      .map(line => line.startsWith('data:') ? line.slice(5).trimStart() : line).join('\n');
    try { event = JSON.parse(json); } catch { throw streamError('upstream_stream_invalid_json'); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || !failedEvent({ ...event, type: event.type || type })) {
      throw streamError('upstream_stream_invalid_json');
    }
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw streamError('upstream_stream_invalid_event');
  if (!event.type && type) event.type = type;
  return event;
}

// Return actionable schema diagnostics without echoing upstream messages, which
// can contain user input, opaque turn state or credentials.
function responseFailure(event) {
  const failure = event.error || event.response?.error || event;
  const invalid = failure.type === 'invalid_request_error';
  const error = streamError('upstream_stream_error');
  error.status = invalid ? 400 : 503;
  if (invalid) {
    const message = typeof failure.message === 'string' ? failure.message.slice(0, 4096) : '';
    const known = ['missing_required_parameter', 'unsupported_value', 'invalid_value', 'invalid_type', 'unknown_parameter'];
    const code = known.includes(failure.code) ? failure.code : known.find(value => message.includes('[' + value + ']'));
    const param = failure.param || /(?:parameter|param):\s*'([^']+)'/i.exec(message)?.[1]
      || /^\[(?:Object|Array|String)Param\]\s*\[([^\r\n]+?)\]\s*\[/.exec(message)?.[1];
    const roots = ['model', 'input', 'tools', 'tool_choice', 'reasoning', 'instructions', 'text', 'include', 'stream', 'store',
      'parallel_tool_calls', 'previous_response_id', 'max_output_tokens', 'max_completion_tokens', 'context_management',
      'truncation', 'temperature', 'top_p', 'service_tier', 'metadata', 'messages', 'system', 'max_tokens', 'thinking', 'output_config'];
    const safeParam = typeof param === 'string' && param.length <= 160 && roots.includes(param.split(/[.\[]/, 1)[0])
      && /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*|\[\d+\])*$/i.test(param) ? param : undefined;
    error.upstream = { type: 'invalid_request_error', code: code || 'upstream_invalid_request',
      message: 'Mirasim rejected the request' + (code ? ': ' + code : '') + (safeParam ? ' (' + safeParam + ')' : ''),
      ...(safeParam ? { param: safeParam } : {}) };
  }
  return error;
}

class TerminalEvents {
  constructor(kind, onEvent = () => {}, onServed = () => false) { this.kind = kind; this.onEvent = onEvent; this.onServed = onServed; this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.done = false; this.failed = false; this.recognized = false; this.served = null; }
  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length);
      const e = parseEventFrame(frame);
      if (!e) continue;
      if (e === '[DONE]') { if (!this.done) throw streamError('upstream_stream_protocol_mismatch'); continue; }
      const type = e.type;
      this.onEvent(e, type);
      if (failedEvent(e)) { this.done = true; this.failed = true; this.error = responseFailure(e); return true; }
      const recognized = this.kind === 'messages'
        ? ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(type)
        : typeof type === 'string' && type.startsWith('response.');
      if (type === 'ping') continue;
      if (Array.isArray(e.choices) || (this.kind === 'messages' && typeof type === 'string' && type.startsWith('response.'))
          || (this.kind === 'responses' && typeof type === 'string' && /^(message_|content_block_)/.test(type))) throw streamError('upstream_stream_protocol_mismatch');
      if (!recognized) continue; // Forward compatibility: unknown event names are not fatal.
      this.recognized = true;
      // relay reports the model that actually served this turn; it differs from the request on a quota fallback.
      const served = type === 'message_start' ? e.message?.model : e.response?.model;
      if (typeof served === 'string' && served.trim() && this.served !== served.trim().slice(0, 160)) {
        this.served = served.trim().slice(0, 160);
        if (this.onServed(this.served)) throw streamError('upstream_stream_model_fallback');
      }
      // Preserve raw events, including optional named SSE event fields.
      e.type = type;
      if (this.kind === 'messages' && e.type === 'message_stop') this.done = true;
      if (this.kind === 'responses' && ['response.completed', 'response.incomplete'].includes(e.type)) this.done = true;
      if (this.done) return true;
    }
    if (this.buffer.length > 8 * 1024 * 1024) throw streamError('upstream_stream_event_too_large');
    return this.done;
  }
}

async function pipeEvents(upstream, downstream, kind, { begin = () => {}, firstEventTimeoutMs = 60000, onServed = () => false, onEvent = () => {} } = {}) {
  const events = new TerminalEvents(kind, onEvent, onServed);
  let pending = [], bytes = 0, started = false;
  const timer = setTimeout(() => upstream.destroy(streamError('upstream_stream_first_event_timeout')), firstEventTimeoutMs);
  timer.unref();
  const write = async (chunk) => {
    if (downstream.destroyed) throw streamError('client_disconnected');
    if (!downstream.write(chunk)) await new Promise((resolve, reject) => {
      const clean = () => { downstream.removeListener('drain', drained); downstream.removeListener('close', closed); downstream.removeListener('error', closed); };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(streamError('client_disconnected')); };
      downstream.once('drain', drained); downstream.once('close', closed); downstream.once('error', closed);
      if (downstream.destroyed) closed();
    });
  };
  try {
  for await (const chunk of upstream) {
    const terminal = events.push(chunk);
    if (events.failed) throw events.error;
    if (!started) {
      bytes += chunk.length; pending.push(chunk);
      if (bytes > 8 * 1024 * 1024) throw streamError('upstream_stream_event_too_large');
      if (!events.recognized) continue;
      clearTimeout(timer); begin(); started = true;
      for (const part of pending) await write(part);
      pending = [];
    } else await write(chunk);
    if (terminal) { downstream.end(); upstream.destroy(); return !events.failed; }
  }
  throw streamError(started ? 'upstream_stream_truncated' : 'upstream_stream_empty');
  } finally { clearTimeout(timer); upstream.destroy(); }
}

function endWithStreamError(res, kind, code, details) {
  // Never manufacture finish_reason, message_stop or response.completed on failure.
  const event = kind === 'messages'
    ? { type: 'error', error: details || { type: 'api_error', code, message: `mirasim-bridge: ${code}` } }
    : { type: 'error', code: details?.code || code, message: details?.message || `mirasim-bridge: ${code}`, param: details?.param || null };
  if (!res.destroyed && !res.writableEnded) res.end('\n\nevent: error\ndata: ' + JSON.stringify(event) + '\n\n');
}
module.exports = { TerminalEvents, pipeEvents, endWithStreamError, parseEventFrame, failedEvent, responseFailure };
