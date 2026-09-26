# Mira 网页管理后台（0.8.1）

完整后台运行在**宿主机的部署服务 `127.0.0.1:8790`**。给它配置独立 HTTPS 域名，即可在浏览器管理账号、额度、模型、升级与回退。不需要改 sub2api，也不需要以后反复进 SSH。

bridge 的 8787 端口另有单账号 `/panel` 页面，但它不能创建容器或升级镜像。你需要反代的是 **8790**，不是 8787。

## 1. 已装部署工具：通过网页终端安装一次后台

**从 0.7.x 升级到 0.8.0 要执行最后一次这一步**：网页文件和宿主机服务装在 `/opt/mirasim-deploy`，旧版部署服务不会自己换成新版。0.8.0 起，网页“升级至最新发布”会从同一个经过校验的镜像中取出宿主机工具并一并更新、必要时重启自身（`self_update`），以后不再需要进终端。安装器会保留现有管理密钥，重复执行是安全的。

在云厂商网页终端、宝塔/1Panel **宿主机终端**执行。前提是现有 bridge 和 `mirasim-deploy.service` 已按 NETWORK-DEPLOY.md 安装。把最后的域名改成你的真实域名，必须为 HTTPS，末尾不要加 `/`。

```bash
panel_tmp="$(mktemp -d)"
cd "$panel_tmp"
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.8.1/mirasim-bridge-0.8.1-source.zip \
  -o mirasim-bridge-0.8.1-source.zip &&
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.8.1/mirasim-bridge-0.8.1-source.zip.sha256 \
  -o mirasim-bridge-0.8.1-source.zip.sha256 &&
sha256sum -c mirasim-bridge-0.8.1-source.zip.sha256 &&
unzip -q mirasim-bridge-0.8.1-source.zip &&
sudo python3 mirasim-bridge/scripts/install-panel.py --origin https://mira-admin.example.com
```

安装器保留现有 Compose 目录、受管账号列表、部署密钥、主动检查 GitHub 指令配置和所有账号数据卷。正在升级或回退时拒绝安装。它只更新宿主机工具、网页文件和 panel 配置，不重建 bridge。

复制专用网页管理密钥：

```bash
sudo cat /etc/mirasim-deploy/panel.key
```

把密钥存入自己的密码管理器。它不同于部署 API 密钥、推理密钥和 sub2 管理 Key。不要公开粘贴；网页只把它保存在当前页面内存中，刷新或退出会清除。

**不能只通过更新 bridge 镜像安装宿主机后台。** 没有 SSH 时用网页终端完成上面的一次接入；完全没有服务器控制通道时需管理员协助。

## 2. 反代域名

在同一宿主机的 Nginx HTTPS `server` 中配置（证书使用你现有的域名证书）：

```nginx
server {
    listen 443 ssl;
    server_name mira-admin.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location = / { return 302 /panel; }
    location = /panel {
        proxy_pass http://127.0.0.1:8790;
        proxy_set_header Host $host;
    }
    location /panel/ {
        proxy_pass http://127.0.0.1:8790;
        proxy_set_header Host $host;
        proxy_read_timeout 240s;
        client_max_body_size 160k;
        proxy_buffering off;
    }
    location / { return 404; }
}
```

保持浏览器的 `Origin` 和 `X-Panel-Key` 请求头。后台只接受安装时指定的 HTTPS Origin，域名不一致会拒绝操作；更换域名需重新运行安装器的 `--origin`，管理密钥保持不变。不要用 `proxy_pass .../` 改写 `/panel` 路径。

面板反代向导可填写 `http://127.0.0.1:8790`，设置 HTTPS 和 240 秒读取超时。如果反代软件在普通 Docker 网络内，`127.0.0.1` 是它自己的容器，访问不到宿主机；应使用宿主机 Nginx或 Linux host 网络的反代服务。无需把 8790 监听改为公网地址。

打开 `https://你的域名/panel`，输入上一步的网页管理密钥。

## 3. 首次进入先更新 bridge

宿主机后台能先于 bridge 更新。若当前 bridge 仍为 0.6.x，账号页请求可能失败，但**版本与升级**页面可用。点击“升级至最新发布”，等页面显示“升级成功”，再刷新概览。

后台读的是服务器真实部署状态，不是 GitHub 工作流状态：

- `succeeded`：桥接器已启动并恢复调度。
- `failed`：发布准备失败，原运行容器未改变。
- `rolled_back`：升级失败，已回退。
- `rollback_failed`：回退未完成，需要查看宿主机日志并修复。

