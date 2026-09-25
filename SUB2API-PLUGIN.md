# Mirasim 的 Sub2API 插件适配结论

**已选择的方向：保持原版 sub2api，采用独立桥接组件。** 0.4.2 已提供配套容器部署，见 DOCKER.md。下文原生插件及宿主改造部分保留为调查记录，不属于当前实施范围。

检查日期：2026-09-25。本文件是兼容性调查与交付范围说明，尚未生成可用 `.s2plugin`，没有替换线上程序或更改已安装插件。

## 当前环境

通过现有管理 API 只读查询：服务器版本为 **0.2.8**，插件管理接口可用，**Yachiyo Quota Keeper 1.0.2** 已启用，占用 `openai.oauth.outbound_transport.v1`。

同时检查官方源码：

- 官方 `v0.2.8` 标签：`d7a82d78ca51d42be41cb4daa3510ea401defe9f`。
- 调查时 main：`a3eb7ef302961cba716dc78b39b93b60c467db0e`。
- 契约：[插件 README](https://github.com/Wei-Shaw/sub2api/blob/v0.2.8/backend/pkg/pluginapi/README.md)、[开发指南](https://github.com/Wei-Shaw/sub2api/blob/v0.2.8/backend/pkg/pluginapi/docs/development.md)。

线上仅核对公开管理接口返回值，未取得线上二进制或其定制源码；版本号不能证明与官方源码逐字一致。

## 为什么不能直接打包现有 bridge

官方宿主目前仅接受 `openai.oauth.outbound_transport.v1`，并在清单校验、转发选择、HostService 账号范围三个位置限定 `platform=openai`、`account_type=oauth`。

现有 bridge 使用 Anthropic API Key 账号承接四模型系列的 Messages，另有 GPT Responses 入口，并独立维护 Mirasim access/refresh token、设备票据、签名与配额。API Key 路径及其他平台并不进入现有插件钩子；官方也没有在此契约中开放新 provider 的登录和刷新生命周期。

此外，现有路由只允许一个 OpenAI OAuth 出站插件启用。把 Mirasim 强行包装成该能力，既覆盖不了原有 Messages 链路，也会与已经启用的 Quota Keeper 冲突。

相关源码入口：

- `backend/internal/service/plugin_manifest.go`：只接受上述能力与账号类型。
- `backend/internal/service/plugin_manager.go`：启用互斥、`ShouldRouteOpenAIOAuth`、单个出站路由。
- `backend/internal/service/openai_plugin_transport.go`：OpenAI OAuth 请求的实际接入点。
- `backend/internal/service/plugin_host_services.go`：插件能力决定其可见账号范围。
- `backend/pkg/pluginapi/v1/plugin.proto`：目前只有传输/配置/状态等 RPC，没有完整的第三方 provider 生命周期。

## 可选交付方式

| 方式 | 能获得什么 | 需要接受什么 |
|---|---|---|
| 原生 `.s2plugin` + Sub2API 宿主适配版 | 后台安装、启停、配置 Mirasim；保留 Claude/GPT/DeepSeek/Kimi；单独能力和路由，与 Quota Keeper 共存 | 需要替换为适配后的宿主镜像/二进制，并维护与上游版本的兼容 |
| 保持原版 + bridge 配套管理入口 | 复用已有转发实现、独立部署升级，宿主仍按 API Key 上游接入 | 这是外部组件和后台入口，不是由原生插件框架完整管理的 provider |

## 原生方案所需的具体改动

1. 为 Mirasim 引入独立的 provider 能力契约及账号绑定，不占用 OpenAI OAuth 出站能力；扩展清单、运行时校验、路由索引与账号可见范围。
2. 将 Messages 和 Responses 两条链路接入对应插件，继续由宿主处理账号选择、流式输出、用量与计费；不以伪造 OpenAI OAuth 账号绕开限制。
3. 明确 Mirasim 凭证导入、加密存储、续期、模型发现、额度状态和多实例锁的归属。迁移现有刷新代码时不能让宿主和插件同时刷新同一凭证。
4. 插件 UI 提供账号/凭证导入、连接检查、模型与额度、运行状态；通过宿主 UI Bridge 通信，不把管理员 Key 塞进 iframe。
5. 提供 Linux amd64/arm64 独立运行时、manifest 哈希、Ed25519 发布者签名；插件包不内置真实用户凭证、管理员 Key 或签名私钥。
6. 用适配后的真实宿主验证安装/升级/停用/回滚、四系列路由、断流、续期、计费，以及与 Quota Keeper 同时启用的行为。

单纯制作 manifest 或把现有 ZIP 改成 `.s2plugin` 后缀，不满足上述条件，不能称为可用插件。
