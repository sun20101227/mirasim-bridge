# 从 0.4.2 / 0.4.3 升级到 0.5.0

新增独立 Google OAuth 登录、每账号独立容器、Mira 剩余额度备注同步；保留原版 sub2api 和 Quota Keeper。新增账号完整流程见 [ACCOUNTS.md](ACCOUNTS.md)。

## Docker 已部署用户

上传 **mirasim-bridge-0.5.0-source.zip** 到服务器家目录。升级使用源码包，保留卷中正在续期的凭证，不要用旧私有包凭证覆盖它。

以下假设原项目在 `~/mirasim-0.4.2/mirasim-bridge`；如果不同，两个目录一起替换。先备份原源码及持久化数据卷，再执行：

```bash
cd ~/mirasim-0.4.2/mirasim-bridge
docker compose stop bridge
unzip -o ~/mirasim-bridge-0.5.0-source.zip -d ~/mirasim-0.4.2
sha256sum -c SHA256SUMS
docker compose config --quiet
docker compose build bridge
docker compose up -d bridge
docker compose exec bridge node /app/mirasim-bridge.js --version
docker compose exec bridge node /app/mirasim-bridge.js status --config /data/config.json
docker compose logs --tail=100 bridge
```

host 模板用户每个 compose 命令加 `-f compose.host.yaml`。已有独立 profile 时还需停止各 worker，更新镜像后按 ACCOUNTS.md 重建。版本应为 `0.5.0`，最终 managed=true、reachable=true、schedulable=on。

源码包不含 `.env`、运行配置和凭证，覆盖代码会保留它们。不要重新运行 setup，不要删除数据卷或执行 `down -v`。升级短暂重启 bridge，之后新增账号登录不需停原 bridge。

## 本版行为变化

- 后台“账号管理”列设置勾选**备注 / Notes**，查看每 5 分钟同步的真实 Mira 剩余额度和重置时间。本地 quota 计费条保留原含义。
- 既有 sub2 账号分组默认保留，不会被旧配置自动改回；新账号使用 `--group-id`。
- 默认排除 `deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`。此前三个型号实测上游 503；本轮复测 `deepseek-flash` 仍为 `no upstream available`，不代表已修复上游容量。确认恢复后可设置 `constraints.disabled_models` 为 `[]`，重启并单次验证。
- 只有各 worker 管理的账号自动更新模型映射和额度。手工克隆账号可能保留旧 DeepSeek 映射，需后台单独调整。
- Kimi 默认 low effort、每个 worker 最多一个并发；保留调用方显式推理设置。SSE 结束事件后立即结束响应，避免额外等待上游断开。
- bridge 的 `test` / `models --check` 默认 128 输出 token、30 秒测试超时，可用 `--timeout-sec` 调整；不更改 sub2 内置测试的超时。Kimi 本轮真实低 effort 请求仍在 45 秒超时，不能保证上游变快。

已部署配置的显式值优先于默认值；检查曾自定义的 disabled_models、quota、Kimi 并发参数。

## systemd 已部署用户

解压新源码包到新的临时目录，停止主服务及所有 profile 服务，在源码目录执行 `sudo bash install.sh`，再启动服务。自定义安装用户/目录继续沿用原参数。安装器保留已有配置和登录态，详见 [DEPLOY.md](DEPLOY.md)。

离线回归和 Compose 配置解析已检查；本机未进行 Docker Engine 构建运行或真实第二个 Google 账号登录。服务器上需完成 status、备注显示和一次真实请求验收。
