# 空间后端（`backend: "space"`）

把 Anthropic `/v1/messages` 翻译成**云空间里的一次 agent 回合**，费用从空间额度扣。这是 0.9.5 新增的第三个后端。

先说清楚它不是什么：**它不是裸模型补全。**

## 与 `backend: "relay"` 的真实差别

| | `relay` | `space` |
|---|---|---|
| 上游 | relay 的模型路由 | 云空间里的 Claude Code agent |
| 调用方 `tools` | 原样透传，会返回 `tool_use` | **被丢弃**，永不返回 `tool_use` |
| `stop_reason` | 上游真实值 | 恒为 `end_turn` |
| 采样参数 | 部分接受 | `temperature` / `top_p` / `stop_sequences` / `thinking` / `max_tokens` **全部忽略** |
| 输入 token 基线 | 无 | **每次约 19–20k**（agent 自身 system prompt + 工具定义） |
| 计费来源 | 个人额度 | **空间额度** |
| 落账 | 即时 | **延迟 15–60 秒，可能分批** |

被丢弃的字段不会静默消失：响应头 `X-Mirasim-Dropped` 会列出它们（URL 编码）。

**靠 `tool_use` 驱动的客户端（Claude Code 这类）走 space 后端会退化**，因为工具循环发生在 agent 内部，不会回到调用方。这是空间池付钱必须付的代价。

## 协议

不是 HTTP 路由，是 WebSocket：

```
1. POST /v2/gateway/session   {nodeId, idleSleep:1}
   authorization: Bearer <access token>
   → {session: <JWT>, gatewayUrl: "wss://relay.mirasim.ai/v2/gateway/ws"}

2. ws 首帧
   {"type":"gatewayAuth","token":<session>,"nodeId":...,"wake":1,"idleSleep":1}

3. {"type":"prompt","clientRef":<random>,"agent":"claude","model":<id>,
    "prompt":<text>,"workdir":"/data/ws","route":"cloud"}

回帧：
   accepted  {sessionKey}
   session   patch.set.phase = "streaming", patch.set.model = "…[1m]", effort
   session   patch.appendText = "…"          ← 增量文本
   session   patch.set.phase = "done", usage {...}
```

**扣费判据**（2026-11-01，space-316be）：一次 haiku 回合让
`/v2/machines/space-316be/credit` 从 `{balance:1122, used:128}` 变成 `{balance:1121, used:129}`，
同一分钟 `/v1/limits`（个人 30d）**一个数都没动**。这是"钱从空间走"的直接证据，不需要进容器。

`gatewayHostCaps` 到达才算真连上——WebSocket `open` 只说明 TCP 通了，空间可能还没醒。

## 流式输出

`stream: true` 时输出真实 Anthropic SSE，不是缓冲后重放：

```
message_start → content_block_start → content_block_delta × N → content_block_stop → message_delta → message_stop
```

`message_start.message.model` 用的是**服务端回的 `patch.set.model`**，不是请求里的 id。
实现上 `MessagesStream` 的 model 参数传 getter，第一次写 delta 时才求值：

```js
let served = requested;
const stream = new MessagesStream(() => served, emit);
await gateway.runTurn({ …, onUpdate: (field, value) => { if (field === 'model') served = value; } });
```

回合中途失败时发 `event: error`，**不会**补一个假的 `message_stop`。

## 错误映射

空间把 agent CLI 的错误文本原样包在 `error` 帧或 `session.patch.set.error` 里，
形如 `API Error: 422 model "x" is not supported at this time`。
`spaceError()` 从文本里提取 4xx 状态码，**两条路径都走它**（只修一条会漏）。

| 情况 | 返回 |
|---|---|
| 上游 4xx（模型不支持等） | **400** `code: space_upstream_rejected` |
| 网关自身失败 / 5xx / 无状态码 | **502** `code: space_turn_failed` |
| 回合超时 | 502（回合 reject） |
| 客户端断开 | `AbortController` 取消，不写响应 |

4xx 是调用方的错，不能伪装成上游故障——否则 sub2api 会把账号判成不健康。

