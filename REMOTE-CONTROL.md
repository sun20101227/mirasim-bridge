# 从对话或 GitHub 触发服务器升级（0.6.1）

接入后，你可以在对话里说“升级服务器”：这里通过已登录的 GitHub CLI 发布升级指令，服务器主动读取并执行。不需要 SSH、不开放公网端口，也不把 GitHub Token 或部署密钥交给桥接器。原版 sub2api 保持不变。

**现有 0.6.0 部署工具不会读取远程指令，必须接入一次。** 仅发布新版镜像无法更新宿主机部署工具，也无法改变已安装服务的行为。如果目前既没有 SSH，也不能使用云厂商网页终端、VNC、宝塔/1Panel 的宿主机终端或让服务器管理员执行命令，就无法远程完成这次接入。

## 已装部署工具：在网页终端执行一次

打开服务器提供商的网页控制台/终端，进入 Linux 宿主机，而不是 bridge 容器内部。此命令沿用已安装工具的 Compose 目录、受管账号列表、部署密钥和所有账号凭证，不需要再次填写这些信息。部署或回退正在进行时会拒绝更新工具。

```bash
deploy_script="$(mktemp)"
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.6.1/deploy-agent.py \
  -o "$deploy_script" &&
sudo python3 "$deploy_script" enable-remote \
  --repository sun20101227/mirasim-bridge --target main
```

看到 `Remote polling enabled for target main` 后，把接入完成告诉我。`main` 是这台服务器的指令标识，不是 Mira 账号名。多台服务器要各用不同标识；同一服务器的多个账号由已有 `targets` 配置共同管理。安装时未纳入的账号不会自动加入。

未安装部署工具时先按 [NETWORK-DEPLOY.md](NETWORK-DEPLOY.md) 完成安装，然后执行上述命令。

## 此后从这里下发指令

我在当前已登录 GitHub 的工作环境执行：

```bash
gh workflow run remote-deploy.yml --repo sun20101227/mirasim-bridge \
  --ref main -f target=main -f action=deploy
```

回退使用同一命令，将 `action=deploy` 换成 `action=rollback`。也可以在 GitHub 的 **Actions → Request server deployment → Run workflow** 点击执行。需要对仓库有运行工作流的权限。

服务器每 30 秒检查专用的 `deploy-control` 分支。GitHub/CDN 缓存及网络状况可能增加延迟。指令有效期 15 分钟，服务器离线错过后需要重新下发；发布版本本身不会自动触发升级。每个标识只保留最新指令，因此不要连续发送相互冲突的操作。

只接受 `deploy` 和 `rollback`，不能指定 shell 命令、路径、镜像地址或新的发布源。升级仍从服务器原先配置的发布源拉取指定仓库的镜像摘要，检查版本并自测后再切换容器。数据卷和原版 sub2api 保留，失败时尝试回退。

## 查看结果与边界

**GitHub 工作流成功只表示指令已发布，不表示服务器收到、开始或完成升级。** 当前没有从服务器向 GitHub 回传状态的功能；这里不能仅凭工作流绿灯宣布升级成功。网页终端中查看真实状态：

```bash
sudo curl --fail-with-body -H @/etc/mirasim-deploy/auth.header \
  http://127.0.0.1:8790/v1/deploy/status
sudo journalctl -u mirasim-deploy --since '15 min ago' --no-pager
```

`phase=succeeded` 是升级成功，`rolled_back` 是已回退，`rollback_failed` 需排障。状态中的 `remote_command.id` 可与 GitHub 工作流输出对应。失败指令不自动循环重试；排查后下发新指令。回退只恢复镜像，不恢复旧凭证。

GitHub 仓库写入者拥有下发升级/回退的权限；指令是公开的，但只含随机编号、服务器标识、动作及时间，不含 IP、凭证或日志。服务器通过 HTTPS 读取固定仓库，拒绝接入前的旧指令、过期/未来指令、错误目标和额外字段，执行前记录指令，重启后也不会重复执行。同一秒发布的多个指令最多接受一个。

## 停用

在网页终端编辑 `/etc/mirasim-deploy/config.json`，删除 `remote_control` 字段，然后执行 `sudo systemctl restart mirasim-deploy`。只停用远程检查，原本的本机管理接口仍可用。改变服务器标识也通过再次执行 `enable-remote --target 新标识` 完成。

## 验证范围

Python 测试覆盖目标/字段/时效校验、重复指令、服务重启、忙碌与断网、日志写盘失败、回退，以及接入时保留已有配置和密钥。Docker 升级/回退仍通过 mock 验证；生产服务器接入及其真实执行结果需要服务器验收。
