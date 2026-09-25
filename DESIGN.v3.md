# mirasim → sub2api 桥接器：调研结论与设计 v3

> 状态：**设计已按第二轮源码核实修订，代码仍未动工**。
> 恢复时先做 §A「开工前必须先做的实验」，再按 §9 实现蓝图开写 `mirasim-bridge.js`。
> 标注：【事实】= 本地浅克隆源码逐行确认；【新核实】= v3 新增的源码确认项；
> 【推断】= 设计决策；【用户拍板】= 用户明确决定。
>
> **v2 → v3 变更摘要**：修正 3 个会导致方案不工作的缺陷（模型列表闸门、temp-unschedulable
> 双闸门、base_url 自相矛盾），补 3 项缺失能力（会话保活实验、优雅退出摘流量、桥接器鉴权），
> 并用源码自带的 admin 客户端替换掉原计划从零手写的 sub2api client。

## 0. 目标

把 Mirasim（Electron 应用）在 agent 会话期间动态创建的 Claude Code 反代端点，
桥接注册到自建 sub2api（`https://sub2api.example.com`），作为 `platform=anthropic` 的 apikey 账号入池；
端点消失自动暂停、恢复后自动启用。

---

## A. 开工前必须先做的实验【v3 新增，最高优先级】

**方案存亡点：Mirasim 端点生命周期 = agent 会话运行期（run 结束即 dispose）。**

v2 把这条写在 §1 当事实，却没有任何对策。但它直接决定方案是否成立：
如果端点只在会话跑的时候存在，那绝大多数时间账号都处于暂停态，池子里等于没有这个账号——
四个交付文件写完也没有价值。

因此**在写转发代码之前**，先回答两个问题：

1. **端点到底能活多久？** 会话结束后端口是立刻消失，还是有空闲保留期？应用最小化/待机时呢？
2. **能不能保活？** 是否存在一个常驻会话形态（例如一个长期不结束的 agent run），
   能让端点稳定存在；代价是什么（是否持续烧额度）。

**做法**：先只实现 `observe` 子命令（比 `serve` 简单得多，独立可用）：

| 子命令 | 作用 |
|---|---|
| `observe [--interval 5] [--out timeline.jsonl]` | 长时间轮询端口发现，把每次「端口出现/消失/切换」写成一行 JSONL 时间线 |

拿到时间线后再决定架构分支：
- **端点能长期存活** → 按本文档现有设计实现即可。
- **端点只在会话期存活** → 必须追加「会话保活器」模块（拉起并维持一个常驻 run），
  这是一个独立的设计课题，且需要重新评估额度成本，届时再补 v4。

在结论出来之前，不要写 `serve` 的健康循环——它的设计参数（interval、阈值、是否值得注册）
全部取决于这个答案。

---

## 1. Mirasim 机制【事实，源自逆向文档】

- Electron 应用，Claude Code 包在内置 Anthropic 反代后面。
- 云端 relay `https://mirasim-relay.mirofish.ai` 要求 HMAC 签名头
  （x-mirasim-device/nonce/sig/ts/token），直连 401 → **必须走本地端点中转**。
- 反代端口动态分配，生命周期 = agent 会话运行期（见 §A）。
- 本地端点不鉴权：token 是占位符 `mirasim-relay-managed-credential`，
  真实托管凭证由应用注入转发链。
- 端口识别（零 token 开销）`GET /v1/models`：
  200+JSON 模型列表=目标；200+HTML=web UI；401=shell 端口。

## 2. sub2api 管理 API【源码核实，克隆位于 %TEMP%\sub2api-src】

> 【v3 修正】源码实际布局是 `backend/internal/...`，v2 引用的 `internal/...`、`routes/admin.go`
> 路径前缀不完整，复查时按 `backend/internal/handler/admin/account_handler.go` 找。

### 认证
二选一：`x-api-key: <admin-api-key>` 或 `Authorization: Bearer <JWT>`（管理员角色）。
优先用管理 Key；JWT 登录备用：`POST /api/v1/auth/login` → `data.access_token`。

### 包络与列表
- 响应包络 `{code: 0, data}`（非 0 即错误）；列表在 `data.items`。
- 账号列表 `GET /api/v1/admin/accounts`：query 支持
  `page/page_size/platform/type/status/search/group/lite/sort_by/sort_order`。
  幂等查找用 `?search=<name>&platform=anthropic` 再客户端精确过滤 name。

