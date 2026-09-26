# 变更记录

## 0.8.1 — 2026-09-26

- **模型目录自动获取**：默认不再按写死的四个系列过滤（`model_filter` 默认为空），上游目录里出现的任何模型/系列（例如新出现的 GLM）自动进入目录、自动同步到 sub2 模型映射；模型页打开即加载，无需手动点击。`model_block`（默认屏蔽 fable）和 `disabled_models` 仍然生效，被屏蔽/未放行的模型会明确标出原因。
- **反代不改变模型指纹（配对复核）**：同一请求分别直连 Mirasim 会话和经 bridge 转发，7 个模型的 HTTP 状态、响应 `model`、消息 id 前缀、`usage` 字段、`message` 字段、事件类型序列、stop_reason 全部一致；Claude opus-4-8 / sonnet-5 / haiku-4-5、Kimi k3、GLM 5.3 flash 经 bridge 6 道推理题全部答对。流式事件逐字节透传，bridge 只在请求侧做上游强制要求的改写。详见 VERIFY.md。
- **控制台换用 Mirasim 图标与配色**：侧栏、登录页和浏览器标签页使用 Mirasim 应用图标，配色改为与图标一致的靛蓝；宿主机自更新和安装器会一并分发图标文件。
- **概览新增“请求趋势”与“各模型延迟”**：每分钟一格的最近 60 分钟成功/失败/被替换柱状图；按模型统计最近 40 次真实请求的首字节、中位和 P95 耗时，模型目录里也显示。“上游最近成功”卡片显示最后一次真实请求成功的时间和 relay 就绪状态。
- **运行日志页**：直接在网页查看 bridge 进程最近 400 行日志（内存缓冲），支持过滤、每 15 秒自动刷新，不再需要进服务器看容器日志。
- **Kimi 推理档可在网页调整**：运行设置新增“Kimi 推理档”（low/不干预/high/max）。选“不干预”时 bridge 不再改写 Kimi 请求，保留其原始推理行为。
- **网页开启 Codex 专用账号**：账号页新增“Codex 专用账号”卡片，按账号启用/关闭、选择 openai/composite 分组、可选账号名。保存后立即注册并进入调度；关闭会暂停该 sub2 账号但不删除。选到 anthropic 分组会被拒绝并说明原因（Responses 会被转成 Messages，Codex 审批/工具参数丢失）。不再需要进容器改配置。
- **新增账号时分组改为下拉选择**：从 sub2 读取 anthropic/composite 分组列表，也保留手动输入 ID。分组列表在 bridge 侧缓存 60 秒。
- **减少发往 Mirasim 的合成探测**：relay 后端下，一个健康周期内刚有真实请求成功，就不再额外发 `/v1/models` 探测；空闲时探测频率不变。
- 健康循环按账号分批并行（每批 4 个），账号多时 tick 时长不再随账号数线性增长；网页一览并行读取各目标状态。
- 验证：122 项 Node 测试（新增 Codex 面板操作、探测省略）、67 项自测、41 项 Python 测试。

## 0.8.0 — 2026-09-26

- **多个 Mira 账号共用一个 bridge（托管模式）**：不再为每个账号起一个容器。主 bridge 按 sub2api 出示的密钥区分账号：每个 profile 有自己的 `bridge_secret`、凭证、sub2 账号名/分组、并发与模型策略、额度和调度状态机，但对外只有一个 base_url。配置项 `accounts.hosted`；网页“新增账号”默认勾选托管，登录完成后自动托管并注册到 sub2。原有的独立容器方式保留，作为需要隔离时的备选。
- **网页一键完整升级**：升级时从同一个经过摘要固定、版本校验和自测的镜像中取出宿主机工具（部署服务、后台页面），写入 `/opt/mirasim-deploy` 并在容器就绪后重启自身服务；回退同时恢复上一版宿主机工具。以后不再需要为了更新页面进服务器终端。从 0.7.x 升到 0.8.0 仍需最后一次运行 `install-panel.py`（见 UPGRADE-0.8.0.md），之后全部在网页完成。可用 `self_update: false` 关闭。
- **网页后台重做账号视图**：概览新增“全部 Mira 账号”一览（托管账号 + 独立容器）：调度状态、Codex 状态、5 小时/7 天剩余额度条、在途与成功/失败计数，点击即切换当前账号；顶部账号选择器；账号页新增“暂停调度/恢复调度”（手动暂停后健康循环不会自动恢复）、“托管到当前 bridge”“移出托管”；运行设置、模型目录、单模型测试都按账号生效并写入该账号自己的配置文件。
- **模型指纹与推理复核（本机独立会话，2026-09-26）**：Claude opus-4-8 / sonnet-5 / haiku-4-5 与 Kimi k3 自报身份正确、响应 `model` 与请求一致（haiku 以带日期别名返回，按客户端规则视为同一模型）、5 道确定性推理题全部答对、UTF-8 无替换字符；GPT 与 DeepSeek 本机仍返回上游无容量，无法复核。上游目录新增 `claude-fable-5-1`、`claude-opus-5-5`、`glm-5.3-flash`（GLM 不在默认放行范围）。详见 VERIFY.md。
- 状态接口新增 `account`、`hold`、`accounts[]`；优雅退出会先暂停所有托管账号再排空；`/__status` 对旧就绪检查保持兼容。
- 验证：120 项 Node 测试（新增 6 项托管账号）、67 项自测、41 项 Python 测试（新增 6 项宿主机自更新）；桌面、手机（390px 无横向滚动）、深色模式截图。真实多账号注册、服务器上的宿主机自更新仍需验收。

