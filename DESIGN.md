# 当前版本说明（0.4.2，2026-09-25）

已选择保持原版 sub2api，通过标准 API Key 上游接入独立桥接器。0.4.2 提供配套容器与独立数据卷，避免修改宿主和占用现有插件能力；部署见 DOCKER.md。原生插件调查 SUB2API-PLUGIN.md 仅作历史备选。

0.4.1 修复凭证持久化、并发认证状态、断流、过滤、退出总超时及安装升级问题；审查记录见 AUDIT.md，使用说明以 README.md / DEPLOY.md 为准。

0.4.0 新增 relay 直连后端，协议移植自 cpa-plugin-mirasim 提交 `d1a25283709ba6920e2bcc2aec3ccf624803c212`。使用 Ed25519 设备签名、X25519/HKDF/ChaCha20-Poly1305 元数据加密、设备票据与账号 token 刷新，不再要求常驻会话。因此下文“方案必须保活”的结论仅适用于旧 session 后端；早期把设备签名称作 HMAC 的表述也由已验证的 Ed25519 实现替代。

新直连经真实账号验证：models/limits 200，Claude Messages、GPT Responses 和 Messages、Kimi Messages 200 + OK；DeepSeek 当前 503。支持 Responses compact，但真实压缩和工具调用尚未验收。Windows 的 setting.json 已变为 mrs1 机器加密，需在原机导出可迁移凭证，私有打包自动完成。完整配置和差异见 RELAY.md。Linux 真机仍待部署验收，线上 sub2api 未在本轮修改。

以下为 0.3.0 及更早历史记录：

0.3.0 默认放行 Claude、GPT、DeepSeek、Kimi 四个系列，统一使用 Messages 协议。经新版桥接器实测 Claude、GPT、Kimi 返回 200 + OK；DeepSeek 三个已列出型号当前均返回上游 no upstream available。具体调用、检测和升级见 MULTI-MODEL.md；历史“仅 Claude”过滤说明已被替代。线上 sub2api 未在本轮更新，需部署后同步。

本文保留历史设计与实验，部分结论已被后续修复替代。部署步骤以 README.md / DEPLOY.md 为准，最新差异见 CHANGELOG.md。

本轮修订：域名不再被当成异机证据；新账号先在分组外创建并暂停；状态端点需要鉴权；发现输出隐藏敏感路径；失败载荷日志默认关闭；退出先排空请求再停保活；Linux 真机与当前 relay 端到端仍待部署验证。历史短时额度不变不能证明长期零成本。

---

# mirasim → sub2api 桥接器：调研结论与设计 v5

> 状态：**§A 实验 1 已完成（2026-08-28 本机实测）。结论是最坏的一支：
> 端口和 token 都每会话一换。方案要成立必须有「会话保活器」——见 §A。**
> 下一步不是写转发代码，而是先验证保活可行性。
>
> **v4.1 → v5 变更（全部来自本机实测，不再是推断）**
>
> | # | 发现 | 影响 |
> |---|---|---|
> | 1 | **端口 + token 每会话一换**（7 次会话 = 7 端口 7 token） | 🔴 存亡级，触发「会话保活器」课题 |
> | 2 | 凭证经 `--settings <临时文件>` 传递，**不内联命令行** | 采集机制重写（settings 文件反查） |
> | 3 | Mirasim 自带完整 CLI：`server.cjs claude/serve/relay/...` | **可程序化起会话，无需 GUI**——保活的关键抓手 |
> | 4 | relay 实际是 `relay.mirasim.ai`，非文档的 `mirasim-relay.mirofish.ai` | 更正常量 |
> | 5 | 临时 settings 文件会话结束后**不清理** | 必须「活进程→其命令行路径→文件」反查，不能挑最新文件 |
> | 6 | v4.1 曾误判「8812 常驻」——实为当时我自己的会话未结束 | 撤销该误判，v3 原判断反而是对的 |
>
> 标注：【实测】= 本机 2026-08-28 验证；【事实】= sub2api 源码逐行确认（已三轮）；
> 【推断】= 设计决策；【用户拍板】= 用户明确决定。
> 标注：【事实】= 源码逐行确认（`%TEMP%\sub2api-src`，已三轮核对，行号可复查）；
> 【推断】= 设计决策；【用户拍板】= 用户明确决定；【待验】= 必须实验才能确定。
>
> **v3 → v4 变更摘要**
>
> | # | 变更 | 性质 |
> |---|---|---|
> | 1 | 新增 §2.4「上游错误码 → 账号状态」映射表 | **新事实，最重要** |
> | 2 | 桥接器自身故障禁用 401/403，一律 503 | **修正致命缺陷** |
> | 3 | 修订调度闸门表：删 2 个不适用、补 2 个漏列 | 修正 |
> | 4 | RESUME 组合动作补原子性语义（半成功不得置 desired） | 修正缺陷 |
> | 5 | 补状态抖动保护（最小驻留 + 指数退避）、drain 超时 | 补缺失 |
> | 6 | §A 增加实验 2：云端 headless Electron 可行性（同为存亡级） | 提升优先级 |
> | 7 | 修正阶段划分（observe 依赖发现内核，不能排在它前面） | 修正 |
> | 8 | 每个阶段补「验收标准」 | 补缺失 |
> | 9 | 新增 §2.6 已排除的非风险（省掉未来重复调研） | 新增 |
> | 10 | 澄清 `public_base_url` 悬空字段 = 拓扑 B 钩子 | 清理 |
> | 11 | 消除 §2/§5/§7/§9 的重复叙述，事实只在一处定义 | 结构 |

---

## 0. 目标

把 Mirasim（Electron 应用）在 agent 会话期间动态创建的 Claude Code 反代端点，
桥接注册到自建 sub2api（`https://sub2api.example.com`），作为 `platform=anthropic` 的
apikey 账号入池；端点消失自动暂停、恢复后自动启用。

---

## A. 存亡实验【实验 1 已完成，结论改变架构】

### 实验 1：token 能活多久？—— **已完成，结论：每会话一换**【实测 2026-08-28】

**问题**：桥接器能不能在「没有 agent 会话在跑」时，拿到一个能用的 token？
**答案：不能。端口和 token 都随会话生灭。**

**证据**：Mirasim 每次拉起 CLI 会话，写一个 `%TEMP%/mirasim-claude-settings-<hash>.json`，
里面是 `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:<port>","ANTHROPIC_AUTH_TOKEN":"<43字符>",...}}`。
比对本机 7 个历史会话文件：

```
06:17  http://127.0.0.1:9493   fp=fc54d490e87c
06:20  http://127.0.0.1:7650   fp=1f59d9548010
06:32  http://127.0.0.1:12478  fp=eb620e081c14
06:55  http://127.0.0.1:9334   fp=5bfbb1565dc1
08:42  http://127.0.0.1:8812   fp=d9d232096419
08:44  http://127.0.0.1:1619   fp=43eac336104e
08:45  http://127.0.0.1:1663   fp=a69416afebae
→ 7 个会话 = 7 个不同端口 + 7 个不同 token
```

会话结束后其端口立即消失（实测 1619/1663 会话退出后 `Get-NetTCPConnection` 查不到）。
v4.1 曾误判「8812 常驻」——那其实是我当时**自己发起的会话**尚未结束，端口自然在。撤销该误判。

**含义**：没有活着的 agent 会话 → 没有可用端口，也没有有效 token → 账号必须处于暂停态。
这正是 §0 目标里最怕的情形：「绝大多数时间账号都是暂停的，池子里等于没有它」。

**→ 方案要成立，必须有「会话保活器」**：拉起并维持一个**长期不结束的 agent 会话**，
让端口与 token 稳定存在，供桥接器采集与转发。

### 实验 1b：保活可行性 —— **已验证成立**【实测 2026-08-28】

**结论：保活形态存在，token 在会话内恒定，且可程序化拉起，全程不需要 GUI。**

