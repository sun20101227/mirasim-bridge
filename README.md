# mirasim-bridge

把 Mirasim 的 **Claude、GPT、DeepSeek、Kimi** 模型桥接到固定 HTTP 端口，通过标准上游账号接入原版 sub2api。当前版本 **0.8.1**，支持网页管理、网络升级接口、**多个 Mira 账号托管在同一个 bridge**（sub2api 按密钥区分）、额度备注同步、独立容器和 systemd，不需要更换 sub2api 或占用现有插件能力。

**0.8.1**：Codex 专用账号可在网页按账号开关，新增账号时分组下拉选择，减少发往 Mirasim 的合成探测。

**0.8.0**：多个 Mira 账号共用一个 bridge 地址，网页登录后自动托管并注册到 sub2；网页升级同时更新宿主机后台，不再需要进服务器终端（从 0.7.x 升级需最后一次运行安装器，见 [UPGRADE-0.8.0.md](UPGRADE-0.8.0.md)）；网页新增全部账号一览、按账号暂停/恢复调度。

0.7.2 只对 Claude 模型注入 Claude Code 身份提示词（GPT/Kimi 不再自称 Claude Code），识别 relay 的模型替换，并新增 Codex 专用 openai 账号：[CODEX.md](CODEX.md) · 检测报告 [VERIFY.md](VERIFY.md)。流式排障见 [STREAM-TROUBLESHOOTING.md](STREAM-TROUBLESHOOTING.md)。这不是 OpenAI Chat Completions 转换功能；客户端协议仍需正确配置。

**无需 SSH，在对话或 GitHub 里触发升级：**见 [REMOTE-CONTROL.md](REMOTE-CONTROL.md)。服务器主动读取升级指令，无需公网管理端口。已安装的旧版部署工具需要通过云厂商网页终端/服务器面板更新一次；这里不能凭空接入一个没有远程控制通道的服务器。

专用管理后台：将宿主机 **8790** 反代为 HTTPS 域名，打开 `/panel` 可查看全部账号的调度状态与真实 Mirasim 额度、按账号暂停/恢复、模型启停/测试，使用 Google/邮箱验证码添加账号（默认托管到当前 bridge），并一键升级/回退（含宿主机后台）。先通过网页终端安装一次后台，操作见 [PANEL.md](PANEL.md)。8787 的单 bridge 页面仅提供部分功能。

