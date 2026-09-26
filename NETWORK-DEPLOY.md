# 网络部署与远程升级接口（0.6.0）

**希望在对话或 GitHub 直接触发，且没有 SSH：**使用 0.6.1 的 [主动读取指令功能](REMOTE-CONTROL.md)。旧工具需通过网页终端接入一次；下面的本机 API 继续保留。

本版提供宿主机部署接口。服务器只需接入一次，以后调用接口即可拉取发布镜像并重建 bridge，不用反复上传 ZIP，也不需要在服务器安装 Node 或构建镜像。部署工具需要 Python 3.10+、Docker Engine、Compose V2 和 systemd。

**发布仓库：[sun20101227/mirasim-bridge](https://github.com/sun20101227/mirasim-bridge)。** 下方已填写真实发布地址。服务器仍需执行一次接入命令；发布代码不会自动操作服务器。

## 1. 建立固定发布源

把本项目源码放进你自己的 GitHub 仓库，保留 `.github/workflows/publish.yml`。不要上传 `config.json`、`private/`、`.env*`、profiles、日志或私有 ZIP。源码 ZIP 中的 `.github` 和 `.gitignore` 也要保留。

在仓库启用 Actions，然后提交并推送与源码版本一致的 tag，例如 `v0.6.0`。工作流将：

1. 运行 Node/Python 回归和自测。
2. 构建 Linux amd64、arm64 镜像并推送 GHCR。
3. 发布源码 ZIP、哈希文件、`deploy-agent.py` 和 `deploy.json`。

`deploy.json` 示例：

```json
{
  "version": "0.6.0",
  "image": "ghcr.io/sun20101227/mirasim-bridge@sha256:完整的64位镜像摘要"
}
```

固定发布地址为 `https://github.com/sun20101227/mirasim-bridge/releases/latest/download/deploy.json`；镜像仓库为 `ghcr.io/sun20101227/mirasim-bridge`，GHCR 名称需小写。把 GitHub 仓库和 GHCR package 设为服务器可读取；最简方案为公开**源码与镜像**。第一次发布后要检查 GHCR package 可见性，GitHub 公共仓库不保证新 package 自动公开。

本版 manifest 下载不带 GitHub 私有仓库认证；如不公开源码，可把发布资产放到你控制的 HTTPS 下载地址。镜像使用服务器现有 `docker login` 凭证拉取。发布源必须可靠，因为其镜像会成为服务器运行代码。

`v0.6.0` 已发布。GitHub Ubuntu 构建通过全部 Node/Python 测试及 Bash 语法检查；amd64/arm64 镜像已推送，amd64 容器离线自测通过。已确认 GHCR 可匿名读取。服务器上的实际升级、回退与 systemd 仍需接入后验收。

## 2. 已有服务器一次性接入

主 bridge 必须已经按 DOCKER.md 正常运行，镜像名是默认的 `mirasim-bridge:local`。本工具兼容标准 0.4.2/0.4.3/0.5.0 Compose 部署；自定义镜像名称或拓扑会拒绝接管。

服务器可以直接下载部署工具，无需再上传 ZIP。在现有 Compose 项目目录执行（目录中应有 compose.yaml 和 .env）：

```bash
test -f compose.yaml || { echo "Please enter the existing Compose project directory"; exit 1; }
deploy_script="$(mktemp)"
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/latest/download/deploy-agent.py \
  -o "$deploy_script" &&
sudo python3 "$deploy_script" install \
  --project-dir "$PWD" \
  --manifest https://github.com/sun20101227/mirasim-bridge/releases/latest/download/deploy.json \
  --image-repository ghcr.io/sun20101227/mirasim-bridge
```

`--project-dir "$PWD"` 使用当前 Compose 目录，不要在新建的空目录运行。若先上传本版源码，也可直接运行 `sudo python3 scripts/deploy-agent.py install ...`。

已有第二、第三个独立账号时，在安装命令加 `--profile second --profile third`；对应 `.env.second`、`.env.third` 与 profile Compose 文件必须已存在。host 网络方案加 `--host-network`。工具只重建这些目标中**当前运行的** bridge，已停止的账号保持停止，未配置的其他容器不接管。

安装生成：

- `/etc/mirasim-deploy/config.json`：固定发布源、项目目录与受管目标。
- `/etc/mirasim-deploy/api.key`：独立的部署密钥，和 bridge/sub2 管理 Key 不同。
- `/etc/mirasim-deploy/auth.header`：供 curl 读取的鉴权头，权限 600。
- `/var/lib/mirasim-deploy/state.json`：任务状态及恢复记录。
- `mirasim-deploy.service`：宿主机服务，监听 `127.0.0.1:8790`。

部署服务以 root 使用 Docker；模型 bridge 容器仍用原 UID 1000，不挂载 Docker socket。重复 install 会拒绝覆盖密钥。增加 profile 时编辑部署配置的 targets，再 `sudo systemctl restart mirasim-deploy`，新增目标应具有唯一 name、对应 compose_file/env_file。

## 3. 一条请求进行升级

在服务器上：

```bash
sudo curl --fail-with-body -H @/etc/mirasim-deploy/auth.header \
  -X POST http://127.0.0.1:8790/v1/deploy

sudo curl --fail-with-body -H @/etc/mirasim-deploy/auth.header \
  http://127.0.0.1:8790/v1/deploy/status
```

POST 返回 `202` 表示任务已接受，**不代表完成**。重复请求遇到正在执行的任务会返回 `409`。查询直到 `phase=succeeded`。接口只允许空请求体或 `{}`，调用方不能指定下载地址、镜像、路径或 shell 命令。

更新流程：读取固定 HTTPS manifest → 校验仓库与镜像 digest → 拉取镜像 → 在无网络临时容器验证版本、自测 → 记录原镜像 → 停止受管 bridge → 重建 → 等待上游就绪且 sub2 已恢复调度。拉取和自测期间原服务继续运行，重建阶段有短暂停服。

只替换 bridge 镜像，不初始化或删除数据卷，不覆盖账号配置、登录态或 sub2 分组。凭证继续由服务器保存和续期。0.8.0 起（配置 `self_update: true`，安装器默认打开）升级会同时把镜像内的宿主机工具（`deploy-agent.py`、`panel-host.py`、网页文件）写入 `/opt/mirasim-deploy` 并重启部署服务，回退时恢复；仍不会同步宿主机目录里的源码、文档或 Compose 模板。不要在网络升级后随手执行旧目录的 `docker compose build`，否则会用旧源码覆盖本地镜像。

## 4. 从电脑或外部系统调用

优先使用 SSH：无需开放公网部署端口，也不需要把部署密钥复制到电脑：

```bash
ssh 用户名@服务器 'sudo curl --fail-with-body -H @/etc/mirasim-deploy/auth.header -X POST http://127.0.0.1:8790/v1/deploy'
```

若需要固定 HTTPS 接口，可在**同一主机运行的** Nginx HTTPS server 中新增以下三个精确路径。Nginx 在容器时，127.0.0.1 不是宿主机，不能直接套用：

```nginx
location = /mirasim-deploy/update {
    proxy_pass http://127.0.0.1:8790/v1/deploy;
    proxy_set_header Authorization $http_authorization;
    client_max_body_size 1k;
}
location = /mirasim-deploy/status {
    proxy_pass http://127.0.0.1:8790/v1/deploy/status;
    proxy_set_header Authorization $http_authorization;
}
location = /mirasim-deploy/rollback {
    proxy_pass http://127.0.0.1:8790/v1/deploy/rollback;
    proxy_set_header Authorization $http_authorization;
    client_max_body_size 1k;
}
```

检查 Nginx 配置后重载。通过 HTTPS 调用时，在 Authorization 头使用独立部署 Key；不要把密钥放在 URL 查询参数里。接口默认不开 CORS，不使用 sub2 管理 Key 鉴权。

## 5. 失败回退与排障

启动/注册检查失败会尝试恢复各容器原镜像；回退成功为 `rolled_back`。`rollback_failed` 表示至少一个容器未恢复就绪，需要检查 Docker 日志、网络和 sub2；此时拒绝新的升级任务，保留恢复记录。修复原因后重试回退：

```bash
sudo curl --fail-with-body -H @/etc/mirasim-deploy/auth.header \
  -X POST http://127.0.0.1:8790/v1/deploy/rollback
sudo journalctl -u mirasim-deploy --since '10 min ago' --no-pager
```

最近一次成功升级也可用该接口回退。回退只恢复镜像，不把已轮换凭证恢复成旧 token；上游故障本身不会因镜像回退而消失。部署进程在切换阶段中断后，服务重启会读取记录并尝试回退。不要在部署/回退期间运行 `docker image prune`、手动重建或修改受管 Compose 文件。

升级/回退故障测试使用模拟 Docker，HTTP 鉴权使用本地真实服务。GitHub 发布流水线已实际构建并拉取 Linux 镜像、运行 amd64 容器自测；现有生产容器重建和 systemd 安装仍需在服务器验收。

## 尚未安装 bridge 的全新服务器

网络下载不能省略首次账号授权与 sub2 配置。可以从 GitHub Release 下载源码包或镜像，按 DOCKER.md 完成首次初始化与凭证导入，运行正常后再接入部署工具。此接口主要解决已部署服务器以后的远程更新。