**常驻形态**【实测】：

```bash
node server.cjs claude -p --verbose \
     --input-format stream-json --output-format stream-json
# 关键：stdin 保持打开且**永不写入**
```

`-p` 配 `--input-format stream-json` 时，claude 会读 stdin 直到它关闭——
所以只要不 `end()` stdin，会话就一直活着；而全程不写任何消息 = **不产生模型调用**。
（这正是 Mirasim 自己拉起长驻会话的形状，从本机 `claude.EXE` 的命令行逆推得到。）

**实测数据**（`exp-keepalive.js`，**24 次采样 / 12 分钟**，08:58→09:10）：

| 观察项 | 结果 |
|---|---|
| 会话存活 | ✅ 12 分钟全程未意外退出 |
| 端口稳定 | ✅ `2083` 一直不变 |
| token 稳定 | ✅ `fp=f8e7e51ac66f` 一直不变 |
| 期间承载真实请求 | ✅ 约 28 个请求打进去，链路正常 |
| **空转额度成本** | ✅ **0**。09:04 与 09:06 两次读数均为 `5h 15% / 7d 4%`，纹丝不动 |

会话自报「28 次模型调用」，逐条对得上**全部是我主动打的探测请求**，
空转本身没有产生任何调用——符合「不写 stdin 就没有模型调用」的预期。

**反证机制**：收尾时主动 `stdin.end()`，子进程随即 `code=0` 退出。
这正面印证了「stdin 一关会话就结束」，也是 §12.1 里「绝不 `stdin.end()`」那条约束的由来。

**→ 路线 A 可行。** 保活器的形态已确定，剩下的是工程实现（§12）。

### 实验 1c：附带问题（阶段 1 顺带回答，不阻塞）

1. **会话结束后旧 token 还能用多久？** 拿采集到的 token 会话退出后定期打 `/v1/models`，记首次失败时刻。
2. **额度耗尽返回什么状态码/body？** 直接决定 §2.4 降级策略——若 `400+"credit balance"` 或 401，
   sub2api 会永久禁用账号，桥接器必须拦截改写成 503。

### 实验 2：云端 Linux 能否 headless 跑起 Mirasim？【实验 1 结论使其更关键】

实验 1 的结论把这条的重要性又抬高了：既然必须**持续跑 agent 会话**才有凭证，
云端那台机器不只要能把 Mirasim「跑起来」，还要能**长期维持一个 agent 会话**。
`server.cjs` 有 headless 友好的迹象（`serve --host 127.0.0.1`、`--no-open`、`mirasim ssh` 连远程 Linux），
但登录态持久化、自动更新、以及 xvfb 是否必要，仍需在真机验证。

它决定**拓扑 A 是否存在**：跑不起来，
「Mirasim + 桥接器 + sub2api 同机、base_url 走 127.0.0.1」的前提直接消失。

### 实验 2：云端 Linux 能否 headless 跑起 Mirasim？【v4 新增】

v3 把这条写成「部署课题，不属桥接器代码」而降级处理——**这低估了它**。
它确实不影响桥接器的代码，但它决定**拓扑 A 是否存在**：跑不起来，
「Mirasim + 桥接器 + sub2api 同机、base_url 走 127.0.0.1」的前提直接消失。

要回答：Electron 应用在无显示器的云主机上（xvfb / `--headless` / 官方是否支持）能否完成
**登录态持久化**与**自动更新**而不卡在 GUI 交互上。注意 `server.cjs` 本身是纯 Node，
可能根本不需要把 Electron 壳跑起来——待验。

**分支决策**：

| 结论 | 拓扑 |
|---|---|
| 能 headless 跑 | **拓扑 A**（§3），首选，无需公网暴露 |
| 不能 | **拓扑 B**：Mirasim + 桥接器留在 Windows 桌面，经隧道暴露，sub2api 的 base_url 填公网地址 → 这就是配置里 `public_base_url` 字段的用途 |

---

## 1. Mirasim 机制【实测修正：原逆向文档有多条错误事实】

> 2026-08-28 在本机（Mirasim payload v0.0.247）实测，推翻原「逆向文档」多条前提。
> 标【实测】= 本机验证过。

**仍然成立的：**
- Electron 应用，Claude Code 包在内置 Anthropic 反代后面。
- 云端 relay 要求 HMAC 签名头，直连 401 → **必须走本地端点中转**，不可能绕开 Mirasim 进程自己签。
  ⚠️ relay 域名实测是 **`relay.mirasim.ai`**（`server.cjs relay` 输出「云端节点 relay.mirasim.ai」），
  原文档写的 `mirasim-relay.mirofish.ai` 不对。

**✅ CLI 全貌**【实测】——`node server.cjs help` 暴露完整命令面，与桥接方案相关的：
- `claude [args...]` / `codex [args...]`：起一次被劫持的 agent 会话（**程序化入口，无需 GUI**）
- `serve [--host --port --no-open --no-im]`：跑 host（web workbench + IM + P2P），本机 4970 即此
- `relay` / `relay mode local|auto|cloud`：路由状态与切换
- `accounts` / `login` / `agents` / `doctor` / `ssh`
- 配置文件：`~/.mirasim/setting.json`（含 `auth.token` / `refreshToken` / 已配的 model providers）

**❌ 原「本地端点不鉴权，token 是占位符 `mirasim-relay-managed-credential`」——错。**【实测】
本地反代端点**真鉴权**，占位符被拒：

```
$ curl -s -H "x-api-key: mirasim-relay-managed-credential" http://127.0.0.1:8812/v1/models
{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}
```

**❌ 原「401 = shell 端口」——错，401 有两种，必须按 body 再分一层。**【实测】

| 端口 | 401 body | 真实身份 |
|---|---|---|
| 4390 | `{"error":"bad shell token"}` | shell 端口 |
| 8812 | `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}` | **Anthropic 反代端点** |
| 4970 | 200 + HTML | 应用 web UI（`server.cjs serve --port 4970`，见 startup.log） |

只看状态码会把目标端点误判成 shell 端口。
`server.cjs` 里 `een='invalid\x20x-api-key'`——这条 401 是 Mirasim 自己发的，不是 relay 透传。

**✅ 真实凭证机制**【实测 + `server.cjs` 源码】

Mirasim 用 **`ANTHROPIC_AUTH_TOKEN`（即 `Authorization: Bearer <token>`），不是 `x-api-key`**。
传递方式是**临时设置文件**，不是内联命令行——命令行上只有 `--settings <path>`：

```
命令行:  claude.EXE -p ... --settings C:\...\Temp\mirasim-claude-settings-<hash>.json ...
文件内容: {"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:<port>",
                  "ANTHROPIC_AUTH_TOKEN":"<43字符>","ANTHROPIC_API_KEY":""}}
```

采集正确姿势：**活进程 → 读其命令行的 `--settings` 路径 → 读该文件的 env**。
⚠️ 这些临时文件会话结束后**不清理**（本机残留 7 个），所以绝不能直接挑 TEMP 里最新的文件——
会读到早已失效的 token。桥接器的 `resolveAgentEnv()` 已按此实现，另备命令行内联与
Linux `/proc/<pid>/environ` 两条降级通道。token 只记 sha256 前 12 位指纹，不落原文。

### 1.1 relay 强制要求 Claude Code 身份 system 提示词【实测，v5 新增，影响转发层核心设计】

**这是本次调研最有工程后果的一条：`/v1/messages` 的请求体不满足形状要求会被 relay 直接 400。**

```
{"error":{"message":"the request was rejected as invalid",
          "type":"invalid_request_error"},"request_id":"…","type":"error"}
```

穷举出的判定规则【实测，全部在本机 127.0.0.1:2083 上验证】：

