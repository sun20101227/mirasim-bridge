# Hermes 接入与空流错误

Hermes 的 `Provider returned an empty stream with no finish_reason` 出自 Chat Completions 流解析器：它没有读到正文、推理内容、拒绝内容、工具调用或结束原因。可能是接口协议不一致，也可能是上游空流、错误地址返回 HTML 或连接故障，不能只凭此句确定根因。[Hermes 源码](https://github.com/NousResearch/hermes-agent/blob/main/agent/chat_completion_helpers.py)

bridge 支持 Messages 与 GPT Responses，不支持 Chat Completions。不要将管理后台的 8790 地址用于推理。以下仅修改/合并对应配置项，保留其他 Hermes 配置；模型名使用你实际的 models 列表。

## 当前 Hermes 配置格式

`~/.hermes/config.yaml` 中显式指定协议，例如使用 sub2api 的 Messages 入口：

```yaml
providers:
  mira:
    api: https://your-sub2api.example.com
    key_env: MIRA_API_KEY
    transport: anthropic_messages
model:
  provider: custom:mira
  default: claude-haiku-4-5
```

`MIRA_API_KEY` 在 Hermes 环境变量配置中设为该分组的**用户 API Key**，不是 sub2 管理 Key。直连 bridge 则使用 bridge_secret，并将 api 改成 bridge 推理入口。

GPT 若通过实际支持 `/v1/responses` 的入口直连 bridge，可单独建立 provider：

```yaml
providers:
  mira-gpt:
    api: https://your-bridge.example.com/v1
    key_env: MIRA_BRIDGE_KEY
    transport: codex_responses
model:
  provider: custom:mira-gpt
  default: gpt-5.6-luna
```

经过 sub2 时先确认该路由/分组确实支持 Responses，不能将 Messages 分组简单当作 Responses 分组。不要把 `/messages`、`/responses` 或 `/chat/completions` 整段端点当作 base URL。

Hermes 官方文档列出的传输名称为 `chat_completions`、`anthropic_messages`、`codex_responses`；旧版 `custom_providers` 格式对应字段是 `api_mode`，新版 `providers` 对应字段是 `transport`。要按安装版本使用，不应不看原文件就整体覆盖。[官方 provider 配置](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md)

配置后重新启动 Hermes。仍然报错时提供模型名、Hermes 版本、provider/api/transport（隐去密钥）以及出错时间。bridge 0.7.1 的流日志与错误分类见 [STREAM-TROUBLESHOOTING.md](STREAM-TROUBLESHOOTING.md)。本文配置依据官方源码/文档核对，未在你的 Hermes 实例上实测。
