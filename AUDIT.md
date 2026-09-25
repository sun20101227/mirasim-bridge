# 审查与验证记录

## 0.6.0 网络部署入口

新增独立 Python 宿主机 API，默认仅监听回环，由 SSH 或现有 HTTPS 反代接入。接口校验独立 Bearer 密钥，不接受调用方提供的镜像地址或命令。发布 manifest 必须来自配置的 HTTPS 地址，镜像必须匹配配置仓库与 SHA-256 digest。

8 项自动测试验证镜像约束、鉴权、禁止任意参数、拉取/版本失败不停止服务、启动失败回退、多账号回退失败继续处理其他账号、停止账号不启动、部署进程重启后的记录恢复和任务互斥。Docker/systemd 是模拟验证；HTTP 使用真实本机监听。没有声称已发布 GitHub 镜像、已部署接口或完成 Linux 真机验收。

部署工具拥有宿主机 Docker 权限，独立于模型容器；公网 HTTPS 配置和发布源归属由用户设置。更新只替换镜像，保留服务器凭证及持久化数据，不自动刷新宿主机源码/Compose/部署工具。

发布工作流通过 actionlint v1.7.12 静态校验（下载工具的 SHA-256 已核对）。这不等于已执行 GitHub Actions 或验证 GHCR 发布权限。

## 0.5.0 独立账号、额度与慢请求

82 项 Node 回归和 67 项自测通过。新增场景覆盖模拟完整 OAuth 登录、随机一次性回调、state 错误/重复凭证/过期拒绝、原配置逐字节保持不变、独立设备密钥与 bridge_secret、只更新受管账号备注、额度失败标记、Kimi 并发释放、诊断绝对超时、上游连接不结束时按终止帧完成请求。长度头回归模拟上游声明过长 Content-Length，验证客户端仍能正常结束。

公开 OAuth provider discovery 实测 HTTP 200，列出 github/google。未代替用户完成第二个 Google 账号的真实授权；模拟登录测试不能证明服务方永远保留旧会话。

本轮真实推理中 deepseek-flash 返回上游 503 no upstream available（约 753 ms）；kimi-k3 使用 low effort、128 token 仍在 45 秒超时。因此仅报告本地超时/并发/流结束处理改善，不宣称上游 DeepSeek 容量或 Kimi 延迟已修复。没有继续重复消耗推理额度。

原版 sub2api 备注列默认隐藏，本版在备注中展示真实 Mira 额度，不将其写入用于本地计费与调度的 quota_limit/used。Quota Keeper 保持原状，手动克隆账号不自动接管。

四份 Compose 模板可由官方 CLI 离线解析；本机无 Docker Engine，未实际构建或运行镜像。新增独立容器共享数据卷但使用各自目录，并非容器间凭证访问的安全隔离。服务器仍需验收 UID 权限、网络解析、真实登录、调度及流量。

## 0.4.3 部署后的接口核验与修复

实际部署验收发现，账号已 active/schedulable，但 GET models 仍返回 12 个平台默认 Claude 型号。检查官方 sub2api v0.2.8 后确认：sync-upstream 返回真实目录（并可能保存能力元数据），但不替调用方写入 credentials.model_mapping；旧测试错误地把“获取目录”和“保存映射”视作同一动作。

已增加显式保存和精确回读校验，保留 base_url 等非敏感凭据，API Key 由宿主保持。新增 mock 按真实接口语义工作：获取目录不会自动改变映射，未保存时 GET 返回非空默认列表，保存被忽略也必须报错。71 项 Node 回归覆盖这些路径。

线上修正只作用于 mirasim-cloud：暂停 → 保存从真实上游取得的 15 个型号 → 精确回读 → 再次向桥接器获取目录以验证凭证未损坏 → 恢复原调度状态。未发送推理请求，未改变 Quota Keeper。

## 0.4.2 补充记录

本轮确定保持原版 sub2api。新增独立 Dockerfile、两种 Compose 网络模板、离线初始化/配置更新工具和 liveness 探针。初始化只操作本地数据卷，普通启动才进行标准账号注册与调度，不调用插件管理接口。

新增 7 项容器相关回归：配置生成、重复初始化保留轮换凭证、主机网络、部分初始化恢复、错误输入和初始化锁、鉴权存活检查、错误日志脱敏、配置更新（若干场景合并在同一个测试中）。全量为 62 项 Node 测试，原有 67 项自测保留。

使用官方 Docker Compose v5.5.1，核对下载 SHA-256 后执行两份模板的离线 `config` 校验。本机没有 Docker Engine，未实际构建/运行镜像；容器 UID、卷权限、网络 DNS、信号处理和 Linux 推理流量需要服务器验收。源码包/私有包均包含新版部署文件，镜像构建上下文用白名单排除配置、凭证和归档。

以下为 0.4.1 记录：

日期：2026-09-25。范围包括 relay 凭证/票据生命周期、Responses、共享转发层、sub2api 管理操作、安装升级、导出及 ZIP 文件完整性。