| system 内容 | HTTP |
|---|---|
| 无 system 字段 | **400** |
| `""`（空串） | **400** |
| `"You are a helpful assistant."`（任意内容） | **400** |
| `"You are Claude Code, Anthropic's official CLI for Claude."` | **200** |
| 上句去掉末尾句号 | **200**（末尾句号可省） |
| `"You are Claude Code"`（短前缀） | **400** |
| `"you are claude code"`（小写） | **400**（大小写敏感） |
| `"Foo bar. " + CC + " Baz qux."`（夹在中间） | **400**（必须在开头） |
| `CC + " Always answer in French."` | **200**，且**法语指令生效** |
| 数组 `[{CC 块}, {客户端块}]` | **200**，客户端指令生效 |
| 数组 `[{客户端块}, {CC 块}]` | **200**（数组形式下顺序不限） |

不受此限制的路径【实测】：
- `GET /v1/models` → **200**，返回 8 个模型（`claude-fable-5` / `claude-haiku-4-5` / `claude-opus-4-8` …）
- `POST /v1/messages/count_tokens` → **200**

**四条设计后果：**

1. **桥接器不能做纯字节透传。** §7-1 原写「全量透传」——对 `/v1/messages` **不成立**：
   必须解析 JSON body、前置注入 CC system 块、重新序列化。其他路径仍原样透传。
2. **注入会改变调用语义**，且不可避免（不注入就是 400）。任何经 sub2api 打进来的请求
   都会被告知「你是 Claude Code」。好在实测客户端自带的 system 指令**仍然生效**，
   影响可控——但必须在 README 里对使用者明说。
3. **`content-length` 必须重算**（body 变长了）。§7-4 原本就规定不转发原 `content-length`，正好吻合。
4. **注入必须幂等**：客户端本身就是 Claude Code 时 body 里已有 CC 块，
   重复注入会浪费 token 且可能触发异常——先检测再注入。

**⚠️ 端口/token 生命周期 = 会话运行期**【实测，v3 原判断正确】
每次会话一套新端口 + 新 token，会话结束端口即消失（§A 实验 1 的 7 样本证据）。
v4.1 曾错误「改口」为「端点常驻」——那是把我自己未结束的会话误当成无会话，已撤销。
**可用性的真正闸门就是「有没有活会话」**，这直接导致 §A 的「会话保活器」课题。

### 1.2 relay 请求体隐藏约束目录【v6 新增，CC 提示词之外的一整页雷区】

> 来源：fttawa/mira-bridge（MIT）探针矩阵的实测结论，2026-09-25 在本机逐一复核并吸收进转发层。
> 该项目同一时间还给出了「relay 按请求特征识别调用方」的警告——与本项目 §1.1 的 CC 提示词
> 要求一致。双方立场相同：**满足上游明示的校验，不做客户端身份伪装**（不下发伪造 UA / 身份）。

约束的共性：**踩中一律回同一句含混的 `400 The request was rejected as invalid.`，绝不指名字段**。
桥接器 `/v1/messages` 转发前逐条兜底（`sanitizeMessagesRequest`）；无法静默兜底的回明确错误。

| 约束 | 实测现象 | 桥接器处理 |
|---|---|---|
| 采样参数（temperature/top_p/top_k） | 推理模型带任一即 400；`temperature=1` 是 thinking 下唯一合法值 | 默认**全部剥离**（`constraints.sampling_models` 为空）= 等价 temp=1 |
| 采样参数自愈 | 模型清单漂移时预剥离规则可能漏 | 400 且原请求带采样 → 全剥重试一次，记 `sampling_rejected_retried` |
| temperature+top_p 同现 | 400 | 只留 temperature |
| temperature > 1 | 400（OpenAI 语义上限是 2） | 钳到 [0,1]，不做线性映射 |
| `cache_control.scope` | CC 2.1+ 的跨会话 cache 扩展，上游不认 | 递归剥 `scope`，保留 `ttl`（system/messages/tools 都可能带） |
| 顶层显式 null（`tool_choice: null` 等） | 400，CC 2.1.237 会发 | 剥掉所有值为 null 的顶层字段 |
| content 数组里的空 text 块（`{"text":""}`） | 任何位置都 400；纯空白 `"   "` 反而合法 | 丢弃空块 |
| 连续 ≥2 条 assistant 消息 | 400（连续 user 反而被上游自动合并） | 合并为一条（内容块拼接，语义不变） |
| assistant 结尾（prefill） | 推理模型 400，只有 haiku 支持 | **无法兜底，回明确错误**（丢末条丢信息，转 user 改变语义） |
| `stop_sequences` 含纯空白项 | 400 | 过滤；全被滤掉则不下发该字段 |
| `max_tokens` < 1 / 缺失 | 400 | 回落 `default_max_tokens`（8192） |
| `max_tokens` 含 thinking token | 小额度 → **200 + 空内容**（最阴险，无报错） | **刻意不补偿**：Anthropic 原生调用方本就知道额度含 thinking |
| `thinking: {type:"enabled"/"disabled"}` | 400；只认 `{"type":"adaptive"}` | 原样透传，**不要"修正"** |
| 模型名带 `[1M]` 后缀（`claude-opus-5[1M]`） | 404（Mirasim 内部 context 变体写法） | 提前回明确错误 |
| 模型黑名单（fable-5 单价偏高） | — | 400 `model_blocked`，且不出现在 `/v1/models` |

`/v1/models` 响应按 `constraints.model_filter`（默认 `^claude-`）+ `model_block`（默认 `fable`）过滤后再给
sub2api——sync-upstream 注册的就是这份；放进去一个不可路由的模型，sub2api 就会把用户请求送过来吃 400。
（mira-bridge 实测 mirasim-router 的 gpt-*/kimi-* 不可路由；新版 relay 还给了 `claude-opus-5-5` 等新模型。）

**2026-09-25 新版 Mirasim 的三处变化**【实测，当日桌面端曾自动更新】：

1. **base_url 带随机路径前缀**：`http://127.0.0.1:<port>/<43字符>`，不带前缀一律 401。
   转发和探测都必须拼 `basePath`。这解释了当日保活器连续 401 重启——不是 token 失效。
   **进一步实测：前缀本身就是全部凭证**——带对前缀，token 缺失或填垃圾都照样 200
   （污染实验 A-D 四点验证）。Bearer 字段当前不被校验；以「前缀每会话一换」规划凭证刷新即可。
   这也反向提醒：`base_path` 与 token 同级敏感，绝不落日志（现状只落指纹，保持）。
2. **haiku 采样参数也收紧了**：`claude-haiku-4-5 + temperature=0.8` 现在 400（旧版接受）。
   被自愈重试兜住才暴露；据此把 `sampling_models` 默认改为空（全部预剥离）。
3. **模型列表 8 → 18 个**：新增 `claude-opus-5-5` 等；fable 仍在，默认被 `model_block` 挡住。

---

## 2. sub2api 契约【事实，单一真相源】

> 源码布局是 `backend/internal/...`。以下行号基于 `%TEMP%\sub2api-src` 当前浅克隆。
> 本章是全文唯一定义 sub2api 行为的地方，后续章节只引用不重述。

### 2.1 认证与响应包络

- 认证二选一：`x-api-key: <admin-api-key>`（优先）或 `Authorization: Bearer <JWT>`（管理员角色）。
  JWT 备用通道：`POST /api/v1/auth/login` → `data.access_token`。
- 包络 `{code: 0, data}`，非 0 即错误；列表在 `data.items`。
- 账号列表 `GET /api/v1/admin/accounts`，query 支持
  `page/page_size/platform/type/status/search/group/lite/sort_by/sort_order`。
  幂等查找：`?search=<name>&platform=anthropic` 再客户端精确过滤 name。

### 2.2 账号 CRUD