## 0.7.2 — 2026-09-26

- **Claude 身份提示词只注入 Claude 模型**：实测 relay 只对 Claude 强制要求。此前给所有模型注入，导致 `gpt-6-astra` 等 GPT 模型、Kimi 自称 Claude Code。若 relay 对其他模型也返回“rejected as invalid”，会自动注入后重试一次。可用 `constraints.cc_identity_models` 调整。
- **识别模型替换**：比较请求模型与响应 `model` 字段（规则与桌面客户端一致），统计替换次数并记录最近一次。`constraints.model_fallback=forbid` 时，在发出任何字节前中断被替换的轮次。检测方法和结果见 VERIFY.md。
- **Codex 专用账号（可选）**：`sub2api.openai_account` 会自动注册一个 platform=openai 账号，只映射 GPT 模型。sub2api 原样转发 `/v1/responses`，不再经过 Responses→Messages 转换，Codex 的工具和审批参数可以完整保留。见 CODEX.md。
- **安全加固**：
  - 必须配置非空 `bridge_secret`。
  - session 后端只放行 Messages/models 路径。
  - 面板新增账号时，注册地址只能是本机或同一 Docker 网络。
  - 面板写配置只改磁盘上的对应字段，不写入环境变量注入的密钥。
  - 转发前移除 cookie、x-panel-key 和 proxy-authorization。
  - 宿主机服务限制并发连接数；拒绝请求前先读完小请求体，避免对方收到 TCP 重置而看不到错误信息。
- **网页后台**：
  - 重新设计，支持深色模式和手机。
  - 额度按剩余比例变色，显示相对时间。
  - 新增请求统计、模型替换记录、Codex 账号状态。
  - 可按账号实时调整并发（不需重启）和模型替换策略。
  - 可按系列批量启停模型，版本页可检查更新。
- 修复面板请求体按分片解码可能拆坏中文的问题。修复 0.7.2 开发中引入的账号名校验错误，并增加回归测试。
- 验证：
  - 通过：114 项 Node 测试、67 项自测、20 项 Python 测试，以及桌面、手机、深色模式截图。
  - 本机真实调用：Claude 与 Kimi。
  - 需在服务器验收：GPT 原生 Responses 路径、Codex 权限模式。
- **升级提示**：网页和宿主机服务需重新运行 `install-panel.py`（见 PANEL.md）；只升级 bridge 镜像不会更新它们。

## 0.7.1 — 2026-09-25

- 修复上游空 SSE 流被提前返回为 HTTP 200 的问题：收到可识别的协议事件后才开始下发流；空流、初始错误、协议不匹配、首事件超时返回明确 503。
- 已经开始的流意外结束时返回协议内错误事件，不再只断开连接；不伪造 finish_reason、message_stop 或 response.completed，不自动重放推理。
- 流式响应禁用代理缓冲/转换；添加 x-bridge-request-id、脱敏 stream_failure 日志和状态中的 last_stream_error，便于区分上游中断与客户端协议配置问题。
- 新增 13 项 SSE 回归覆盖空流、仅心跳、初始/中途错误、非法 JSON、协议错配、编码异常、超时、TCP 中断与工具调用。没有该次请求的客户端/模型/路径证据，不能据此断言用户所报错误的唯一根因。

## 0.7.0 — 2026-09-25

- 新增专用 `/panel` 管理后台：运行状态、Mirasim 额度、模型启停/测试、profile 列表和独立账号登录。
- 新增真实邮箱验证码登录：沿用客户端的 `/auth/code` 与 `/auth/verify`，不再把邮箱登录错误地当成 OAuth provider。
- 新增 Google/邮箱两种网页登录入口；每次登录仍写入独立 profile，不覆盖原账号。
- panel key 独立于 bridge secret、Mirasim token 和 sub2api 管理 Key；网页不挂 Docker socket。
- 宿主机网页增加受管账号启停、独立 profile 容器创建和 sub2 自动注册、升级与回退真实进度、操作记录。后台仅接受配置的 HTTPS Origin 和固定操作。
- 87 项 Node 回归、19 项 Python 测试及 Chrome 桌面/手机交互验证通过；邮箱接口与 Docker 使用模拟服务验证，实际邮件发送与服务器容器运行需验收。

