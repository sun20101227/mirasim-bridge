# “最新发布”停在旧版本（0.8.5）

如果“当前运行”是旧版而“最新发布”是新版，点击升级即可。如果两者一直是 0.8.2，但 GitHub 已是新版，需检查服务器保存的发布源或下载代理缓存，不能只刷新浏览器，也不能认定 GitHub 没发布。

旧版每次检查实际读取 `/etc/mirasim-deploy/config.json` 的 `manifest_url`。地址若为 `/releases/download/v0.8.2/deploy.json`，它就永远返回 0.8.2；此外旧工具的 60 秒缓存无法被手动检查绕过，下载重定向也没有缓存重验证。截图本身不能区分这些情况。

## 当前服务器的一次性解决办法

已装网页后台且部署状态为 `succeeded` 的服务器，在云厂商网页终端或宝塔/1Panel **宿主机终端**执行下面命令；不要求 SSH。下载明确的 0.8.5，不经过可能缓存的 latest 跳转：

```bash
update_dir="$(mktemp -d)"
cd "$update_dir" &&
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.8.5/mirasim-bridge-0.8.5-source.zip \
  -o mirasim-bridge-0.8.5-source.zip &&
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.8.5/mirasim-bridge-0.8.5-source.zip.sha256 \
  -o mirasim-bridge-0.8.5-source.zip.sha256 &&
sha256sum -c mirasim-bridge-0.8.5-source.zip.sha256 &&
unzip -q mirasim-bridge-0.8.5-source.zip &&
sudo python3 mirasim-bridge/scripts/install-panel.py --follow-latest
```

该命令沿用原面板域名、管理密钥、Compose 目录和账号配置，只更新宿主机工具/网页，并将**同一仓库**的 GitHub 发布源设为 latest。不会重建 bridge、重新登录 Mira、清除数据卷或自动改用别的仓库。安装时后台会短暂重启。

随后：

1. 刷新管理网页并重新输入原管理密钥。
2. 在“版本与升级”点击 **强制检查更新**。发布源应显示“自动跟随 … 的正式发布”，最新版本至少为 0.8.5。
3. 点击“升级至最新发布”，等待 `succeeded`，再刷新确认**当前运行**版本。安装检测工具不会单独把 bridge 从 0.8.2 升级。

如果配置是自定义下载代理/非匹配仓库，`--follow-latest` 会拒绝自动改源；可去掉此参数仅更新工具，在网页查看源类型并由管理员确认正确源。不要把自定义地址中的认证参数发到公开聊天。如果状态是 `rollback_failed`，先用 [RECOVERY.md](RECOVERY.md) 的恢复流程，不能把失败状态强制改为成功。

## 新版检测行为

- 自动查询保留短时缓存，手动点击强制刷新；页面明确显示检查时间与缓存标记。
- GitHub 最新源先解析具体正式 tag，再取该 tag 的清单，要求版本一致且镜像来自已配置仓库并固定 sha256。API 暂不可达时可使用带缓存重验证的 latest 下载入口，并显示此回退方式。
- 固定源显示固定版本，不冒充“全站最新”。按钮“改为跟随最新发布”只允许切换同一 GitHub/GHCR 仓库，且不会立即部署。
- 查询失败显示“无法确认”，不会拿上一次的 0.8.2 继续显示为最新版。

本项目无法在旧服务器没有可用远程管理通道时，从 GitHub 发布动作直接修改它的宿主机配置；如果旧工具一直读取旧源，这一次宿主机接入仍需服务器面板或云控制台操作。
