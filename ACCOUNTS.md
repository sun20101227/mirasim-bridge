# 独立 Mirasim 账号与 sub2api 分组

## 0.8.0：托管到同一个 bridge（推荐）

从 0.8.0 起，多个 Mira 账号**不需要各自一个容器**。主 bridge 同时持有多个账号的凭证，sub2api 里每个账号仍是独立的 `platform=anthropic / type=apikey` 账号，但它们的 `base_url` 都是主 bridge 的地址；sub2api 转发请求时带上该账号的 `api_key`（即该 profile 的 `bridge_secret`），bridge 按这个密钥选择用哪个 Mira 凭证去签名。每个账号有自己的额度快照、调度状态机、并发上限、模型策略和计数。

网页操作：

1. “账号管理 → 新增账号”，填 profile、sub2 账号名、分组 ID，保持“托管到当前 bridge”勾选，用邮箱验证码或 Google 授权完成登录。
2. 页面会自动托管并注册到 sub2，几秒后在概览的“全部 Mira 账号”里显示为“已入池”（首次可能等 1-2 轮健康检查）。
3. 顶部“当前账号”选择器或点击一览中的行，可以切换查看/设置某个账号；“暂停调度”会把它立即摘出池子直到手动恢复。
4. 已经用命令行登录、只保存了凭证的 profile，在 profiles 列表点“托管到当前 bridge”即可。

命令行等价操作：编辑主配置 `/data/config.json` 的 `accounts.hosted`（如 `["second","third"]`）后重启容器；profile 目录必须已有 `setting.json` 和 `config.json`。托管账号会覆盖自身配置里的 `listen`、`sub2api.public_base_url` 和 sub2 管理连接为主配置的值，其余（凭证、`bridge_secret`、`sub2api.account_name`/`group_ids`/`concurrency`、`forward.*`、`constraints.*`）保持 profile 自己的。

限制：托管只在 `backend=relay` 下可用；同一个 profile 不能同时以容器和托管方式运行（会互相覆盖同名 sub2 账号的 base_url）；两个账号的 `bridge_secret` 或 sub2 账号名相同会被拒绝加载。

下面各节是 0.5.0–0.7.x 的独立容器方式，仍然可用，适合需要与主 bridge 进程隔离的场景。

0.7.0 支持用 Google 或邮箱验证码登录第二个 Mirasim 账号。每个 profile 单独保存凭证、设备密钥、bridge_secret、sub2api 账号名，并运行一个 bridge 进程。代码不会调用原账号的退出接口，也不会覆盖原账号或桌面的 setting.json；上游自己的会话政策仍由 Mirasim 决定。

网页后台中的“邮箱验证码”使用客户端实际使用的 `POST /auth/code` → `POST /auth/verify` 流程；它不是 OAuth 回调。输入邮箱后收验证码，再输入验证码完成新 profile 保存。

## 1. 升级原 bridge

已部署用户先按 [UPGRADE-0.5.0.md](UPGRADE-0.5.0.md) 更新到 0.5.0。以下 Docker 步骤适用于 [DOCKER.md](DOCKER.md) 的 A 方案：sub2api 与 bridge 在同一个自定义 Docker 网络。所有命令在原来的 `mirasim-bridge` 目录运行，无需停止 sub2api。

## 2. 登录第二个 Google 账号

保持原 bridge 运行，在服务器交互终端执行（不要加 `-T`）：

```bash
docker compose exec -it bridge node /app/mirasim-bridge.js login \
  --config /data/config.json \
  --profile second --provider google \
  --account-name mirasim-second --group-id 15 \
  --public-base-url http://mirasim-second:8787
```

`15` 是本项目原有环境的分组 ID。确认它仍存在且为 anthropic/composite；要隔离用量，在 sub2api 后台先创建另一个相应平台分组，再填新 ID。

1. 在自己电脑浏览器的**无痕窗口**打开终端打印的授权地址。
2. 选择另一个 Google 账号，完成 Mirasim 授权。
3. 浏览器最终跳到 `http://127.0.0.1:端口/callback/...`。服务器登录时该页面通常打不开，因为它指向浏览器所在电脑。复制地址栏的**完整最终 URL**。
4. 返回正在等待的服务器终端，粘贴并回车。输入会隐藏；不要粘贴到 shell 命令行、聊天或工单。等待最多 15 分钟。
5. 看到“已保存独立 profile: second”后再启动容器。若 relay 检查暂未通过，凭证仍保留，先检查网络/账号状态，不必重复登录。

原 `/data/setting.json` 保留，新文件为 `/data/profiles/second/setting.json` 与 `config.json`。同名 profile 会被拒绝覆盖。再次选择同一个 Google/Mira 账号不会获得独立额度。

```bash
docker compose exec bridge node /app/mirasim-bridge.js accounts --config /data/config.json
```

## 3. 保存配置并启动独立容器

先查原 bridge 的实际数据卷名：

```bash
docker inspect "$(docker compose ps -q bridge)" \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}'
```

标准部署输出 `mirasim-bridge_data`。如果不同，把下面的卷名改成实际值；如果输出为空，说明是自定义绑定目录，不能直接套用此卷模板。

下面配置文件只创建一次；以后直接使用保存的 `.env.second`：

```bash
cp .env .env.second
cat >> .env.second <<'ENV'

MIRASIM_PROFILE=second
MIRASIM_PROFILE_ALIAS=mirasim-second
MIRASIM_DATA_VOLUME=mirasim-bridge_data
ENV
chmod 600 .env.second
docker compose --env-file .env.second -f compose.profile.yaml config --quiet
docker compose --env-file .env.second -f compose.profile.yaml up -d bridge
docker compose --env-file .env.second -f compose.profile.yaml logs -f --tail=100 bridge
```

