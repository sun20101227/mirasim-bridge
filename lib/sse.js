'use strict';
const { StringDecoder } = require('node:string_decoder');

class TerminalEvents {
  constructor(kind) { this.kind = kind; this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.done = false; this.failed = false; }
  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter((s) => s.startsWith('data:')).map((s) => s.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let e; try { e = JSON.parse(data); } catch { continue; }
      if (!e || typeof e !== 'object') continue;
      if (e.type === 'error' || e.type === 'response.failed') { this.done = true; this.failed = true; }
      if (this.kind === 'messages' && e.type === 'message_stop') this.done = true;
      if (this.kind === 'responses' && ['response.completed', 'response.incomplete'].includes(e.type)) this.done = true;
    }
    if (this.buffer.length > 8 * 1024 * 1024) throw Error('SSE event exceeds 8 MB');
    return this.done;
  }
}

async function pipeEvents(upstream, downstream, kind) {
  const events = new TerminalEvents(kind);
  for await (const chunk of upstream) {
    const terminal = events.push(chunk);
    if (!downstream.write(chunk)) await new Promise((resolve, reject) => {
      const clean = () => { downstream.removeListener('drain', drained); downstream.removeListener('close', closed); downstream.removeListener('error', closed); };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(Error('Client disconnected')); };
      downstream.once('drain', drained); downstream.once('close', closed); downstream.once('error', closed);
      if (downstream.destroyed) closed();
    });
    if (terminal) { downstream.end(); upstream.destroy(); return !events.failed; }
  }
  throw Error('Upstream SSE ended without a terminal event');
}
module.exports = { TerminalEvents, pipeEvents };