## 0.6.1 — 2026-09-25

- 宿主机部署工具增加可选的 GitHub 指令检查，可从对话中的 GitHub CLI 或 Actions 页面请求升级/回退，无需 SSH 或公网入站端口。
- 服务器只读取固定仓库的指令，不需要 GitHub Token。指令有目标、有效期和持久化去重，只支持固定升级/回退动作。
- `enable-remote` 更新宿主机工具并保留现有部署密钥、账号列表与 Compose 配置。旧服务须通过网页终端/服务器面板接入一次，不能仅靠更新镜像完成。
- 修复部署状态写盘失败后，内存仍提前更新造成指令被误记为已处理的问题。
- GitHub 工作流下发成功不表示服务器升级成功；当前没有远程状态回传，真实结果仍通过本机状态接口查看。见 REMOTE-CONTROL.md。

## 0.6.0 — 2026-09-25

- 新增可选的宿主机部署 API：固定 HTTPS 发布源、指定仓库的镜像摘要、独立 Bearer 密钥、异步状态查询。模型容器不获取 Docker 管理权限。
- 镜像拉取、版本检查与自测先于停服；只重建已配置且正在运行的 bridge。保留数据卷、凭证和原版 sub2api。
- 注册/健康检查失败尝试恢复各账号原镜像；保存切换记录用于部署进程中断后恢复。回退失败时阻止新升级，并提供重试回退接口。
- 附 GitHub Actions：测试、发布 Linux amd64/arm64 镜像、源码 ZIP 和 deploy.json，供服务器网络拉取。工作流尚未在用户仓库实际执行。
- 8 项 Python 部署回归、82 项 Node 回归、67 项自测。真实 Docker/systemd 运行仍需服务器验收。操作说明见 NETWORK-DEPLOY.md。

## 0.5.0 — 2026-09-25

- 新增 Google OAuth 独立 profile 登录：一次性 state 验证、隐藏输入回调地址、新设备密钥与凭证单独保存，不修改原账号文件或调用退出接口。
- 每个 profile 使用独立容器和 sub2api 账号，提供 Docker 网络与 Linux host 网络模板；既有账号分组默认保留。
- 每 5 分钟读取真实 Mirasim limits，将剩余额度与重置时间同步到受管账号备注，保留手写内容；不修改本地计费限额或 Quota Keeper。
- 默认排除三个当前不可用的 DeepSeek 型号；可显式重新启用。Kimi 默认 low effort、并发 1，保留调用方推理参数；诊断默认 128 token/30 秒，不自动重试。
- 流式响应在终止事件到达后结束，正确处理拆分 UTF-8、背压、断流与提前结束的长度头。
- 82 项 Node 回归、67 项自测通过。真实 Kimi 低 effort 请求仍在 45 秒超时；DeepSeek 复测仍上游 503。Linux Docker 运行与第二个真实 Google 登录需服务器验收。
- 完整升级与多账号说明见 UPGRADE-0.5.0.md、ACCOUNTS.md。

## 0.4.3 — 2026-09-25

- 修复实际部署发现的模型注册缺陷：sub2api sync-upstream 返回目录不等于已保存 model_mapping；GET models 的平台默认列表不能作为成功依据。
- 注册、健康重验、手动恢复均显式保存原名映射并精确回读。变化时先暂停，验证后恢复；未变化时不重复写入/暂停。
- 保留 GET 账号返回的非敏感凭据字段，并让 sub2api 保留未提交的 API Key，避免仅更新 model_mapping 时丢失 base_url。
- 新增 9 项模型同步测试（包含一个父测试与八个场景）；共 71 项 Node 测试。升级不需要重新初始化数据卷，见 UPGRADE-0.4.3.md。

## 0.4.2 — 2026-09-25

- 保持原版 sub2api，新增独立 Docker/Compose 部署，不修改插件能力或 Quota Keeper 绑定。提供加入现有 Docker 网络和 Linux 原生宿主网络两种配置。
- 镜像只含运行代码和许可文件；.dockerignore 使用白名单，凭证/管理 Key 不进入构建上下文。setup 在无网络容器中初始化可写数据卷，服务以 UID/GID 1000 运行。
- 重复初始化保留已轮换凭证和配置；增加停止服务后经 stdin 验证并原子写入配置的工具，避免手动复制文件改变属主。
- 新增鉴权的 `/__live` 和容器健康检查；`/__health` 保持上游就绪语义。新增 status 命令和 sub2api 调度状态字段。
- 配置解析错误不回显可能包含密钥的 JSON 片段。
- 官方 Compose CLI v5.5.1 离线解析通过；没有 Docker Engine，未宣称镜像 build/run 或 Linux 真机验收通过。
- 67 项自测、62 项 Node 回归测试通过。

