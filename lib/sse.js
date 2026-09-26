'use strict';
const { StringDecoder } = require('node:string_decoder');

const streamError = (code) => Object.assign(Error(code), { code });
class TerminalEvents {
  constructor(kind, onEvent = () => {}) { this.kind = kind; this.onEvent = onEvent; this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.done = false; this.failed = false; this.recognized = false; this.served = null; }
  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter((s) => s.startsWith('data:')).map((s) => s.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { if (!this.done) throw streamError('upstream_stream_protocol_mismatch'); continue; }
      let e; try { e = JSON.parse(data); } catch { throw streamError('upstream_stream_invalid_json'); }
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw streamError('upstream_stream_invalid_event');
      const eventName = frame.split(/\r?\n/).find((s) => s.startsWith('event:'))?.slice(6).trim();
      const type = e.type || eventName;
      this.onEvent(e, type);
      if (type === 'error' || type === 'response.failed' || e.error || e.response?.error || e.response?.status === 'failed') { this.done = true; this.failed = true; return true; }
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
      if (!this.served && typeof served === 'string' && served.trim()) this.served = served.trim().slice(0, 160);
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
  const events = new TerminalEvents(kind, onEvent);
  let pending = [], bytes = 0, started = false, servedSeen = false;
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
    if (events.served && !servedSeen) {
      servedSeen = true;
      // onServed returns true to refuse a substituted model before any byte reaches the client.
      if (onServed(events.served) && !started) throw streamError('upstream_stream_model_fallback');
    }
    if (!started) {
      if (events.failed) throw streamError('upstream_stream_error');
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

function endWithStreamError(res, kind, code) {
  // Never manufacture finish_reason, message_stop or response.completed on failure.
  const event = kind === 'messages'
    ? { type: 'error', error: { type: 'api_error', code, message: `mirasim-bridge: ${code}` } }
    : { type: 'error', code, message: `mirasim-bridge: ${code}`, param: null };
  if (!res.destroyed && !res.writableEnded) res.end('\n\nevent: error\ndata: ' + JSON.stringify(event) + '\n\n');
}
module.exports = { TerminalEvents, pipeEvents, endWithStreamError };
