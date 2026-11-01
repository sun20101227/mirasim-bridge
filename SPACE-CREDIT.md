# 空间额度（space credit）

## Mirasim 有两套额度，只有一套在 `/v1/limits` 里

| | personal | space |
|---|---|---|
| 归属 | 用户本人（`subject: usr_…`） | 某个机器/空间（`nodeId: space-…`） |
| 查询接口 | `GET /v1/limits` | `GET /v2/machines/<nodeId>/credit` |
| 认空间参数吗 | **不认**。`?space=` 和 `x-mirasim-space` 都被忽略（2026-10-31 实测，响应完全一致） | 按 nodeId 天然区分 |
| 签名要求 | 无（控制接口） | 无，用 access token 即可 |

所以「把空间的额度反代出来」**不能**靠 `/v1/limits`——它对空间维度一无所知。

## 桥接器提供的接口

全部要求 `bridge_secret`（`x-api-key` 或 `Authorization: Bearer`）。读操作不产生推理用量。

| 接口 | 返回 |
|---|---|
| `GET /v2/machines` | 这台账号能看到的机器/空间（id、名称、平台、在线、客户端版本） |
| `GET /v2/machines/member-seats` | 同上 + 座位与归属（`kind`、`owner`、`seats`） |
| `GET /v2/machines/<nodeId>/credit` | 该节点的额度账本 |

写操作只开放两个，都必须带显式确认：

| 接口 | 作用 |
|---|---|
| `PUT /v2/machines/<nodeId>/credit/mode` | `{"mode":"space"}` 用空间池付费；`{"mode":"personal"}` 用个人额度 |
| `PUT /v2/machines/<nodeId>/credit/prefer` | 另一套额度付不了时回落到哪个 |

转账（`transfers`）和上限（`caps`）**不开放**——它们直接动钱。

`nodeId` 只接受 API 自己会产出的形状：`pc-…`、`space-…`、`alloc_…`。百分号编码会在校验前解码，`a%2F..%2Fb` 这类路径直接拒绝，不会成为任意路径代理。

### `credit` 响应示例（实测 space-316be）

```json
{
  "node_id": "space-316be",
  "space_key": "alloc_77f4ba7d0ac91f16",
  "mode": "space",
  "balance": 1182,
  "funded": 1250,
  "used": 68,
  "space_funded": true,
  "payer": "space",
  "empty_reason": null,
  "me": { "cap": null, "used": 68, "remaining": null, "prefer": "space" },
  "members": [{ "role": "owner", "used": 68, "contributed": 0 }]
}
```

字段说明：

- `space_funded` —— **判断「这个空间有没有额度」请用这个**。`balance > 0` 对一台已充值的机器也成立，不区分是不是空间池。
- `payer` —— `space` 表示从空间池扣费；`personal` 表示回落到个人额度。
- `empty_reason` —— 空间没充值时上游会说 `space_empty`。这是正常状态，不是错误。
- `balance` / `funded` / `used` —— 上游单位。**不是美元，也不是 sub2api 的计费余额。**

## 空空间的正常表现

一台被 attach 但从未充值的机器返回：

```json
{ "balance": 0, "funded": 0, "mode": "space", "payer": "personal", "empty_reason": "space_empty" }
```

这跟「查询失败」是两回事。接口照常 200，数值照实返回 0。

## 命令行

```bash
node mirasim-bridge.js space-credit                    # 列出全部空间
node mirasim-bridge.js space-credit space-316be        # 查单个空间
node mirasim-bridge.js space-credit space-316be --raw  # 上游原始 JSON
```

`space-credit` 命令要求 `backend: "relay"`。

## 网页后台

`space-credit` 是管理端操作（`/__panel/space-credit`），参数 `{ account?, node? }`：

- `{}` → 列出该账号可见的空间
- `{ node: "space-316be" }` → 单个空间的额度

`space-credit` 是只读操作，不抢升级/OAuth 的互斥锁；`space-pool` 会动钱，所以列在写操作里，需要显式确认，并参与互斥。宿主机（`panel-host.py`）与容器内适配器（`panel-bridge.js`）的白名单都已放行。

## 边界

- **不提供充值、转账、改上限。** 只有 `mode` 和 `prefer` 两个开关开放，因为它们决定"用哪套额度"，不是转移余额。`can.toggle` / `can.set_caps` / `can.transfer` 只作为上游事实透出。
- **`/v2` 只发 `authorization: Bearer <access token>`**，和官方客户端 `ugn()` 完全一致：不带签名、不带加密信封、不带任何 `x-mirasim-*` 头。2026-11-01 实测确认这条路可用。
- 切换付费来源会立即影响后续请求的扣费；余额为 0 的空间切过去也不会有额度，页面会提示。

## 网页端

「运行概览」页新增**空间额度**卡片：列出每个空间/机器、余额进度、当前付费来源，余额非零的空间有「用这个空间的额度」按钮。点击后会 `PUT .../credit/mode`，并回读确认。
