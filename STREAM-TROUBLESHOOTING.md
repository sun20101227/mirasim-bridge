# 空流、finish_reason 和 SSE 报错排查

Hermes 用户先看 [HERMES.md](HERMES.md)，它支持显式配置 Messages / Responses，不应默认使用 Chat Completions 连接本 bridge。

`Provider returned an empty stream with no finish_reason` 是客户端解析响应失败的提示，不足以单独确定上游或桥接器的根因。可能是协议不匹配、上游未生成有效流、连接中断或中间反代超时。

## 先确认客户端协议

- Anthropic Messages：`/v1/messages`，结束事件是 `message_stop`，停止原因位于 `message_delta.delta.stop_reason`。
- OpenAI Responses：`/v1/responses`，GPT 模型使用，结束事件是 `response.completed` 或 `response.incomplete`。
- OpenAI Chat Completions：`/v1/chat/completions`，通常使用 `choices[].finish_reason` 和 `[DONE]`。bridge 尚未实现这个接口和对应协议转换。

所以模型名称以 GPT 开头不代表应该选择 Chat Completions。通过 sub2api 调用时还要确认 sub2 该分组实际提供的接口；不要把 Messages 的 SSE 直接交给 Chat Completions 解析器。请提供客户端名称、模型 ID、所选 API 类型和出错时间，不要提供密钥或完整请求内容。

## 0.7.1 错误行为

收到合法协议事件之前不向客户端承诺成功的 200 响应。空流、仅心跳后结束、初始错误等情况返回 HTTP 503 和以下稳定代码；已经开始的流以协议内 `error` 事件报告，不补造成功结束标记。

| 代码 | 含义 |
|---|---|
| `upstream_stream_empty` | 上游结束时没有可识别的模型事件 |
| `upstream_stream_error` | 上游发送了错误事件 |
| `upstream_stream_protocol_mismatch` | 接口与收到的事件协议不同 |
| `upstream_stream_invalid_json` | data 帧不是有效 JSON |
| `upstream_stream_first_event_timeout` | 已收到 SSE 响应头，但首个有效事件超过 upstream_headers_timeout_ms |
| `upstream_stream_truncated` | 流已开始，但没有结束事件就 EOF |
| `upstream_stream_interrupted` | TCP 中断或其他流传输错误 |
| `upstream_stream_encoding` | 请求 identity，但上游仍返回压缩编码 |

读取响应头 `x-bridge-request-id`，与 bridge 日志里的 `stream_failure` 对应。日志只含内部请求编号、模型、协议、错误分类和时间，不记请求正文、token 或原始上游错误内容。`status` 输出的 `last_stream_error` 是该进程最近一次流错误，重启清空，不代表当前请求一定失败。

```bash
docker compose logs --since=10m bridge
docker compose exec bridge node /app/mirasim-bridge.js status --config /data/config.json
```

## 反代设置

模型流量所在的 Nginx location 使用 `proxy_buffering off` 和足够长的 `proxy_read_timeout`。管理后台的 8790 不是模型 API，模型入口仍为 bridge 8787 或 sub2api 的 API 地址。

0.7.1 只需更新 bridge 镜像，原数据卷与宿主机管理页面不必重装。升级只改善错误传播和诊断，不能修复上游账号容量或保证所有客户端都显示详细 SSE 错误。遇到持续故障请结合模型、接口类型和请求编号排查。