升级/回退只使用服务器已配置的发布源，网页不能输入镜像地址或命令。0.8.0 起升级同时更新宿主机工具：镜像内的 `deploy-agent.py`、`panel-host.py` 和网页文件先做语法校验，容器就绪后写入 `/opt/mirasim-deploy` 并备份旧版，最后重启部署服务（页面短暂断开，刷新后重新输入密钥）。回退会一并恢复上一版宿主机工具。状态里的 `host_updated / host_restart / host_restored` 说明这次是否动了宿主机。

## 4. 邮箱验证码 / Google 添加新账号

1. “账号管理 → 新增账号”，填写唯一 profile、sub2 账号名，在下拉里选一个 anthropic/composite 分组（读不到分组列表时可手动填 ID）。
2. 选择 **邮箱验证码**，输入邮箱，点击发送，然后输入邮件中的验证码。错误可重试，最多 5 次，发送间隔至少 60 秒。验证码由 Mirasim 发出。
3. 或选择 **Google 授权**，在无痕窗口打开授权链接，完成后复制地址栏的最终回调 URL，粘贴到表单并验证。回调打不开属服务器登录的正常情况；不要把含 token 的地址发到聊天或日志。
4. 保存成功后，原账号的凭证保持不变，新凭证保存在 `/data/profiles/名字/`。
5. 默认勾选 **“托管到当前 bridge”**：保存后页面自动托管并注册到 sub2，不新建容器。取消勾选则走旧的独立容器流程（profiles 列表的“独立容器”按钮）。
6. 在概览“全部 Mira 账号”确认调度为“已入池”。注册依赖已有的 sub2 管理 Key；同组共享池，不同组隔离调用。

主 bridge 需要运行才能发起/完成新登录。标准 Docker 网络会自动使用 `mirasim-名字:8787`；host 网络必须填写一个未占用的独立端口。已有自定义绑定目录、非标准网络不自动改造；网页会拒绝不支持的拓扑。

新 profile 容器共享原数据卷中的独立目录，**不是容器级凭证安全隔离**。不同 Mira 登录各有独立凭证，登录相同 Mira 账号并不会增加额度。本项目不调用原账号 logout/revoke；上游自己的会话政策仍由 Mirasim 决定。

邮箱登录来自桌面客户端的独立流程：`POST /auth/code {email}` → `POST /auth/verify {email,code}`，与 OAuth provider 列表无关。没有真实邮件验证码时不会进行账号登录或生成凭证；测试使用模拟服务。

## 5. 额度、模型与账号启停

- 概览显示所选账号的真实额度快照、更新时间、剩余比例和重置时间。查询失败或数据过期显示“未知”，不会冒充实时余额。
- 模型目录打开即自动读取上游实时目录，不发送推理；上游新增的模型/系列自动出现并同步到 sub2。单模型测试明确确认后才发送真实请求，会消耗额度；Kimi 默认 low effort（可在运行设置改为“不干预”），30 秒测试超时。
- 概览的“请求趋势”“各模型延迟”和“运行日志”页都来自 bridge 进程内存，重启清零；日志不含密钥、凭证和对话内容。
- 启用/停用模型后，下一轮健康检查持久化并验证 sub2 模型映射。被其他过滤规则屏蔽的模型不能只靠取消 disabled 状态启用。
- DeepSeek 默认禁用，因为之前实际请求返回上游无容量；界面启用不能修复上游容量。Kimi 上游慢响应仍可能发生。
- 停止账号会排空连接并尝试暂停 sub2 账号；sub2 管理 API 故障时需确认暂停。启动后等待健康与注册检查完成。
- “Codex 专用账号”卡片按账号开关 openai 平台账号（见 [CODEX.md](CODEX.md)）；必须选 openai 或 composite 分组。
- 管理记录只保存最近 100 条动作、目标、时间、结果，不记录验证码、token、邮箱或回调 URL。

## 单 bridge 页面（可选）

需要仅查看某个 bridge 时，8787 上的 `/panel` 提供状态、额度、模型及凭证保存；不会启用镜像更新或容器启停。该页面使用卷内 `.panel-key`，首次通过以下命令取得：

```bash
printf '%s' '{"operation":"panel-key"}' | docker compose exec -T bridge node /app/scripts/panel-bridge.js
```

主推荐仍是反代宿主机 8790 的完整后台；两种页面的密钥不能混用。

## 验证范围

已通过 Node/Python 回归和 Chrome 浏览器测试（桌面、390px 手机宽度、验证码保存、启动操作、升级进度）。邮箱验证、Docker 容器启停/注册在测试中使用模拟上游/运行器；真实邮件投递、Google 授权与生产服务器拓扑仍需在你的服务器验收。
