# 第三方实现与许可

本项目 0.4.0 的 `lib/relay.js`、`lib/responses.js` 和 `tests/relay.test.js` 参考并移植了
[KIDA-MNESIA/cpa-plugin-mirasim](https://github.com/KIDA-MNESIA/cpa-plugin-mirasim) 的协议与响应处理逻辑。

- 研究版本：`d1a25283709ba6920e2bcc2aec3ccf624803c212`（2026-09-25 拉取）。
- 主要来源：`internal/mirasim/protocol.go`、`client.go`、`internal/executor/codex.go`、`compact.go`、`internal/credentials/storage.go`。
- 两个固定密码学测试向量来源：`internal/mirasim/protocol_test.go`，不包含真实凭证。
- 上游采用 MIT License，完整声明随本项目保留在 [licenses/cpa-plugin-mirasim.txt](licenses/cpa-plugin-mirasim.txt)。

这里是 Node.js 协议移植，不加载该仓库的原生 `.so/.dll`，也不需要 CLIProxyAPI、Go 或 C 编译器。
0.5.0 的 `lib/login.js`、`scripts/account-login.js` 还参考同一版本上游的 OAuth provider discovery、回调 token 接收和独立设备密钥流程；沿用上述 MIT 许可声明，未复制其网页登录页面。
Responses 请求规范化还参考 [CLIProxyAPI v7.3.17 的 Responses→Codex 转换器](https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.17/internal/translator/codex/openai/responses/codex_openai-responses_request.go)，其 MIT 许可保留在 [licenses/CLIProxyAPI.txt](licenses/CLIProxyAPI.txt)。
没有包含 CPA 管理面板、插件 ABI、OAuth 网页、图片生成与协议间翻译器。
`scripts/export-credential.js` 的 `mrs1` 兼容格式另由本机 Mirasim 后端行为核对；仅导出当前用户的 Mirasim 账号凭证，不导出其他 provider 密钥。
