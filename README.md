[**中文**](./README.md) | [English](./README.en.md)

# dsh-ofm-quota

**看得见还剩多少，用光了自动换。**

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 上的 [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 加上**接口配额管理**：实时统计每次对话真正落在哪个接口上、花了多少 token；额度耗尽时自动切到**同名模型的其他接口**。右侧栏多一张卡片，把「还剩多少」摊开给你看。

> **官方路由默认不兜底。** DSH 内核自带的 `deepseek-account`（DeepSeek 官方账号）是**按量计费**的，和 Our Free Model 的免费车道是两套体系。本插件默认**不会**在你不知情时切过去——额度用尽就如实报错。想开兜底要显式配置 `officialFallback`；面板里官方路由永远单独标成「官方 · 计费」并沉底，不会混在免费车道里。

[![test](https://github.com/dx906/dsh-ofm-quota/actions/workflows/test.yml/badge.svg)](https://github.com/dx906/dsh-ofm-quota/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](./package.json)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-6f42c1.svg)](#安装)
[![platform](https://img.shields.io/badge/platform-web%20%7C%20desktop-0a7ea4.svg)](#安装)

---

## 它解决什么问题

Our Free Model 把十几家免费与协付渠道聚合成一个 provider，好处是一次登录到处能用。但它带来三个麻烦：

1. **你看不见剩多少。** 每个渠道的积分是独立的一池，TRAE 剩 382、Qoder 剩 400、ZCode 已经 0——这些数字散在各家控制台里，聚合面板上不显示。
2. **用光了才知道。** 触发一线是 HTTP 429 或 `QUOTA_EXHAUSTED`。那一刻对话正卡在中间，你只能手动去模型选择器里翻下一个。
3. **累计消耗是笔糊涂账。** 一天下来跑了多少 token、哪家吃了大头，没有地方对得上。

这个插件补的就是这三件事。它不是 OFM 的替代品，是**架在它旁边的仪表盘与自动挡**。

## 特性

### 1. 用量检测

旁听内核的 `llm/stream` 水位，记录每次请求实际派发到的 `provider/model` 与适配器回报的 token 用量（输入 / 输出 / 思考 / 缓存读）。

两个数据源交叉印证：

| 来源 | 是什么 | 可信度 |
|---|---|---|
| **我们旁听** `llm/stream` | 本进程内每一次真实派发 | 实时，但只覆盖本进程 |
| **渠道包权威台账** `token-ledger.json` | 渠道包自己按 `direct\|provider\|accountId\|model` 逐日累计 | 含历史全部请求，是权威值 |

界面上两者都给：**模型用量明细**里能看到「我们旁听 773 次 / 渠道包权威 1628 次」这样的对照，差异说明有请求发生在插件安装之前。

### 2. 额度耗尽自动切换

额度耗尽时**自动切到同名模型的其他接口**。默认到此为止——不再往下走官方计费。

```
接口额度耗尽（QUOTA_EXHAUSTED / 429 / 授权失效）
      ↓
沿「同名族」找还有额度的备用接口
      ↓
找得到 → 换过去重跑本 step，对话不中断
找不到 → 如实报错（默认）
         └─ 只有显式配了 officialFallback，才切 DeepSeek 官方模型
```

**为什么默认不兜底到官方**：`deepseek-account` 是 DSH 内核自带的官方账号路由，**按量计费**。
自动兜底等于在用户不知情时花钱，而且失败是静默的——用户只会觉得「怎么变慢了」，
看不到账单。把失败如实抛出去，让用户自己决定值不值得花这个钱，才是正确的默认。

### 3. 侧边栏卡片

DSH 原生右侧栏新增「接口额度」卡片，展示各渠道的**剩余积分**与实时消耗。

**余额是渠道账号的属性，不是模型的属性。** 同一渠道下的几十个模型共享一份积分池，所以卡片只画一张渠道卡（可展开看每个账号），而不是为每个模型重复同一个数字——后者只会得到满屏「额度未知」。模型级用量折叠在次级的「模型用量明细」里，默认收起。

## 界面

右侧栏 →**接口额度**：

```
┌─ 接口额度 ────────────────────────┐
│ 讯飞 Loomy        剩余 4320 credits│
│ Qoder CN          剩余  400 credits│
│ 有道 LobsterAI    剩余  400 credits│
│ TRAE（字节）       剩余   19.67 credits│
│ ZCode（智谱）      剩余    0 credits│
│ Cline             余额未知          │
│                                   │
│ ▸ 模型用量明细 (12)                │
└───────────────────────────────────┘
```

`余额未知` 是**如实报告**，不是失败：Cline 没配凭据时，插件不会伪造一个 0（那会让你以为积分没了）。

## 前置要求

- **DSH**（DeepSeek Harness），提供 profile / bundle / cordis 插件机制。
- **[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)**，提供被管理的渠道。本插件依赖它的落盘文件与 `channel-pack` RPC。
- **Node.js** `^22.19.0 || >=24.0.0`。

**零运行时依赖。** 只用 Node 内置模块（`node:crypto` / `fs` / `os` / `path` / `url`），`client.js` 连 import 都没有。装进来的字节就是你审得完的字节——没有 `node_modules` 里的意外。

> 本插件只读 OFM 的**落盘文件**，不修改它、不替代它。两者可以独立升级。

## 安装

本包**不打到 npm**（`private: true`）。从源码打 tarball 装进 profile——这样装进去的字节和你审过的源码一致。

```sh
# 0. 拿到源码
git clone https://github.com/dx906/dsh-ofm-quota.git
cd dsh-ofm-quota

# 1. 打本地 tarball 到 profile 的 vendor/
mkdir -p "$DSH_HOME/profiles/desktop/vendor"
pnpm pack --pack-destination "$DSH_HOME/profiles/desktop/vendor"

# 2. 在 profile/package.json 的 dependencies 加一行：
#    "dsh-ofm-quota": "file:./vendor/dsh-ofm-quota-0.1.1.tgz"

# 3. 在 profile/package.json 的 dsh.profile.bundles 末尾追加：
#    "dsh-ofm-quota"

# 4. 在 profile 目录解析依赖
cd "$DSH_HOME/profiles/desktop"
pnpm install --frozen-lockfile --offline --ignore-scripts
```

> **改完 tarball 必须同步更新 `pnpm-lock.yaml` 里该包的 `integrity`**（sha512-base64），否则 `--frozen-lockfile` 会失败。同版本号时 pnpm 还会认为 `Already up to date`，需要先 `rm -rf node_modules/dsh-ofm-quota` 再 `--force`。

装完**从托盘退出并重开 DSH**。

> ⚠️ **不重启等于没装。** 运行中的宿主是旧代码——这一点在开发期间骗过我们一次：磁盘上明明修好了，行为却还是坏的。插件启动时会打一行 `[ofm-quota] loaded build=<hash>`，拿它确认版本。

**web 与 desktop 共用同一个 profile，一次安装两边都生效。**

### 桌面端的一个坑

桌面端的 `desktop` profile 由 Electron 应用独占，CLI 直接 `dsh plugin add` 会报：

```
profile "desktop" is managed exclusively by the Electron application
```

所以上面的手工步骤是桌面端的正路（应用内插件管理器也可以，但本包建议手工装，理由见下）。

## 快速开始

1. 重开 DSH，右侧栏点开**接口额度**。
2. 点**同步**——插件从本机落盘文件读取接口清单与历史用量。

| 数据源 | 路径 | 提供什么 |
|---|---|---|
| Our Free Model catalog | `$DSH_HOME/our-free-model/catalog.json` | free / EAC / Kilo 三条车道的接口清单（`entries` / `sealIds` / `kiloRows`） |
| 渠道包账号 | `$DSH_HOME/channel-pack/state.json` | 已登录的渠道账号（trae / qodercn / loomy / zcode …） |
| 渠道包用量 | `$DSH_HOME/channel-pack/token-ledger.json` | **权威 token 用量**，按 `direct\|provider\|accountId\|model` 逐日累计 |

3. 点**刷新余额**——拿到各渠道的真实剩余积分。
4. 正常用。额度耗尽时它会自己换接口。

> **为什么不走它们的 HTTP API？** `/api/our-free-model/*` 受内核 connection 的 `dsh-auth-*` cookie 围栏保护（无 launch token → 401），`/api/channel-pack` 是 exact Fetch route（非 owner peer → 403）。同进程读文件是被支持的路径，也是唯一稳的路径。

## 工作原理

### 1. 余额：为什么要绕一个弯

渠道包把余额 RPC 注册成 connection 的 **exact Fetch route**（`/api/channel-pack`），而 exact route 对**非 owner Peer 一律返回 403**（`dsh-client-connection/lib/index.js:830`）。这正是 Our Free Model 自己的 host 半身也读不到余额、只能靠浏览器半身去读的原因。

本插件在 host 半身里造一个**进程内 owner Peer** 再自己 dispatch：

```js
const peer = connection.createPeer({ principal: { kind: 'owner' } })
const handler = connection.createSharedFetchHandler('/api')
await handler.fetch(new Request('http://127.0.0.1/api/channel-pack', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'client-request', rpcId: '...', method: 'channel-pack',
    payload: { method: 'credits.balances', payload: { provider: 'trae', force: true } },
  }),
}), peer)
```

这样拿到的余额会落进接口行的 `quotaRemaining`，自动切换不必等 429 就能**提前**换走。

宿主没有 `createSharedFetchHandler` 时只降级（返回 `no-connection`），绝不抛错。

> **`balance: null` + `error` 绝不能当 0。** 渠道包自己记录过这个已修复的报障——查询失败显示成 0 会让用户以为积分没了。本插件只在拿到真实数字时才把 `quotaKnown` 置真；全部账号都查不到时返回 `ok:false` 并带上原因。

### 2. 自动切换：用内核原生的两个水位钩子

不碰 `ctx.llm`（它没有 middleware），用内核自己的 waterfall：

```
agent/request-error  → 失败且命中触发码 → 决定目标 → 记 pending → 返回 {kind:'retry'}
agent/request        → loop 重跑本 step → 读出 pending → 改写 provider/model → 丢弃 reasoningEffort
```

三个必须做对的细节：

1. **触发码要覆盖两个命名体系。** 内核的 `normalizeLlmFailure` 会**原样保留**适配器自己抛出的 `code`（`dsh-llm/lib/index.js:402-410` 的 `ownErrorCode`），并不把它映射成内核码。所以要同时列内核码与生态码：

   - 内核码：`QUOTA` / `ACCOUNT_QUOTA` / `RATE_LIMIT` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED`
   - OFM 生态码（`src/http.js:29-51`，channel-pack 沿用同一套）：`QUOTA_EXHAUSTED`（**最关键**）/ `PERMISSION_DENIED` / `AUTHORIZATION_REQUIRED` / `LANE_LOCKED`

   `QUOTA` 与 `ACCOUNT_QUOTA` 必须**都写**：`dsh-llm-deepseek-account` 会把前者升格成后者（`lib/index.js:455-460`），只写一个就少触发一半。

2. **换路必须丢弃源路由的 `reasoningEffort`。** 那是上一条路由自己的思考档位，目标适配器可能不认这个 id。与路由无关的字段（`maxTokens` 等）原样保留。

3. **`signal` 已 abort 时不得返回 retry**，否则 loop 会再跑一次被中止的 step。

其他行为：

- **同名匹配**按归一化族名（剥掉 `-free` / `-preview` / `-latest` / `-stable`）。实测 `trae/deepseek-v4.1-flash` 与 `our-free-model/deepseek-v4.1-flash-free` 互为备用接口。
- **官方路由永不作为「同名备用接口」**，它只能是兜底——否则兜底永远走不到。
- **`CONTEXT_WINDOW_EXCEEDED` 是请求级失败**，只换接口不打冷却，避免一个 1M 窗口接口被几轮长对话误判成不可用。
- **失败接口进冷却**（默认 15 分钟），冷却期内不会被优先选中。
- **每 step 切换次数有上限**（默认 3），防止链式循环放大延迟。
- **组合顺序天然正确**：本插件在 `dsh.profile.bundles` 末尾，注册晚于 `dsh-base` 里的 `llm-retry`，所以 llm-retry 先尝试重试，只有它放弃后才轮到换接口。

### 3. 路由自带信任围栏

插件的 HTTP 路由挂在 `/api/ofm-quota`，比内核的 `/api` 更长，**会先命中**——所以准入检查必须自己做，不能指望内核兜底。

有 `connection` 时用它的 `admit` 裁决；没有时按 loopback + 同源结构化复刻。**比较的是含端口的 `url.host`，不是 hostname**（只比 hostname 会让本机任意端口的页面越权）。fail-closed。

## 配置

`$DSH_HOME/ofm-quota/settings.json`，或卡片 / HTTP 改：

```json
{
  "enabled": true,
  "autoSwitch": true,
  "maxSwitchesPerStep": 3,
  "cooldownMs": 900000,
  "windowHours": 24,
  "officialFallback": null,
  "syncCatalog": true,
  "manualQuota": {}
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoSwitch` | `true` | 自动切换开关 |
| `triggerCodes` | 9 个码（见下） | 触发切换的失败码。**必须同时覆盖内核码与 OFM 生态码** |
| `maxSwitchesPerStep` | `3` | 每 step 最多切换次数（防止链式循环） |
| `cooldownMs` | `900000` | 失败接口冷却时长（15 分钟） |
| `windowHours` | `24` | 用量统计窗口 |
| `officialFallback` | **`null`（关闭）** | 全部第三方不可用时的兜底路由。**官方按量计费，所以默认关**；开启请写真实 provider id：`{ "provider": "deepseek-account", "model": "deepseek-flash" }` |
| `syncCatalog` | `true` | 启动时自动从 OFM catalog 同步接口清单 |
| `manualQuota` | `{}` | 手填额度（真实读取优先，手填只兜底） |

`triggerCodes` 默认值：

```js
// 内核码
'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED',
// Our Free Model / channel-pack 适配器码
'QUOTA_EXHAUSTED', 'PERMISSION_DENIED', 'AUTHORIZATION_REQUIRED', 'LANE_LOCKED',
```

**设置迁移是并集式的**：升级插件时会补齐新增的默认触发码，但**不会删掉你自己加的码**，且幂等。

想手填额度还有两条路：

- `POST /api/ofm-quota/quota` `{provider, model, remaining, total}` — 给单个接口
- `POST /api/ofm-quota/provider-quota` `{provider, remaining, total}` — 给整个渠道

## HTTP API

全部挂在 `/api/ofm-quota`（同源，与宿主 `/api` 同一信任围栏）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/status` | 卡片用：接口行、各 lane 汇总、额度可得性、最近切换/失败 |
| GET | `/endpoints` | 仅接口行 |
| POST | `/sync` | 从落盘文件同步接口清单与用量 |
| POST | `/balances` | **读渠道真实剩余积分**（`credits.balances`）；可只给 `{provider}` |
| POST | `/settings` | 改开关（校验白名单字段） |
| POST | `/quota` | 手填单接口额度 |
| POST | `/provider-quota` | 手填整个渠道额度 |
| POST | `/unblock` | 手动解除冷却 |
| POST | `/reset` | 清空用量与切换记录 |

`/balances` 只接受**已知 provider**（静态 12 渠道表 + 已登录 / 已同步过的），避免被当成任意上游的探测跳板。

## 额度可得性（实测结论，不是免责声明）

**渠道包的十二个渠道能读到真实剩余积分**——点卡片上的「刷新余额」即可，走的是渠道包自己的 `credits.balances` RPC，拿到的就是 Our Free Model 卡片上显示的那个数字（例如 TRAE 的「剩余积分 382」对应返回值的 `balance.total`）。

| 车道 | 能读额度 | 依据 |
|---|---|---|
| channel（trae / qoder / qodercn / codearts / loomy / raccoon / minimax / zcode / cline / gemini / lobsterai / opencode） | ✅ 真实积分 | 渠道包 `credits.balances` RPC，`balance.total` |
| free（匿名免密车道） | ❌ | 只有 `429` + `retry-after`，无额度端点 |
| EAC（协付） | ❌ 个人额度 | 只有 GitHub 授权状态与池级容量 |
| Kilo | ❌ | 没有额度概念 |
| aggregate（自带 key 的 provider） | ❌ | 需对每个 provider 单独实现余额查询 |

读不到额度的车道不装死：它们靠**失败反馈**触发切换。

## 自检

```sh
pnpm test                  # 两套都跑
pnpm run test:host         # 仅 host 半身
pnpm run test:client       # 仅浏览器半身
pnpm run deadcode          # 死代码扫描
```

`scripts/selftest.mjs`（host 半身，**17 组**）覆盖：三个钩子的真实 payload 形状与返回契约、同名备用接口解析（含官方路由及其旧别名必须被排除）、**官方兜底默认关闭 / 显式开启 / 必须能再关掉**、落盘文件同步（catalog 三种 id 形态 / 渠道账号 / token-ledger）、渠道余额 RPC（owner Peer 与非 owner 403 的对照）、**路由准入围栏的正反例**、**有界内存**（turn 表上限 512、路由表上限 256）、**额度来源优先级（真实读取压过手填）**、HTTP 路由、契约审计三条、**死代码审计四条**（账号累加 / 解除冷却 / 失败回写 / reset）。

`scripts/client-test.mjs` 覆盖：ModuleLoader 入口契约、tab 类型与两个 keyed 席位注册、组件在最小 props 下不抛错、**路由 URL 不得带前导斜杠**（反代前缀或 `dsh-app://` 壳下会 404/跨源）。

全部离线运行，不启动宿主。CI 在 Node 22.19 与 24 上跑同一套（`.github/workflows/test.yml`）——因为零依赖，CI 里连 install 步骤都不需要。

> **测试哲学：每条关键断言都做反向对照。** 把修复改回坏代码，确认测试真的会红。这条规矩是被现实教出来的——我们曾写过一条**永远不会执行**的断言（`if (requested.length > 0)` 里的 `requested` 恒为空数组），于是「已锁定该缺陷」这句话整整骗了自己一轮。

## 常见问题

**Q：装了没反应？**
A：多半是没重启。宿主进程里跑的是旧代码。看日志有没有 `[ofm-quota] loaded build=`。

**Q：余额全是「未知」？**
A：先点「刷新余额」。如果仍未知，说明 `connection` 服务不可用——那是个真实降级，插件不会伪造数字。Cline 之类没配凭据的渠道会一直显示未知，这是对的。

**Q：为什么卡片不按模型显示额度？**
A：余额根本不在模型粒度上。同一渠道的几十个模型共享一份积分池，按模型重复画只会得到满屏「额度未知」。

**Q：自动切换没触发过？**
A：只有额度真的耗尽才会触发。如果 `switches: 0` 且 `failures: 0`，说明你还没撞上过额度墙。

**Q：它会偷偷联网吗？**
A：会联网，但不是偷偷的。启动 3 秒后它会主动打一次上游读余额（`bootstrap()`）。`settings.syncCatalog` 只能关掉清单同步，关不掉这个自举。想要零自动外联需要再加开关。

**Q：和 OFM 的自动更新冲突吗？**
A：如果你用包管理器（pnpm）装了本插件，本插件是独立包，与 OFM 各自的更新互不影响。

## 已知边界

- 只有渠道车道能**提前**读到余额；free / EAC 个人 / Kilo / aggregate 没有额度端点，只能靠失败反馈触发切换。
- 余额按**渠道账号**展示，不按模型。
- 真实读取到的余额压过用户手填值；手填只在读不到时兜底。
- 路由 `/api/ofm-quota` 自带信任围栏，因为它比内核 `/api` 更长、会先命中。

## 兼容性

| 组件 | 版本 |
|---|---|
| DSH | 内核 `0.2.1-rc.2` 上实测通过 |
| dsh-our-free-model | `2.5.8` 上实测通过 |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

DSH 的插件 API 仍在快速演进（`0.1.x` / `0.2.x` 并存）。本插件对内核契约的依赖点都写在注释里并标了出处文件与行号，升级内核时按那些锚点检查。

## 免责声明

本插件是独立第三方作品，与 DeepSeek、Our Free Model 及各渠道提供方均无隶属关系。它只读取本机落盘文件并调用本机 DSH 进程内的 RPC，不上传任何数据到第三方服务器。

各渠道的免费额度由渠道方提供，其条款与可用性由渠道方决定。

## 许可

[MIT](./LICENSE)

## 致谢

- **[Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)** — 本插件管理的渠道聚合层，也是本项目的存在理由。
- **dsh-better-sidebar** — 右侧栏卡片的形态参考。
- **dsh-my-guardian** — 原生 sidebarRightTabs + slots 写法的参考实现。