## 配置

```json
{
  "backend": "space",
  "space": {
    "node_id": "space-316be",
    "gateway_url": "wss://relay.mirasim.ai/v2/gateway/ws",
    "workdir": "/data/ws",
    "turn_timeout_ms": 600000
  }
}
```

`node_id` 必须是合法的空间节点 ID（`space-…`）。仍需要 `relay.setting_json` 指向可用的 access token，因为网关会话是用它签发的。

## 可用接口

| 接口 | 行为 |
|---|---|
| `POST /v1/messages` | 翻译成一次 agent 回合；支持 `stream: true` |
| `POST /v1/messages/count_tokens` | **本地估算**，不真发回合（真发会白烧 20k tokens 且扣钱） |
| `GET /v1/models` | 网关 `getCatalog()`，按白名单过滤 |
| `GET /v1/limits` | `{personal, space}` 双段：personal 来自 relay，space 来自 `/v2/machines/<node>/credit` |

其余路径一律 400。

## 模型名

**不要自己做映射。** 客户端发 `claude-opus-5-5`，空间自己会规范化成 `claude-opus-5-5[1m]`；响应里的 `model` 用**服务端回帧的 `patch.set.model`**，不是请求里的值。

不支持的模型空间会回 422，bridge 映射成 **400**（调用方的错，不是上游故障），错误文本原样透出。

## 并发与队列

- 不同 `clientRef` + `sessionKey: null` → 各自独立会话，**真并行、不串流**
- **`queued` 字段不可靠**（实测空闲时恒为 `false`），不要用它做背压
- 并发上限必须自己限，用 `forward.max_concurrency`

## 会话与上下文

**每个 `/v1/messages` 请求开新 `sessionKey`**，把完整历史拍平成 `prompt`。

不要复用 `sessionKey`：`patch` 帧是按 sessionKey 广播、不带 clientRef，复用会让上一轮的 `appendText` 混进下一轮的流里（实测出现过 `"ALPHABETA"` 这种混流）。

代价是每次请求都带约 19–20k tokens 基线，短请求也不便宜。

## usage 字段口径

空间的 `usage` 有三个数，**不能互换**：

| 空间字段 | Anthropic 字段 | 说明 |
|---|---|---|
| `contextUsedTokens` | `input_tokens` | 这一轮真实携带的输入总量 |
| `inputTokens` | —— | 只是这一轮的**新鲜**部分，不含 agent 自带 prompt |
| `cachedInputTokens` | `cache_read_input_tokens` | 提示缓存命中 |
| `outputTokens` | `output_tokens` | |
| `contextWindowTokens` | `space_context_window` | 上下文窗口（非 Anthropic 标准字段，只做提示） |

一次实测回帧是 `inputTokens:2, cachedInputTokens:0, contextUsedTokens:18873`——
两个小数字加起来 ≈ 2，但上下文实际是 18873。所以：

```js
input_tokens = contextUsedTokens ?? (inputTokens + cachedInputTokens)
```

用 `inputTokens + cachedInputTokens` 会把 20k 报成 2，sub2api 那边记账全错。

## 代码

| 文件 | 职责 |
|---|---|
| `lib/space-gateway.js` | `SpaceGateway`：mint、WS 连接与就绪等待、帧分发、回合生命周期、超时/取消/断线、`getCatalog`、`spaceError` |
| `lib/space-messages.js` | `toPrompt` / `toMessage` / `MessagesStream` / `toUsage`：Anthropic ⇄ agent 回合 |
| `mirasim-bridge.js` | `handleSpaceProxy`：路由、SSE、错误映射、`X-Mirasim-Dropped` |
| `tests/space-backend.test.js` | 假 WebSocket 喂帧序列 |

**`relay.js` 必须放行 `POST /v2/gateway/session`**，否则 mint 永远失败：

```js
const v2 = route.startsWith('/v2/machines') || route === '/v2/gateway/session';
const v2Post = route === '/v2/gateway/session' && method === 'POST';
```

