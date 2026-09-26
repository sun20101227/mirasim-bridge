# 用 Codex 接入 Mirasim GPT 模型

## 为什么原来的接法会出问题

把 Codex 接到 **anthropic 平台分组**（例如原来的 `mirasim` 分组 15）时，请求链路是：

```
Codex ──/v1/responses──▶ sub2api ──把 Responses 转成 Anthropic Messages──▶ bridge /v1/messages ──▶ GPT
```

问题出在两次格式转换上：

- **身份错乱**：0.7.1 及之前的版本会在所有 `/v1/messages` 请求前注入 `You are Claude Code, Anthropic's official CLI for Claude.`，GPT 模型（如 `gpt-6-astra`）因此会自称 Claude Code。0.7.2 起只对 Claude 模型注入，见 [VERIFY.md](VERIFY.md)。
- **Codex 专有能力丢失**：Codex 的 shell / apply_patch 工具、沙箱和审批参数（完全访问权限、替我审批）依赖原生 Responses 协议。sub2api 把 Responses 转成 Messages 再转回来（源码 `gateway_handler_responses.go`），这些字段无法完整保留，所以相关权限功能会失效。

## 正确接法：单独的 openai 平台账号

```
Codex ──/v1/responses──▶ sub2api（openai 分组，原样转发）──▶ bridge /v1/responses ──▶ Mirasim 原生 GPT Responses
```

中间没有格式转换，也不注入 Claude 身份提示词。需要 bridge 使用 `backend=relay`（Docker 部署默认就是 relay）。

### 1. 在 sub2api 后台新建 openai 分组

平台选 **openai**，倍率按需设置。记下分组 ID（下面用 `20` 举例）。不要复用 anthropic 分组。

### 2. 打开 bridge 的 Codex 账号

**网页方式（0.8.1 起）**：后台“账号管理 → Codex 专用账号”，勾选“启用”，在下拉里选刚建的 openai 分组，可选填账号名，点“保存”。bridge 会立即在 sub2api 里创建该账号（默认名 `账号名-codex`，platform=openai、type=apikey），只映射 `gpt-*` 模型，并与所属 Mira 账号一起暂停/恢复。卡片右上角显示它的调度状态；托管的每个 Mira 账号都可以各自开一个。

**配置文件方式**：在该账号配置的 `sub2api` 下增加：

```json
"openai_account": { "enabled": true, "account_name": "mirasim-codex", "group_ids": [20] }
```

重启 bridge 后效果相同（Docker 部署的改法见 [DOCKER.md](DOCKER.md) 的“修改配置”一节）。

### 3. 配置 Codex

`~/.codex/config.toml`（Windows 为 `%USERPROFILE%\.codex\config.toml`）：

```toml
model = "gpt-6-astra"
model_provider = "sub2"

[model_providers.sub2]
name = "sub2"
base_url = "https://你的-sub2api域名/v1"
wire_api = "responses"
env_key = "SUB2_API_KEY"
```

`SUB2_API_KEY` 用一个**绑定到上面 openai 分组**的 sub2 用户 Key。

## 验收

1. 在 Codex 里问“你是哪个模型、由哪家公司训练”，不应再回答 Claude Code。
2. 分别在“完全访问权限”和“替我审批”模式下执行一条需要审批的命令，确认审批流程正常。
3. 在网页后台概览查看“模型被替换”计数。如果大于 0，说明 relay 在额度不足时用别的模型顶替过；可在“账号管理 → 运行设置”里改为“中断本轮”。

以上三项需要在你的服务器和 Codex 客户端上完成。2026-09-26 本机测试时，GPT 系列在 Messages 接口返回 `no upstream available`；原生 Responses 路径的实际可用性，需要在服务器上确认。

## 乱码（锟斤拷）和缺括号

- **锟斤拷**是 UTF-8 替换字符 `U+FFFD` 被当作 GBK 显示的结果。它说明某处曾把非 UTF-8 字节（常见是 Windows 控制台的 GBK 输出）按 UTF-8 解码。bridge 的流式转发逐字节透传，0.7.2 的回归测试把中文和 emoji 拆成单字节分片后，客户端收到的字节与上游完全一致。本机真实测试中，Claude 系列也能原样输出中文和括号，没有乱码。
- 在 Windows 上使用 Codex 时，建议让终端和脚本统一使用 UTF-8：PowerShell 7 或 `chcp 65001`；PowerShell 5.1 写文件时加 `-Encoding utf8`。
- 缺括号等低级错误更可能来自模型本身，或 Responses 与 Messages 之间的转换。先改用上面的原生接法，再观察是否复现；同时留意“模型被替换”计数，被替换成的模型质量可能不同。
