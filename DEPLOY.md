# Linux 服务器部署操作说明（0.6.0）

希望保持原版 sub2api、用配套 Docker 容器部署时，优先看 [DOCKER.md](DOCKER.md)。下面保留 systemd 安装方式。

适用于安装了 systemd 的 Linux 主机。以下使用 sub2api 管理地址 `https://sub2api.example.com`、分组 `15`、账号名 `mirasim-cloud`。这些是已有环境的历史配置，安装时 doctor 会重新检查，不固定账号 ID 或模型数量。

新安装默认使用 **relay 直连，不需要 Electron、server.cjs 或 Claude CLI**。支持 Claude、GPT、DeepSeek、Kimi 的 Messages，以及 GPT 原生 Responses/compact。已有分组 15 和账号继续作为 Messages 上游，Responses 需要客户端直连桥接器或在 sub2api 另配相应协议路由。详见 [RELAY.md](RELAY.md) 和 [MULTI-MODEL.md](MULTI-MODEL.md)。

## 1. 选择并上传压缩包

- `mirasim-bridge-0.6.0-source.zip`：源码、测试和文档；账号凭证需要另行提供。
- **`mirasim-bridge-0.6.0-linux-private.zip`**：已带导出的可迁移账号凭证和 sub2api 管理 Key，默认不附带 server.cjs。它含真实凭证，不要公开分享。

Windows PowerShell：

```powershell
scp .\dist\mirasim-bridge-0.6.0-linux-private.zip 用户名@服务器IP:~/
```

服务器终端：

```bash
umask 077
mkdir -p ~/mirasim-upload
chmod 700 ~/mirasim-upload
unzip ~/mirasim-bridge-0.6.0-linux-private.zip -d ~/mirasim-upload
cd ~/mirasim-upload/mirasim-bridge
sha256sum -c SHA256SUMS
chmod 600 private/setting.json private/admin-key
```

每个校验项应显示 OK。若解压目录已经有旧版本，改用新的目录，避免混合文件。

## 2. 准备依赖

```bash
node -v
systemctl --version
```

桥接器需要 Node ≥18，Node 必须对服务用户可执行，不能只装在 `/root/.nvm`。服务器须能直接访问 `relay.mirasim.ai` 和 `auth.mirasim.ai` 的 HTTPS；当前直连后端不实现出站 HTTP/SOCKS 代理。无需 npm install。

只有选择旧的 `--backend session` 时，才另外安装 Claude CLI：

```bash
sudo npm install -g @anthropic-ai/claude-code
```

session 模式脚本不自动更新外部 CLI，CLI 同样必须对服务用户可执行。

Google 登录无需密码：私有 ZIP 已在原机将 `mrs1:` 加密字段导出成可迁移凭证，Linux 不需要 Windows 的 secret.key。**不要直接复制旧桌面加密 setting.json**；源码包用户先按 RELAY.md 导出。Linux 真机仍需完成本说明的验收。

先跑不消耗模型额度的本地自测：

```bash
node mirasim-bridge.js selftest
node --test tests/*.test.js
```

## 3. 确认 sub2api 从哪里访问桥接器

| sub2api 的运行位置 | 桥接配置 |
|---|---|
| 本机原生进程，或使用 host 网络的容器 | 默认 `127.0.0.1:8787` 可用 |
| 本机普通 Docker 容器 | 容器的 127.0.0.1 是它自己；必须配置宿主机可达地址 |
| 另一台服务器 | 配置双方可达的内网地址，或经过认证的 HTTPS 隧道/反代地址 |

`sub2api.base_url` 是管理 API 地址；`sub2api.public_base_url` 是 **sub2api → 本桥接器** 的地址。两者不要混淆。管理地址使用公网域名也可能是同一台服务器。

Docker 场景可在 sub2api 的 Compose 服务中添加：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

按原部署方式重建该容器，让配置生效。安装桥接器时额外传入：

```bash
--listen-host 0.0.0.0 --public-base-url http://host.docker.internal:8787
```

这两个选项加在下一节的安装命令后面。确认宿主防火墙只允许 sub2api 所在网络访问 8787，不要直接对整个公网开放。若 sub2api 自身禁止访问私网地址，需要调整其上游访问策略；错误会在 sync-upstream 中体现。