**`target.space` 分支必须写在 `readBody()` 之前**，否则 `GET /v1/models` 没有 body，
`readBody` 会挂住，下游拿不到 req。

## usage 字段口径

空间的 `usage` 有三个数，**不能互换**：

| 空间字段 | Anthropic 字段 | 说明 |
|---|---|---|
| `contextUsedTokens` | `input_tokens` | 这一轮真实携带的输入总量 |
| `inputTokens` | —— | 只是这一轮的**新鲜**部分，不含 agent 自带 prompt |
| `cachedInputTokens` | `cache_read_input_tokens` | 提示缓存命中 |
| `outputTokens` | `output_tokens` | |
| `contextWindowTokens` | `space_context_window` | 上下文窗口（非 Anthropic 标准字段，只做提示） |

一次实测回帧是 `inputTokens:2, cachedInputTokens:0, contextUsedTokens:18873`——
两个小数字加起来 ≈ 2，但上下文实际是 18873。所以：

```js
input_tokens = contextUsedTokens ?? (inputTokens + cachedInputTokens)
```

用 `inputTokens + cachedInputTokens` 会把 20k 报成 2，sub2api 那边记账全错。

## 代码

| 文件 | 职责 |
|---|---|
| `lib/space-gateway.js` | `SpaceGateway`：mint、WS 连接与就绪等待、帧分发、回合生命周期、超时/取消/断线、`getCatalog`、`spaceError` |
| `lib/space-messages.js` | `toPrompt` / `toMessage` / `MessagesStream` / `toUsage`：Anthropic ⇄ agent 回合 |
| `mirasim-bridge.js` | `handleSpaceProxy`：路由、SSE、错误映射、`X-Mirasim-Dropped` |
| `tests/space-backend.test.js` | 假 WebSocket 喂帧序列 |

**`relay.js` 必须放行 `POST /v2/gateway/session`**，否则 mint 永远失败：

```js
const v2 = route.startsWith('/v2/machines') || route === '/v2/gateway/session';
const v2Post = route === '/v2/gateway/session' && method === 'POST';
```

**`target.space` 分支必须写在 `readBody()` 之前**，否则 `GET /v1/models` 没有 body，
`readBody` 会挂住，下游拿不到 req。

## 计费

实测：`claude-opus-5-5` 一次 19427 input → 空间 `used +10`；`claude-haiku-5-5` 一次 → `used +1`。

但**单次扣费无法精确预测**：5 个并发回合最后只落下 8 点，且落账延迟 15–60 秒、会分两批跳。bridge 只报原始 `balance` / `used` 快照，不做换算承诺。

## 取消

**协议层没有取消帧。** 客户端→网关的可发帧白名单是
`netExec / netExecCancel / netFile / netStatus / prompt / subscribe / unsubscribe / ping / netBlobPut / netTaskStart / netThreadRead / netThreadPost`
——没有 `stop` / `cancel` / `interrupt`（`steer` 是往运行中的回合追加指令，不是取消）。

实测：回合进行中依次发 `{"type":"stop"}`、`{"type":"stop",sessionKey}`、`{"type":"cancel"}`、`{"type":"interrupt"}`，
socket 不断、回合照常跑到 `phase:done`。

所以：

- 客户端断开时桥接器**只停止本地等待**（`AbortController`），**不会取消空间里已开始的回合**，该回合仍会跑完并计入额度。
- 要控制成本，**收紧 `forward.max_concurrency`，而不是靠断开**。
- 面板 `last_turn.elapsed_ms` 可能显示"用户已断开但回合仍在跑"的时长，这是真实的。

## 用量统计

每个成功回合都写进 `usage` 台账（与 relay 后端同一个 `lib/usage.js`），字段口径：

| 台账字段 | 来源 |
|---|---|
| `model` | 请求里的模型 id |
| `served_model` | 回帧的 `patch.set.model`（首个回合可能不回，此时回落到请求值） |
| `input_tokens` | `contextUsedTokens` **减去**缓存读写（台账要求三项分开，否则重复计费） |
| `cache_read_tokens` | `cachedInputTokens` |
| `usage_state` | 有完整数字时 `complete`，否则 `unknown` |

