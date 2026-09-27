'use strict';
// Responses SSE aggregation adapted from cpa-plugin-mirasim, MIT.

function normalizeResponses(body, { compact = false, allowed = () => true, defaultEffort = '' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('请求体必须是 JSON 对象');
  body = structuredClone(body);
  if (typeof body.model !== 'string' || !body.model.startsWith('gpt-')) throw Error('Responses / compact 需要 GPT 模型；其他系列使用 /v1/messages');
  if (!allowed(body.model)) throw Error('模型不在允许范围内');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw Error('stream 必须是布尔值');
  if (compact && body.stream) throw Error('/v1/responses/compact 不支持 stream:true');
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) throw Error('input 必须是字符串或数组');
  if (body.reasoning != null && (typeof body.reasoning !== 'object' || Array.isArray(body.reasoning))) throw Error('reasoning 必须是对象');
  if (body.instructions != null && typeof body.instructions !== 'string') throw Error('instructions 必须是字符串');
  if (body.include != null && (!Array.isArray(body.include) || body.include.some((v) => typeof v !== 'string'))) throw Error('include 必须是字符串数组');
  if (body.reasoning?.effort === 'ultra') body.reasoning.effort = 'max';
  if (body.reasoning?.effort != null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning.effort)) throw Error('reasoning.effort 只支持 none/minimal/low/medium/high/xhigh/max/ultra，具体可用档位由上游模型决定');
  if (body.store !== undefined && typeof body.store !== 'boolean') throw Error('store 必须是布尔值');
  if (body.truncation != null && body.truncation !== 'disabled') throw Error('Mirasim 暂不支持 truncation:auto；请使用 context_management 压缩或由客户端保留完整历史');
  for (const key of ['max_output_tokens', 'max_completion_tokens']) {
    if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1)) throw Error(key + ' 必须是正整数');
  }
  if (body.max_completion_tokens !== undefined) {
    if (body.max_output_tokens !== undefined && body.max_output_tokens !== body.max_completion_tokens) throw Error('max_output_tokens 与 max_completion_tokens 冲突');
    body.max_output_tokens = body.max_completion_tokens; delete body.max_completion_tokens;
  }
  const downstreamStream = body.stream === true;
  if (compact) delete body.stream;
  else {
    body.stream = true; // relay emits SSE even for a downstream JSON response
    // Codex Responses wire constraints, also used by CPA's Responses translator.
    if (body.store === undefined) body.store = false;
    // Keep explicit per-turn effort and all opaque history untouched.
    const historyEffort = Array.isArray(body.input) && body.input.some(item => item?.type === 'configuration_update' && item.reasoning?.effort != null);
    if (body.reasoning?.effort == null && !historyEffort && defaultEffort) body.reasoning = { ...body.reasoning, effort: defaultEffort };
    if (body.parallel_tool_calls === undefined) body.parallel_tool_calls = true;
    if (body.instructions === undefined) body.instructions = '';
    body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), 'reasoning.encrypted_content'])];
    if (typeof body.input === 'string') body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }];
    // Output budgets and context_management are accepted by the real relay.
    // truncation:disabled is equivalent to omission and is rejected upstream.
    for (const k of ['temperature', 'top_p', 'truncation', 'prompt_cache_options', 'prompt_cache_retention', 'user']) delete body[k];
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (!item || typeof item !== 'object') continue;
      if (item.type && item.type !== 'message') continue;
      if (item.role === 'system') item.role = 'developer';
      delete item.prompt_cache_breakpoint;
      for (const field of ['content']) {
        for (const part of Array.isArray(item[field]) ? item[field] : []) {
          if (part && typeof part === 'object') delete part.prompt_cache_breakpoint;
        }
      }
    }
  }
  return { body, downstreamStream };
}

function aggregateResponses(raw) {
  const indexed = new Map(), fallback = [];
  let response, error;
  const accept = (e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw Error('Invalid Responses event');
    if (e.type === 'error' || e.type === 'response.failed' || e.error || e.status === 'failed') {
      error = 'Mirasim Responses stream failed'; return;
    }
    if (e.object === 'response') response = e;
    if (['response.completed', 'response.incomplete'].includes(e.type)) response = e.response;
    if (e.type === 'response.output_item.done' && e.item) {
      if (Number.isInteger(e.output_index)) indexed.set(e.output_index, e.item);
      else fallback.push(e.item);
    }
  };
  if (raw.trimStart().startsWith('{')) accept(JSON.parse(raw));
  else {
    for (const frame of raw.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      const e = JSON.parse(data);
      if (e && !e.type) e.type = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
      accept(e);
    }
  }
  if (error) throw Error(error);
  if (!response || typeof response !== 'object') throw Error('Responses stream has no terminal response');
  if (response.status === 'failed' || response.error) throw Error('Mirasim Responses failed');
  if (!['completed', 'incomplete'].includes(response.status)) throw Error('Responses response is not terminal');
  if (response.output !== undefined && !Array.isArray(response.output)) throw Error('Invalid Responses output');
  // A partial terminal snapshot must not discard earlier completed reasoning,
  // tool or compaction items needed by the next turn.
  if (indexed.size || fallback.length) {
    const terminal = response.output || [], consumed = new Set();
    const completed = [...[...indexed].sort(([a], [b]) => a - b).map(([, value]) => value), ...fallback];
    response.output = completed.map(item => {
      const index = terminal.findIndex((value, i) => !consumed.has(i) && (item.id && item.id === value.id || JSON.stringify(item) === JSON.stringify(value)));
      if (index < 0) return item;
      consumed.add(index); return { ...item, ...terminal[index] };
    });
    response.output.push(...terminal.filter((_, index) => !consumed.has(index)));
  }
  return response;
}

module.exports = { normalizeResponses, aggregateResponses };
