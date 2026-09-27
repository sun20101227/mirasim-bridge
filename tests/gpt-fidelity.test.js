'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { normalizeResponses, aggregateResponses } = require('../lib/responses');
const { createCredential } = require('../lib/login');
const b = require('../mirasim-bridge');
const frame = e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => { s.close(r); s.closeAllConnections(); });

test('Responses preserves caller budgets, storage, context, opaque reasoning, tools and instructions without mutation', () => {
  const original = { model: 'gpt-6-astra', stream: false, store: true, previous_response_id: 'resp-old',
    max_output_tokens: 16384, reasoning: { effort: 'xhigh', context: 'all_turns', summary: 'auto' },
    context_management: [{ type: 'compaction', compact_threshold: 150000 }], parallel_tool_calls: false,
    instructions: 'Preserve Unicode: 中文🙂', text: { format: { type: 'json_object' }, verbosity: 'high' },
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { prompt_cache_breakpoint: { type: 'string' } } } }],
    tool_choice: { type: 'function', name: 'lookup' },
    input: [{ type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: [] },
      { type: 'function_call', id: 'fc', call_id: 'call-1', name: 'lookup', arguments: '{"prompt_cache_breakpoint":"keep"}' },
      { type: 'function_call_output', call_id: 'call-1', output: [{ type: 'input_text', text: 'tool result', prompt_cache_breakpoint: 'tool-owned-data' }] },
      { type: 'compaction', encrypted_content: 'compressed-history' }] };
  const before = structuredClone(original), out = normalizeResponses(original, { defaultEffort: 'high' }).body;
  assert.deepEqual(original, before);
  for (const key of Object.keys(original).filter(k => k !== 'stream')) assert.deepEqual(out[key], original[key], key);
  assert.equal(out.stream, true); assert.ok(out.include.includes('reasoning.encrypted_content'));
});
test('GPT default effort only fills an absent effort; history updates and explicit none/low/max win', () => {
  const input = { model: 'gpt-test', input: 'hi' };
  assert.equal(normalizeResponses(input, { defaultEffort: 'high' }).body.reasoning.effort, 'high');
  assert.equal(normalizeResponses(input, { defaultEffort: '' }).body.reasoning, undefined);
  assert.equal(normalizeResponses(input, { compact: true, defaultEffort: 'high' }).body.reasoning, undefined);
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeResponses({ ...input, reasoning: { effort } }, { defaultEffort: 'high' }).body.reasoning.effort, effort);
  }
  const update = { type: 'configuration_update', reasoning: { effort: 'low' } };
  const out = normalizeResponses({ ...input, input: [update, { role: 'user', content: 'hi' }] }, { defaultEffort: 'high' }).body;
  assert.equal(out.reasoning, undefined); assert.deepEqual(out.input[0], update);
  assert.throws(() => normalizeResponses({ ...input, truncation: 'auto' }), /truncation/);
  assert.equal(normalizeResponses({ ...input, max_completion_tokens: 1000 }).body.max_output_tokens, 1000);
  assert.throws(() => normalizeResponses({ ...input, max_completion_tokens: 1000, max_output_tokens: 3 }), /冲突/);
});
test('JSON aggregation retains encrypted reasoning omitted by a partial terminal snapshot and handles named SSE', () => {
  const reasoning = { type: 'reasoning', id: 'rs-1', encrypted_content: 'opaque-next-turn', summary: [] };
  const tool = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'lookup', arguments: '{}' };
  const answer = { type: 'message', id: 'msg-1', content: [{ type: 'output_text', text: 'answer' }] };
  const terminal = { object: 'response', status: 'completed', output: [answer] };
  const raw = frame({ type: 'response.output_item.done', output_index: 1, item: tool })
    + frame({ type: 'response.output_item.done', output_index: 0, item: reasoning })
    + frame({ type: 'response.output_item.done', output_index: 2, item: answer })
    + 'event: response.completed\ndata: ' + JSON.stringify({ response: terminal }) + '\n\n';
  assert.deepEqual(aggregateResponses(raw).output, [reasoning, tool, answer]);
  assert.deepEqual(aggregateResponses(raw.replace(JSON.stringify(terminal), JSON.stringify({ ...terminal, output: [reasoning, tool, answer] }))).output, [reasoning, tool, answer]);
});