**以后不想手动上传 ZIP：**见 [NETWORK-DEPLOY.md](NETWORK-DEPLOY.md)。一次性安装宿主机部署工具后，可用带独立密钥的 HTTP 接口拉取固定发布源并更新镜像，失败尝试回退。源码与发布入口：[GitHub](https://github.com/sun20101227/mirasim-bridge) · [最新版本](https://github.com/sun20101227/mirasim-bridge/releases/latest)。服务器仍需按说明接入一次。

**已部署 0.7.x 的用户请按 [UPGRADE-0.8.0.md](UPGRADE-0.8.0.md) 升级**（更早版本先看 [UPGRADE-0.5.0.md](UPGRADE-0.5.0.md)）。新增账号操作见 [ACCOUNTS.md](ACCOUNTS.md)。

本版参考 [KIDA-MNESIA/cpa-plugin-mirasim](https://github.com/KIDA-MNESIA/cpa-plugin-mirasim) 移植了设备签名、加密元数据、票据缓存、token 刷新、GPT Responses/compact 和额度查询，见 [RELAY.md](RELAY.md) 与 [许可说明](THIRD-PARTY-NOTICES.md)。

**保持原版、使用配套容器请读 [DOCKER.md](DOCKER.md)**；原生 systemd 部署见 [DEPLOY.md](DEPLOY.md)。变更记录见 [CHANGELOG.md](CHANGELOG.md)。[DESIGN.md](DESIGN.md) 保留历史实验，运行方式与默认参数以本 README、示例配置和当前代码为准。

## 验证范围

0.8.0：120 项 Node 测试（含 6 项托管账号：密钥路由、各账号独立设备签名与计数、面板托管/移出/暂停、配置写入各自文件）、67 项自测、41 项 Python 测试（含 6 项宿主机自更新：镜像内文件校验、备份与回退、语法错误拒装、失败不触碰宿主机）。桌面/手机/深色截图通过。真实多账号注册与服务器上的宿主机自更新仍需验收。

0.6.0 延续 82 项 Node 回归和 67 项自测，新增 8 项 Python 网络部署测试，覆盖接口鉴权、固定镜像摘要、部署失败回退及中断恢复。部署/回退操作由 mock 验证；GitHub Ubuntu 发布已通过测试，完成 amd64/arm64 构建与 amd64 容器离线自测，镜像支持匿名拉取。宿主机部署及生产容器升级仍需服务器验收。

0.5.0 通过 67 项自测、82 项 Node 回归；涵盖独立 OAuth profile、额度同步、DeepSeek 禁用策略、Kimi 终止帧/超时/并发限制。真实第二个 Google 账号授权和 Linux 容器运行仍需服务器验收；自动测试使用模拟 OAuth。

0.4.1 通过 67 项自测和 55 项离线回归；新增故障场景、真实控制接口结果及未验收边界见 [AUDIT.md](AUDIT.md)。

0.4.2 全量 62 项 Node 测试和 67 项自测通过，含容器初始化、配置更新、健康检查；两份模板通过官方 Compose CLI 离线校验。当前工作机没有 Docker Engine，尚未实际构建/运行容器；Linux 的文件权限、网络和真实流量仍需服务器验收。

- 离线回归包含 mock relay、上游固定密码学向量、令牌刷新、Responses 工具/压缩项、截断流与原有 session 行为。
- 0.4.0 在 Windows 使用真实账号、经桥接器直连 relay 验证：模型/额度 HTTP 200；Claude Messages、GPT Responses、Kimi Messages 返回 200 + OK；DeepSeek 仍为上游 503。未更改线上 sub2api 账号。
- 0.3.0 另在 Windows 经新版桥接器实测：`claude-haiku-4-5`、`gpt-5.6-luna`、`kimi-k3` 均返回 HTTP 200 和可见文本 OK。未修改线上账号。
- `deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 当前均被 Mirasim 列出，但实际请求返回 **503 no upstream available**；支持转发不代表上游当前有可用路由。
- Linux 的安装脚本已做 Bash 语法检查；**尚未在真实 Linux 服务器完成安装、Google 登录态迁移和 Mirasim 端到端验证**。提供 systemd 部署方式不等于这些外部兼容性已经确认。
- 历史短时间观察中未发现空闲保活产生模型调用；不能据此承诺长期零成本、不被回收或账号不会受限制。

## 工作方式

```text
relay 后端：调用方/sub2api → bridge:8787 → Mirasim relay
session 后端：调用方/sub2api → bridge:8787 → Mirasim 本地会话端点 → relay
```

新安装选择 relay，使用现有设备私钥和可刷新的账号凭证，不启动保活。session 模式仍拉起 `node server.cjs claude -p --verbose --input-format stream-json --output-format stream-json`，保持 stdin 打开并只使用自己创建的会话。未配置 backend 的旧安装继续使用 session。

调用方使用 `x-api-key: <bridge_secret>` 或 `Authorization: Bearer <bridge_secret>`。这同样适用于 `/__live`、`/__health`、`/__status`。随机路径前缀与会话 token 都是敏感信息，发现/观测输出仅保留路径指纹。

兼容处理会改变请求：`/v1/messages` 注入 Claude Code system 文本、清理部分参数和空块；默认删除采样参数，模型列表放行 `^(claude-|gpt-|deepseek-|kimi-)` 且排除 `fable`。模型名原样转发。客户端 system 文本保留，但不能承诺所有模型上的行为完全不变。默认规则来自实测，可能随 Mirasim 更新失效。

**Messages 接口保留四个系列；relay 后端另提供 GPT 原生 `/v1/responses` 与 `/v1/responses/compact`。** 未实现 `/v1/chat/completions` 或不同协议间的转换。Responses 不注入 CC system，支持 SSE 和非流式 response JSON。参见 [MULTI-MODEL.md](MULTI-MODEL.md)。

独立 OAuth 登录生成各自的设备密钥，签名沿用参考协议；限流与退避用于控制负载。已有账号导出的设备密钥保持原值。

## 快速使用

```bash
node mirasim-bridge.js selftest
node --test tests/*.test.js
cp config.example.json config.json
# 按 DEPLOY.md 填可迁移凭证与分组；relay 不需要 server.cjs
node mirasim-bridge.js doctor
node mirasim-bridge.js serve
```

需要 Node ≥18；relay 模式只要求有效的 token、refresh token 和 Ed25519 设备私钥。**桌面 `mrs1:` 加密文件须先在原机导出，私有 ZIP 自动处理**。session 模式另需 `server.cjs` 和服务用户 PATH 内的 `claude`。无需为桥接器执行 `npm install`。

## 配置

新安装示例见 [config.example.json](config.example.json)，底层默认配置在 DEFAULT_CONFIG。示例选择 relay；缺少 backend 的旧配置保持 session。`config.json` 是严格 JSON，不允许注释。默认读取脚本目录的配置，`--config /absolute/config.json` 可指定其他位置；`state.json` 写入所选配置所在目录。

| 字段 | 用途 / 默认 |
|---|---|
| `backend` | `relay` 或 `session`；示例/新安装用 relay，未声明的旧配置保持 session |
| `relay.setting_json` | 可迁移凭证文件；空值使用服务用户的 `~/.mirasim/setting.json` |
| `relay.client_version` / `relay.collect` | 参考协议版本 `0.0.354` / 默认发送关闭收集信号 |
| `listen.host` / `listen.port` | `127.0.0.1:8787`；非回环监听必须设置密钥 |
| `bridge_secret` | 调用桥接器的密钥，与 sub2api 管理 Key 不同；安装时随机生成 |
| `sub2api.base_url` | 管理 API 地址，例如 `https://sub2api.example.com` |
| `sub2api.public_base_url` | **从 sub2api 网络空间访问桥接器的地址**；空值使用 `http://127.0.0.1:8787` |
| `sub2api.admin_api_key` | 管理 Key；也支持 `sub2api.jwt`，过期需更新 |
| `sub2api.group_ids` | 已存在的 anthropic/composite 分组；本环境历史配置为 `[15]` |
| `sub2api.account_name` | 默认 `mirasim-cloud`，按名字查找并更新 |
| `sub2api.manage_existing_groups` | 默认 false，保留后台修改的既有账号分组；新账号仍使用 group_ids |
| `sub2api.concurrency` / `forward.max_concurrency` | 均默认 2，建议同步修改 |
| `forward.kimi_max_concurrency` | 默认 1，每个 worker 的 Kimi 并发上限 |
| `constraints.disabled_models` | 默认排除当前上游不可用的三个 DeepSeek 型号，空数组可重新启用 |
| `constraints.kimi_default_effort` | 默认 low；保留调用方显式推理配置，空字符串关闭默认注入 |
| `quota.enabled` / `quota.sync_notes` / `quota.interval_sec` | 默认开启查询和备注同步，每 300 秒一次 |
| `diagnostics.timeout_sec` / `diagnostics.max_tokens` | bridge 检测默认 30 秒、128 token，不改变 sub2 内置测试超时 |
| `keepalive.server_cjs` | Linux 安装后为 `/opt/mirasim-bridge/server.cjs` |
| `forward.replay_buffer_mb` | 入站请求体缓冲上限 8 MB，超限拒绝 |
| `forward.upstream_headers_timeout_ms` | 等待上游响应头最长 60 秒 |
| `forward.upstream_idle_timeout_ms` | 上游连接无活动最长 300 秒；有数据的 SSE 可持续更久 |
| `forward.log_failures` | 默认 false；开启后记录截断的错误载荷，可能含聊天内容 |
| `forward.failure_log` | `requests.log`，约 5 MB 时轮转成 `.1`；相对服务工作目录 |
| `health.interval_sec` | 30 秒；定期重新验证 sub2api 侧可达性 |
| `shutdown.drain_timeout_sec` | 30 秒；先摘流量、等请求结束，再关闭保活 |
| `shutdown.total_timeout_sec` | 150 秒，覆盖注册/暂停/排空的总时间；systemd 超时必须更长 |

可用环境变量：`SUB2API_BASE_URL`、`SUB2API_ADMIN_API_KEY`、`MIRASIM_ACCOUNT_NAME`、`MIRASIM_LISTEN_HOST`、`MIRASIM_LISTEN_PORT`、`MIRASIM_BRIDGE_SECRET`。

## 命令和运维

| 命令 | 行为 |
|---|---|
| `doctor [--json]` | 环境、登录态、发现机制、分组和模型检查；FAIL 时退出码 1，JSON 模式同样如此 |
| `serve [--no-register]` | 保活、转发；默认还注册账号并自动管理调度 |
| `discover [--json]` | 查看进程、端口和脱敏会话信息 |
| `observe --interval 5` | 输出 JSONL 时间线，Ctrl-C 停止 |
| `models [--family gpt] [--json]` | 经桥接器列出模型，不做推理，不代表每个型号当前可用 |
| `models --check --model MODEL [--timeout-sec 30] [--json]` | 单模型真实检测；失败退出码 1，超时明确标记，不自动重试 |
| `quota [--direct] [--raw]` | relay 模式读取并汇总 `/v1/limits`；raw 输出原始响应，direct 无需启动桥接器 |
| `status` | 读取进程、上游和 sub2api 调度状态，不打印凭证、不触发推理 |
| `login --profile NAME` | 登录另一个账号并保存独立 profile，不退出原账号 |
| `accounts` | 列出独立 profile，不输出凭证 |
| `test --model MODEL [--max-tokens 128] [--timeout-sec 30]` | 默认**经桥接器**发送真实请求；显式 `--direct` 直连所选后端 |
| `groups` | 列出 sub2api 分组 |
| `register` | 注册/更新并同步模型，账号保持暂停，交给健康循环或手动 resume 恢复 |
| `pause` / `resume` | 手动改调度；resume 先验证模型同步成功 |
| `selftest` | 内置纯函数测试 |

`pause` 不会永久覆盖正在运行的健康循环；需要维护时用 `systemctl stop mirasim-bridge`。单独执行 `register` 后，正在运行的服务若已缓存旧调度状态，应重启服务重新接管。

新账号先在分组外创建，再暂停、加入目标分组和同步模型；既有账号先暂停再更新。`sync-upstream` 失败或模型为空时不得恢复。域名管理地址不代表异机，最终可达性由 sub2api 发起的同步验证。

模型同步必须包括：获取上游目录 → 保存 `credentials.model_mapping` → GET models 精确回读。0.4.3 已实现完整流程，不再把平台默认的非空模型列表误认成同步成功。

额度每 5 分钟写入账号 Notes/备注，需在 sub2 账号列表列设置中开启。DeepSeek 三个已知不可用型号默认禁用；Kimi 默认 low effort、并发 1，在默认总并发 2 下为其他模型保留容量。本轮 Kimi 实测仍在 45 秒超时，上游延迟未解决。

429/529 使用本地退避，并尊重上游 `Retry-After`；503 不自动重试。仅在仍保留采样参数且 400 明确指出采样字段时，删除这些参数重试一次，重试结果继续经过鉴权/退避处理。

## 文件与打包

- `mirasim-bridge.js`：主程序；`lib/relay.js` / `lib/responses.js`：直连及 Responses；`tests/`：离线回归。
- `install.sh` / `mirasim-bridge.service`：Linux 安装与 systemd 配置。
- `Dockerfile` / `compose*.yaml`：主账号及独立 profile 的 Docker 网络/host 网络模板；凭证只进入数据卷，不进入构建上下文。`/__live` 用于进程健康检查，`/__health` 用于上游就绪检查。
- `package.ps1`：在 Windows 生成 ZIP；包含 SHA256SUMS，并校验 ZIP 内文件内容。
- 源码包排除 config、state、运行日志和登录凭证。私有包默认只附带导出的 `private/setting.json` 与 `private/admin-key`，不依赖桌面后端；**仅用于自己的服务器，不用于公开分发**。需要 session 后端时显式添加下方打包选项。

```powershell
.\package.ps1
.\package.ps1 -IncludePrivateDeployment
.\package.ps1 -IncludePrivateDeployment -IncludeSessionBackend
```

部署不需要 Windows 的 `state.json`；账号按名字重新查找。不要把日志或私有部署包提交到 Git。

**从 0.2.0 升级：** 如果已有 config.json 显式写了 `"model_filter": "^claude-"`，安装器会保留它。请改为 `"^(claude-|gpt-|deepseek-|kimi-)"` 后重启服务，让模型重新同步。没有配置该字段时自动采用新默认值。