## 0.4.1 — 2026-09-25

- 修复令牌刷新后写盘失败丢失轮换凭证、迟到认证失败误伤新票据、认证拒绝复用旧票据、共享认证等待不能及时取消等问题。
- auth/admin 增加绝对超时；刷新尊重 Retry-After；凭证与 Responses JSON 形状验证；模型列表与 count_tokens 统一过滤；断流正确关闭并计错。
- 停服总超时覆盖注册、暂停及 drain；初始探测期间也处理退出信号。健康循环异常计入失败，账号查找分页并拒绝重名，手动操作不复用旧 state ID。
- 安装器支持无参数升级，检查实际生效的自定义凭证路径和目录写权限，生成足够长的 systemd 停止超时；私有包默认不附带不必要的 server.cjs。
- 67 项自测、55 项离线回归通过。真实 models/limits/model-roster 均 200；Linux 真机未验证。详见 AUDIT.md。

## 0.4.0 — 2026-09-25

- 参考 cpa-plugin-mirasim 提供独立 Node relay 后端：Ed25519 签名、X25519/HKDF/ChaCha20 加密元数据、短期设备票据与续期；无需 server.cjs / Claude CLI / 常驻会话。
- 提前刷新 access token、单实例并发合并与跨进程刷新锁、轮换凭证原子持久化。推理鉴权失败不自动重放；票据 404/501 的 access token 签名回退与其他错误退避分开处理。
- GPT 原生 Responses / compact、Codex 路径别名、SSE 直传与 JSON 聚合；补齐 CPA 的 Codex 请求字段规范化，不注入 CC system。未实现 Chat Completions 或跨协议翻译。
- 新增 quota 命令与签名 limits/model-roster 端点，额度查询不触发推理；保留四模型系列及旧 session 后端。
- 发现新版桌面 setting.json 为 mrs1 机器加密；增加原机凭证导出。私有包只导出当前账号及设备字段，不再携带其他 provider Key，不改桌面原文件。
- 新安装默认 relay；已有配置保持 session，切换需显式编辑 backend。更新 Linux 安装器、使用说明、打包文件和第三方 MIT 许可。
- Windows 实际直连：models/limits 200，Claude Messages / GPT Responses / Kimi Messages 200 + OK；DeepSeek 当前 503。Linux 真机、真实 compact/工具执行仍待验收。

## 0.3.0 — 2026-09-25

- 默认模型白名单扩展到 Claude、GPT、DeepSeek、Kimi；请求校验、模型列表及 doctor 使用同一过滤规则，模型名不做替换。
- 新增 `models` 列表/分类/单型号检测；`test` 默认经过桥接器，`--direct` 才直连，并修复旧 test 丢失随机路径前缀的问题。
- 检测识别 HTTP 错误、SSE error、流中断和空正文；失败退出码 1，避免 200 假阳性。
- 新增 MULTI-MODEL.md，明确仍为 Messages 协议，没有新增 Chat Completions/Responses 转换。
- 经新版桥接器实测 Claude、GPT、Kimi 正文 OK；DeepSeek 三个型号当前返回上游 503 no upstream available。没有改线上注册或调度。
- 内置自测 67/67；离线测试 20/20。Linux 真机仍待验证。

## 0.2.0 — 2026-09-25

- 修复保活 PID 为空时误选其他会话、缓存与健康检查隔离不一致的问题。
- 发现/观测输出隐藏随机路径凭证；状态端点也需 bridge_secret；错误载荷日志改为默认关闭。
- 修复并发 PAUSE/RESUME 顺序竞争；注册先暂停再更新，新账号先在分组外创建。
- 移除“域名必定异机”的阻断判断，使用实际模型同步证明可达性，并周期重验。
- SSE 客户端断开时取消上游，增加响应头及无活动超时，限制缓冲响应大小。
- 清理 Connection 指定的逐跳头；请求未经过解压处理时要求 identity 编码。
- Retry-After 生效；采样重试只在明确的参数错误时触发，重试响应统一处理。
- 改正先杀保活再排空请求的退出顺序，systemd 使用 KillMode=mixed。
- 配置参数校验、深拷贝数组、原子状态写入、doctor JSON 失败退出码。
- 安装脚本检查服务用户权限，保留配置和刷新后的登录态，支持 Docker/异机访问地址。
- 添加离线 HTTP/注册状态测试与 ZIP 打包、哈希校验脚本。

验证：内置自测 67/67；离线 Node 测试 14/14；Bash 语法检查通过。真实 Linux 安装与本轮真实 relay 调用尚未验证。
