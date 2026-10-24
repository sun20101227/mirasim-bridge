# 降低暴露面：`local_only` 单账号自用形态

## 先说清楚它是什么

它做的是**把桥接器的本地行为收窄成一个自用账号的样子**：

| 项 | 改之前 | `local_only` 之后 |
|---|---|---|
| 在途推理请求 | 每账号最多 `forward.max_concurrency`（默认 2） | **1**，同一账号一次只跑一个 |
| 空闲期健康探测 | 每 30 秒发一次 `GET /v1/models` | 只在超过 30 分钟没有任何上游交互时探一次 |
| 额度后台轮询 | 每 300 秒 | 不低于 900 秒 |
| 会员后台轮询 | 每 900 秒 | 不低于 1800 秒 |

效果是：上游看到的事实变成「一台机器、一个设备、一个账号、一次一个请求」。这是真实的，不是装出来的。

## 它刻意不做什么

- **不改**请求签名（`mrs-sig-v2` / `x-mirasim-sig`）
- **不改**设备指纹（`x-mirasim-device`、设备私钥、`deviceId`）
- **不改** `client_version` 去冒充新版官方客户端
- **不改**请求节奏、不补人工操作痕迹、不轮换身份

那些是让检测失效，属于绕过对方的访问控制。这个项目从 0.6.0 起就写在 `RELAY.md` 里：不伪造仓库路径、Git 提交、设备轮换或假装人工操作。这条线不动。

换句话说：**它的目标不是「检测不出来」，而是「本来就没有可检测的多租户特征」。**

## 怎么开

`config.json`：

```json
{
  "local_only": {
    "enabled": true,
    "single_concurrency": true,
    "idle_probe": true,
    "idle_liveness_sec": 1800,
    "quota_min_interval_sec": 900,
    "membership_min_interval_sec": 1800
  }
}
```

默认 `enabled: false`，升级不会改现有行为。字段校验：三个布尔 + 三个 ≥60 的整数秒，写错会在 `validateConfig` 阶段直接报错，不会带着半生效的配置跑。

启动时日志会打出来：

```
local_only 已启用：单并发 是，空闲探测间隔 1800s，额度轮询 900s，会员轮询 1800s
local_only 只收窄本地并发与后台轮询，不改签名、设备标识或请求节奏——上游看到的是本机真实形态，不是伪装的官方客户端
```

## 静默不会掩盖故障

这是实现里唯一需要小心的地方，也是我专门写了三条回归的原因：

- 只有**上一次探测已知健康**时才允许静默。健康状态未知（刚启动）或不健康（上次探测失败）时，照常每 tick 探测——否则永远发现不了恢复。
- 真实请求**成功或失败**都会重置静默计时器（`ctx.lastUpstreamAt`），不是只看成功。
- 超过 `idle_liveness_sec` 没有任何上游交互，强制探一次，用来发现凭证失效。
- `/__status` 里 `local_only.idle_probe_skipped` 会累计跳过次数，`last_upstream_at` 给最后一次上游交互时间——安静是能被看见的，不是黑箱。

## 状态如实报告

之前页面显示「并发上限 2」，而实际只放 1 个，这种情况不该发生。现在：

- `accountSummary` 同时给 `max_concurrency`（配置值）和 `effective_concurrency`（实际生效值）
- `/__status.local_only` 给出 `enabled` / `concurrency` / `idle_probe_skipped` / `last_upstream_at`
- 服务启动日志里的「并发上限 N」打的是实际生效值

## 验证

```
node --test tests/*.test.js   → 245 项通过（新增 local-only.test.js 8 项）
node mirasim-bridge.js selftest → 68/68
py -3 -m pytest tests/ -q      → 64 passed, 18 subtests
```

新增的 8 项覆盖：

1. 配置校验：默认关闭、各字段类型/下界、`local_only: null` 被拒
2. 关闭时并发/轮询严格等于配置值（不是"大致相同"）
3. 开启时压到 1；显式配置更长的间隔不会被缩短；`single_concurrency: false` 真的是开关
4. 并发闸门按 `local_only` 生效，不是按配置值（配置 3、在途 1，第二个请求被 503）
5. 空闲 tick 完全不发 `/v1/models`，计数正确，且 `lastHealthy` 仍为 true
6. 不健康账号持续探测，静默不掩盖故障
7. 关闭时健康循环照旧每 tick 探测（行为不变）
8. `/__status` 与账号摘要如实报告生效值

**未验证**：没有对 `relay.mirasim.ai` 实跑——账号共享额度仍在耗尽状态，任何推理请求在校验请求体前就回 429。上面的结论全部来自本地 mock relay 和纯函数测试。真实服务器上的并发收窄效果、以及上游是否真的因此少看一个维度，需要你那边有额度时才能确认。

## 上线前要你决定的两件事

1. **要不要关掉多账号托管。** `accounts.hosted` 里如果还挂着多个 profile，`local_only` 会把每个账号各自压到单并发，但「一个 bridge 出多个 Mira 身份」这个事实本身还在。真要收到单账号形态，得把托管账号摘掉，一个 bridge 对一个 Mira 账号。
2. **`forward.max_concurrency` 要不要一起改。** `local_only` 是运行时收窄，配置里仍写着 2 或更高，页面会同时显示两个值。如果你想彻底一致，把配置也改成 1，`local_only` 就变成纯保险。
