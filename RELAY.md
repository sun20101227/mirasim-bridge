# 直连 relay 使用说明（0.6.0）

保持原版 sub2api 的配套容器部署见 [DOCKER.md](DOCKER.md)，无需启用原生插件。

新增后端来自 [cpa-plugin-mirasim](https://github.com/KIDA-MNESIA/cpa-plugin-mirasim) 的 Node.js 移植，来源和 MIT 许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 两种后端

| 配置 | 链路 | 运行依赖 |
|---|---|---|
| `backend: "relay"` | 调用方 → bridge → Mirasim relay | Node ≥18、可刷新账号凭证及设备私钥；新安装默认 |
| `backend: "session"` | 调用方 → bridge → Mirasim 本地会话 → relay | Node、server.cjs、Claude CLI、Mirasim 登录态；旧配置未写 backend 时保持此模式 |

直连模式不会启动保活进程，也不会扫描或使用你的个人会话。它用导入的设备私钥签名、申请短期设备票据，推理请求携带加密元数据。没有伪造仓库路径、Git 提交、设备轮换或假装人工操作。

## Google 登录凭证怎样带到 Linux

不需要 Google 密码。可以使用已登录 Mirasim 的账号，也接受 CPA 插件的 `type: "mirasim"` OAuth JSON。

**新版桌面 setting.json 的 `mrs1:` 字段是机器加密密文，单独复制这个文件到 Linux 不够。** 在原登录机器、以原用户运行：

```powershell
node scripts/export-credential.js --out private/relay-setting.json
```

可用 `--settings <原文件>` 指定输入。Windows 从该文件同目录的 `secret.key` 经当前用户 DPAPI 解锁；macOS 使用 Mirasim Keychain 项，Linux 使用 Mirasim `secret-tool` 项，也支持已有 `MIRASIM_SECRET_KEY`。脚本不打印密钥、不改原文件、不覆盖已存在的输出。再次导出时选一个新文件名。

输出仅含当前账号 auth 和 device 字段（CPA 文件保留等价字段），不携带其他 provider API Key；输出是可直接使用的私有凭证，不应公开。私有 ZIP 的 `private/setting.json` 已自动经过这一步，服务器不用再次导出，也不需要 Windows 的 `secret.key`。

将该文件交给安装器 `--setting-json`。直连服务会将刷新的 token 原子写回服务用户的凭证文件，保持其他字段，Linux 新文件权限 0600。每个可刷新凭证只运行一个服务实例；桌面和多台服务器同时使用导出的同一 refresh token，能否并行续期取决于上游的轮换策略，未验证。

## 配置

```json
{
  "backend": "relay",
  "relay": {
    "setting_json": "/var/lib/mirasim/.mirasim/setting.json",
    "url": "https://relay.mirasim.ai",
    "auth_url": "https://auth.mirasim.ai",
    "client_version": "0.0.354",
    "collect": false,
    "locale": ""
  }
}
```

这些字段合并到现有配置；保留 listen、bridge_secret、sub2api 等。`setting_json` 留空使用服务用户的 `~/.mirasim/setting.json`；相对路径相对 config.json。`client_version` 是参考实现对应的协议版本，可随上游变化调整。`collect:false` 发送上游定义的关闭收集信号，不能证明上游保留数据的实际行为。

旧安装升级时停止服务、先准备可读凭证，再编辑 backend。安装器保留已有 config，`--backend relay` 不会强行覆盖旧配置。切换回 session 前要确保其后端和 CLI 依赖仍存在。

## 接口与调度

所有接口使用 bridge_secret 鉴权，支持 `x-api-key` 或 `Authorization: Bearer`。

| 接口 | 用途 |
|---|---|
| `GET /v1/models` | 账号实时模型列表，按现有四系列白名单过滤 |
| `GET /v1/limits` | 原始额度窗口，保留 `model_scoped`；不触发推理 |
| `GET /v1/model-roster` | 上游模型规格；无本地虚构的上下文窗口 |
| `POST /v1/messages` | Claude、DeepSeek、Kimi；GPT 也保留此兼容入口，能力以上游为准 |
| `POST /v1/responses` | GPT 原生 Responses；流式直传，非流式收集终止事件后返回 response JSON |
| `POST /v1/responses/compact` | GPT 非流式上下文压缩，保留不透明 compaction 内容 |

也支持 `/backend-api/codex/responses` 和 `/backend-api/codex/responses/compact` 别名。工具调用、usage、加密 reasoning/compaction 字段保留；Responses 不注入 Claude Code system 提示词。`ultra` effort 映射为 `max`，不实现上游客户端外围的多轮工作流。

普通 Responses 会转换字符串 input、设置 store=false、请求 encrypted reasoning，并移除 Codex 不接受的 max_output_tokens/max_completion_tokens、采样参数等字段；**不能用这些输出上限字段限制该路径的输出预算**。compact 不做这些清洗，保留其非流式输入输出。

**未实现 Chat Completions ↔ Messages/Responses 转换，也没有完整移植 CPA 的所有翻译器。** 调用 GPT 时选 Responses 客户端；不能因为有 `/v1/responses` 就把客户端的 `/v1/chat/completions` 指到这里。

自动注册 sub2api 的方式仍为 `platform=anthropic`，供 Messages 使用。新增 Responses 直接入口不代表分组 15 会自动接收 OpenAI Responses 流量；需要在 sub2api 按它的版本配置 OpenAI/Responses 上游或单独从客户端调用桥接器。本次不自动改动线上分组/账号。

## 检查

```bash
node mirasim-bridge.js doctor
node mirasim-bridge.js serve --no-register  # 仅验证桥接器时
node mirasim-bridge.js models --family gpt
node mirasim-bridge.js quota               # 经已运行桥接器，无模型调用
node mirasim-bridge.js quota --direct      # 不要求启动 bridge
node mirasim-bridge.js test --model gpt-5.6-luna --protocol responses
node mirasim-bridge.js test --model kimi-k3 --protocol messages
```

型号以实时列表为准；test 会产生真实用量。直连模式的 GPT 检测默认走 Responses，可用 `--protocol messages` 明确选兼容路径。

直连 doctor 验证签名和模型访问，不要求 server.cjs、Claude CLI 或活会话。额度不足、单模型无容量、请求形状不受支持仍可能导致推理失败。健康模型列表不是全模型推理成功的证明。

## 恢复与排障

- Token 提前 15 分钟尝试刷新；暂时刷新失败且旧 token 尚有 30 秒以上有效期时继续使用它。真正失效则返回 503，不把 refresh token 或上游刷新正文打进日志。
- 若刷新成功但写盘失败，新 token 保留在内存，刷新锁保持，后续请求重试保存而非重复刷新。看到 `Cannot persist refreshed credential` 时先修复磁盘/目录权限，不要立即重启。安装器会检查凭证父目录的服务用户写权限。
- 设备票据接口 404/501 时按参考实现冷却后以 access token 签名；其他错误不绕过，按退避处理。
- 推理 401/403 转为本地 503，作废票据；401 触发后续请求刷新。已经发出的推理不因鉴权错误自动重放。
- `*.refresh-lock` 防止 doctor/serve 同时刷新；进程崩溃可能留下锁。先排除当前进程持有待保存的新 token，确认所有相关 bridge 已停止后，才删除遗留锁并重启。
- `Encrypted mrs1 credential`：在原机重新导出，或使用新版私有 ZIP；不能在另一台 Linux 上直接解开 Windows DPAPI 密钥。
- 服务器必须能直接访问 relay 和 auth 的 HTTPS。当前直连传输未实现 HTTP/SOCKS 出站代理配置；不应假设桌面系统代理会自动继承。

协议单测包含上游固定 Ed25519、X25519/HKDF/ChaCha20-Poly1305 向量和本地 mock relay。真实 Linux/systemd 环境仍需按 DEPLOY.md 验收。
