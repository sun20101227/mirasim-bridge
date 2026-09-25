# 保持原版 sub2api 的容器部署（0.6.0）

本方案只部署独立的 Mirasim bridge，通过 sub2api 原有管理 API 注册普通上游账号；不升级 sub2api、不加载 `.s2plugin`，也不改变 Quota Keeper 的插件绑定。

希望以后直接联网升级，按 [NETWORK-DEPLOY.md](NETWORK-DEPLOY.md) 接入部署接口。bridge 运行后可打开 `/panel` 使用专用管理后台，见 [PANEL.md](PANEL.md)。以下初始化步骤只用于新安装；新增独立 Google/邮箱登录、每账号容器及 sub2 分组见 [ACCOUNTS.md](ACCOUNTS.md)。真实剩余额度在页面或账号列表备注列查看。

默认用 Anthropic API Key 账号承接 Claude、GPT、DeepSeek、Kimi 的 Messages 请求。桥接器另有 GPT Responses 接口，但现有 Anthropic 分组不会自动变成 OpenAI 分组，详见 MULTI-MODEL.md。

## 上传后准备

上传 `mirasim-bridge-0.6.0-linux-private.zip`，解压到一个新目录：

```bash
umask 077
mkdir -p ~/mirasim-0.6.0
unzip ~/mirasim-bridge-0.6.0-linux-private.zip -d ~/mirasim-0.6.0
cd ~/mirasim-0.6.0/mirasim-bridge
sha256sum -c SHA256SUMS
docker version
docker compose version
```

服务器只需 Docker Engine 和 Compose，Node 在镜像中。私有包含 `private/setting.json` 和 `private/admin-key`；源码包用户自行提供这两个文件，登录凭证须先按 RELAY.md 在原机器导出。不得把私有包公开上传。

如果之前已运行 systemd 版 **mirasim-bridge**，先停它，避免两个桥接器同时管理同名账号：`sudo systemctl stop mirasim-bridge`。这不需要停止 sub2api。

## A. sub2api 本身运行在 Docker 中

查到当前 sub2api 容器名和所在网络：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}'
docker inspect 你的sub2api容器名 --format '{{json .NetworkSettings.Networks}}'
cp .env.example .env
```

编辑 `.env`，把 `SUB2API_NETWORK` 换成上一步看到的实际网络名，例如 `sub2api_default`。其他字段默认即可，里面只填文件路径，不填真实密钥。

新服务加入已有网络，原版 sub2api 通过 `http://mirasim-bridge:8787` 访问它。另建的 egress 网络只供桥接器出站访问 relay/auth，默认不发布宿主机端口；不需要更改 sub2api 的 Compose 文件。此模式要求用户自定义 Docker 网络，不能用缺少服务名解析的默认 `bridge` 网络。参见 [Docker 网络说明](https://docs.docker.com/compose/how-tos/networking/)。

```bash
docker compose config --quiet
docker compose build bridge

# 仅首次初始化；只复制/校验本地文件，不创建线上账号、不发推理请求
docker compose run --rm setup \
  --sub2api-url https://sub2api.example.com \
  --group-id 15 --account-name mirasim-cloud

docker compose up -d bridge
docker compose logs -f --tail=100 bridge
```

分组 15 是本项目原有环境的配置；其他服务器替换为实际 anthropic/composite 分组 ID。这里的 `--sub2api-url` 是桥接器访问管理 API 的地址，不是注册给 sub2api 的上游地址。容器内不能用 `localhost` 代指另一个容器。

