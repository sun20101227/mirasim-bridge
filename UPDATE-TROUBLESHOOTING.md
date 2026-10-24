# 升级卡在“准备失败”，重试无效

## 先判断：是暂时性失败还是引导死锁

看后台的**失败步骤**和**错误码**（“版本与升级”页会显示，例如 `后台 · 记录原容器：镜像不存在`）。

- 每次都停在同一处、错误码完全一样 → **重试不会有任何变化**，继续往下看。
- 错误码会变，或时好时坏 → 属于暂时性问题（Docker 忙、磁盘、网络），先排除环境再重试。

日志里出现 `Release preparation failed; running containers unchanged` 是好消息：准备阶段不改动运行中的容器，旧版本一直在正常服务，没有中断。

## 引导死锁：修复装不上去

宿主机部署工具 `/opt/mirasim-deploy/deploy-agent.py` 负责执行升级。它的更新时机是**部署成功之后**的 `install_host` 步骤：

```
snapshot()          ← 失败发生在这一步
  ↓
activate_image / stop / start / check_health
  ↓
install_host        ← 新 deploy-agent.py 在这里才被写入宿主机
```

因此，任何“修复位于部署成功之后才能安装的组件”的问题，都会形成死锁：**修复要等部署成功，部署成功又要等修复生效**。宿主机上跑的旧脚本没有新代码，重试一百次也是同一个报错。

典型触发是 0.9.0 的 `mirasim-bridge:local` 回退标签被清理：

```
docker image inspect mirasim-bridge:local  →  no such image
docker ps                                  →  容器在跑，版本正常
```

**缺的是标签，不是镜像。** 容器用的镜像 ID 一直存在，只是那个别名没了。

## 一次性解决：在宿主机手动补回标签

在云厂商网页终端 / 宝塔 / 1Panel 的**宿主机终端**执行（不是容器里）：

```bash
# 1. 查看容器与它实际使用的镜像
sudo docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'

# 2. 用运行中容器的镜像 ID 补回标签（只加别名，不替换、不重启容器）
sudo docker tag \
  "$(sudo docker inspect --format '{{.Image}}' "$(sudo docker ps -q --filter name=bridge | head -1)")" \
  mirasim-bridge:local

# 3. 确认标签已就位
sudo docker image inspect --format '{{.Id}}' mirasim-bridge:local
```

第 2 条命令做的正是 0.9.1 起 `deploy-agent.py` 会自动做的事：把运行中容器的镜像 ID 重新指向 `mirasim-bridge:local`。`docker tag` 只是新增一个名字，**不会重建、停止或重启任何容器**，业务不中断。

补完后回后台再点“升级至最新发布”。这次 `snapshot` 能取到镜像 ID，会一路跑完，并在 `install_host` 阶段装上含修复的新 `deploy-agent.py`——**以后不再需要手工干预**。

### 容器名不是 bridge 时

默认 Compose 项目把服务命名为 `bridge`。若第 2 条命令取到空值：

```bash
sudo docker ps --format '{{.Names}}\t{{.Image}}' | grep -i mirasim
```

用输出里实际的容器名替换 `--filter name=bridge`，或直接写镜像 ID：

```bash
sudo docker tag <镜像ID> mirasim-bridge:local
```

### 多个账号运行在不同镜像上

不要手工挑一个补标签：那会让其他账号失去回退能力。0.9.1 起代理会直接拒绝并报 `rollback_tag_ambiguous`，此时应先把这些账号统一到同一镜像，或逐个升级，再重试。

## 补完标签仍然失败

说明还有第二个原因。此时错误归属已经准确（`snapshot` + 具体 code），把「版本与升级」页的完整状态和错误码发出来即可。常见后续：

- `docker_unavailable` / `permission_denied`：Docker 服务或权限问题，与镜像无关。
- `disk_full`：先清理磁盘，不要重试。
- `bridge_unresponsive`：这是**已切换之后**的健康检查失败，会触发回退，属于另一类问题，见 [RECOVERY.md](RECOVERY.md)。

## 什么时候需要重装宿主机工具

只有当死锁无法靠补标签解除时（例如旧代理本身已经损坏），才需要在宿主机重新安装一次工具：

```bash
update_dir="$(mktemp -d)"
cd "$update_dir" &&
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.9.1/mirasim-bridge-0.9.1-source.zip \
  -o mirasim-bridge-0.9.1-source.zip &&
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/sun20101227/mirasim-bridge/releases/download/v0.9.1/mirasim-bridge-0.9.1-source.zip.sha256 \
  -o mirasim-bridge-0.9.1-source.zip.sha256 &&
sha256sum -c mirasim-bridge-0.9.1-source.zip.sha256 &&
unzip -q mirasim-bridge-0.9.1-source.zip &&
sudo python3 mirasim-bridge/scripts/install-panel.py
```

下载地址写明版本号，不用 `latest`：`latest/download/` 里的文件名带版本，新版发布后会 404。

安装器沿用原面板域名、管理密钥、Compose 目录与账号配置，只更新宿主机工具和网页，**不重建 bridge、不重新登录 Mira、不清数据卷**。执行时后台会短暂重启，完成后刷新页面并重新输入管理密钥。

> 重装工具**不会**单独升级 bridge 容器。工具装好后仍需在页面点一次“升级至最新发布”。

---