test('real bridge routes preserve GPT state and abort late reported model substitution', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-gpt-fidelity-'));
  let mode = 'normal', seen = [], calls = 0;
  const reasoning = { type: 'reasoning', id: 'rs-1', encrypted_content: 'opaque-next-turn', summary: [] };
  const tool = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'lookup', arguments: '{"key":"中文"}' };
  const upstream = http.createServer(async (req,res) => {
    let raw='';for await (const c of req) raw+=c;
    if(req.url==='/v1/device/session')return res.end('{"ticket":"ticket-test","expiresIn":600}');
    calls++;const body=JSON.parse(raw);seen.push(body);
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(frame({type:'response.created',response:{model:body.model,status:'in_progress'}}));
    if(mode==='late')await new Promise(r=>setTimeout(r,25));
    res.write(frame({type:'response.output_item.done',output_index:0,item:reasoning}));
    res.end(frame({type:'response.output_item.done',output_index:1,item:tool})
      +frame({type:'response.completed',response:{object:'response',status:'completed',model:mode==='late'?'gpt-6-luna':body.model,
        reasoning:{effort:body.reasoning?.effort},output:[tool],usage:{input_tokens:50,output_tokens:100,output_tokens_details:{reasoning_tokens:80}}}}));
  });
  const upPort=await listen(upstream),cfg=b.deepMerge({},b.DEFAULT_CONFIG);
  cfg.backend='relay';cfg._config_path=path.join(dir,'config.json');cfg.relay.url=cfg.relay.auth_url=`http://127.0.0.1:${upPort}`;cfg.relay.setting_json='setting.json';
  fs.writeFileSync(path.join(dir,'setting.json'),JSON.stringify(createCredential({access:'mock-access',refresh:'mock-refresh'})));
  cfg.bridge_secret='test-key';cfg.constraints.model_fallback='forbid';const ctx=b.newAccountCtx('main');
  const server=b.createBridgeServer(cfg,ctx,cfg.bridge_secret,2),port=await listen(server);
  t.after(async()=>{await close(server);await close(upstream);await ctx.usageStore?.queue;assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('bridge-gpt-fidelity-'));fs.rmSync(dir,{recursive:true,force:true});});
  const target={host:'127.0.0.1',port,prefix:'',headers:{'x-api-key':cfg.bridge_secret}};
  const call=async body=>{const result=await b.diagnosticRequest(target,'/v1/responses',body);await ctx.usageStore?.queue;for(let i=0;ctx.inflight&&i<100;i++)await new Promise(r=>setTimeout(r,5));return result;};
  const request={model:'gpt-6-astra',input:'PRIVATE_PROMPT',store:true,stream:false,max_output_tokens:12000,context_management:[{type:'compaction',compact_threshold:200000}]};
  let result=await call(request);
  assert.equal(result.status,200);assert.deepEqual(JSON.parse(result.raw).output,[reasoning,tool]);
  assert.equal(seen[0].max_output_tokens,12000);assert.equal(seen[0].store,true);assert.deepEqual(seen[0].context_management,request.context_management);assert.equal(seen[0].reasoning.effort,'high');
  const next={...request,input:[...JSON.parse(result.raw).output,{type:'function_call_output',call_id:'call-1',output:'PRIVATE_RESULT'}],reasoning:{effort:'low'},previous_response_id:'resp-id',store:false};
  result=await call(next);
  assert.deepEqual(seen[1].input,next.input);assert.equal(seen[1].reasoning.effort,'low');assert.equal(seen[1].previous_response_id,'resp-id');
  assert.equal(ctx.lastGptRequest.sent_effort,'low');assert.equal(ctx.lastGptRequest.effort_source,'client');assert.equal(ctx.lastGptRequest.reported_effort,'low');
  assert.doesNotMatch(JSON.stringify(ctx.lastGptRequest),/PRIVATE|resp-id|mock-access|opaque-next-turn/);
  mode='late';result=await call({...request,stream:true});
  assert.match(result.raw,/upstream_stream_model_fallback/);assert.doesNotMatch(result.raw,/response.completed/);
  assert.equal(ctx.counters.fallback,1);assert.equal(calls,3,'no silent replay');
});
