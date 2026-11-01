# 与官方客户端的一致性

这份文档记录「桥接器发出的请求和 Mirasim 官方桌面客户端差在哪」，以及哪些差异已经被**证明消除**、哪些仍然存在。

## 已证明一致（字节级，有回归测试）

官方桌面客户端把签名内核编译成 wasm 内嵌在 `server-main.cjs` 里（导出的 `cc_sign` / `cc_seal` / `cc_canonical`）。仓库把这块 wasm 原样保存在 `lib/vendor/cc.wasm`，`tests/official-wire-format.test.js` 用它做**标准答案**：

| 项 | 验证方式 | 结果 |
|---|---|---|
| canonical 字符串 | 我们的 `canonical()` vs 官方 `cc_canonical` | **逐字节相同** |
| 加密信封 | 我们的 `seal()` vs 官方 `cc_seal` | **逐字节相同** |
| Ed25519 签名 | Node `crypto.sign` vs 官方 `cc_sign` | **逐字节相同** |
| 信封内外 header 划分 | 官方 `RSi` / `Brc` 规则 | **一致** |

canonical 格式（官方 `cc_canonical` 实际输出）：

```
mrs-sig-v2
<METHOD>
<path>
<ts>
<nonce>
<deviceId>
<clientVersion>
sha256(credential)      ← hex，不是明文
sha256(metaPairs)       ← "<k>\0<v>\0..." 的 sha256
sha256(body)
```

信封内外（官方规则）：

- **信封内**：`x-mirasim-session`、`x-mirasim-agent`、`x-mirasim-call`、`x-mirasim-account`、`x-mirasim-collect`、`x-mirasim-locale`、`x-mirasim-repo`、`x-mirasim-git-head`
- **明文保留**：`x-mirasim-device`、`x-mirasim-ts`、`x-mirasim-nonce`、`x-mirasim-sig`、`x-mirasim-client`
- **单独发送**：`x-mirasim-enc` 承载加密后的 meta

## 未解决：relay 仍然拒绝

即使上面全部字节级一致，推理请求仍返回：

```json
401 {"error":{"code":"device_signature","message":"request signature rejected (missing_headers)"}}
```

已排除的因素（都实测过）：

| 尝试 | 结果 |
|---|---|
| deviceId 用凭证派生值 / `device.json` 的 UUID | 同样 401 |
| credential 用 ticket / access token | 同样 401 |
| client_version 0.0.629 / 0.660 / 0.700 / 0.724 / 0.736 | 同样 401 |
| call id 放信封内 / 外 | 同样 401 |
| 补全 account / locale / collect | 同样 401 |
| 用官方 WASM 的 `cc_sign` / `cc_seal` 替代 Node 实现 | 同样 401 |
| 用桌面端当前实时凭证（`scripts/export-credential.js` 导出） | 同样 401 |

`missing_headers` 是 **relay 服务端**返回的，桌面客户端代码里没有这个字符串，因此无法从客户端侧反推它到底缺什么。

历史流量记录（`~/.mirasim/traffic/`）显示 claude 模型曾经成功 2328 次，最后一次成功是 **2026-10-05**；此后全部失败。这说明是上游行为变化，不是我们引入了回归。

## 结论

- **请求头、签名、信封格式**：已与官方客户端逐字节一致，并由回归测试锁定，任何漂移都会让 `official-wire-format.test.js` 失败。
- **能否被 relay 接受**：不在客户端可控范围内。需要一次官方客户端的真实成功请求抓包（含完整 header）才能继续定位。

## 复现验证

```bash
node --test tests/official-wire-format.test.js
```

若 `lib/vendor/cc.wasm` 缺失，三条字节级比对会跳过（`SKIP`），第四条 header 划分规则仍会执行。
