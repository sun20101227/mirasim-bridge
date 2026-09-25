# 从 0.4.2 升级到 0.4.3

0.4.2 漏掉了向 sub2api 保存 `credentials.model_mapping` 的步骤：`sync-upstream` 能返回真实目录，却不会替调用方配置模型映射；随后 GET models 会回退到平台默认列表，使非空检查误判为成功。

0.4.3 明确保存原名到原名的映射，然后精确回读验证。健康循环在映射变化时先暂停、更新、校验，再按原有健康策略恢复。相同映射不重复写入或暂停；API Key 和其他凭据字段保持原值。

2026-09-25 已通过管理 API 修正线上 `mirasim-cloud`（本次查询 ID 103），回读为 15 个模型、active、schedulable=true，未调用推理。后续账号 ID 以名字查找，不把 103 写死在程序里。

## Docker 升级

上传 **mirasim-bridge-0.4.3-source.zip** 到服务器。这个包不包含凭证，适合覆盖旧目录的代码。

假设旧目录是 `~/mirasim-0.4.2/mirasim-bridge`，在该目录执行：

```bash
cd ~/mirasim-0.4.2/mirasim-bridge
docker compose stop bridge
unzip -o ~/mirasim-bridge-0.4.3-source.zip -d ~/mirasim-0.4.2
sha256sum -c SHA256SUMS
docker compose build bridge
docker compose up -d bridge
docker compose logs --tail=100 bridge
```

实际目录不同则替换两处路径；父目录仍叫 0.4.2 不影响运行版本。`.env`、private 文件和 Docker 数据卷都不在源码覆盖范围内。**不要重新运行 setup，也不要 down -v。** host 网络用户的 Docker Compose 命令继续加 `-f compose.host.yaml`。

验收：

```bash
docker compose exec bridge node /app/mirasim-bridge.js --version
docker compose exec bridge node /app/mirasim-bridge.js status --config /data/config.json
docker compose exec bridge node /app/mirasim-bridge.js models --config /data/config.json
```

版本应为 0.4.3。恢复可能需要几轮健康检查，最终应见 sub2api managed=true、reachable=true、schedulable=on。目录包含四个系列不等于每个型号当时都有容量，DeepSeek 仍需真实请求确认。

需要验证一次推理时（产生实际用量）：

```bash
docker compose exec bridge node /app/mirasim-bridge.js test \
  --config /data/config.json --model claude-haiku-4-5
```

客户端访问 sub2api 时使用属于 `mirasim` 分组的**用户 API Key**，不要使用管理员 Key。Messages 入口仍为 `/v1/messages`。
