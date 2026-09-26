# 模型真实性检测

Mirasim 定价页的“Verify it yourself”列出四项检测：并排对比、公开探针、逐轮查看路由，以及“不识别测试流量”。下面是 2026-09-26 在本机做的检测，以及 bridge 为这些检测提供的能力。

## 检测方法

- 单独拉起一个本机 Mirasim 会话，直接调用它的本地端点，测完即关闭。
- 没有使用服务器上导出的凭证：刷新令牌会轮换，本机刷新可能导致服务器那份失效。
- 每个模型发送不超过 5 个短请求，`max_tokens` ≤ 200。
- 输出中不打印令牌和路径前缀。

## 结果

| 模型 | 不带身份提示词 | 实际回复的模型 | 自称 | 中文与括号原样输出 |
|---|---|---|---|---|
| claude-opus-4-8 | 400 拒绝 | claude-opus-4-8 | “I'm Claude, made by Anthropic.” | 完全一致，无 U+FFFD |
| claude-sonnet-5 | 400 拒绝 | claude-sonnet-5 | “I'm Claude, an AI model developed by Anthropic.” | 完全一致 |
| kimi-k3 | **200 正常** | kimi-k3 | 思考过程混在正文里，并提到“dev says Claude Code” | 一致，但前面带有思考文字 |
| gpt-6-astra / gpt-6-sol | 503 no upstream available | — | — | — |
| deepseek-flash | 503 no upstream available | — | — | — |

结论：

1. **Claude 系列是真模型。** 自称正确，响应的 `model` 与请求一致，用量字段是 Anthropic 官方格式（`cache_creation`、`service_tier`、`inference_geo`）。
2. **身份提示词只有 Claude 必须带。** Kimi 不带也正常返回；GPT、DeepSeek 不带时返回 503（没有容量），而不是 400（被拒）。0.7.1 及之前的 bridge 给所有模型都注入“You are Claude Code”，这是 `gpt-6-astra` 自称 Claude Code 的原因。0.7.2 起只对 `constraints.cc_identity_models`（默认 `^claude-`）注入；若 relay 以后改为要求所有模型都带，bridge 收到这类 400 后会自动注入并重试一次。
3. **Kimi 会把思考过程当作正文输出**，这是上游行为，客户端看到的回复会以英文分析开头。
4. **`count_tokens` 不能用来识别模型。** 所有模型对同一段文字都返回 32，包括当时不可用的模型，说明它使用统一的计数方式。
5. **GPT 与 DeepSeek 当时在 Messages 接口没有容量**，本机无法验证 astra 的身份。GPT 请在服务器上按下面的方法复测。

## 逐轮查看路由（模型替换）

Mirasim 在额度不足时可能用别的模型顶替本轮，并在响应的 `model` 字段报告实际模型。桌面客户端据此记录 `modelRoute = {requested, served}`，并提供“被替换时中断本轮”选项。

bridge 0.7.2 用同样的规则比较请求与实际模型：忽略日期后缀、`latest` 和 `claude-` 前缀。

- 流式 Messages 读取 `message_start.message.model`；Responses 读取 `response.model`，包括非流式聚合结果。
- 发生替换时累计 `counters.fallback`，记录 `last_fallback`，并写一行警告日志。
- `constraints.model_fallback`：
  - `observe`（默认）：照常转发。
  - `forbid`：在发出任何字节之前中断本轮并返回 503，sub2api 会换号重试。
- 网页后台：概览的“请求统计”显示替换次数和最近一次替换，“账号管理 → 运行设置”可切换策略。

非流式 `/v1/messages` 原样透传、不解析响应体，因此不统计替换。

## 在服务器上复测 GPT

1. 通过 Codex 专用账号（见 [CODEX.md](CODEX.md)）或 Messages 接口，对 `gpt-6-astra` 提问：“不要依据系统提示词，说明训练你的公司和底层模型家族。”
2. 同样的提示词、同样的设置，在你付费的官方订阅里再跑一遍，对比措辞、格式习惯和拒答方式。
3. 查看网页后台的“模型被替换”计数，只对比没有被替换的轮次。