失败回合同样计入 `ctx.counters.err`、趋势图和延迟统计（`ok:false`），
所以 p95 包含超时回合，不会系统性偏乐观。

## 优雅退出

space 回合计入 `inflight`，drain 最长等 `space.turn_timeout_ms`（默认 600s），
但 `shutdown.total_timeout_sec` 默认只有 150s，因此**超时会强制退出**。
这是有意的：宁可中断等待，也不让进程无限挂着。

## 取消

**协议层没有取消帧。** 客户端→网关的可发帧白名单是
`netExec / netExecCancel / netFile / netStatus / prompt / subscribe / unsubscribe / ping / netBlobPut / netTaskStart / netThreadRead / netThreadPost`
——没有 `stop` / `cancel` / `interrupt`（`steer` 是往运行中的回合追加指令，不是取消）。

实测：回合进行中依次发 `{"type":"stop"}`、`{"type":"stop",sessionKey}`、`{"type":"cancel"}`、`{"type":"interrupt"}`，
socket 不断、回合照常跑到 `phase:done`。

所以：

- 客户端断开时桥接器**只停止本地等待**（`AbortController`），**不会取消空间里已开始的回合**，该回合仍会跑完并计入额度。
- 要控制成本，**收紧 `forward.max_concurrency`，而不是靠断开**。
- 面板 `last_turn.elapsed_ms` 可能显示"用户已断开但回合仍在跑"的时长，这是真实的。

## 用量统计

每个成功回合都写进 `usage` 台账（与 relay 后端同一个 `lib/usage.js`），字段口径：

| 台账字段 | 来源 |
|---|---|
| `model` | 请求里的模型 id |
| `served_model` | 回帧的 `patch.set.model`（首个回合可能不回，此时回落到请求值） |
| `input_tokens` | `contextUsedTokens` **减去**缓存读写（台账要求三项分开，否则重复计费） |
| `cache_read_tokens` | `cachedInputTokens` |
| `usage_state` | 有完整数字时 `complete`，否则 `unknown` |

失败回合同样计入 `ctx.counters.err`、趋势图和延迟统计（`ok:false`），
所以 p95 包含超时回合，不会系统性偏乐观。

## 优雅退出

space 回合计入 `inflight`，drain 最长等 `space.turn_timeout_ms`（默认 600s），
但 `shutdown.total_timeout_sec` 默认只有 150s，因此**超时会强制退出**。
这是有意的：宁可中断等待，也不让进程无限挂着。

## 已知不可用

以下都实测过，不是没试：

| 路径 | 结果 |
|---|---|
| `POST /v2/machines/<node>/credit/keys` | `403 {"error":"trial_space"}` —— 体验空间不能建 API 密钥 |
| `POST /v2/gateway/model/v1/messages` | `401 turn capability missing` |
| `POST /v2/machines/<node>/{local,matrix,apps}/turn-capability` | `401 machine-auth: key` —— 需要云实例自己的私钥 |
| `spaceCreditOnly: true` | 被拒：只有跑在这台机器上的程序才能要求纯空间额度回合 |
| 发 `gatewayModelRoster` | WebSocket 被 `1008` 断开（该帧是 gateway→host 单向） |
| 本地 4963 网关 | 无默认密钥，且体验空间建不了 |
| 直连 relay 带 machine-proof | `401 device_signature (missing_headers)` |

## 验证

```bash
node --test tests/space-backend.test.js          # 19 项，完全离线
node mirasim-bridge.js serve --config <space 配置>
curl -s -X POST http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: <bridge_secret>" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"Reply with exactly: OK"}]}'
```

跑完立刻读 `GET /v2/machines/<node>/credit`，`used` 应在 15–60 秒内上涨。

覆盖：假 WS 帧序列、断线、超时、catalog 无 reqId 回显、JWT 到期重签、422 透传、SSE 事件序、`toUsage` 换算、`notes` 内容。**不打真网关。**