`setup` 是按需运行的 profile 服务，只进行本地初始化；普通 `up -d bridge` 不会再次执行它。显式运行带 profile 的服务不需要另外开启整个 profile，见 [Compose profiles](https://docs.docker.com/compose/how-tos/profiles/)。

## B. sub2api 是 Linux 本机原生进程

使用独立的 `compose.host.yaml`，不要与 compose.yaml 合并：

```bash
docker compose -f compose.host.yaml build bridge
docker compose -f compose.host.yaml run --rm setup \
  --sub2api-url https://sub2api.example.com \
  --group-id 15 --account-name mirasim-cloud
docker compose -f compose.host.yaml up -d bridge
docker compose -f compose.host.yaml logs -f --tail=100 bridge
```

该文件使用 Linux host 网络，桥接器只监听 `127.0.0.1:8787`，原生 sub2api 可访问同一个回环地址。后续操作均带 `-f compose.host.yaml`。不要同时启用 A、B；初始化会拒绝与已有配置不一致的监听方式。首次要确认宿主 8787 没被其他服务占用。

## 验收

```bash
docker compose ps
docker compose exec bridge node /app/scripts/healthcheck.js --ready
docker compose exec bridge node /app/mirasim-bridge.js status --config /data/config.json
docker compose exec bridge node /app/mirasim-bridge.js models --config /data/config.json
docker compose exec bridge node /app/mirasim-bridge.js quota --config /data/config.json
```

两种健康检查含义不同：

- Docker 内置探针请求鉴权后的 `/__live`，只证明进程可响应，不访问上游、扫描会话或消耗额度。
- `healthcheck.js --ready` 请求 `/__health`，表示当前目标就绪且不处于本地冷却。
- `status` 的 `sub2api.managed=true`、`reachable=true`、`schedulable="on"` 才表示自动调度已接管、反向可达并已恢复调度；Docker 显示 healthy 不等于账号已入池。

日志应出现模型同步成功和 `sub2api RESUME 成功`。如果反向可达性不通过，账号保持暂停，检查网络名、容器 DNS、sub2api 私网访问策略和密钥。三个当前不可用的 DeepSeek 型号默认排除；模型出现在列表中仍不代表有可用容量。

最后可选择一个实时列表里的型号做真实请求验收，例如：

```bash
docker compose exec bridge node /app/mirasim-bridge.js test \
  --config /data/config.json --model gpt-5.6-luna
```

test 会产生模型用量；普通 status/models/quota 不发送推理请求。

## 凭证、升级和停止

`setup` 把凭证和配置写入项目的持久化 `data` 卷；运行服务以 UID/GID 1000 执行，根文件系统只读，只把 `/data` 留作凭证续期、state 和可选失败日志的存储。挂载整个目录支持原子替换，不能把 setting.json 单文件只读挂载后期待续期。卷生命周期参考 [Docker volumes](https://docs.docker.com/engine/storage/volumes/)。

重复 setup 保留已存在的配置、bridge_secret 和刷新后的 token，即使传入了不同参数也不覆盖。改变参数需停服务并明确编辑配置，不能用旧上传凭证覆盖已轮换的 token。

升级：将新版源码放进新目录，把原 `.env` 复制过去（保留相同 Compose 项目名 `mirasim-bridge`，以复用数据卷），执行：

```bash
docker compose stop bridge
docker compose build bridge
docker compose up -d bridge
```

**不要再次初始化，不要执行 `down -v` 删除数据卷。** 新目录可以不带原始 private 文件；setup profile 未运行时，常规 bridge 服务只使用已保存的数据卷。

备份配置或修改配置时，文件含管理 Key，需要保持私有：

```bash
docker compose stop bridge
docker compose cp bridge:/data/config.json ./container.config.json
# 编辑 container.config.json，保留 relay.setting_json="setting.json"
# 以运行用户验证并原子写入，避免 docker cp 改变文件属主
cat container.config.json | docker compose run -T --rm --no-deps \
  --entrypoint node bridge /app/scripts/container-config.js
docker compose up -d bridge
```

停止只作用于桥接器：`docker compose stop bridge`。Compose 等待 180 秒，应用默认最多 150 秒，期间暂停账号并排空请求。若管理 API 不可达，应到 sub2api 后台核对账号暂停状态。正常退出/故障恢复均不操作 Quota Keeper。

只运行一个 bridge 副本，避免同一账号被多个调度循环争用、同一凭证被跨容器并发刷新。宿主 Docker 重启后的进程恢复使用 restart policy；Docker 的 unhealthy 状态本身不会自动重启容器。若收到 `Cannot persist refreshed credential`，优先恢复卷的空间和权限，让当前进程保存新 token。

## 验证边界

初始化与健康检查使用本地文件/HTTP 回归验证；Compose 模板使用官方 CLI 离线解析验证。当前工作机没有 Docker Engine，未实际 build/run 镜像，也未在 Linux 服务器验证卷权限、DNS、SIGTERM 和真实流量。不能把配置解析通过等同于生产验收。