### 账号 CRUD
- 建：`POST /api/v1/admin/accounts`
  ```json
  {
    "name": "mirasim-cloud",
    "platform": "anthropic",
    "type": "apikey",
    "credentials": {"api_key": "<桥接共享密钥，见 §8>", "base_url": "http://127.0.0.1:8787"},
    "extra": {},
    "concurrency": 4,
    "priority": 0,
    "rate_multiplier": 1.0,
    "group_ids": [1],
    "auto_pause_on_expired": false,
    "confirm_mixed_channel_risk": true
  }
  ```
- 改：`PUT /api/v1/admin/accounts/:id`（UpdateAccountRequest 全指针字段；
  `status` oneof **active/inactive/error**；`credentials` 整体替换 map；
  `group_ids` 为 `*[]int64` 不传不改）
- 暂停/恢复：`POST /api/v1/admin/accounts/:id/schedulable`，body `{"schedulable": false|true}`
  （SetSchedulableRequest，account_handler.go:2540）。
- 其他：`GET /:id`、`DELETE /:id`、`POST /:id/test`、`POST /:id/clear-error`。

### 【新核实】调度闸门是多维的，不止 schedulable

`backend/internal/service/gateway_scheduling.go` 选号时逐层过滤，任一不过就跳过该账号：

| 闸门 | 代码位置 | 对本方案的含义 |
|---|---|---|
| `isAccountSchedulableForSelection` | gateway_scheduling.go:281 | schedulable 开关 + temp 态 |
| `isModelSupportedByAccountWithContext` | :296 | **账号模型列表不含请求模型 → 直接过滤** |
| `isAccountSchedulableForModelSelection` | :300 | 模型范围 |
| `isAccountSchedulableForQuota` | :306 | 配额 |
| `isAccountSchedulableForWindowCost` | :310 | 窗口费用 |
| `isAccountSchedulableForRPM` | :315 | RPM |

**两个由此产生的必办事项，v2 完全遗漏：**

**(a) 模型列表必须同步，否则账号进池但永远零流量。**
`GET /api/v1/admin/accounts/:id/models`、`POST /api/v1/admin/accounts/:id/models/sync-upstream`。
注册流程必须以 sync-upstream 收尾：此时桥接器已在 listen，sub2api 会打到桥接器 → Mirasim
的 `/v1/models` 把真实模型集拉回来。这是「注册看着成功、但一条请求都不来」的最可能原因。

**(b) `temp_unschedulable` 是与 `schedulable` **正交**的第二个闸门。**
- 账号实体有 `temp_unschedulable_until` / `temp_unschedulable_reason` 两个字段
  （`backend/ent/account/where.go`）。
- 由 `rateLimitService` 在上游报错时自动设置，**带 TTL**。
- 管理端：`GET /api/v1/admin/accounts/:id/temp-unschedulable`（`{active:bool, state}`，
  已过期返回 `active:false`）、`DELETE /api/v1/admin/accounts/:id/temp-unschedulable`
  （account_handler.go:2388 / :2414）。
- **关键**：`SetSchedulable` handler（:2540）只调 `SetAccountSchedulable`，**不碰 temp 态**。
  所以桥接器把 schedulable 置回 true 后，若 temp 态仍在有效期内，账号依然不参与调度。
  → **恢复动作必须是一个组合，见 §5 状态机。**

### 分组
`GET /api/v1/admin/groups/all`（全量）/ `GET /api/v1/admin/groups`（分页）/ `POST /api/v1/admin/groups`。

### 转发行为
- 消息转发：`targetURL = validatedURL + "/v1/messages?beta=true"`
  → **base_url 不能带 /v1、不能带尾斜杠**。
- count_tokens 拼 `/v1/messages/count_tokens?beta=true`。
- 上游认证头由账号凭据统一注入（设 `x-api-key`）；
  **authorization/x-api-key 属禁止覆写头**（account_header_override.go）。
- SSRF 防护默认关（config.go:2021-39）：`url_allowlist.enabled=false`、
  `allow_private_hosts=true`、`allow_insecure_http=true`
  → **http://127.0.0.1 base_url 开箱即用**。