`.env.second` 保留 `.env` 中的真实 `SUB2API_NETWORK`。profile 对应登录时的名称，alias 必须与 `--public-base-url` 主机名相同。独立容器使用同一镜像和数据卷中的不同目录：各自使用独立凭证和状态，但共享卷不构成容器间的凭证安全隔离。不要同时运行两个相同 profile 的 worker。

## 4. sub2api 里如何添加、如何选择账号

**启动成功后自动添加账号，不需要手动新建或复制 token/API Key。** 自动注册依赖主配置中已有的 sub2api 管理 Key。每个 profile 对应一个独立的 `platform=anthropic`、`type=apikey` 账号：

| Mira 登录 | sub2api 账号名 | 上游 base_url | 分组示例 |
|---|---|---|---|
| 原账号 | `mirasim-cloud` | `http://mirasim-bridge:8787` | 原绑定保持不变 |
| 第二个账号 | `mirasim-second` | `http://mirasim-second:8787` | 15 |
| 第三个账号 | `mirasim-third` | `http://mirasim-third:8787` | 15 或新分组 |

- **共用池：**账号加入同一分组，sub2api 按自身策略调度，不保证均匀轮询。客户端使用绑定该分组的用户 API Key。
- **分别调用：**后台创建不同的 anthropic/composite 分组，分别绑定相应账号，再创建绑定不同分组的用户 API Key。客户端通过 Key 选择池。管理 Key 不用于模型调用。
- **已有账号改分组：**在 sub2api 后台调整，bridge 默认保留既有账号分组。`--group-id` 用于新账号初次注册。仅克隆原 sub2 账号会继续指向同一个 Mira 登录，仍共享原额度。

第三个账号重复第 2、3 步，换成 `third`、`mirasim-third`、`.env.third`。账号名与 DNS 别名必须唯一。已有 Anthropic 账号不会自动提供 OpenAI 分组路由；GPT 原生 Responses 接入见 [MULTI-MODEL.md](MULTI-MODEL.md)。

查看第二个账号状态和额度：

```bash
docker compose --env-file .env.second -f compose.profile.yaml exec bridge \
  node /app/mirasim-bridge.js status --config /data/profiles/second/config.json
docker compose --env-file .env.second -f compose.profile.yaml exec bridge \
  node /app/mirasim-bridge.js quota --config /data/profiles/second/config.json
```

预期 `sub2api.managed=true`、`reachable=true`、`schedulable="on"`；首次启动可能等待几轮健康检查。后台账号 base_url 应各不相同。容器 healthy 不等于已入池。

## 5. 查看真实剩余额度

后台“账号管理”的列设置勾选 **备注 / Notes**（原版默认隐藏）。bridge 每 5 分钟更新各受管账号备注中的 `[mirasim-quota]` 区块，保留区块外的手写备注。里面显示剩余额度/百分比、重置时间和更新时间；查询失败标记数据可能过期。具体窗口以 Mira `/v1/limits` 为准。

原版 sub2api 的额度条表示本地计费限额，不等同于 Mira 剩余额度。本方案显示在备注列，不修改 sub2api 或 Quota Keeper。手动克隆且无独立 worker 的账号不会自动收到备注更新。

## 6. 停止、启动和升级

```bash
docker compose --env-file .env.second -f compose.profile.yaml stop bridge
docker compose --env-file .env.second -f compose.profile.yaml start bridge
# 更新源码并重新构建主镜像后，重建独立容器
docker compose --env-file .env.second -f compose.profile.yaml up -d --force-recreate bridge
```

停止第二个 worker 会尝试暂停其 sub2 账号，原 worker 继续运行。管理 API 故障时需后台确认暂停。不要删除 data 卷；删除 profile 前先停其 worker，再删除对应 sub2 账号和 profile 目录。

## 原生 Linux / systemd

bridge 和 sub2api 都原生运行在同一主机时，使用默认安装目录与用户：

```bash
sudo -u mirasim -H node /opt/mirasim-bridge/mirasim-bridge.js login \
  --config /opt/mirasim-bridge/config.json --profile second \
  --account-name mirasim-second --group-id 15 --port 8788 \
  --public-base-url http://127.0.0.1:8788
sudo cp /etc/systemd/system/mirasim-bridge.service /etc/systemd/system/mirasim-second.service
sudo sed -i 's|^ExecStart=.*|ExecStart=/usr/bin/node /opt/mirasim-bridge/mirasim-bridge.js serve --config /opt/mirasim-bridge/profiles/second/config.json|' /etc/systemd/system/mirasim-second.service
sudo systemctl daemon-reload
sudo systemctl enable --now mirasim-second
sudo journalctl -u mirasim-second -f
```

如果原 service 不是 `/usr/bin/node`，新 ExecStart 使用原 Node 路径。确保 8788 空闲；第三个账号另用 8789。独立文件必须由服务用户创建，以便自动保存刷新后的 token。

如果用 DOCKER.md 的 B 方案（bridge 容器 host 网络、sub2 原生），使用配套的 `compose.profile.host.yaml`：第 2 步主容器命令加 `-f compose.host.yaml`，登录参数加 `--port 8788`，并将 `--public-base-url` 改成 `http://127.0.0.1:8788`。第 3 步查主数据卷时也加 `-f compose.host.yaml`；后续独立容器命令把 `-f compose.profile.yaml` 换成 `-f compose.profile.host.yaml`。`.env.second` 中的 alias 在 host 模式不使用；新 profile 继承主配置的回环监听方式。第三个账号改用其他端口。

真实第二个 Google 账号登录和 Linux 容器运行仍需服务器验收；本地自动测试覆盖模拟 OAuth、原配置不变、独立凭证、额度同步和请求隔离。
