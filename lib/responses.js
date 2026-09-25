'use strict';
// Responses SSE aggregation adapted from cpa-plugin-mirasim, MIT.

function normalizeResponses(body, { compact = false, allowed = () => true } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('请求体必须是 JSON 对象');
  if (typeof body.model !== 'string' || !body.model.startsWith('gpt-')) throw Error('Responses / compact 需要 GPT 模型；其他系列使用 /v1/messages');
  if (!allowed(body.model)) throw Error('模型不在允许范围内');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw Error('stream 必须是布尔值');
  if (compact && body.stream) throw Error('/v1/responses/compact 不支持 stream:true');
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) throw Error('input 必须是字符串或数组');
  if (body.reasoning != null && (typeof body.reasoning !== 'object' || Array.isArray(body.reasoning))) throw Error('reasoning 必须是对象');
  if (body.instructions != null && typeof body.instructions !== 'string') throw Error('instructions 必须是字符串');
  if (body.include != null && (!Array.isArray(body.include) || body.include.some((v) => typeof v !== 'string'))) throw Error('include 必须是字符串数组');
  if (body.reasoning?.effort === 'ultra') body.reasoning.effort = 'max';
  if (body.reasoning?.effort != null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning.effort)) throw Error('reasoning.effort 只支持 low/medium/high/xhigh/max/ultra');
  const downstreamStream = body.stream === true;
  if (compact) delete body.stream;
  else {
    body.stream = true; // relay emits SSE even for a downstream JSON response
    // Codex Responses wire constraints, also used by CPA's Responses translator.
    body.store = false;
    if (body.parallel_tool_calls === undefined) body.parallel_tool_calls = true;
    if (body.instructions === undefined) body.instructions = '';
    body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), 'reasoning.encrypted_content'])];
    if (typeof body.input === 'string') body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }];
    for (const k of ['max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'truncation', 'context_management', 'prompt_cache_options', 'prompt_cache_retention', 'user']) delete body[k];
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (!item || typeof item !== 'object') continue;
      if (item.role === 'system') item.role = 'developer';
      delete item.prompt_cache_breakpoint;
      for (const field of ['content', 'output']) {
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
      accept(JSON.parse(data));
    }
  }
  if (error) throw Error(error);
  if (!response || typeof response !== 'object') throw Error('Responses stream has no terminal response');
  if (response.status === 'failed' || response.error) throw Error('Mirasim Responses failed');
  if (!['completed', 'incomplete'].includes(response.status)) throw Error('Responses response is not terminal');
  if (response.output !== undefined && !Array.isArray(response.output)) throw Error('Invalid Responses output');
  if (!response.output?.length && (indexed.size || fallback.length)) response.output = [...[...indexed].sort(([a], [b]) => a - b).map(([, value]) => value), ...fallback];
  return response;
}

module.exports = { normalizeResponses, aggregateResponses };
