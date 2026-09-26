# 回退未完成 / 新增账号失败（0.8.3 修复）

## 截图对应的已确认缺陷

旧版本遇到 `rollback_failed` 会封锁所有账号操作，包括只读的状态/概览。连续 `summary/status` 失败不等于容器一定已停止。旧版部署检查还要求 sub2 已入池、relay 可用，即使手动暂停也可能触发升级及回退失败。仅凭页面无法确定你那次失败的原始原因。

“当前运行 — / 已是最新版”是前端判断错误；操作记录中的“升级 完成”实际上只代表接受了异步任务。0.8.3 均已修正，部署状态才是最终结果。

## 已处于 rollback_failed 的旧宿主机

**旧工具会拒绝升级新镜像**，不能靠重复点“升级”解除。通过云厂商网页终端或服务器面板的**宿主机终端**执行一次（不依赖 SSH）。使用原本的 HTTPS 域名配置，不需要重填任何密钥：

```bash
repair_dir="$(mktemp -d)"
cd "$repair_dir" &&
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.8.3/mirasim-bridge-0.8.3-source.zip \
  -o mirasim-bridge-0.8.3-source.zip &&
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.8.3/mirasim-bridge-0.8.3-source.zip.sha256 \
  -o mirasim-bridge-0.8.3-source.zip.sha256 &&
sha256sum -c mirasim-bridge-0.8.3-source.zip.sha256 &&
unzip -q mirasim-bridge-0.8.3-source.zip &&
sudo python3 mirasim-bridge/scripts/install-panel.py --repair-recovery
```

这会安装固定发布版本的宿主机工具、保留原容器快照，交由新版工具重试回退。旧宿主机备份不会覆盖刚安装的恢复工具。**不清空状态，不删除凭证/数据卷，不运行 setup，不把未完成的任务强制标成功。** 恢复过程中会重建快照所对应的 bridge，可能短暂停服。

然后刷新网页并重新输入管理密钥：

1. 点“查询进度”，等待 `rolled_back`。这只表明恢复完成，还不是升级到 0.8.3。
2. 点“升级至最新发布”，等待 `succeeded`，刷新后确认当前运行版本。
3. 如果仍为 `rollback_failed`，现在页面会显示失败目标、步骤与错误码。提供这些字段即可，勿发送密钥或 OAuth 回调 URL。例如 `disk_full`、`image_missing`、`bridge_unresponsive` 需要不同处理，不能无条件重试。

如果原本没有失败回退，仅需修复宿主机页面，可去掉命令末尾的 `--repair-recovery`。正常工作的 0.8.0+ 自更新服务可直接网页升级，无需此流程。

## Google / GitHub 新增账号

0.8.3 后台和网页均支持这两种方式。Profile 可留空自动生成，或填 `second`。选择分组、账号名和登录方式，点击“生成授权链接”。

在无痕窗口授权后跳转到 `127.0.0.1` 无法访问是远程部署的正常情况：复制**地址栏的完整回调 URL**回到本次登录表单，验证并保存。不要把这个 URL 发给任何人，它包含临时登录凭证。保存后新账号独立存储，原账号文件不会被覆盖。

实测 Google 入口跳至 `accounts.google.com`，GitHub 入口跳至 `github.com/login/oauth/authorize`。链接生成和重定向已验证；最终 OAuth 登录需要你本人授权，不能仅据 307 宣称真实账号已保存。邮箱验证码目前在网页禁用。
