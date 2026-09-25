# Claude、GPT、DeepSeek、Kimi 使用说明

## 支持范围

0.5.0 保留 `claude-`、`gpt-`、`deepseek-`、`kimi-` 前缀的协议支持，并保持原始模型名；当前三个不可用的 DeepSeek 型号默认排除。列表来自 Mirasim，不在失败后换用另一品牌模型。

本轮 `deepseek-flash` 复测仍为上游 503；Kimi 默认 low effort 后仍在 45 秒超时。下方 0.4.0 的成功记录为历史样本，不代表当前可用性。Kimi 并发限制和终止帧处理解决本地等待问题，不保证上游生成变快。

原有四系列 **Anthropic Messages** 接口保留，sub2api 自动注册账号仍是 `platform=anthropic, type=apikey`。新 `backend=relay` 增加 GPT 原生 **Responses** 与 **Responses compact**，推荐 GPT 客户端使用 Responses。

未实现 Chat Completions 转换；不能把 `/v1/chat/completions` 指到这里。已有 sub2api Anthropic 分组不会自动成为 Responses 分组，需另配对应路由或直连桥接器的 Responses。见 [RELAY.md](RELAY.md)。

## 0.4.0 新直连后端实测（2026-09-25 Windows）

| 型号/接口 | 结果 |
|---|---|
| `/v1/models`、`/v1/limits` | 均 HTTP 200，签名与凭证链路成立 |
| `claude-haiku-4-5` / Messages | HTTP 200，OK |
| `gpt-5.6-luna` / Responses | HTTP 200，OK |
| `gpt-5.6-luna` / Messages 兼容入口 | HTTP 200，OK |
| `kimi-k3` / Messages | HTTP 200，OK |
| `deepseek-v4-flash` / Messages | 上游 HTTP 503，no upstream available |

以上推理均经本次桥接器，不启动保活，不修改线上 sub2api。Responses JSON 聚合、工具调用和 compact 不透明字段通过 mock 测试；真实工具执行、compact 压缩和 Linux 部署仍需分别验收。

## 0.3.0 session 后端历史测试（2026-09-25 Windows）

| 型号 | 路径 | 结果 |
|---|---|---|
| `claude-haiku-4-5` | 新版桥接器 → Mirasim | HTTP 200，正文 OK |
| `gpt-5.6-luna` | 新版桥接器 → Mirasim | HTTP 200，正文 OK |
| `kimi-k3` | 新版桥接器 → Mirasim | HTTP 200，正文 OK |
| `deepseek-v4-flash` | 新版桥接器 → Mirasim | HTTP 503，no upstream available |
| `deepseek-flash` | Mirasim 直连 | HTTP 503，no upstream available |
| `deepseek-v4-flash-vision-exp` | Mirasim 直连 | HTTP 503，no upstream available |

当时过滤后列表有 15 个型号，其中还包括其他 GPT 和 Claude 型号；没有逐个验证它们的推理、工具调用或图片能力。Linux 上仍需重新测试。上游返回的模型 ID 仅按原样展示，这些实验不核验模型底层身份或品牌归属。

上表历史 DeepSeek 503 来自上游。0.5.0 默认在本地拒绝三个已知不可用型号并从目录排除；上游恢复后可设置 `constraints.disabled_models: []` 重新启用并单次测试。单个模型 503 不会当作全局凭证失效，不触发保活重启。

## 配置与升级

在 config.json 的 `constraints` 下设置：

```json
{
  "model_filter": "^(claude-|gpt-|deepseek-|kimi-)",
  "model_block": "fable"
}
```

这是 `constraints` 对象内容，不要直接覆盖完整配置。新安装默认就是这个值；旧配置的 `^claude-` 不会被安装器覆盖。`model_block` 保留已有 fable 排除规则，需要时可自行调整。

修改后重启服务，健康循环会从 sub2api 重新同步模型。不需要上传 Windows 的 state.json，也不要为不同品牌重复创建相同 Messages 上游。

## 列出与检测

在应用目录运行，默认连接正在运行的桥接器：

```bash
node mirasim-bridge.js models
node mirasim-bridge.js models --family gpt --json
node mirasim-bridge.js models --family deepseek --json
node mirasim-bridge.js models --check --model kimi-k3 --json
node mirasim-bridge.js test --model gpt-5.6-luna
```

- `models` 只请求列表，显示 `availability: not_tested`。
- `--check` 必须同时指定 `--model`，一次只检测一个型号；会产生真实模型调用。
- `test` 默认经桥接器，验证清洗、注入及转发；`--direct` 才直接使用活会话进行对照。
- 成功需要 HTTP 200、流正常结束、无 error 事件且有可见正文。只有 thinking、空正文或中途断流都不会假报成功。
- Messages 检测默认输出预算 128 token，可用 `--max-tokens 1024` 调整。**GPT 的 Codex Responses 不接受输出上限字段，兼容层会移除 max_output_tokens/max_completion_tokens；该参数不能限制 Responses 输出成本。** 推理 token 可能占用 Messages 预算。
- bridge CLI 检测默认等待 30 秒，可用 `--timeout-sec 60` 调整；失败退出码 1，不自动重试。不改变 sub2 内置检测超时。

## API 请求示例

从 `/v1/models` 选择真实型号，向 `/v1/messages` 发送：

```json
{
  "model": "gpt-5.6-luna",
  "max_tokens": 512,
  "stream": true,
  "messages": [{ "role": "user", "content": "Reply only OK." }]
}
```

请求头为 `Content-Type: application/json`、`anthropic-version: 2023-06-01` 和 `x-api-key: <bridge_secret>`。调用 sub2api 对外网关时改用该网关的用户 API Key。

响应是 Anthropic SSE：`message_start`、`content_block_delta`、`message_delta`、`message_stop`，不是 OpenAI 的 `choices[].delta` 格式。

GPT Responses（relay 后端）示例：

```json
{
  "model": "gpt-5.6-luna",
  "input": "Reply only OK.",
  "stream": false
}
```

发送到 `POST /v1/responses`，使用相同 bridge_secret。`stream:false` 返回标准 response JSON；true 返回 Responses SSE。桥接器把字符串 input 转成消息数组，设置 store=false，移除 Codex 不支持的采样/输出上限等字段，保留客户端 instructions、工具调用和不透明 reasoning/compaction 内容。`input` 的 system 角色转换为 developer；不会注入 Claude 身份文本。