## 3. 部署拓扑【用户拍板】

- **Linux（云端，生产）**：Mirasim、桥接器、sub2api 同机。
  桥接器注册 base_url=`http://127.0.0.1:<桥接监听端口>`，无需公网暴露、无需隧道。
  云上跑 Mirasim 需 headless Electron 方案（xvfb 等）——部署课题，不属桥接器代码。
- **Windows（本地桌面，辅助）**：只做验证——`observe` + `discover` + `test`（+可选 `serve`）。
  不承担向 sub2api 注册的职责。

请求链路（云端）：sub2api → 127.0.0.1:<桥接固定端口> → 127.0.0.1:<mirasim动态端口> → 凭证注入 → relay。

## 4. 技术选型【已定】

单文件零依赖 Node.js（≥18，本机 v22）：`node:http/https/fs/path/os/child_process`。
Windows 与 Linux 同一份核心代码，平台差异只在端口发现方式与守护方式（systemd）。

### 【v3 新增】不要从零写 sub2api 客户端

源码自带 **`skills/sub2api-admin/scripts/sub2api-admin.js`**（759 行，零依赖 Node），
已覆盖本方案需要的全部管理操作：
`accounts list/create/update/get/set-schedulable/clear-error/clear-rate-limit/recover-state/
test/models/sync-models/temp-unschedulable/reset-temp-unschedulable`、`groups all`。

v2 §8 模块 6 计划从零手写这一层——直接复用它的 request 封装与包络处理即可，
省掉大部分工作量和踩坑。

⚠️ **环境变量名对齐**：该脚本读 `SUB2API_ADMIN_API_KEY`（不是 v2 §5 写的 `SUB2API_ADMIN_KEY`）
和 `SUB2API_BASE_URL` / `SUB2API_JWT`。本项目统一采用脚本的命名。

## 5. 状态机【v3 重写，v2 此处有缺陷】

桥接器维护 `desired`（期望调度态）与 `observed`（探测结果），**只在状态跃迁时调 API**，
不要每个 tick 都打一次。

```
启动    : desired = unknown → 先探测，不要一上来就置 true
探测成功: successCount++ ; 连续 >= success_threshold 且 desired != on  → 执行 RESUME
探测失败: failCount++    ; 连续 >= fail_threshold    且 desired != off → 执行 PAUSE
收到信号: 立即 PAUSE → drain 在途请求 → 退出（§7 B2）
```

**PAUSE** = `POST /:id/schedulable {"schedulable": false}`

**RESUME** = 组合动作，顺序执行（因为 §2 的双闸门）：
1. `DELETE /api/v1/admin/accounts/:id/temp-unschedulable` —— 清 sub2api 自己设的 TTL 封禁
2. `POST /api/v1/admin/accounts/:id/clear-error` —— 清 error 态
3. `POST /api/v1/admin/accounts/:id/schedulable {"schedulable": true}`
4.（可选）`POST /:id/clear-rate-limit`

双向都要迟滞（fail_threshold / success_threshold），避免端口抖动导致 API 刷屏。

## 6. CLI 设计

| 子命令 | 作用 | 平台 |
|---|---|---|
| `help` | 帮助 | 双 |
| **`observe`** | **【新】端口生命周期时间线，回答 §A** | **双，最先做** |
| `discover [--json]` | 枚举候选端口→三态探测→打印分类表 | 双 |
| `test [--model X]` | 发现→取模型列表→发一条 stream:true 的最小 /v1/messages 验证链路 | Windows 主用 |
| `serve [--no-register] [--port N] [--host H]` | 常驻：转发+健康循环+自动暂停/恢复+自动注册 | Linux 主用 |
| `register` | 幂等注册/更新账号（按 name 查重→create 或 PUT）**+ sync-models 收尾** | Linux |
| `groups` | 列出 sub2api 分组 | 配置辅助 |
| `pause` / `resume` | 手动触发 §5 的 PAUSE / RESUME 组合动作 | 运维兜底 |

