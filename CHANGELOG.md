# 变更记录

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