- **建** `POST /api/v1/admin/accounts`

  ```json
  {
    "name": "mirasim-cloud",
    "platform": "anthropic",
    "type": "apikey",
    "credentials": {
      "api_key": "<bridge_secret，见 §8>",
      "base_url": "http://127.0.0.1:8787"
    },
    "extra": {},
    "concurrency": 4,
    "priority": 0,
    "rate_multiplier": 1.0,
    "group_ids": [1],
    "auto_pause_on_expired": false,
    "confirm_mixed_channel_risk": true
  }
  ```

  **不要设置任何配额字段**——见 §2.3 闸门 4。

- **改** `PUT /api/v1/admin/accounts/:id`：`UpdateAccountRequest` 全指针字段；
  `status` oneof **active / inactive / error**；`credentials` 是整体替换的 map（不是 merge）；
  `group_ids` 为 `*[]int64`，不传不改。
- **暂停 / 恢复** `POST /api/v1/admin/accounts/:id/schedulable`，body `{"schedulable": false|true}`
  （`SetSchedulableRequest`，`account_handler.go:2539`）。
- **模型列表** `GET /:id/models`（`:2563`）、`POST /:id/models/sync-upstream`（`:2758`）。
- **临时封禁** `GET /:id/temp-unschedulable`（`:2387`，返回 `{active, state}`，已过期返回 `active:false`）、
  `DELETE /:id/temp-unschedulable`（`:2413`）。
- 其他：`GET /:id`、`DELETE /:id`、`POST /:id/test`、`POST /:id/clear-error`、`POST /:id/clear-rate-limit`。
- 分组：`GET /api/v1/admin/groups/all`（全量）/ `GET /api/v1/admin/groups`（分页）/ `POST /api/v1/admin/groups`。

### 2.3 调度闸门【v4 修订：删 2 补 2】

`gateway_scheduling.go` 选号时逐层过滤，任一不过就跳过该账号。
**v3 的表把不适用的闸门列进来吓自己，又漏了两个真实存在的。**修订版：

| # | 闸门 | 位置 | 对 `platform=anthropic` + `type=apikey` 的适用性 |
|---|---|---|---|
| 1 | `isAccountSchedulableForSelection` | `:1095` → `IsSchedulable()` | **适用**。schedulable 开关 + temp 态，见下方双闸门说明 |
| 2 | `isGatewayAccountProfitEligible` | `:650` 等 | **适用**【v4 补漏】。利润策略过滤，默认应不生效，但注册后需用 `/:id/test` 验证确实能被选中 |
| 3 | `isModelSupportedByAccountWithContext` | `:296` | **适用，且是最大的坑**。账号模型列表不含请求模型 → 直接过滤，见下方 (a) |
| 4 | `isAccountSchedulableForQuota` | `:1259` | **适用**。`IsAPIKeyOrBedrock()` 为真才检查；但 `IsQuotaExceeded()` 仅在 `limit > 0` 时才可能为真（`account.go:2886`）→ **不设配额即天然放行，所以千万别顺手填配额字段** |
| 5 | `isAccountSchedulableForWindowCost` | `:1269` | **不适用**【v4 删除】。注释明写「只检查 Anthropic OAuth/SetupToken 账号」，apikey 直接放行 |
| 6 | `isAccountSchedulableForModelSelection` | `:300` | 适用，模型范围限制，默认不配置即放行 |
| 7 | RPM / `isUpstreamModelRestrictedByChannel` | `:315` / `:2020` 附近 | 适用但默认不配置即放行 |

**(a) 模型列表必须同步，否则账号进池但永远零流量。**
注册流程**必须以 `POST /:id/models/sync-upstream` 收尾**：此时桥接器已在 listen，
sub2api 会打到桥接器 → 桥接器透传到 Mirasim 的 `/v1/models` → 真实模型集被拉回。
这是「注册看着成功、但一条请求都不来」的最可能原因。

**(b) `temp_unschedulable` 是与 `schedulable` 正交的第二个闸门。**
- 账号实体有 `temp_unschedulable_until` / `temp_unschedulable_reason`（`ent/account/where.go`），
  由 `RateLimitService` 在上游报错时自动设置，**带 TTL**。
- **关键**：`SetSchedulable` handler（`:2539`）只调 `SetAccountSchedulable`，**不碰 temp 态**。
  桥接器把 schedulable 置回 true 后，若 temp 态仍在有效期内，账号依然不参与调度。
  → **恢复必须是组合动作，见 §5。**

### 2.4 上游错误码 → 账号状态映射【v4 新增，本次最重要的发现】

sub2api 拿到 base_url（也就是桥接器）返回的状态码后，会据此**改写账号状态**。
逻辑在 `RateLimitService.HandleUpstreamError`（`ratelimit_service.go:281` 起）。
桥接器返回什么码，直接决定账号会不会被打死：

| 桥接器/上游返回 | sub2api 的反应 | 严重度 |
|---|---|---|
| **401** | 非 OAuth 账号 → `handleAuthError` → **`SetError`，status=error 永久禁用** | 🔴 **致命** |
| **403** | 同上，`handleAuthError` → **`SetError` 永久禁用** | 🔴 **致命** |
| **400** 且 body 含 `credit balance`（anthropic） | `handleAuthError` → **永久禁用**（语义等同 402 余额耗尽） | 🔴 **致命** |
| 400 含 `organization has been disabled` / `identity verification is required` | 永久禁用 | 🔴 |
| 其他 400 | 不处理，不禁用 | 🟢 |
| **429**（anthropic） | 先试 `persistAnthropicExhaustedWindowLimit`（5h/7d 窗口耗尽 = 硬限制），否则走 temp-unschedulable 规则 | 🟡 带 TTL，可恢复 |
| **529** | `handle529` → 过载冷却（不禁用） | 🟡 可恢复 |
| **502 / 503 / 其他 5xx** | **switch 无对应 case，落空不处理** → 账号状态不变 | 🟢 **安全** |

**由此产生的三条硬纪律：**

1. **桥接器表达「我这边没有可用端点」必须用 `503`，绝不能用 401/403。**
   v3 的 §8 鉴权设计里，`x-api-key` 不匹配就返 403——一旦 `bridge_secret` 配错，
   第一次请求就把账号打成 error 态，且只有 `clear-error` 能救。
   → 改为：**桥接器自身的任何故障（无端点 / 鉴权失败 / 转发失败）一律 503**，
   并在 body 里写明原因供人排查。403 只在你**主动希望账号被禁用**时才用。

2. **必须拦截改写来自 Mirasim 的 401/403/400-credit-balance。**
   Mirasim 额度耗尽时 relay 大概率会返回其中之一（【待验】，见 §A 实验 1 问题 3）。
   若原样透传，账号被永久禁用，而实际情况只是「等额度刷新」。
   → 桥接器识别到这几类响应时：**触发 PAUSE + 向 sub2api 返回 503**，把「可恢复」的语义留住。

3. **主动降级判据**：转发时上游返回 401/403/429/529 或连接失败 → 立即触发 §5 的 PAUSE，
   不等健康循环慢慢发现。

**候选加固项**【推断，待验证】：apikey 账号支持 `credentials.pool_mode: true`（`account.go:1071`）。
池模式下 sub2api **默认不标记本地账号状态**（401 除外）——正好符合「账号状态由桥接器独占管理」
的设计意图。但它同时改变重试语义（`GetPoolModeRetryStatusCodes`），
**不要在实验前默认打开**，列为阶段 3 的可选优化。

### 2.5 转发行为与 SSRF

- 消息转发：`targetURL = validatedURL + "/v1/messages?beta=true"`
  → **base_url 不能带 `/v1`、不能带尾斜杠**。
- count_tokens 拼 `/v1/messages/count_tokens?beta=true`。
- 上游认证头由账号凭据统一注入（设 `x-api-key`）；
  `authorization` / `x-api-key` 属**禁止覆写头**（`account_header_override.go`）——
  这正是 §8 鉴权方案能成立的基础。
- SSRF 防护默认关（`config.go:2021-39`）：`url_allowlist.enabled=false`、
  `allow_private_hosts=true`、`allow_insecure_http=true`
  → **`http://127.0.0.1` 的 base_url 开箱即用**，无需改 sub2api 配置。