配置解析顺序：内置默认 ← `--config <path>`（缺省脚本目录 config.json）← 环境变量
（`SUB2API_BASE_URL / SUB2API_ADMIN_API_KEY / MIRASIM_LISTEN_PORT / MIRASIM_LISTEN_HOST /
MIRASIM_ACCOUNT_NAME`）。

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
  "health": {"interval_sec": 30, "fail_threshold": 2, "success_threshold": 2},
  "forward": {"replay_buffer_mb": 8},
  "port_policy": "sticky"
}
```

## 7. 关键坑位清单【v3 修订】

### 已修正的 v2 缺陷

1. **【删除 v2 §8-8 的「端口变了→PUT 更新 base_url」】** 这是自相矛盾的残留。
   §3 已定桥接器监听**固定**端口，sub2api 的 base_url 指向桥接器（`127.0.0.1:8787`），
   Mirasim 的动态端口对 sub2api 完全不可见。**base_url 永远不变**，健康循环里不该有 PUT。
   换掉端口是桥接器**内部**重解析目标，对 sub2api 无感。

2. **模型列表闸门**（§2a）：注册必须以 `sync-upstream` 收尾，否则零流量。

3. **temp-unschedulable 双闸门**（§2b）：恢复必须走 §5 的组合动作，
   只置 `schedulable=true` 不够。

### 转发层

4. **全量透传，不要路径白名单。** v2 列举 `/v1/messages` 与 `/v1/messages/count_tokens` 两条。
   改成「除 `/__*` 外，原样透传 `req.url`」更短更稳：自动覆盖 `/v1/models`（sync-models 要用）
   和将来新增路径，也天然保留 `?beta=true`。

5. **重放语义收紧。** 「失败→重发现→重试一次」**只在尚未向客户端写出任何响应字节时**才允许，
   否则流式响应会把两段内容串在一起。另外 v2 的 64MB 全内存缓冲 × 并发是内存炸弹：
   改成 `replay_buffer_mb`（默认 8）以内可重放，超过则边收边转、放弃重放资格。

6. **SSE 保活要写全**：`server.requestTimeout=0`、`server.headersTimeout`、`res.setTimeout(0)`、
   上游 `req.setTimeout(0)`、`socket.setNoDelay(true)`（降 TTFB 抖动）。

7. **头部卫生**：剥离 hop-by-hop 头（connection / keep-alive / transfer-encoding / upgrade），
   重写 `host`，不要转发原 `content-length`（重新流式发送时长度会变）。
   不要动 `accept-encoding`——字节原样透传，不解压。

8. **上游连接复用**：共享一个 `http.Agent({keepAlive:true})` 指向 Mirasim，省掉每请求 TCP 建连。

9. **主动降级**：转发时若上游返回 401/403/429，直接触发 §5 的 PAUSE，
   不要等健康循环慢慢发现。

### 发现层

10. **按 PID 收窄，不要全端口扫。** v2 是枚举所有 LISTEN 端口挨个打 `GET /v1/models`——
    这会给同机无关服务发垃圾请求（可能触发别人的告警甚至副作用），而且慢。
    改法：先定位 Mirasim 进程 PID（Windows `Get-NetTCPConnection` 自带 `OwningProcess`；
    Linux `/proc/net/tcp` 的 inode → 反查 `/proc/<pid>/fd`），**只探测它自己监听的回环端口**。
    配合 sticky 缓存「上次可用端口优先探测」，常态是 O(1)。探测并发限流 16，排除自身监听端口。

### 运维层

11. **优雅退出必须先摘流量**（v2 缺失）：SIGTERM/SIGINT → PAUSE → drain 在途请求 → 退出。
    否则 systemd 重启/部署窗口内 sub2api 继续往死端口打，直接产生用户可见 5xx 和 error 态。

12. **`concurrency` 不要设 0（无限）。** 对一个单会话代理过于乐观，
    起步设 4，观察 relay 侧是否有 HMAC nonce / 限流问题再调。

13. **状态落盘** `state.json`：account_id + 上次可用端口 + desired 态。
    重启免重新查找，也避免重复建号。

14. **平台常量**：platform=`anthropic`（不是 claude）；base_url 无 `/v1` 无尾斜杠；
    Mirasim 侧占位 token `mirasim-relay-managed-credential`。

15. sub2api 若启用了 `security.url_allowlist` 需放行私网；**默认关闭，无需动作**【已核实】。

## 8. 【v3 新增】桥接器鉴权

v2 的桥接器完全裸奔。绑 `127.0.0.1` 只挡外网，**同机任何进程都能白嫖这个额度端点**。

零成本加固，不需要 sub2api 任何额外配置：

1. 生成随机密钥 `bridge_secret`。
2. 注册账号时把 `credentials.api_key` 填成这个密钥（而非占位符）——
   sub2api 本来就会把它作为 `x-api-key` 注入到发往 base_url 的请求。
3. 桥接器校验入站 `x-api-key === bridge_secret`，不匹配直接 403。
4. 转发给 Mirasim 时替换成占位符 `mirasim-relay-managed-credential`。

`bridge_secret` 留空则退化为不鉴权（本地 `test`/`observe` 场景方便）。

## 9. 实现蓝图

文件：`mirasim-bridge.js`（唯一代码）、`config.example.json`、`mirasim-bridge.service`、`README.md`。

**阶段 0（先做，见 §A）**：`observe` — 端口生命周期时间线。拿到结论再继续。

**阶段 1（本地可验证，无需 sub2api）**
1. 常量/默认配置/config 加载合并
2. `listCandidatePorts()`：定位 Mirasim PID → 取其回环 LISTEN 端口
   （win: `Get-NetTCPConnection` 含 OwningProcess，回退 `netstat -ano`；
   linux: `/proc/net/tcp`+tcp6，`st==0A`，inode 反查 `/proc/<pid>/fd`）
3. `probeModels(port)`：三态分类 {proxy|webui|auth|other} + models 列表
4. `discover()`：sticky 优先 + 并发限流探测；`chooseTarget(state, policy)`
5. `cmdTest()`：取模型 id（`--model` 覆盖，否则优先含 haiku 的）→ stream:true 最小对话 →
   解析 SSE 打印 TTFB/delta/usage/stop_reason

**阶段 2（转发层）**

6. HTTP server：鉴权（§8）→ readBody(replay_buffer_mb) → forwardOnce(port) →
   仅在零字节写出时可重发现重试一次 → 502；`/__health`、`/__status`（当前端口/计数器/desired 态）；
   全量路径透传；SSE 参数与头部卫生按 §7-4/6/7/8

**阶段 3（sub2api 集成）**

7. sub2api client：**复用 `skills/sub2api-admin/scripts/sub2api-admin.js`** 的 request/包络层，
   补 `findAccountByName / createAccount / updateAccount / syncModels /
   setSchedulable / clearTempUnschedulable / clearError / listGroups`
8. `cmdRegister()`：查重 → create 或 PUT → **`POST /:id/models/sync-upstream` 收尾**
9. serve 主循环：ensureRegistered → listen → 健康循环（重叠保护 running flag）驱动 §5 状态机；
   注册信号处理器实现 §7-11 优雅退出
10. CLI 分发 + 日志（时间戳前缀，stdout）

## 10. 恢复实现还差的用户输入

1. **§A 实验结论**——端点能活多久 / 能否保活。**这是唯一真正阻塞架构的问题。**
2. sub2api 管理 Key（`admin-` 前缀）或登录账号密码（JWT 备用通道）。
3. 目标 group_ids（可先用 `groups` 命令查）、priority 数值、账号名偏好（默认 mirasim-cloud）。
4. 云端 Mirasim headless 运行方案（xvfb？官方支持？）——只影响部署不影响桥接代码。
5. 桥接监听端口偏好（默认 8787）。

## 11. 进度快照

- **已完成**：Mirasim 机制调研；sub2api 全量源码核实（两轮，含调度闸门、temp-unschedulable
  双闸门、账号模型列表、自带 admin CLI 脚本）。
- **未开始**：全部交付文件；Windows 本机 smoke（`node --check`、`observe`/`discover` 空跑）。
- **环境**：`%TEMP%\sub2api-src` 浅克隆留存可复查（v3 已二次核对）；本机 node v22.23.1；
  本机存在 Mirasim 安装痕迹（`%LOCALAPPDATA%\@mirasimdesktop-updater`、`%APPDATA%\@mirasim`）。
- **用户指令原话**：「linux我直接在云端部署，在云端安装mirasim并且反代，windows的只需要把
  mirasim的云端额度反代出来就行了」「暂停，保留所有进度和你的思考数据」。