## 本轮修复

| 问题 | 修复与验证 |
|---|---|
| refresh token 已轮换，凭证写盘失败后仍可能复用旧 refresh token | 先保留新凭证于内存，再 fsync + 原子替换；写盘失败保持刷新锁，后续只重试持久化。模拟 EACCES 后恢复，确认只刷新一次 |
| 旧推理请求迟到的 401 作废新票据 | 按凭证/票据版本判断拒绝响应，只作废对应版本；并发回归覆盖 |
| 申请票据返回 401 时复用尚未过期的旧票据 | 认证拒绝立即作废，不走临时故障回退 |
| 调用方断开后一直等待共享认证操作 | 调用方可立即取消等待；其他请求仍能完成共享 mint，不重复申请票据 |
| auth/admin 持续返回少量字节使空闲超时失效 | 增加整个控制请求的绝对时间上限；流式推理继续使用可配置空闲超时 |
| 刷新失败忽略 Retry-After | 尊重上游时间；仍有效的 access token 可继续使用，失效 token 不放行 |
| 模型列表仅处理 data，models 格式绕过过滤 | 三种列表格式共用解析，异常格式返回 503；健康探测只统计本地允许的模型 |
| count_tokens 未检查模型白名单 | 请求也执行同一模型过滤，不注入或改写计数正文 |
| Responses 非终态 JSON 被聚合成成功 | 必须是 completed/incomplete；拒绝错误 output 结构、null 事件；增加输入形状校验 |
| 已截断上游流计为成功，可能不关闭下游 | 未完成流关闭下游并记入错误，正常结束才计成功 |
| 停服只限制 drain，未限制注册/暂停等待 | 从收到退出信号起设置 150 秒总上限；先关闭监听，暂停账号，排空请求，再结束保活。初始探测期间也处理信号 |
| 配置或凭证异常跳过健康计数，账号可能一直留在池内 | 健康循环异常也记一次失败，按阈值暂停 |
| 账号搜索只取第一页，重名时任意选一个 | 分页精确匹配；多个同名账号明确拒绝。pause/resume 在当前服务器按名重新找 ID，不信任旧 state 的 ID |
| 升级强制验证上传文件，而实际保留另一个文件 | 无参数升级检查实际生效凭证；支持 relay.setting_json 的绝对/相对路径；显式替换才备份并覆盖 |
| 凭证可读但目录不可写，启动后无法续期 | 安装时按服务用户检查父目录可写；systemd 超时随应用总超时生成 |
| 直连私有 ZIP 强制依赖桌面 server.cjs | 默认只带账号凭证和管理 Key；仅 -IncludeSessionBackend 时附带后端 |

## 已执行验证

- 67 项内置自测。
- 55 项 Node 离线回归，包含原有 session 兼容测试、固定密码学向量、模拟 relay、持久化失败、认证竞争、客户端取消、停服、安装配置及 systemd 模板。
- Bash 语法检查和 `install.sh --help`；Windows 上使用 Git Bash。
- 真实账号控制接口：`/v1/models`、`/v1/limits`、`/v1/model-roster` 均 HTTP 200。模型列表按当前过滤规则有 15 个，此数量不是固定契约。
- 本轮不修改生产 sub2api，不批量重测模型推理。

复现离线检查：

```bash
node mirasim-bridge.js selftest
node --test tests/bridge.test.js tests/relay.test.js tests/resilience.test.js tests/deployment.test.js
bash -n install.sh
```

## 外部验收边界

本机没有可用 Linux 发行版或 Docker，因此没有把 systemd 安装、发行版权限和服务重启称作“Linux 真机已验证”。安装逻辑的 Node 部分经过离线回归，Bash 经过语法检查；目标服务器仍按 DEPLOY.md 验收。

0.4.0 已在 Windows 经真实 bridge 验证 Claude Messages、GPT Responses/Messages、Kimi Messages 返回 200 + OK；DeepSeek 当时为上游 no upstream available。本轮未证明 DeepSeek 容量恢复，也未新增真实 compact、工具执行、长时间稳定性或跨机器同时刷新凭证的验证。

协议、上游容量、账号状态和服务器网络都能变化。通过这些检查表明本轮覆盖的场景没有失败，不能承诺任何部署环境与未来上游变化都没有问题。

## 运行注意

- 出现 `Cannot persist refreshed credential` 时，先修复磁盘/目录权限，让当前进程完成保存；此时不要立即重启并丢掉仍在内存里的新凭证。
- `*.refresh-lock` 在进程崩溃后可能遗留；确认相关进程均停止且不是上面的待写盘情况，再按 RELAY.md 排障。
- 0.4.1 的安装器保留既有 config 和账号状态；改变 backend 要显式编辑配置。已有 session 安装可复用已安装的 server.cjs。
- 常规停服总超时 150 秒，默认 systemd 180 秒；自定义后运行安装器会生成更长的 systemd 上限，手工改配置后也需同步修改 unit。