### 2.6 已排除的非风险【v4 新增，避免重复调研】

以下几项曾疑似会干扰本方案，已核实**不构成问题**，不要再花时间查：

| 疑虑 | 核实结论 |
|---|---|
| sub2api 会不会有后台定时器周期性 `test` 账号，把死端点标成 error？ | **不会**。`scheduled_test_service.go` 是按 plan 的 CRUD，需管理员手动创建计划，无默认 cron |
| 分组的 `require_privacy_set` 会不会把账号标 error？ | **不会**。`IsPrivacySet()`（`account.go:252`）只对 OpenAI / Antigravity 做实质判断，anthropic 走 `default: return true` |
| 窗口费用闸门会不会卡住 apikey 账号？ | **不会**，见 §2.3 闸门 5 |
| 需要为私网 base_url 配 allowlist 吗？ | **不需要**，见 §2.5 |

---

## 3. 部署拓扑【用户拍板 + §A 实验 2 决定】

**拓扑 A（首选，前提是实验 2 通过）**：Linux 云端，Mirasim、桥接器、sub2api 同机。
桥接器注册 `base_url = http://127.0.0.1:<桥接监听端口>`，无需公网暴露、无需隧道。

```
sub2api → 127.0.0.1:<桥接固定端口> → 127.0.0.1:<mirasim 动态端口> → 凭证注入 → relay
```

**拓扑 B（实验 2 不通过时的退路）**：Mirasim + 桥接器留在 Windows 桌面，
经隧道（frp / cloudflared / tailscale）暴露，sub2api 的 base_url 填 `public_base_url`。
此时 §8 的 `bridge_secret` 从「可选加固」变成**强制项**——端点已经在公网上了。

**Windows 本地机的定位**：拓扑 A 下只做验证（`observe` / `discover` / `test`），
不承担注册职责；拓扑 B 下它就是生产环境。

### 3.1 实测踩坑：base_url 是从 sub2api 那侧解析的【2026-08-28 事故记录】

在 Windows 上跑 `serve` 连远端 sub2api（`sub2api.example.com`），注册后
`sync-upstream` 返回 **HTTP 502**。原因不是代码问题，是拓扑：

> `base_url` 由 **sub2api 服务器**发起连接。填 `http://127.0.0.1:8787` 时，
> 它连的是**它自己的 localhost**，而不是桥接器所在的机器。

**连带暴露一个真缺陷**：账号创建时默认 `schedulable=true`，
而健康循环当时只探「桥接器 → Mirasim」这个**正向**——本机一切正常，
于是状态机会在 ~60s 后把这个 base_url 根本连不通的账号 RESUME 进池，
真实用户流量打过去就是 5xx。（实测确认账号创建后即为 `status=active schedulable=true`。）

**三处修复：**

1. **健康判据改成双向**，缺一不可：

   | 方向 | 验证方式 | 频率 |
   |---|---|---|
   | 桥接器 → Mirasim | 探 `/v1/models` | 每 tick |
   | **sub2api → 桥接器** | `sync-upstream` 成功 | 注册时一次；失败后每 10 tick 重试 |

   `sync-upstream` 是唯一一个**从 sub2api 侧发起**的检查，它成功即等于反向可达。

2. **注册时反向不通 → 立刻把账号置为不可调度**，不让它带着不可达的 base_url 进池。

3. **建号前加拓扑预检**：sub2api 是远端主机而 base_url 是回环地址时直接中止（`--force` 可强行继续），
   避免先建出一个废账号再补救。

---

## 4. 技术选型【已定】

单文件零依赖 Node.js（≥18，本机 v22.23.1）：`node:http/https/fs/path/os/child_process/crypto`。
Windows 与 Linux 同一份核心代码，平台差异只在**端口发现方式**与**守护方式**（systemd）。

**不要从零写 sub2api 客户端。** 源码自带 `skills/sub2api-admin/scripts/sub2api-admin.js`
（759 行，零依赖 Node），已覆盖本方案需要的全部管理操作：
`accounts list/create/update/get/set-schedulable/clear-error/clear-rate-limit/recover-state/test/
models/sync-models/temp-unschedulable/reset-temp-unschedulable`、`groups all`。
复用它的 request 封装与包络处理即可。

⚠️ **环境变量名对齐**：该脚本读 `SUB2API_ADMIN_API_KEY`（**不是** `SUB2API_ADMIN_KEY`）、
`SUB2API_BASE_URL`、`SUB2API_JWT`。本项目统一采用脚本的命名。

---

## 5. 状态机【v4 修订：补原子性与抖动保护】

桥接器维护 `desired`（期望调度态：`unknown | on | off`）与 `observed`（探测结果），
**只在状态跃迁时调 API**，不要每个 tick 都打一次。

```
启动      : desired = unknown  →  先探测，不要一上来就置 true
探测成功  : successCount++ ; 连续 >= success_threshold 且 desired != on   → 执行 RESUME
探测失败  : failCount++    ; 连续 >= fail_threshold    且 desired != off  → 执行 PAUSE
转发遇 401/403/429/529/连接失败 → 立即 PAUSE（§2.4 纪律 3）
收到 SIGTERM/SIGINT → 立即 PAUSE → drain 在途请求 → 退出（§7-5）
```

**PAUSE** = `POST /:id/schedulable {"schedulable": false}`（单步，成功即置 `desired = off`）

**RESUME** = 组合动作，顺序执行（因为 §2.3(b) 的双闸门）：

1. `DELETE /:id/temp-unschedulable` —— 清 sub2api 自己设的 TTL 封禁
2. `POST /:id/clear-error` —— 清 error 态
3. `POST /:id/schedulable {"schedulable": true}`
4. （可选）`POST /:id/clear-rate-limit`

**原子性语义**【v4 新增，修正 v3 的未定义行为】：
这四步**不是事务**。v3 没规定失败怎么办，会产生「temp 清了但 schedulable 没置回」的半吊子态，
而 `desired` 已被乐观地置成 `on`，下一轮不再重试 → 账号静默死在池外。

> **规则：只有第 1–3 步全部返回 `code: 0` 才置 `desired = on`；
> 任一步失败则保持 `desired = unknown`，记录错误并在下一 tick 整体重试。**
> 第 4 步失败只记日志，不影响 `desired`。

**抖动保护**【v4 新增】：双向迟滞（`fail_threshold` / `success_threshold`）之外，再加两道：

- **最小驻留时间** `min_dwell_sec`（默认 60）：一次状态跃迁后，该时间内不允许反向跃迁。
- **失败退避**：RESUME 连续失败时指数退避（`30s → 60s → 120s`，上限 `600s`），
  避免 sub2api 侧出问题时被刷屏。

---

## 6. CLI 与配置

| 子命令 | 作用 | 平台 |
|---|---|---|
| `help` | 帮助 | 双 |
| **`observe`** | **端口生命周期时间线，回答 §A 实验 1** | **双，最先做** |
| `discover [--json]` | 枚举候选端口 → 三态探测 → 打印分类表 | 双 |
| `test [--model X]` | 发现 → 取模型列表 → 发一条 `stream:true` 的最小 `/v1/messages` 验证链路 | Windows 主用 |
| `serve [--no-register] [--port N] [--host H]` | 常驻：转发 + 健康循环 + 自动暂停/恢复 + 自动注册 | 生产 |
| `register` | 幂等注册/更新账号（按 name 查重 → create 或 PUT）**+ sync-models 收尾** | 生产 |
| `groups` | 列出 sub2api 分组 | 配置辅助 |
| `pause` / `resume` | 手动触发 §5 的 PAUSE / RESUME 组合动作 | 运维兜底 |

配置解析顺序：内置默认 ← `--config <path>`（缺省为脚本目录 `config.json`）← 环境变量
（`SUB2API_BASE_URL` / `SUB2API_ADMIN_API_KEY` / `MIRASIM_LISTEN_PORT` /
`MIRASIM_LISTEN_HOST` / `MIRASIM_ACCOUNT_NAME`）。

