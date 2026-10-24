# 0.9.0 升级说明

0.9.0 是一次**界面重写 + 协议适配**，不是修修补补。控制台的颜色、字号、间距、状态全部换成设计令牌，同时接上了 Mirasim 新版 roster 与 chat-completions。

## 这个版本改了什么

### 界面

- **视觉与可访问性**：新增 `web/tokens.css`（三层设计令牌、浅色/深色/跟随系统、`prefers-contrast`、`forced-colors`）。所有正文与次要文字的对比度实测 ≥ 4.5:1，次要文字从原来的 2.73–3.21:1 提到 5.05:1 以上。
- **字号可缩放**：`style.css` 从 392 处 px 改为 rem 令牌，浏览器缩放和系统字号现在真的生效。
- **触控目标**：按钮最小命中区 44px（紧凑按钮视觉 28px，命中区仍 44px）。
- **主题切换**：右上角「自动 / 浅色 / 深色」，写 `localStorage`，跟随系统时实时响应。
- **语义结构**：跳转链接、landmark、表格 `caption` + `scope`、每个字段的 label 关联、`aria-invalid` + 字段级错误、进度条语义、`aria-live` 播报。
- **不再有阻塞对话框**：7 处原生 `confirm()` 全部换成页内对话框（焦点陷阱、Esc、返回焦点）。**回退版本**需要手动输入「回退」二字才能确认。
- **可撤销**：暂停调度改为「提示 + 撤销」，不再二次确认。
- **深链**：`#/overview`、`#/models` 等，刷新和浏览器后退都能回到原页；切页后焦点移到标题。
- **键盘**：`Ctrl/⌘+K` 命令面板（切账号、切视图、刷新、切主题）、`/` 聚焦搜索、`g` 后接 `o/a/m/u/l/r` 跳转、`?` 看快捷键。
- **卡片四态**：加载 / 空 / 失败可重试 / 数据过期，不再只在顶部闪一条提示。
- **性能**：JS/CSS 加 `ETag` + `304` + gzip。`app.js` 从 107 KB 降到约 33 KB 传输，轮询时只回 304。轮询失败自动退避（15→30→60 秒）并显示数据新鲜度。

### 协议与模型

- **`/v1/chat/completions` 已放通**：实测该路由真实存在（封装请求得到 429 额度拦截，而 `/v1/completions`、`/v1/embeddings`、任意伪路径都是 404 `not an endpoint on this router`）。桥接器**原样转发**，不做 Chat ↔ Messages/Responses 转换。
- **`[1m]` 后缀透传**：官方桌面客户端会给上下文 ≥ 1M 的 claude 模型自动加 `[1m]`（默认模型就是 `claude-opus-5-5[1m]`）。旧版直接拒绝，现在原样发给上游，只在匹配白名单/黑名单时剥掉后缀比对。
- **roster `agents` 完整解析**：不再只取 id，保留 `label`、`contextWindow`、`maxOutput`、`autoCompactRatio`、`adaptive`、`default`、每模型 `effort`。
- **`pricing_usd` 归一化**：把 roster 的 `cacheRead` / `cacheWrite5m` / `cacheWrite1h` 映射成用量估算认识的键名。
- **`off` 推理档**：deepseek/dsh 的 `off` 档现在被接受（原来只认 `none`/`minimal`）。
- **模型页**：显示额度系数、上下文、最大输出、自动压缩比例、adaptive、上游单价、「已下架」「未路由」计数、只读 roster 标记；支持排序与目录 JSON 导出。
- **`adaptive_effort`（默认关闭）**：开启后对 roster 标记 `adaptive` 的模型发送 `thinking.type=adaptive` + `output_config.effort`。**未经真实上游验证**，见下方「未验证」。

### 登录失效可重新登录

刷新令牌被上游永久拒绝（撤销、在别处轮换、过期）时：

- relay 层不再把它当临时故障退避，而是标记 `reauth_required` 并**清除冷却**（冷却等不回来）。
- 账号列表显示「需要重新登录」，账号页新增「登录状态」卡片：说明原因、时间，以及一条**重新登录当前账号**按钮。
- 重新登录走正常的 Google/GitHub/邮箱授权，**只替换凭证文件**：账号名、分组、并发、端口都不动。
- 旧凭证保留为 `setting.previous.json`（同目录），文件损坏时可人工回退。
- 新凭证原子写入并立即热加载，**不需要重启 bridge**。
- 429/5xx 这类临时失败仍按原有退避处理，不会被误报成登录失效。

## 安装

与之前相同：解压到新目录，`sha256sum -c SHA256SUMS` 校验，保留原配置与凭证，再按你的部署方式（源码 Compose / systemd / 宿主机升级工具）替换。

**宿主机后台必须一起更新**：0.9.0 新增 `web/tokens.css`、`web/modal.js`、`web/undo.js`。`scripts/deploy-agent.py` 与 `scripts/install-panel.py` 的文件清单已同步；如果宿主机后台仍是 0.8.x，新控制台会 404 掉这三个文件、整个页面不可用。用宿主机升级工具升级会自动处理；手工部署请确认 `/opt/mirasim-deploy/web/` 下这五个文件都在。

## 验证

`node --test tests/*.test.js` = 237 项；`selftest` = 68 项；Python = 58 项。

新增的门禁会长期生效：

- `tests/design-tokens.test.js`：两套主题、8 个文字令牌 × 8 个背景、主题令牌对齐，任何一处对比度掉到 4.5 以下都会失败并列出具体组合。
- `tests/a11y-static.test.js`：表格 caption/scope、每个控件的 label、跳转链接、主题切换器、禁止 `confirm(`/`alert(`/`prompt(`、主题写入与 hash 路由。
- `tests/panel-assets.test.js`：每个注册资源都真实存在（防止打包漏文件）、304、gzip。
- `tests/reauth.test.js`：永久拒绝 vs 临时失败的区分、重新登录只换凭证、失败时不动旧凭证。
- `tests/mirasim-adapters.test.js`：chat/completions 放通、`[1m]` 透传、roster 合并、`adaptive_effort` 开关。
- `tests/docker-context.test.js`：`.dockerignore` 是白名单，这个门禁沿真实 require 图检查每个模块都进了构建上下文。0.9.0 首次发布就是被它抓到的问题——宿主机测试全绿，镜像里却没有 `lib/roster.js`，容器启动直接 `Cannot find module`。

## 未验证

- **`adaptive_effort` 的线上行为**：账号共享额度用尽中，所有推理请求在请求体校验前就返回 429，所以 `thinking.type=adaptive` + `output_config.effort` 这套线格式**从未被真实上游接受过**。默认关闭，开启前请先用一个额度充足的账号实测一轮多轮对话。
- **`/v1/chat/completions` 的响应语义**：路由存在已确认，但请求体/响应体从未跑通过一次真实推理。同额度原因。
- **真实浏览器截图与屏幕阅读器**：本轮只做了静态断言（DOM 结构、类名、ARIA 属性）和假 DOM 单元测试，没有在真实 Chrome/NVDA 里走一遍。发布前建议人工过一遍浅色/深色/375px/键盘全流程。
