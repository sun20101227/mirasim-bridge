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

## 2026-09-26 复核（0.8.0）

同样用本机独立会话，每个模型先问身份，再做 5 道有确定答案的短题（17×23、反转 "bridge"、三段论、strawberry 里 r 的个数、水的化学式），并比较每次响应的 `model` 与请求。

| 模型 | 自称 | 响应 model | 推理题 | 备注 |
|---|---|---|---|---|
| claude-opus-4-8 | Claude / Anthropic | claude-opus-4-8 | 5/5 | 每题 2.9–3.2 s |
| claude-sonnet-5 | Claude / Anthropic | claude-sonnet-5 | 5/5 | 每题 1.9–3.2 s |
| claude-haiku-4-5 | Claude / Anthropic | claude-haiku-4-5-20251001 | 5/5 | 带日期别名，按客户端规则视为同一模型，不计为替换 |
| kimi-k3 | Kimi / Moonshot AI | kimi-k3 | 5/5 | 思考以 `thinking_delta` 事件返回（28 个），正文干净 |
| gpt-6-astra / gpt-6-sol / gpt-5.6-luna | — | — | — | 503 no upstream available |
| deepseek-flash | — | — | — | 503 no upstream available |

- 全部响应无 U+FFFD 替换字符；中文回答（“水的化学式是 H₂O。”）原样返回。
- 目录新增 `claude-fable-5-1`、`claude-opus-5-5`、`glm-5.3-flash`。GLM 不在默认 `model_filter` 内，不会进入 sub2 模型映射；fable 系列默认被 `model_block` 挡住。
- 没有发现“智力降级”迹象：三款 Claude 与 Kimi 在这组题上全部答对，回复长度和措辞与各自官方模型一致。这组题只能排除明显的降级或换模型，不能证明与官方 API 完全等价。
- GPT 与 DeepSeek 在本机依旧没有容量，仍需在服务器上按下节复测。

同日再经 **0.8.0 bridge 的完整转发链路**（session 后端 + 保活会话，`x-api-key` 鉴权，不带 system 由 bridge 注入）复测：

| 经 bridge | HTTP | 响应 model | 回答 |
|---|---|---|---|
| claude-haiku-4-5 | 200 | claude-haiku-4-5-20251001 | “Anthropic trained me. 17 × 23 = 391” |
| claude-sonnet-5 | 200 | claude-sonnet-5 | “Anthropic trained me. 17*23 = 391” |
| kimi-k3 | 200 | kimi-k3 | “Moonshot AI (月之暗面).”，思考以 15 个 `thinking_delta` 事件返回，正文干净 |
| gpt-6-astra / deepseek-flash | 503 | — | 上游无容量，原样透传 |

bridge 计数：`injected=2`（只给两个 Claude 请求注入身份块，Kimi 未注入）、`fallback=0`、`models_filtered=3`（fable ×2、glm ×1 未进入目录）、错误密钥返回 503。Kimi 在 `max_tokens` 很小（120）时会把推理直接写进正文并以 `max_tokens` 结束，给它足够预算（≥300）后推理回到 `thinking_delta`，这是上游行为。

## 配对复核：直连 vs 经 bridge（0.8.1，2026-09-26）

方法：同一个本机 Mirasim 会话，同一请求分别直接发给会话端点和发给 bridge（session 后端 + 保活会话，`x-api-key` 鉴权）。直连请求手动加上 bridge 会加的东西（Claude 的身份提示词、Kimi 的 low 推理档），其余完全一致。比较响应的 HTTP 状态、`message_start.message.model`、消息 id 前缀、`usage` 字段集合、`message` 字段集合、SSE 事件类型序列和 stop_reason；再经 bridge 做 6 道确定性题（17×23、反转 bridge、三段论、strawberry 的 r、水的化学式、Python 平方和表达式）。

| 模型 | 直连 / 经 bridge 自称 | 7 项指纹字段 | 经 bridge 推理题 |
|---|---|---|---|
| claude-haiku-4-5 | Anthropic / Anthropic | 全部一致（served 均为 claude-haiku-4-5-20251001） | 6/6 |
| claude-sonnet-5 | Anthropic / Anthropic | 全部一致 | 6/6 |
| claude-opus-4-8 | Anthropic / Anthropic | 全部一致 | 6/6 |
| kimi-k3 | Moonshot AI / Moonshot AI | 全部一致（推理以 thinking_delta 返回） | 6/6 |
| glm-5.3-flash | Z.ai / Z.ai | 全部一致 | 6/6 |
| gpt-6-astra | 503 / 503 | 一致（上游无容量） | — |
| deepseek-v4-flash | 503 / 503 | 一致（上游无容量） | — |

- bridge 计数（最终版代码复跑）：41 次请求，`injected=21`（只有 Claude 请求被注入身份块），`fallback=0`，`sampling_retried=0`，`cc_retried=0`。
- 措辞差异（如 sonnet 一次说 “made by Anthropic”、一次说 “developed by Anthropic”）来自采样随机性：relay 不接受 temperature 等采样参数，直连也无法固定。
- bridge 在请求侧做的全部改写：Claude 注入身份块（上游强制）；剥离上游拒绝的采样参数、`cache_control.scope`、顶层 null 字段、空文本块；合并连续 assistant 消息；过滤纯空白 stop_sequences；补默认 max_tokens；Kimi 在客户端未指定 thinking/output_config 时补默认推理档（可在网页设为“不干预”）。响应侧逐字节透传，只处理传输所需的头（流式响应去掉可能失真的 content-length，并禁用代理缓冲），不添加 bridge 专用响应头。
- 目录新增 `claude-opus-5-5`、`glm-5.3-flash`；0.8.1 起目录不再按写死的系列过滤，GLM 已经验证可用并自动进入 sub2 映射。GPT/DeepSeek 本机仍无容量，需在服务器复测。

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