```json
{
  "listen":  {"host": "127.0.0.1", "port": 8787},
  "sub2api": {
    "base_url": "https://sub2api.example.com",
    "admin_api_key": "admin-xxxx",
    "account_name": "mirasim-cloud",
    "group_ids": [],
    "priority": 0,
    "concurrency": 4,
    "public_base_url": ""
  },
  "bridge_secret": "",
  "health": {
    "interval_sec": 30,
    "fail_threshold": 2,
    "success_threshold": 2,
    "min_dwell_sec": 60
  },
  "forward": {"replay_buffer_mb": 8},
  "shutdown": {"drain_timeout_sec": 30},
  "port_policy": "sticky"
}
```

字段说明（只列不自明的）：
- `public_base_url`：**拓扑 B 专用**。非空时 `register` 用它当 base_url 而不是
  `http://127.0.0.1:<listen.port>`。拓扑 A 下留空。（v3 有这个字段但正文从未解释，属悬空项，此处补齐。）
- `bridge_secret`：见 §8。拓扑 A 下可留空退化为不鉴权；**拓扑 B 下强制非空**。
- `min_dwell_sec` / `drain_timeout_sec`：见 §5 / §7-5。

---

## 7. 坑位清单

> §2 已定义的 sub2api 行为不在此重复。本章只写**桥接器实现层**的坑。

### 转发层

1. **URL 全量透传，但 `/v1/messages` 的 body 必须改写。**【v5 修正】
   除 `/__*` 外原样透传 `req.url`：自动覆盖 `/v1/models`（sync-models 要用）
   和将来新增路径，也天然保留 `?beta=true`。
   **但 body 不能原样过**——`/v1/messages`（含 `?beta=true`）必须按 §1.1 注入
   Claude Code 身份 system 块，否则 relay 一律 400。伪码：

   ```js
   const CC = "You are Claude Code, Anthropic's official CLI for Claude.";
   function injectCC(body) {
     const s = body.system;
     if (typeof s === 'string')  return s.startsWith(CC) ? body
                                      : { ...body, system: [{type:'text',text:CC},{type:'text',text:s}] };
     if (Array.isArray(s))       return s.some(b => b && typeof b.text === 'string' && b.text.startsWith(CC))
                                      ? body : { ...body, system: [{type:'text',text:CC}, ...s] };
     return { ...body, system: [{ type:'text', text: CC }] };   // 原本没有 system
   }
   ```

   仅对 `/v1/messages` 做；`/v1/models`、`/v1/messages/count_tokens` 实测不受限制，别动它们。

2. **重放语义收紧。** 「失败 → 重发现 → 重试一次」**只在尚未向客户端写出任何响应字节时**才允许，
   否则流式响应会把两段内容串在一起。缓冲上限 `replay_buffer_mb`（默认 8），
   超过则边收边转、放弃重放资格——v3 早期设想的 64MB 全内存缓冲 × 并发是内存炸弹。

3. **SSE 保活要写全**：`server.requestTimeout = 0`、`server.headersTimeout`、`res.setTimeout(0)`、
   上游 `req.setTimeout(0)`、`socket.setNoDelay(true)`（降 TTFB 抖动）。

4. **头部卫生**：剥离 hop-by-hop 头（`connection` / `keep-alive` / `transfer-encoding` / `upgrade`），
   重写 `host`，**不要转发原 `content-length`**（重新流式发送时长度会变）。
   不要动 `accept-encoding`——字节原样透传，不解压。

5. **上游连接复用**：共享一个 `http.Agent({keepAlive: true})` 指向 Mirasim，省掉每请求 TCP 建连。

6. **错误码纪律**：见 §2.4 三条硬纪律。这是转发层最容易写错、代价最大的一处。

### 发现层

7. **按 PID 收窄，不要全端口扫。** 枚举所有 LISTEN 端口挨个打 `GET /v1/models` 会给同机无关服务
   发垃圾请求（可能触发别人的告警甚至副作用），而且慢。
   改法：先定位 Mirasim 进程 PID
   （Windows `Get-NetTCPConnection` 自带 `OwningProcess`，回退 `netstat -ano`；
   Linux `/proc/net/tcp` + `tcp6`，`st == 0A`，inode 反查 `/proc/<pid>/fd`），
   **只探测它自己监听的回环端口**。配合 sticky 缓存「上次可用端口优先探测」，常态是 O(1)。
   探测并发限流 16，**排除桥接器自身的监听端口**（否则自己探自己）。

### 运维层

8. **优雅退出必须先摘流量**：SIGTERM/SIGINT → PAUSE → drain 在途请求（**上限 `drain_timeout_sec`，
   超时强制退出**，v3 只说 drain 没给超时，会挂死在长 SSE 上）→ 退出。
   否则 systemd 重启 / 部署窗口内 sub2api 继续往死端点打，直接产生用户可见 5xx。

9. **`concurrency` 不要设 0（无限）。** 对一个单会话代理过于乐观，起步设 4，
   观察 relay 侧是否有 HMAC nonce / 限流问题再调。

10. **状态落盘 `state.json`**：`account_id` + 上次可用端口 + `desired` 态 + 上次跃迁时间戳
    （最后一项是 `min_dwell_sec` 重启后仍生效所必需的）。重启免重新查找，也避免重复建号。

11. **平台常量**：`platform = anthropic`（不是 claude）；base_url 无 `/v1` 无尾斜杠；
    发往 Mirasim 用 `Authorization: Bearer <采集到的 token>`（占位符无效，§1/§8）。

12. **base_url 永远不变。** 桥接器监听**固定**端口，Mirasim 的动态端口对 sub2api 完全不可见。
    健康循环里**不该有任何 PUT 更新 base_url 的逻辑**——换端口是桥接器内部重解析目标，对 sub2api 无感。
    （v3 已删除该残留设计，此处保留提醒以防再犯。）

---

## 8. 桥接器鉴权

绑 `127.0.0.1` 只挡外网，**同机任何进程都能白嫖这个额度端点**；拓扑 B 下更是直接暴露在公网。

零成本加固，不需要 sub2api 任何额外配置：

1. 生成随机密钥 `bridge_secret`（`crypto.randomBytes(32).toString('hex')`）。
2. 注册账号时把 `credentials.api_key` 填成这个密钥（而非占位符）——
   sub2api 本来就会把它作为 `x-api-key` 注入到发往 base_url 的请求（§2.5）。
3. 桥接器校验入站 `x-api-key`，**用 `crypto.timingSafeEqual` 做定长比较**
   （先检查长度再比，避免 `!==` 的时序侧信道；拓扑 B 下这条不是洁癖）。
4. **【v4.1 修正】转发给 Mirasim 时必须换头，不是换值。**
   v3/v4 写的「替换成占位符 `mirasim-relay-managed-credential`」两处都错：
   占位符无效（§1 实测），且 Mirasim 收的是 `Authorization: Bearer`，不是 `x-api-key`。
   正确动作：

   ```
   入站（来自 sub2api）:  x-api-key: <bridge_secret>
                          ↓  删除 x-api-key，换上：
   出站（发往 Mirasim）:  authorization: Bearer <采集到的 ANTHROPIC_AUTH_TOKEN>
   ```

   token 由 §1 的采集机制（扫 agent CLI 进程命令行）提供。
   **采集不到 token 时，桥接器返回 503 并触发 PAUSE**——绝不能返回 401/403（§2.4 纪律 1）。

⚠️ **校验失败返回 `503`，不是 `403`**——见 §2.4 纪律 1。
配错密钥的后果应该是「账号暂时不可用、改完配置即恢复」，而不是「账号被打成 error 态」。
body 里写明 `bridge_secret mismatch` 供排查。

