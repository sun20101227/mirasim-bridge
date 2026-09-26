# 升级到 0.8.0

0.8.0 有两处需要一次性动作，之后升级全部在网页完成：

1. 宿主机工具从这个版本起会随镜像一起更新，但**旧版宿主机服务不会自己换成新版**，所以从 0.7.x 升级需要最后一次通过服务器网页终端运行安装器。
2. 多账号改为“托管到同一个 bridge”，已有的独立 profile 容器可以继续运行，也可以迁移为托管（见第 3 节）。

## 1. 网页升级 bridge 镜像

在旧版后台的“版本与升级”点“升级至最新发布”，等待显示“升级成功”。这一步只更新容器。

## 2. 最后一次安装宿主机后台

在云厂商网页终端、宝塔/1Panel 宿主机终端执行（把域名换成你的后台域名，HTTPS，末尾不要 `/`）：

```bash
panel_tmp="$(mktemp -d)"
cd "$panel_tmp"
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.8.0/mirasim-bridge-0.8.0-source.zip \
  -o mirasim-bridge-0.8.0-source.zip &&
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.8.0/mirasim-bridge-0.8.0-source.zip.sha256 \
  -o mirasim-bridge-0.8.0-source.zip.sha256 &&
sha256sum -c mirasim-bridge-0.8.0-source.zip.sha256 &&
unzip -q mirasim-bridge-0.8.0-source.zip &&
sudo python3 mirasim-bridge/scripts/install-panel.py --origin https://mira-admin.example.com
```

安装器保留部署密钥、网页密钥、受管账号列表、GitHub 远程指令配置和全部数据卷，并把 `self_update` 打开。之后每次网页升级都会：

- 拉取并校验新镜像（摘要固定、版本一致、自测通过）；
- 从镜像中取出 `deploy-agent.py`、`panel-host.py` 和网页文件，先做语法校验；
- 重建容器并等待注册/调度恢复；
- 把宿主机文件替换为新版并备份旧版，最后重启部署服务（页面会短暂断开，刷新后重新输入密钥）。

回退会一并恢复上一版宿主机工具。升级页的状态会写明“宿主机后台已一并更新并重启”。

## 3. 把独立容器迁移为托管账号（可选）

托管模式下所有账号共用主 bridge 的地址，sub2api 用各账号自己的 `bridge_secret` 区分，不需要 `mirasim-<profile>` 网络别名，也不占用额外容器。迁移步骤：

1. 网页“账号管理”里选中该容器账号，点“停止容器”，等待其 sub2 账号显示已暂停。
2. 在 profiles 列表对同一个 profile 点“托管到当前 bridge”。主 bridge 会读取 `/data/profiles/<name>/` 里的凭证和配置，用同名 sub2 账号重新注册（base_url 改为主 bridge 地址），并同步模型映射。
3. 概览的“全部 Mira 账号”里看到该账号“已入池”后，可以删除对应的 `panel-profile-<name>.json` 和宿主机部署配置里的目标条目；不删也不影响，只是它会一直显示为停止状态。

不要让同一个 profile 同时以容器和托管两种方式运行：两者会用同一个 sub2 账号名互相覆盖 base_url。

## 4. 新账号

“新增账号”对话框默认勾选“托管到当前 bridge”。邮箱验证码或 Google 授权完成后，页面会自动托管并注册，几秒内出现在“全部 Mira 账号”里。取消勾选才会走原来的独立容器流程。

## 5. 命令行

```bash
# 查看本 bridge 托管的全部账号
docker compose exec bridge node /app/mirasim-bridge.js status --config /data/config.json | jq .accounts
```

手工编辑 `/data/config.json` 的 `accounts.hosted` 数组后重启容器，效果与网页托管相同；profile 目录必须已有 `setting.json` 和 `config.json`。
