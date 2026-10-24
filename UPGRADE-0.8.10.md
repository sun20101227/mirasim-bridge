# 0.8.10 本地升级包

本包修复 `request body exceeds replay_buffer_mb (8MB)`：默认上限提高到 64 MB，并在后台“账号管理 → 运行设置”加入请求体上限，保存后对当前账号的新请求立即生效。主账号和托管账号分别读取自己的上限。真正超限时返回 HTTP 413 / `request_too_large`。

这是源码升级包，包含已有的 2026-10-06 GPT 兼容修复、本次请求体修复，以及 2026-10-24 对齐 roster `2026-10-24.v3` 的改动（`ultra` 档位透传、`/v1/model-roster` 解析与缓存、429 共享额度用尽分类）。不含账号凭证、私钥、真实配置或预构建 Docker 镜像；未上传 GitHub Release，也未升级服务器。网页“检查更新”不会自动获取这个本地包。

## roster 与额度拒绝的变化

升级后 `reasoning.effort: "ultra"` 原样发给上游，不再被改写成 `max`。它只在 `gpt-6-astra`、`gpt-6.1-sol`、`gpt-5.6-sol`、`gpt-5.6-terra` 上有效；`gpt-6-luna`、`gpt-5.6-luna` 最高到 `max`，对它们用 `ultra` 会被上游拒绝，桥接器不代为降级。后台“运行设置 → GPT 默认推理档”也新增了 `ultra` 选项，默认仍是 `high`。

`/v1/models` 返回 429 且带 `credit_exhausted_shared` 时，现在按“平台共享额度用尽”处理：账号保持注册但标为不健康，后台显示“共享额度用尽 · N分”，`/__status` 与账号详情保留 `last_probe_failure`（含 `retry-after`）。这段时间模型目录页改读 `/v1/model-roster`（缓存 10 分钟），所以模型列表仍可查看，只是不能推理。额度恢复后健康循环会自动恢复调度，不需要改配置。

> ⚠️ 实测确认 relay 的控制接口不校验请求签名、`x-mirasim-client` 取值也不被校验，因此**不要**为了“更新”去改 `relay.client_version`，也不要改用新版桌面客户端的签名规范（当前 relay 会返回 401 `device_signature`）。

## 安装前

将 ZIP 解压到新的目录，在 `mirasim-bridge` 目录运行 `sha256sum -c SHA256SUMS` 校验文件。保留原配置、凭证、Compose 项目名和数据卷；不需要重新初始化账号。

已有配置如果明确设置 `forward.replay_buffer_mb`，升级会保留该值，包括旧的 `8`。未配置时直接采用新默认值 `64`。完成程序升级后，在后台选择报错的账号，将“请求体上限（MB）”改为 `64` 并保存；如果是多个托管账号，请分别设置。已有配置也可按 [DOCKER.md](DOCKER.md) 的“修改配置”步骤编辑该字段并重启。

## 使用源码 Compose 的部署

按 [DOCKER.md](DOCKER.md) 的“凭证、升级和停止”操作，将原 `.env` 复制到新源码目录，确认 Compose 项目名、数据卷和网络与原部署一致后执行：

```bash
docker compose stop bridge
docker compose build bridge
docker compose up -d bridge
docker compose exec bridge node /app/mirasim-bridge.js --version
```

最后应输出 `0.8.10`。原来使用 `compose.host.yaml` 时，为以上每条 Compose 命令加上 `-f compose.host.yaml`。独立 profile 容器使用原来的 profile Compose 文件、项目名和卷，不应套用主账号的默认项目名。

若现有部署由宿主机网络升级工具管理，使用的是固定远端镜像和生成的 Compose 配置，请先核对其项目名与卷，再将本源码构建的镜像配置给原服务；不要直接在另一目录启动默认 Compose 项目，以免接入空数据卷。此源码包没有对应的远端部署清单。

## 宿主机管理页面

直接访问 bridge 的 `/panel` 会随 bridge 一起更新。如果使用 8790 端口的独立宿主机后台，还需在 Linux 宿主机、新源码目录运行：

```bash
sudo python3 scripts/install-panel.py
```

安装器沿用已有后台域名与配置。仅更新宿主机页面不代表 bridge 已升级；确认 bridge 版本为 `0.8.10` 后再设置上限。

## systemd 部署

从新源码目录按 [DEPLOY.md](DEPLOY.md) 运行现有安装器，再启动服务：

```bash
sudo systemctl stop mirasim-bridge
sudo bash install.sh
sudo systemctl start mirasim-bridge
```

原安装使用自定义服务用户时，沿用原安装参数。安装器保留已有配置与凭证；若显式配置上限为 8 MB，可在后台修改，或编辑实际使用的 `config.json` 后重启服务。

## 验证与上限说明

后台应显示当前账号实际的请求体上限。重试原先报错的请求；仍超过上限时，可在 1–1024 MB 范围内调整或减少请求中的图片和历史。MB 按 1024² 字节计算，限制作用于完整 JSON 请求体，不是模型 Token 上限。

此限制使用内存缓冲。调大时需同时考虑账号并发和服务器内存；解析 JSON、格式转换会额外占用内存。Nginx、sub2api 和 Mirasim 上游自身的请求大小及上下文限制仍各自生效。