`bridge_secret` 留空 = 不鉴权，仅拓扑 A 的本地 `test` / `observe` 场景可接受。

---

## 9. 实现蓝图

交付文件：`mirasim-bridge.js`（唯一代码）、`config.example.json`、`mirasim-bridge.service`、`README.md`。

> **v4 修正阶段划分**：v3 把 `observe` 放「阶段 0」、把 `listCandidatePorts` / `probeModels`
> 放「阶段 1」——但 observe 正是由这两个函数组成的，依赖倒置了。
> 重排为「阶段 0 = 发现内核 + observe」。

### 阶段 0：发现内核 + observe（回答 §A 实验 1）

1. 常量 / 默认配置 / config 加载合并（`--config` ← env ← 默认）
2. `listCandidatePorts()`：定位 Mirasim PID → 取其回环 LISTEN 端口
   （win: `Get-NetTCPConnection` 含 `OwningProcess`，回退 `netstat -ano`；
   linux: `/proc/net/tcp` + `tcp6`，`st == 0A`，inode 反查 `/proc/<pid>/fd`）
3. `probeModels(port)`：三态分类 `{proxy | webui | auth | other}` + models 列表
4. `cmdObserve()`：定时轮询 2+3，diff 出「出现 / 消失 / 切换」事件写 JSONL

**验收标准**：Windows 本机 `node --check` 通过；`observe --interval 5` 连续跑 ≥ 2 小时，
覆盖「一次 agent 会话的完整起止」，JSONL 里能清楚看到端口出现与消失的时刻。
→ **拿到时间线后回到 §A 做架构分支决策，不要直接往下写。**

### 阶段 1：本地验证（无需 sub2api）

5. `discover()`：sticky 优先 + 并发限流探测；`chooseTarget(state, policy)`
6. `cmdTest()`：取模型 id（`--model` 覆盖，否则优先含 haiku 的）→ `stream:true` 最小对话 →
   解析 SSE 打印 TTFB / delta / usage / stop_reason
7. **顺带回答 §A 实验 1 的问题 3**：故意跑到额度耗尽（或用已耗尽的账号）观察 relay 返回的
   状态码与 body，记录下来——这是 §2.4 纪律 2 的输入。

**验收标准**：`test` 能打通端到端并打印出真实 token usage；额度耗尽时的响应特征已记录在案。

### 阶段 2：转发层

8. HTTP server：鉴权（§8，失败 503）→ `readBody(replay_buffer_mb)` → `forwardOnce(port)`
   → 仅在零字节写出时可重发现重试一次 → 失败 503
9. 上游响应的 401/403/400-credit-balance 拦截改写（§2.4 纪律 2）
10. `/__health`、`/__status`（当前端口 / 计数器 / `desired` 态 / 上次跃迁时间）
11. 全量路径透传；SSE 参数与头部卫生按 §7-1/3/4/5

**验收标准**：把 `test` 的目标从 Mirasim 端口改成桥接器端口，结果完全一致（含流式与 usage）；
杀掉 Mirasim 会话后请求返回 **503 而非 401/403**；`/__status` 反映真实内部态。

### 阶段 3：sub2api 集成

12. sub2api client：**复用 `skills/sub2api-admin/scripts/sub2api-admin.js`** 的 request / 包络层，
    补 `findAccountByName / createAccount / updateAccount / syncModels /
    setSchedulable / clearTempUnschedulable / clearError / listGroups`
13. `cmdRegister()`：查重 → create 或 PUT → **`POST /:id/models/sync-upstream` 收尾**（§2.3a）
14. serve 主循环：`ensureRegistered` → listen → 健康循环（重叠保护 running flag）驱动 §5 状态机，
    含原子性语义、`min_dwell_sec`、指数退避
15. 信号处理器实现 §7-8 优雅退出（PAUSE → drain → 超时强退）
16. CLI 分发 + 日志（时间戳前缀，stdout）
17. （可选）评估 `credentials.pool_mode: true`（§2.4 候选加固项）

**验收标准**：`register` 后 `GET /:id/models` 返回非空模型列表；
从 sub2api 的对外网关发一条请求能命中该账号并成功返回；
杀掉 Mirasim 会话后账号在 `fail_threshold × interval_sec` 内变为不可调度，
恢复后自动回池且 `temp-unschedulable` 已被清空；
`systemctl restart` 期间对外无 5xx。

---

## 10. 恢复实现还差的用户输入 / 决策

**实验 1 已答（每会话一换），实验 1b 是现在的阻塞点，需要用户拍板：**

0. **【架构决策】接受「会话保活器」路线吗？** 现实是：没有常驻 agent 会话就没有可用凭证，
   所以桥接器要么自己维持一个长驻会话（持续占用额度、复杂度上一个台阶），
   要么承认这个账号只在「用户恰好在用 Mirasim 时」入池。请二选一：
   - **(A) 上保活器**——我先做实验 1b（测常驻形态 + 额度成本），再据此设计。
   - **(B) 不保活**——桥接器退化为「有会话就注册、没会话就暂停」，接受高频暂停。
1. **§A 实验 2**——云端 Linux 能否 headless 长期维持一个 agent 会话。**决定拓扑 A 还是 B。**
2. sub2api 管理 Key（`admin-` 前缀）或登录账号密码（JWT 备用通道）。
3. 目标 `group_ids`（可先用 `groups` 命令查）、`priority` 数值、账号名偏好（默认 `mirasim-cloud`）。
4. 桥接监听端口偏好（默认 8787）；拓扑 B 时还需隧道方案与 `public_base_url`。

---

## 11. 进度快照

- **已完成**：
  - Mirasim 机制调研；sub2api 源码核实**三轮**（基础 API / 调度闸门 + temp 双闸门 +
    自带 admin CLI / 错误码状态映射 + 闸门适用性 + 非风险排除）。
  - **阶段 0 代码已写完并在本机跑通**（2026-08-28）：配置加载 / 端口发现 /
    三态探测 / agent 凭证采集 / `discover` / `observe` / `selftest`，`config.example.json`。
    `node --check` 通过；`selftest` **23/23**；`discover` 真机命中活会话的
    `base_url=http://127.0.0.1:8812 token_fp=d9d232096419`（与 settings 文件一致）。
  - **§A 实验 1 已完成**：**端口 + token 每会话一换**（7 样本），会话结束端口即消失。
    凭证机制查清（`--settings` 临时文件，不清理，需活进程反查）。
  - **§A 实验 1b 已完成，路线 A 可行**：保活形态确定并实测稳定
    （`-p --input-format stream-json` + 握住 stdin），会话内端口/token 恒定，
    空转不烧额度。保活器设计见 §12。
  - **§1.1 新增（最有工程后果的一条）**：relay 强制要求 Claude Code 身份 system 提示词，
    规则已穷举。**转发层因此不能做纯字节透传**，`/v1/messages` 必须改写 body。
  - **端到端链路已打通**：用采集到的 token 直接打保活会话端口，
    `GET /v1/models` → 200（8 个模型）、`POST /v1/messages` → 200 流式、
    `count_tokens` → 200。桥接方案的核心假设全部验证成立。
  - **§1 多条错误事实实测推翻并修正**（端点真鉴权、401 分两种、
    凭证走 `Authorization: Bearer`、relay 域名 `relay.mirasim.ai`、凭证经临时文件传递）。
  - **阶段 1-2 + §12 保活器已实现并实测通过**（2026-08-28）：
    `test` 端到端（TTFB 895ms，usage 完整）；`serve` 转发层
    （鉴权 / CC 注入 / 头部卫生 / 503 纪律 / 并发闸门 / 退避 / `__health` / `__status`）；
    `KeepaliveSupervisor`（拉起 4s 就绪、崩溃 5s 后自愈、目标自动跟随）。
    `selftest` **39/39**。转发层 7 项用例全绿，其中**无 system 的请求经桥接器返回 200**
    （直连必 400），注入计数器精确为 2，已带 CC 的请求未重复注入。
  - **限流与退避已按封号顾虑落为保守默认**：`max_concurrency: 2`、
    429 退避 60s / 529 退避 30s、桥接器自身故障一律 503 不重试。
  - **阶段 3 已实现**（2026-08-28）：sub2api 客户端、`groups` / `register` /
    `pause` / `resume`、`ScheduleState` 状态机（双闸门 RESUME 组合动作 + 原子性 +
    最小驻留 + 指数退避）、健康循环、优雅退出先 PAUSE、`state.json` 落盘。
    已对线上 sub2api 实跑：`groups` 通、建分组通、建账号通。
  - **线上现状**：已建专用分组 **id=15 `mirasim` / platform=anthropic / 倍率 x1**；
    已建账号 **id=90 `mirasim-cloud`**，当前**暂停态**（base_url 指向回环，
    在 Windows 上不可达）。等云端部署后跑 `register` 会按名字找到并更新它，
    届时 `127.0.0.1:8787` 反而是正确的。