## 4. 安装（暂不启动）

原生同机部署：

```bash
sudo bash install.sh \
  --backend relay \
  --setting-json "$PWD/private/setting.json" \
  --admin-key-file "$PWD/private/admin-key" \
  --sub2api-url https://sub2api.example.com \
  --group-id 15 \
  --account-name mirasim-cloud
```

源码包用户将凭证和管理 Key 路径换成自己的文件。也可省略 `--admin-key-file`，安装器会在终端隐藏输入管理 Key。旧 session 模式增加 `--backend session --server-cjs /path/to/server.cjs`；要从 Windows 附带此文件，打包加 `-IncludeSessionBackend`。

安装器创建用户 `mirasim`，新用户 HOME 为 `/var/lib/mirasim`，应用目录为 `/opt/mirasim-bridge`。已有同名用户则使用其现有 HOME 和主组。配置和登录态权限为 600，bridge_secret 自动随机生成。

安装最后以服务用户执行 doctor。relay 模式应通过凭证与签名模型列表检查，不检查活会话。修复 FAIL 后再启动；旧账号模型不一致可能在首次成功同步后解决。脚本失败不代表没有安装文件，**不会自动启动服务**。

重复安装保留 config.json 与现有登录态，CLI 参数不会覆盖已有配置。需要更换登录态时显式加 `--replace-setting`，旧文件会备份。

## 5. 启动与验收

```bash
sudo systemctl enable --now mirasim-bridge
sudo journalctl -u mirasim-bridge -f
```

关注：直连模式启动 → 监听成功 → relay 初始探测 HTTP 200 → 模型同步成功 → `sub2api RESUME 成功`。默认检查周期 30 秒、驻留时间 60 秒，预留几分钟。Ctrl-C 只退出日志查看。

状态端点也需要密钥。下面直接在服务用户内部读取配置，不把密钥打印到终端：

```bash
sudo -u mirasim -H node - <<'NODE'
const http = require('http');
const c = require('/opt/mirasim-bridge/config.json');
const host = ['0.0.0.0', '::'].includes(c.listen.host) ? '127.0.0.1' : c.listen.host;
for (const path of ['/__health', '/__status', '/v1/models']) {
  const r = http.get({host, port:c.listen.port, path, headers:{'x-api-key':c.bridge_secret}}, res => {
    let s=''; res.on('data', d=>s+=d);
    res.on('end', ()=>console.log(path, res.statusCode, s));
  });
  r.setTimeout(15000, ()=>r.destroy(new Error('timeout')));
  r.on('error', e=>{ console.error(path, e.message); process.exitCode=1; });
}
NODE
```

relay 模式预期：health 200、backend=relay、relay.ready=true、keepalive.enabled=false、模型列表非空。session 模式检查 keepalive.ready=true、target.is_keepalive=true。模型数量随上游变化。

查看其他系列并单独检测（检测会消耗真实额度）：

```bash
sudo -u mirasim -H node /opt/mirasim-bridge/mirasim-bridge.js models --family gpt
sudo -u mirasim -H node /opt/mirasim-bridge/mirasim-bridge.js quota
sudo -u mirasim -H node /opt/mirasim-bridge/mirasim-bridge.js test --model gpt-5.6-luna
sudo -u mirasim -H node /opt/mirasim-bridge/mirasim-bridge.js test --model kimi-k3
```

型号以当前 `/v1/models` 为准。0.5.0 默认排除三个实测不可用的 DeepSeek 型号；Kimi 仍可能超过测试默认 30 秒上限。不要用“模型出现在列表里”代替真实请求验收。独立账号登录及后台额度备注显示见 [ACCOUNTS.md](ACCOUNTS.md)。

再进 sub2api 后台确认 `mirasim-cloud` 账号可调度，模型为桥接器过滤后的列表。使用**sub2api 用户 API Key**从外部客户端发一条 `/v1/messages` 请求，并查看实际命中的账号；这是最终业务验收，会产生真实用量。管理 Key 不是网关调用 Key。

## 6. 日常维护、升级和回退

```bash
sudo systemctl status mirasim-bridge --no-pager
sudo journalctl -u mirasim-bridge --since '10 min ago' --no-pager
sudoedit /opt/mirasim-bridge/config.json
sudo systemctl restart mirasim-bridge
```