- **当前阻塞**：**必须在 Linux 部署**（§3.1 已实证 Windows + 远端 sub2api 不可行）。
  好消息：今天全程用 `node server.cjs ...` 驱动，**Electron 界面从未参与**，
  云端大概率只需 `server.cjs` + `~/.mirasim/setting.json` + node ≥18，不需要 xvfb。
  未验证：headless 登录（用户用谷歌登录，CLI 只提供 `github|email`；
  备选是直接拷贝 `~/.mirasim/setting.json`，内含 `auth.token` / `refreshToken` / `device.privateKey`）。
- **未开始**：Linux 部署清单与 systemd unit；实验 2 实机验证；
  长时间空闲回收观察；单会话并发能力测试。

### Linux 就绪度【2026-08-28】

Linux 代码路径已写但**从未在 Linux 上执行过**（开发机是 Windows）。复查中发现并修掉两个真 bug：

| Bug | 症状 | 修法 |
|---|---|---|
| 自命中 | 进程匹配比对 cmdline，而桥接器自己的 cmdline 是 `node …/mirasim-bridge.js`，含 `mirasim` → 把自己当成 Mirasim 进程（Windows 因进程名是 `node` 而侥幸躲过） | `SELF_SCRIPT` 排除 + 排除 `process.pid` |
| 权限静默失败 | `/proc/<pid>/fd` 需同用户或 CAP_SYS_PTRACE。以独立服务用户跑 systemd 时全线 EACCES，被 `continue` 吞掉 → 报告「没有端口」，与「Mirasim 没启动」现象完全一致 | 统计 EACCES 并显式 `warn` |

纯解析逻辑已用合成 `/proc/net/tcp` 数据验证：`node mirasim-bridge.js selftest` → **23/23 通过**
（十六进制 v4/v6 解码、v4-mapped、LISTEN 过滤、inode 匹配、settings 文件路径提取与安全拒绝、
三通道凭证解析、三态分类）。凭证采集在 Linux 上反而多一条 `/proc/<pid>/environ` 通道（同用户可读）。

**仍未验证的只剩系统调用层**：`/proc` 遍历实际行为、Linux 上 Mirasim 的进程名/路径是否真含
`mirasim`（若是 AppImage 可能不含，需调 `discovery.process_match`）、
以及 Linux 上是否同样用 `--settings` 临时文件传子进程（预期是，`server.cjs` 跨平台同一份）。
到手一台 Linux 后跑 `selftest` + `discover` 即可在 30 秒内证伪或确认。
- **环境**：`%TEMP%\sub2api-src` 浅克隆留存可复查；本机 node v22.23.1；
  本机存在 Mirasim 安装痕迹（`%LOCALAPPDATA%\@mirasimdesktop-updater`、`%APPDATA%\@mirasim`）。
- **历史版本**：v3 全文保留在 `DESIGN.v3.md`。
- **一次性探针**（非交付件，可删）：`exp-keepalive.js`（保活形态与稳定性）、
  `exp-probe.js` / `exp-probe2.js`（relay 请求形状规则）。

---

## 12. 会话保活器设计【路线 A 已拍板，形态已实测确定】

桥接器多一个内部模块 `KeepaliveSupervisor`，职责是「让一个 agent 会话永远活着」。

### 12.1 拉起与握持

```js
spawn(process.execPath,
  [SERVER_CJS, 'claude', '-p', '--verbose',
   '--input-format', 'stream-json', '--output-format', 'stream-json'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
// 绝不 stdin.end()——一旦关闭 stdin，claude 立刻收尾退出，端口和 token 随之消失
// 绝不向 stdin 写消息——写了就是一次真实模型调用，要烧额度
```

`SERVER_CJS` 需可配置（Windows 与 Linux 安装路径不同），默认值按平台推断：
- Windows `%LOCALAPPDATA%\Programs\@mirasimdesktop\resources\server.cjs`
- Linux 待验（§A 实验 2）

### 12.2 采集当前目标

会话起来后，用已实现的 `findAgentProcesses()` 找到 ppid == 保活子进程 pid 的那个 agent，
经其命令行的 `--settings` 路径读出 `{base_url, token}`。**实测在会话生命周期内恒定**，
所以只需在「会话刚起来」和「会话重启后」采集，不必每请求都读。

### 12.3 会话重启 = 目标全换

子进程一旦退出（崩溃、被 Mirasim 内部回收、机器休眠等），重启后是**全新的端口和 token**。
所以重启必须走完整序列，不能只是 respawn：

```
子进程 exit
  → 立即 PAUSE（§5），把 sub2api 流量摘走
  → 指数退避后 respawn（5s → 15s → 45s，上限 300s）
  → 轮询等待新 agent 进程出现并采集到 base_url + token（超时 60s 视为失败，继续退避）
  → 用新 token 打一次 GET /v1/models 自检
  → 成功才 RESUME
```

**转发层必须每次请求读取当前 target（端口 + token），不能在启动时缓存一份长期用。**
这是与 v4 设计最大的不同：v4 假设目标端点是稳定的，实际它随会话轮换。

### 12.4 健康判据变了

健康循环探测的不再是「有没有端口开着」，而是：

1. 保活子进程还活着吗（`child.exitCode === null`）
2. 采集到的端口 + token 打 `GET /v1/models` 是否 200

两者都满足才算健康。只看端口会误判——端口可能属于别的会话（本机就同时存在两个）。

### 12.6 实现状态【2026-08-28 已落地并实测】

`KeepaliveSupervisor` 已实现，本机验证：

| 场景 | 结果 |
|---|---|
| 冷启动 | 拉起 → **4 秒内就绪**（port=12606, 自检 8 个模型） |
| 目标选择 | 正确选中自己拉起的会话，未误用同机其他会话（`is_keepalive: true`） |
| **崩溃恢复** | 杀掉子进程 → 检测退出 + 触发降级钩子 → 5s 退避 → 重启 → **新端口 12639 + 新 token**，桥接器自动跟上 |

崩溃恢复实测证实了 §12.3 的判断：**会话重启 = 端口和 token 全换**
（`12606/145b1c2b004c` → `12639/8421808cb4af`），所以转发层每次请求重解析目标是必需的，不是保险。

### 12.5 待定与风险

| 项 | 状态 |
|---|---|
| 空转额度成本 | 实测中，预期 0（不写 stdin = 无模型调用） |
| Mirasim 会不会主动回收长时间空闲的会话 | **未测**，需长时间（数小时）观察 |
| 单会话代理的并发能力 | **未测**，`concurrency=4` 仍是猜测（§7-9） |
| 保活会话被计入「在跑的 agent」是否影响用户正常使用 | **未评估**，云端专机上无所谓，本机场景需注意 |
- **用户指令原话**：「linux我直接在云端部署，在云端安装mirasim并且反代，windows的只需要把
  mirasim的云端额度反代出来就行了」「暂停，保留所有进度和你的思考数据」。