重新体检（默认安装路径和用户）：

```bash
sudo -u mirasim -H sh -c 'cd /opt/mirasim-bridge && node mirasim-bridge.js doctor'
```

如果使用了非标准 Node/CLI 路径，此命令的 PATH 要与 `systemctl cat mirasim-bridge` 中相同。

升级前保存旧源码包，并备份 config.json 和实际使用的凭证文件。先 `sudo systemctl stop mirasim-bridge`，再从新包运行 `sudo bash install.sh`；自定义用户需继续传 `--user`。无需重传凭证或管理 Key，脚本检查当前生效的凭证，并拒绝覆盖正在运行的服务。安装后重新启动并验收。回退同理，但旧安装器仍可能要求原安装参数。

从旧版升级时，若 config.json 有 `constraints.model_filter: "^claude-"`，必须改成 `"^(claude-|gpt-|deepseek-|kimi-)"`。否则旧配置优先于新默认值，仍然只会看到 Claude。

从 0.3.0 切换直连：停服务，将 config.json 顶层加入 `"backend":"relay"`，用新版私有包的凭证加 `--replace-setting` 安装，再启动。安装器会保留旧 backend，因此仅传 `--backend relay` 不会自动迁移已有配置。保持 session 则仍需 server.cjs 和 Claude CLI。

停服先关闭监听，再暂停账号、排空请求并结束保活。应用总上限为 `shutdown.total_timeout_sec`（默认 150 秒），包括注册/暂停/drain；systemd 默认 180 秒。安装器会生成至少比应用总上限多 15 秒的 `TimeoutStopSec`；手工改配置后也要同步调整 unit。管理 API 不可达时，检查后台并手动暂停账号。

需要长期暂停时用 `systemctl stop`；单独 `pause` 可能被自动健康循环恢复。

## 排障

升级若设置了 `relay.setting_json`，安装器使用该绝对路径或相对安装目录的路径；只有显式 `--replace-setting` 才备份并替换。父目录必须允许服务用户写入，以便原子保存新 token。本轮审查和未验收范围见 [AUDIT.md](AUDIT.md)。

| 现象 | 检查 |
|---|---|
| `Encrypted mrs1 credential` | 使用新版私有包内导出的凭证；旧桌面加密文件不能单独迁移 |
| `Cannot persist refreshed credential` | 先修复磁盘空间/目录权限，保留当前进程让新 token 完成保存，不要立即重启 |
| `Credential refresh locked` | 先停所有使用同一凭证的 bridge，确认无刷新进程后删除凭证旁遗留的 .refresh-lock |
| GPT Responses 400 | 核对客户端是否使用 Responses，compact 禁用流式；不支持 Chat Completions |
| `claude` 不可执行 | root 私有安装目录、服务用户 PATH/权限；不要通过改成 root 运行解决 |
| 有进程但无端口/会话 | `/proc` 权限、CLI 的 settings 传递方式；桥接器和保活必须同用户 |
| 每分钟保活重启 | journal 子进程报错；登录态失效、缺模块、CLI 参数变化等，不能一概认定为 token 错误 |
| 本地 200，sync-upstream 失败 | 容器网络、public_base_url、防火墙、sub2api 的私网访问限制 |
| `/__status` 返回 503 | 检查 bridge_secret；状态接口已改为鉴权 |
| 429/529 后暂时 503 | 本地退避，等待 Retry-After，不要循环重启 |
| 400 请求形状错误 | 查看兼容规则；必要时临时启用 forward.log_failures，排障后关闭 |
| 流式响应停住后断开 | 默认无活动 300 秒超时；按上游实际特性调整 idle timeout |
| 已有配置不随安装参数变化 | 这是保留策略；编辑 config.json 后重启 |
| DeepSeek 出现在列表但返回 no upstream available | 上游当前无该型号路由；不应通过重启保活或替换成 Claude 来掩盖 |

私有 ZIP、解压出的 `private/` 和备份都包含有效凭证。确认安装成功后，从上传目录移除不再需要的凭证副本，或存入仅自己可访问的备份位置。请求日志可能包含对话内容，分享排障输出前检查敏感字段。
