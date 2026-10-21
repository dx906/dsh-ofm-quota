/**
 * dsh-ofm-quota — Host 半身（入口）。
 *
 * 三层职责，全部围绕「接口」这个概念：
 *
 *   1. 用量检测：`agent/request` 与 `agent/request-error` 两个水位钩子记下每次
 *      对话真正派发到哪个 provider/model，以及适配器回报的 token 用量。DSH 的
 *      `llm/stream` 是 waterfall，插件的 `agent/request` 又决定了最终 provider/
 *      model，因此「这一轮实际用了哪个接口」在这里是权威答案，而不是靠猜日志。
 *   2. 自动切换：额度耗尽（QUOTA_EXHAUSTED / RATE_LIMIT / 授权失效）时，沿
 *      「同名模型的其他接口」依次换，全部用尽则落到 DeepSeek 官方模型。
 *   3. 侧边展示：/api/ofm-quota/* 供右侧栏卡片读取，卡片走
 *      ctx.sidebarRightTabs + keyed slots，未装 better-sidebar 也能工作。
 *
 * 设计约束（为什么这样写）：
 *   - 顶层不声明 inject：宿主在 ctx 已 inactive 时解析顶层 inject 会抛错并让
 *     整个 dsh 启动失败；改用 apply 内 ctx.inject 局部等待（与 dsh-my-guardian
 *     的 issue #242 修复同一模式）。
 *   - 任何一条路径抛错都只能降级自己，绝不能把 boot 拖下水。
 *   - 所有外联只走本机 /api/ofm-quota 与宿主已提供的服务，不另起服务、不改
 *     Our Free Model 的文件。
 *
 * @module index.js
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ofm-quota'

/**
 * 渠道包的 provider 显示名。**同时是 `/balances` 的白名单来源**，所以放在顶层
 * 常量里：运行时与路由共用同一份真相，不会漂移。
 */
const CHANNEL_PROVIDER_LABELS = Object.freeze({
  codearts: '华为云 CodeArts',
  lobsterai: '有道 LobsterAI',
  qoder: 'Qoder',
  qodercn: 'Qoder CN',
  trae: 'TRAE（字节）',
  cline: 'Cline',
  loomy: '讯飞 Loomy',
  raccoon: '商汤 Raccoon',
  minimax: 'MiniMax Code',
  zcode: 'ZCode（智谱）',
  gemini: 'Gemini',
  opencode: 'opencode',
})

/**
 * 把上游错误消息里的凭据抹掉，再落盘 / 回传浏览器。
 *
 * 为什么必须做：`INVALID_CREDENTIAL` 这类失败的上游响应体经常把收到的 key
 * 原样回显（401 body 里带 token 是常见实现）。这条消息会进 ledger、再经
 * /status 回传到浏览器——等于把凭据写进磁盘和一个前端面板里。
 *
 * 只做保守的形状匹配（Bearer / sk- 前缀 / 长十六进制串 / key=value），
 * 宁可多抹也不漏。抹掉的是"看起来像凭据"的片段，不是整个消息，保留诊断价值。
 */
function redactSecrets(value) {
  const text = String(value ?? '')
  if (text === '') return ''
  return text
    // Authorization: Bearer <token> / bearer <token>
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 [redacted]')
    // 常见前缀密钥：sk-xxx / pk-xxx / ak-xxx
    .replace(/\b(sk|pk|ak|rk)-[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    // 显式字段：api_key=xxx / token: xxx / secret="xxx"
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]{4,})/gi,
      (match, name, separator) => `${name}${separator}[redacted]`)
    // 长十六进制/Base64 串（32 字符以上，通常是 token 或 session id）
    .replace(/\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}/g, '[redacted]')
}

/**
 * 这三个键一旦成为对象键就会命中原型链，任何把它们当数据键用的地方都必须
 * 拒绝。定义在顶层（而不是某个 runtime 闭包里），因为 `upsertEndpoint` 这类
 * 早期函数要用它——放在后面会引入 TDZ 风险。
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 数据目录：$DSH_HOME/../ofm-quota（与 Our Free Model 平级，互不写对方文件）。 */
const DATA_DIR_NAME = 'ofm-quota'

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 顶层 inject 留空，见文件头注释。 */
export const inject = []

export function apply(ctx, config) {
  // Watchdog：apply 内的任何同步异常都只降级本插件。
  let shared
  try {
    shared = applyWithScopedServices(ctx, config ?? {})
  } catch (error) {
    ctx.logger?.warn?.(`[ofm-quota] apply failed — plugin degraded: ${messageOf(error)}`)
    return undefined
  }
  return shared
}

function applyWithScopedServices(ctx, config) {
  const logger = ctx.logger ?? console
  const dataDir = path.resolve(resolveDshHome(), DATA_DIR_NAME)
  const store = createStore(dataDir, logger)
  const runtime = createQuotaRuntime({ ctx, logger, config, store })

  // 加载指纹：把本文件的内容哈希打一行 info。
  //
  // 起因是一次真实的误判：磁盘上的 index.js 已经加好信任围栏，但运行中的宿主
  // 还是旧进程（没重启），于是外部测试仍然看到越权成功——「源码修好」与
  // 「进程真的加载了它」在日志里完全无从区分。打一行指纹就能一眼对上。
  try {
    const selfPath = fileURLToPath(import.meta.url)
    const digest = createHash('sha256').update(readFileSync(selfPath)).digest('hex').slice(0, 12)
    logger.info?.(`[ofm-quota] loaded build=${digest} bytes=${statSync(selfPath).size} pid=${process.pid}`)
  } catch (error) {
    logger.warn?.(`[ofm-quota] build fingerprint unavailable: ${messageOf(error)}`)
  }

  // 三个服务各自在自己的 scoped ctx 上等：
  //   llm        —— 装用量/切换钩子；
  //   webServer  —— 挂 /api/ofm-quota 路由；
  //   connection —— 造 owner Peer 读渠道真实余额。必须单独 inject：cordis 的
  //                 服务按 isolate 键取，webServer 作用域里读不到 connection，
  //                 这正是「刷新余额」一直返回 no-connection、余额永远未知的根因。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], scoped => {
      try {
        runtime.attachAgentHooks(scoped)
      } catch (error) {
        logger.warn?.(`[ofm-quota] agent hooks unavailable: ${messageOf(error)}`)
      }
    })
    ctx.inject(['webServer'], scoped => {
      try {
        runtime.mountRoutes(scoped)
      } catch (error) {
        logger.warn?.(`[ofm-quota] HTTP routes unavailable: ${messageOf(error)}`)
      }
    })
    ctx.inject(['connection'], scoped => {
      try {
        runtime.attachConnection(scoped)
        // 启动自举：把接口清单和渠道余额各拉一次，用户打开卡片就能看到真实
        // 数字，而不是先看到一片「额度未读取」。延迟 3 秒让宿主先完成挂载；
        // 失败只记日志，绝不影响启动。
        const warmup = setTimeout(() => {
          void runtime.bootstrap().catch(error => {
            logger.warn?.(`[ofm-quota] warmup failed: ${messageOf(error)}`)
          })
        }, 3000)
        warmup.unref?.()
      } catch (error) {
        logger.warn?.(`[ofm-quota] connection unavailable: ${messageOf(error)}`)
      }
    })
  } else {
    // 旧宿主 / 测试桩：直接尝试。
    try {
      runtime.attachAgentHooks(ctx)
    } catch (error) {
      logger.warn?.(`[ofm-quota] agent hooks unavailable: ${messageOf(error)}`)
    }
    try {
      runtime.mountRoutes(ctx)
    } catch (error) {
      logger.warn?.(`[ofm-quota] HTTP routes unavailable: ${messageOf(error)}`)
    }
    try {
      runtime.attachConnection(ctx)
    } catch (error) {
      logger.warn?.(`[ofm-quota] connection unavailable: ${messageOf(error)}`)
    }
  }

  return {
    store,
    runtime,
    flush: () => store.flush(),
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ─────────────────────────── 持久化 ─────────────────────────── */

/**
 * 一个极小的 JSON 存储：settings（用户开关）+ ledger（用量与切换记录）。
 *
 * 与 Our Free Model 的 JsonStore 同一写法：先合并默认值，损坏文件改名保留
 * 而不是覆盖，写入用 tmp+rename 且 mode 0600（里面只有用量计数，不含密钥，
 * 但保持与生态惯例一致）。
 */
/**
 * 设置的默认值。抽成函数是为了让「初始化」与「迁移」读同一份真相——
 * 迁移必须知道最新默认清单才能把旧配置补齐。
 */
function createSettingsDefaults() {
  return {
    enabled: true,
    /** 自动切换总开关。 */
    autoSwitch: true,
    /**
     * 触发切换的失败码。
     *
     * 必须覆盖**两个命名体系**，因为 DSH 的 `normalizeLlmFailure` 会原样保留
     * 适配器自己抛出的 `code`（见 dsh-llm/lib/index.js:402-410 的
     * `ownErrorCode`），并不把它映射成内核码：
     *
     * 1. **内核码**（`@deepseek-ai/dsh-llm/lib/types/error.js`）：
     *    `QUOTA` / `ACCOUNT_QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `INVALID_CREDENTIAL`
     *    + retry-policy 的 `RATE_LIMIT`。必须同时列 `QUOTA` 与 `ACCOUNT_QUOTA`：
     *    `dsh-llm-deepseek-account` 会把前者升格成后者，只写一个就少触发一半。
     * 2. **生态适配器码**（Our Free Model 的 `src/http.js:29-51` CODE 枚举，
     *    channel-pack 沿用同一套）：`QUOTA_EXHAUSTED`（额度用尽，**最关键**）/
     *    `PERMISSION_DENIED` / `AUTHORIZATION_REQUIRED`（协付车道未登录）/
     *    `LANE_LOCKED`（整条车道被拒）。这些码带着原值一路到达
     *    `agent/request-error`，所以必须逐个列出。
     *
     * 曾把 `QUOTA_EXHAUSTED` 误当「旧码」删掉——那会让本插件对 OFM 免费车道
     * 的额度耗尽完全不反应。这是审计发现的实质缺陷，已修复并由迁移兜底。
     *
     * `CONTEXT_WINDOW_EXCEEDED` 也触发，但走 request-scope：换到窗口更大的
     * 同名接口有意义，且不该给源接口打冷却。
     */
    triggerCodes: [
      // 内核码
      'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'INVALID_CREDENTIAL',
      'CONTEXT_WINDOW_EXCEEDED',
      // Our Free Model / channel-pack 适配器码
      'QUOTA_EXHAUSTED', 'PERMISSION_DENIED', 'AUTHORIZATION_REQUIRED', 'LANE_LOCKED',
    ],
    /** 同一 step 内最多切几次，防止链式循环放大延迟。 */
    maxSwitchesPerStep: 3,
    /** 被切走/失败的接口在这么多毫秒内不再被优先选中。 */
    cooldownMs: 15 * 60 * 1000,
    /** 全部第三方接口用尽后落到的官方路由。 */
    officialFallback: { provider: 'deepseek-official', model: 'deepseek-flash' },
    /** 是否允许启动时自动从 Our Free Model 的 catalog 同步接口清单。 */
    syncCatalog: true,
    /** 计算「剩余额度」时用的周期窗口（小时），仅用于按量估算展示。 */
    windowHours: 24,
    /** 每个接口的手动额度（读不到真实余额时的兜底）。 */
    manualQuota: {},
  }
}

function createStore(dataDir, logger) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const settingsFile = path.join(dataDir, 'settings.json')
  const ledgerFile = path.join(dataDir, 'ledger.json')

  const settings = createJsonStore(settingsFile, createSettingsDefaults(), logger)

  /**
   * 设置迁移：把老版本默认写进 settings.json 的 triggerCodes 补齐。
   *
   * 为什么必须有：JsonStore 的语义是「磁盘值覆盖默认值」，所以只改代码里的
   * 默认清单对**已落盘的旧配置毫无作用**。实测这台机器的 settings.json 存着
   * 不含 `QUOTA_EXHAUSTED` 的旧数组，于是额度耗尽时插件完全不反应。
   *
   * 只做并集、绝不删除用户自己加的码。
   */
  ;(() => {
    const defaults = createSettingsDefaults()
    const stored = settings.get().triggerCodes
    if (!Array.isArray(stored)) {
      settings.update({ triggerCodes: defaults.triggerCodes })
      return
    }
    const missing = defaults.triggerCodes.filter(code => !stored.includes(code))
    if (missing.length === 0) return
    logger.info?.(`[ofm-quota] settings migrated: triggerCodes += ${missing.join(', ')}`)
    settings.update({ triggerCodes: [...stored, ...missing] })
  })()

  const ledger = createJsonStore(ledgerFile, {
    version: 1,
    /** 每个接口一行：provider/model -> 累计计数与周期窗口。 */
    endpoints: {},
    /** 最近切换记录（环形，最多 200 条）。 */
    switches: [],
    /** 最近失败记录（环形，最多 200 条）。 */
    failures: [],
    /** 最近一次同步我们看到的 Our Free Model catalog 快照时间。 */
    catalogSyncedAt: 0,
    /** 从 channel-pack 的 token-ledger 导入的逐接口用量：`provider/model` -> 当日累计。 */
    imported: {},
    /** 最近一次导入 token-ledger 的时间。 */
    tokenLedgerAt: 0,
    /**
     * 渠道账号余额快照：`provider -> { at, unit, total, ok, rows[] }`。
     * 按账号而非按模型存——同一渠道的多个模型共享一份积分池，按模型重复
     * 显示同一个数字既冗余又误导。
     */
    accounts: {},
  }, logger)

  return {
    dataDir,
    settings,
    ledger,
    /** 落盘（宿主关停或面板按钮触发）。 */
    flush() {
      settings.flush()
      ledger.flush()
    },
    dispose() {
      settings.dispose()
      ledger.dispose()
    },
  }
}

function createJsonStore(file, initial, logger) {
  const state = {
    file,
    value: { ...structuredClone(initial) },
    dirty: false,
    timer: undefined,
    disposed: false,
  }
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      state.value = { ...state.value, ...parsed }
    }
  } catch {
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* 不可写的 home 不是这个文件的问题 */ }
  }

  const store = {
    get: () => state.value,
    update(patch) {
      if (state.disposed) return state.value
      state.value = { ...state.value, ...patch }
      store.schedule()
      return state.value
    },
    edit(mutate) {
      if (state.disposed) return state.value
      const next = mutate(structuredClone(state.value))
      if (next !== undefined) state.value = next
      store.schedule()
      return state.value
    },
    schedule(delayMs = 800) {
      if (state.disposed) return
      state.dirty = true
      if (state.timer !== undefined) return
      state.timer = setTimeout(() => {
        state.timer = undefined
        store.flush()
      }, delayMs)
      state.timer.unref?.()
    },
    flush() {
      if (!state.dirty || state.disposed) return
      state.dirty = false
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(temp, JSON.stringify(state.value, undefined, 2), { mode: 0o600 })
        fs.renameSync(temp, file)
      } catch (error) {
        state.dirty = true
        logger.warn?.(`[ofm-quota] cannot write ${path.basename(file)}: ${messageOf(error)}`)
      }
    },
    dispose() {
      store.flush()
      state.disposed = true
      if (state.timer !== undefined) clearTimeout(state.timer)
    },
  }
  return store
}

/* ─────────────────────────── 运行时 ─────────────────────────── */

function createQuotaRuntime({ ctx, logger, config, store }) {
  const settings = store.settings
  const ledger = store.ledger

  /**
   * 每个 step 的切换计数，key = `${agent.id}:${turn}:${step}`。
   *
   * 必须修剪：key 里带 turn/step，一次会话跑几百轮就会往里塞几百个条目，
   * 而每个条目在 step 结束后再也不会被读到——不修剪就是纯泄漏（长跑会话
   * 内存单调上涨）。修剪策略见 `pruneTurnMaps`：超过上限时按插入顺序丢最旧
   * 的一批（Map 保证插入顺序，正好当 LRU 用）。
   */
  const switchBudget = new Map()
  const MAX_TURN_ENTRIES = 512

  /** 让几个「按 turn/step 记」的 Map 保持有界。 */
  function pruneTurnMaps() {
    for (const map of [switchBudget, pendingSwitch]) {
      if (map.size <= MAX_TURN_ENTRIES) continue
      // 多丢一些，避免每次只删一个导致每轮都进来修剪。
      const drop = Math.ceil(MAX_TURN_ENTRIES / 4)
      let removed = 0
      for (const key of map.keys()) {
        map.delete(key)
        removed += 1
        if (removed >= drop) break
      }
    }
  }

  /**
   * 接口清单。三个来源合并，按 `provider/model` 去重，供「同名备用接口」查找：
   *   1. `~/.dsh/our-free-model/catalog.json` 的接口清单（见 syncCatalog）；
   *   2. `~/.dsh/channel-pack/state.json` 里已登录的渠道账号（provider 级线索）；
   *   3. 本插件旁听 `llm/stream` 时看到的真实 provider/model。
   */
  const endpointIndex = new Map()
  /** provider -> { accounts, enabled, nickname, expiresAt }，用于判断车道是否可用。 */
  const providerAccounts = new Map()

  function endpointKey(provider, model) {
    return `${provider}/${model}`
  }

  /* ── 渠道余额：走 connection 的 exact Fetch route ──────────── */

  /**
   * 读渠道包里**真实**的剩余积分（TRAE 的「剩余积分 382」这类数字）。
   *
   * 为什么不是普通 HTTP：渠道包把余额 RPC 注册成 connection 的 exact Fetch
   * route（`/api/channel-pack`），而 exact route 对**非 owner Peer 一律 403**
   * （dsh-client-connection/lib/index.js:830）——这正是 Our Free Model 自己的
   * host 半身读不到余额、只能靠浏览器半身的原因。
   *
   * 正确姿势是造一个进程内 owner Peer 再自己 dispatch：
   *   peer = connection.createPeer({ principal: { kind: 'owner' } })
   *   handler = connection.createSharedFetchHandler('/api')
   *   response = await handler.fetch(new Request(...POST /api/channel-pack...), peer)
   * 请求体要符合 rpcFetchHandler 的封套：
   *   { type:'client-request', rpcId, method:'channel-pack', payload:{ method, payload } }
   * 返回 `{ ok: true, value }` 或 `{ ok: false, error }`。
   *
   * 注意 `createSharedFetchHandler` 在 0.2.1-rc.2 是**实例方法**；更早的宿主没有
   * 它，此时退回「只靠手动登记」，绝不抛错。
   */
  let channelRpcBridge = null
  /** connection 的 scoped ctx，由 apply 的 ctx.inject(['connection']) 交进来。 */
  let connectionScope = null

  function attachConnection(scoped) {
    connectionScope = scoped
    // 桥可能在 connection 到达前就用 null 缓存过，这里重置以允许重建。
    channelRpcBridge = null
    try {
      ensureChannelBridge(scoped)
    } catch {
      /* attach 期间建不起来不影响后面按需重建 */
    }
    return () => { connectionScope = null; channelRpcBridge = null }
  }

  function ensureChannelBridge(parent) {
    if (channelRpcBridge !== null) return channelRpcBridge
    const source = parent ?? connectionScope
    if (source === null || source === undefined) return null
    try {
      const connection = source.connection ?? source.get?.('connection')
      if (connection === null || connection === undefined) return null
      if (typeof connection.createPeer !== 'function'
        || typeof connection.createSharedFetchHandler !== 'function') return null
      const peer = connection.createPeer({ principal: { kind: 'owner' } })
      const handler = connection.createSharedFetchHandler('/api')
      channelRpcBridge = { connection, peer, handler }
      return channelRpcBridge
    } catch (error) {
      logger.warn?.(`[ofm-quota] channel RPC bridge unavailable: ${messageOf(error)}`)
      return null
    }
  }

  /**
   * 调用渠道包的一个 RPC 方法。返回 `value`，失败返回 null（调用方決定怎么展示）。
   * 超时 90 秒——余额查询会真的打到上游，TRAE/Qoder 有时很慢。
   */
  async function callChannelRpc(parent, method, payload, timeoutMs = 90_000) {
    const bridge = ensureChannelBridge(parent)
    if (bridge === null) return { ok: false, reason: 'no-connection' }
    const rpcId = `ofm-quota-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'channel-pack',
      payload: { method, payload },
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const request = new Request('http://127.0.0.1/api/channel-pack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      })
      const response = await bridge.handler.fetch(request, bridge.peer)
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
      const text = await response.text()
      const parsed = JSON.parse(text)
      // rpcFetchHandler 用 fullResponse 包了一层 { rpcId, result }。
      const result = parsed?.result ?? parsed
      if (result?.ok === true) return { ok: true, value: result.value }
      return { ok: false, reason: result?.error?.message ?? result?.error?.code ?? 'rpc-failed', code: result?.error?.code }
    } catch (error) {
      return { ok: false, reason: messageOf(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 把某个渠道 provider 的余额拉下来。
   *
   * **按账号记录，不按模型**：同一渠道的多个模型共享同一份积分池，为每个
   * 模型重复显示同一个数字既冗余又误导。用户要看的是「这个账号还剩多少」。
   *
   * 返回结构（TRAE 实测）：
   *   { accounts: [{ accountId, nickname, balance: { total, packages[], expiredTotal }, error? }] }
   * `balance.total` 就是 Our Free Model 卡片上的「剩余积分」。**`balance ===
   * null` 且带 error 时绝不能当 0**（渠道包自己的报障结论），如实标未知并带原因。
   */
  async function refreshProviderBalances(parent, provider, options = {}) {
    // `force` 必须由调用方决定，不能在这里写死 true。
    //
    // 写死 true 的后果（安全审计发现）：`credits.balances` 的 force 会绕过
    // 渠道包自己的缓存，每次调用都真的打上游；而调用方（/balances）的
    // provider 又来自 body、无白名单 —— 随机 provider 名能绕过 inFlightBalances
    // 去重，每个请求挂 90 秒超时，既是上游 DoS 也是内存放大。
    // 默认 false：走渠道包缓存；只有用户显式点「强制刷新」才传 true。
    const force = options.force === true
    const result = await callChannelRpc(parent, 'credits.balances', { provider, force })
    if (result.ok !== true) {
      return { ok: false, provider, reason: result.reason ?? 'failed' }
    }
    const accounts = Array.isArray(result.value?.accounts) ? result.value.accounts : []
    const rows = []
    let total = 0
    let known = false
    let unit = quotaUnitOf(provider, 'channel')
    for (const account of accounts) {
      if (account === null || typeof account !== 'object') continue
      const row = {
        provider,
        accountId: typeof account.accountId === 'string' ? account.accountId : '',
        nickname: typeof account.nickname === 'string' ? account.nickname : '',
        remaining: null,
        total: null,
        unit,
        error: typeof account.error === 'string' ? account.error : '',
        packages: [],
        expiredTotal: 0,
        at: Date.now(),
      }
      const balance = account.balance
      if (typeof balance === 'number') {
        row.remaining = balance
        row.total = balance
        total += balance
        known = true
      } else if (balance !== null && balance !== undefined && typeof balance === 'object') {
        if (typeof balance.unit === 'string' && balance.unit !== '') {
          unit = balance.unit
          row.unit = balance.unit
        }
        if (typeof balance.total === 'number') {
          row.remaining = balance.total
          row.total = balance.total
          total += balance.total
          known = true
        }
        if (Number.isFinite(Number(balance.expiredTotal))) row.expiredTotal = Number(balance.expiredTotal)
        if (Array.isArray(balance.packages)) {
          row.packages = balance.packages
            .filter(item => item !== null && typeof item === 'object')
            .map(item => ({
              name: typeof item.name === 'string' ? item.name : '',
              remaining: Number(item.remaining) || 0,
              total: Number(item.total) || 0,
              used: Number(item.used) || 0,
            }))
        }
      }
      rows.push(row)
    }
    const at = Date.now()
    // 账号级余额独立落盘：`accounts[provider] = { rows, total, unit, at }`。
    ledger.edit(state => {
      const previous = state.accounts ?? {}
      return {
        ...state,
        accounts: {
          ...previous,
          [provider]: { at, unit, total, rows, ok: known },
        },
      }
    })
    // 同时把 provider 级总额写到该渠道所有接口行，供 decideTarget 使用。
    //
    // H-3 / H-4 修复要点：
    //   - 读取**失败**时也要回写状态，否则行里还留着上一次的「382 可用」，
    //     而 decideTarget 会据此把对话切到一个凭据已经失效的接口上去；
    //   - `quotaUsed` 不能写死 0：剩余 == 总额时进度条恒满，「已用」恒为 0，
    //     面板等于没在报数。真实余额只有 remaining，总额是未知的，所以这里
    //     把 total 记为 remaining（即「当前可用即当前总额」），并把 used 标为
    //     0 的同时由前端按「已知总额 = 剩余」渲染——更诚实的做法是标成
    //     `totalUnknown`，让前端画不定态进度条而不是假的 100%。
    for (const entry of endpointIndex.values()) {
      if (entry.provider !== provider) continue
      if (known) {
        upsertEndpoint(entry.provider, entry.model, {
          quotaKnown: true,
          // 标记来源：真实读取的额度必须压过用户手填的旧值。
          quotaSource: 'observed',
          quotaRemaining: total,
          quotaTotal: total,
          // 上游只给「还剩多少」，没给「总额多少」；不要把 used 伪造成 0。
          quotaUsed: null,
          quotaTotalUnknown: true,
          quotaUnit: unit,
          exhaustedAt: total <= 0 ? at : 0,
          blockedUntil: total <= 0 ? at + (Number(settings.get().cooldownMs) || 0) : 0,
          lastError: '',
        })
      } else {
        // 读不到额度：标记为未知（而不是保留旧的成功读数），并记下原因。
        upsertEndpoint(entry.provider, entry.model, {
          quotaKnown: false,
          quotaSource: 'unknown',
          lastError: redactSecrets(rows.find(row => row.error !== '')?.error ?? 'balance unavailable').slice(0, 120),
        })
      }
    }
    if (!known) {
      const firstError = rows.find(row => row.error !== '')?.error
      return { ok: false, provider, reason: firstError ?? 'every account reported no balance', accounts: rows.length, rows }
    }
    return { ok: true, provider, remaining: total, unit, accounts: rows.length, rows }
  }

  /**
   * 刷新所有「已登录渠道账号」的余额。
   *
   * 性能考虑（用户反馈「响应有点慢」）：每个渠道的余额查询都要真的打到上游，
   * 一个接一个串行执行时，十二个渠道就是十二个往返。这里做三件事：
   *   1. **并发**（最多 4 路）——不同渠道之间互不依赖，串行只是浪费时间；
   *   2. **去重**：同一个 provider 的 in-flight 请求只发一次，重复点按钮不会
   *      叠加请求；
   *   3. **新鲜度**：30 秒内刚查过的渠道直接用缓存，除非显式 `force`。
   * 每个渠道单独 try，一个失败不拖垮其它。
   */
  const inFlightBalances = new Map()
  const BALANCE_FRESH_MS = 30_000
  const BALANCE_CONCURRENCY = 4

  async function refreshProviderBalancesOnce(parent, provider, { force = false } = {}) {
    const pending = inFlightBalances.get(provider)
    if (pending !== undefined) return pending
    if (!force) {
      const cached = (ledger.get().accounts ?? {})[provider]
      if (cached !== undefined && Number(cached.at) > 0 && Date.now() - cached.at < BALANCE_FRESH_MS) {
        return { ok: cached.ok === true, provider, remaining: cached.total, unit: cached.unit, cached: true, rows: cached.rows ?? [] }
      }
    }
    const run = (async () => {
      try {
        return await refreshProviderBalances(parent, provider, { force })
      } catch (error) {
        return { ok: false, provider, reason: messageOf(error) }
      } finally {
        inFlightBalances.delete(provider)
      }
    })()
    inFlightBalances.set(provider, run)
    return run
  }

  async function refreshAllBalances(parent, providers, options = {}) {
    const targets = Array.isArray(providers) && providers.length > 0
      ? providers
      : [...providerAccounts.keys()]
    const force = options?.force === true
    const results = []
    // 小并发池：手写而不是 Promise.all，因为要保留每个渠道的失败原因，
    // 且不能让一个渠道的 90 秒超时阻塞整批完成。
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const provider = targets[cursor]
        cursor += 1
        try {
          results.push(await refreshProviderBalancesOnce(parent, provider, { force }))
        } catch (error) {
          results.push({ ok: false, provider, reason: messageOf(error) })
        }
      }
    }
    const lanes = Math.max(1, Math.min(BALANCE_CONCURRENCY, targets.length || 1))
    await Promise.all(Array.from({ length: lanes }, worker))
    // 恢复按 targets 顺序，便于前端稳定渲染。
    results.sort((a, b) => targets.indexOf(a.provider) - targets.indexOf(b.provider))
    return results
  }

  /**
   * 启动自举：同步接口清单 + 读一次渠道余额。
   *
   * 为什么不只在点按钮时做：宿主重启后 ledger 里的余额快照可能已经很旧，
   * 用户打开卡片先看到一排「额度未读取」，体验就像功能没做。启动时静默拉一次
   * 就把这张脸补上了。任何一步失败都只返回诊断，不抛给宿主。
   */
  async function bootstrap() {
    const report = { sync: null, balances: [], at: Date.now() }
    if (settings.get().syncCatalog === false) {
      // 用户关掉了自动同步：启动时不碰 catalog，但余额仍值得读（它更贵更慢，
      // 却有 30 秒缓存兜底）。关同步的人通常是想手工维护清单。
      report.sync = { ok: false, skipped: true, reason: 'syncCatalog disabled' }
    } else {
      try {
        report.sync = await syncCatalog()
      } catch (error) {
        report.sync = { ok: false, reason: messageOf(error) }
      }
    }
    try {
      // 有 connection 才读余额；没有就跳过（清单已经同步好了）。
      if (ensureChannelBridge(connectionScope) !== null) {
        report.balances = await refreshAllBalances(connectionScope, [])
      }
    } catch (error) {
      report.balances = [{ ok: false, reason: messageOf(error) }]
    }
    report.ok = report.sync?.ok === true || report.balances.some(item => item.ok === true)
    return report
  }

  function upsertEndpoint(provider, model, patch = {}) {
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return
    // 所有接口行的唯一写入口：在这里统一拒绝畸形/危险键，比在十几个调用点
    // 各写一遍更可靠（安全审计 M-1 的加固点）。
    if (FORBIDDEN_KEYS.has(provider) || FORBIDDEN_KEYS.has(model)) return
    const key = endpointKey(provider, model)
    const previous = endpointIndex.get(key) ?? {
      key,
      provider,
      model,
      lane: '',
      displayName: model,
      quotaKnown: false,
      quotaTotal: 0,
      quotaUsed: 0,
      quotaRemaining: 0,
      quotaUnit: 'unknown',
      exhaustedAt: 0,
      blockedUntil: 0,
      lastUsedAt: 0,
      lastError: '',
      source: 'observed',
    }
    const next = { ...previous, ...patch }
    // 只有 provider 和 model 本身能确定身份；其余字段允许被后来的来源覆盖。
    next.provider = provider
    next.model = model
    endpointIndex.set(key, next)
    return next
  }

  /* ── 从 Our Free Model 同步接口清单 ─────────────────────────── */

  /**
   * 同步接口清单 + 权威用量。两个来源都是磁盘文件（见 readFreeModelCatalog
   * 上的说明），不碰它们的 HTTP API：
   *
   *   `catalog.json` 里三种 id 形态 → 接口清单（free / eac / kilo 三条车道）；
   *   `channel-pack/state.json` 里已登录的渠道账号 → 那些 provider 的接口，
   *  实际模型名由 llm.listProviders + 我们观察到的调用补齐；
   *   `channel-pack/token-ledger.json` → 逐接口的真实 token 用量。
   *
   * 顺带：Our Free Model 未启动、文件不存在时返回 ok:false 但不清空已有清单，
   * 因为「此刻读不到」不等于「之前那些接口不存在」。
   */
  async function syncCatalog() {
    const home = resolveDshHome()
    const catalog = readFreeModelCatalog(home)
    const channelState = readChannelState(home)
    const imported = importTokenLedger(home)

    let added = 0
    let total = 0
    if (catalog !== null) {
      const endpoints = endpointsFromCatalog(catalog)
      total = endpoints.length
      for (const item of endpoints) {
        const before = endpointIndex.has(endpointKey(item.provider, item.model))
        upsertEndpoint(item.provider, item.model, {
          lane: item.lane,
          displayName: item.name !== undefined && item.name !== '' ? item.name : item.model,
          quotaUnit: quotaUnitOf(item.provider, item.lane),
          source: 'our-free-model',
        })
        if (!before) added += 1
      }
    }

    // 已登录的渠道账号 → 至少把 provider 记进清单，这样「同名备用接口」
    // 知道这台机器上确实有这个渠道，而不是只能靠失败才发现。
    //
    // 每次同步必须**重建**这张表，而不是往里累加：
    // 原来写成 `accounts: (previous?.accounts ?? 0) + 1`，于是每点一次同步
    // 账号数就翻一倍（实测 2→4→6）。同时 enabled / nickname / expiresAt 只
    // 保留最后一个账号的值，一个疑似失效的账号就能把整张卡误标「已停用」。
    // 正确做法：先按 provider 分组收集，再整体替换。
    let channelAccounts = 0
    const grouped = new Map()
    for (const account of Array.isArray(channelState?.accounts) ? channelState.accounts : []) {
      if (account === null || typeof account !== 'object') continue
      const provider = typeof account.provider === 'string' ? account.provider : ''
      if (provider === '') continue
      channelAccounts += 1
      const bucket = grouped.get(provider) ?? {
        provider,
        accounts: 0,
        enabled: false,
        nickname: '',
        expiresAt: 0,
      }
      bucket.accounts += 1
      // 只要**有任意一个**启用的账号，这条车道就算可用。
      if (account.enabled !== false) bucket.enabled = true
      // 昵称/过期时间取「第一个启用账号」的，展示更贴近用户实际在用的那个。
      if (bucket.nickname === '' && typeof account.nickname === 'string' && account.nickname !== '') {
        bucket.nickname = account.nickname
      }
      const expiresAt = Number(account.expiresAt) || 0
      if (expiresAt > 0 && (bucket.expiresAt === 0 || expiresAt < bucket.expiresAt)) {
        bucket.expiresAt = expiresAt
      }
      grouped.set(provider, bucket)
    }
    // 整体替换（而不是累加）：先清空，再写入本次同步的完整结果。
    providerAccounts.clear()
    for (const [provider, bucket] of grouped) providerAccounts.set(provider, bucket)

    if (catalog !== null) ledger.update({ catalogSyncedAt: Date.now() })
    return {
      ok: catalog !== null,
      ...(catalog === null ? { reason: 'our-free-model/catalog.json 不存在（Our Free Model 未启动过）' } : {}),
      total,
      added,
      channelAccounts,
      ledger: imported,
    }
  }

  /**
   * 读 Our Free Model 落盘的状态，而不是走它的 HTTP API。
   *
   * 为什么不用 HTTP：实测 `/api/our-free-model/*` 全部走内核 connection 的
   * `dsh-auth-*` cookie 围栏（无 launch token → 401），`/api/channel-pack`
   * 更是 exact Fetch route（非 owner peer → 403）。同进程插件读文件反而是
   * 被支持的路径，且不必依赖 webServer 端口探测。
   *
   * 三个来源：
   *   - `~/.dsh/our-free-model/catalog.json`：接口清单（entries/sealIds/kiloRows）；
   *   - `~/.dsh/channel-pack/state.json`：已登录的渠道账号（含 provider id）；
   *   - `~/.dsh/channel-pack/token-ledger.json`：**权威用量**，按
   *     `direct|provider|accountId|model` 逐日累计 requests/tokens。
   * 任何一个缺失都只是少一部分数据，不抛错。
   */
  function readFreeModelCatalog(home) {
    const file = path.join(home, 'our-free-model', 'catalog.json')
    const raw = readJsonFile(file)
    if (raw === null) return null
    return raw
  }

  function readChannelState(home) {
    return readJsonFile(path.join(home, 'channel-pack', 'state.json'))
  }

  function readTokenLedger(home) {
    return readJsonFile(path.join(home, 'channel-pack', 'token-ledger.json'))
  }

  function readJsonFile(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * catalog.json 的三种 id 形态统一成接口清单：
   *   - `entries`（免费车道的裸 id，无 provider 前缀）→ our-free-model/<id>；
   *   - `sealIds`（EAC/密封车道的 `org/model`）→ eac/<org>/<model> 的 provider 取首段；
   *   - `kiloRows`（Kilo 车道的对象数组）→ 逐个取 provider/model。
   */
  function endpointsFromCatalog(parsed) {
    const out = []
    for (const id of Array.isArray(parsed?.entries) ? parsed.entries : []) {
      if (typeof id === 'string' && id !== '') out.push({ provider: 'our-free-model', model: id, lane: 'free' })
    }
    for (const id of Array.isArray(parsed?.sealIds) ? parsed.sealIds : []) {
      if (typeof id !== 'string' || id === '') continue
      const slash = id.indexOf('/')
      const provider = slash > 0 ? id.slice(0, slash) : 'eac'
      out.push({ provider, model: id, lane: 'eac' })
    }
    for (const row of Array.isArray(parsed?.kiloRows) ? parsed.kiloRows : []) {
      if (row === null || typeof row !== 'object') continue
      const model = typeof row.id === 'string' ? row.id : (typeof row.model === 'string' ? row.model : '')
      if (model === '') continue
      out.push({ provider: 'kilo', model, lane: 'kilo', name: typeof row.name === 'string' ? row.name : '' })
    }
    return out
  }

  /** token-ledger 的 key 是 `direct|provider|accountId|model`。 */
  function parseLedgerKey(key) {
    const parts = String(key ?? '').split('|')
    if (parts.length < 4) return null
    return { mode: parts[0], provider: parts[1], accountId: parts[2], model: parts.slice(3).join('|') }
  }

  /**
   * 把 token-ledger 的全量用量灌进本插件台账（幂等：每次同步覆盖累计值，
   * 不做加法，避免重复累加）。它比我们自己旁听 `llm/stream` 更权威——那是
   * 渠道包自己记的上游真实用量，含 errors/ttft。
   */
  function importTokenLedger(home) {
    const ledgerRaw = readTokenLedger(home)
    if (ledgerRaw === null) return { ok: false, reason: 'token-ledger.json 不存在（渠道包未产生用量）' }
    const days = ledgerRaw.days ?? {}
    // 一次性构造完整快照再写回，而不是逐行 edit：ledger 的 flush 是 800ms
    // 防抖的，逐行改会让「读到的 state」与「将要落盘的 state」交错。
    const snapshot = {}
    let imported = 0
    for (const [day, rows] of Object.entries(days)) {
      if (rows === null || typeof rows !== 'object') continue
      for (const [key, value] of Object.entries(rows)) {
        const parsed = parseLedgerKey(key)
        if (parsed === null || value === null || typeof value !== 'object') continue
        const endpoint = upsertEndpoint(parsed.provider, parsed.model, {
          lane: parsed.provider === 'our-free-model' ? 'free' : 'channel',
          source: 'token-ledger',
          quotaUnit: quotaUnitOf(parsed.provider, 'channel'),
        })
        if (endpoint === undefined) continue
        const rowKey = `${parsed.provider}/${parsed.model}`
        const previous = snapshot[rowKey] ?? {
          provider: parsed.provider, model: parsed.model, accountId: parsed.accountId,
          day, requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, errors: 0,
        }
        // 同一接口可能挂在多个账号上，按天累加。
        snapshot[rowKey] = {
          ...previous,
          day,
          requests: previous.requests + (Number(value.requests) || 0),
          input: previous.input + (Number(value.inputTokens) || 0),
          output: previous.output + (Number(value.outputTokens) || 0),
          reasoning: previous.reasoning + (Number(value.reasoningTokens) || 0),
          cacheRead: previous.cacheRead + (Number(value.cacheReadTokens) || 0),
          errors: previous.errors + (Number(value.errors) || 0),
        }
        imported += 1
      }
    }
    ledger.update({ imported: snapshot, tokenLedgerAt: Date.now() })
    return { ok: true, imported, endpoints: Object.keys(snapshot).length }
  }

  /**
   * 不同 lane 的「额度」单位不同，这是展示与判零的依据：
   *   - free 车道：没有可读额度，只能按请求数兜底展示；
   *   - 渠道（channel-pack）：**积分**（唯一能真读到余额的车道）；
   *   - EAC：池级容量，按请求；
   *   - Kilo：没有额度概念，按 token；
   *   - 官方：token。
   * lane 缺省时按 provider 判断，这样手工登记的行也有合理单位。
   */
  function quotaUnitOf(provider, lane) {
    const value = lane !== undefined && lane !== '' ? lane : ''
    if (value === 'free' || provider === 'our-free-model') return 'requests'
    if (value === 'eac') return 'requests'
    if (value === 'kilo') return 'token'
    if (provider === 'deepseek-official') return 'token'
    return 'credits'
  }

  /* ── 用量记录 ─────────────────────────────────────────────── */

  function recordUsage({ provider, model, input, output, reasoning, cacheRead, ok, error }) {
    if (!settings.get().enabled) return
    const at = Date.now()
    const entry = upsertEndpoint(provider, model, {
      lastUsedAt: at,
      lastError: ok ? '' : String(error ?? '').slice(0, 200),
      source: endpointIndex.get(endpointKey(provider, model))?.source ?? 'observed',
    })
    if (entry === undefined) return
    ledger.edit(state => {
      const endpoints = { ...(state.endpoints ?? {}) }
      const key = endpointKey(provider, model)
      const row = endpoints[key] ?? {
        provider, model, input: 0, output: 0, reasoning: 0, cacheRead: 0,
        calls: 0, failed: 0, firstAt: at, lastAt: at, windowStart: at,
        windowCalls: 0, windowInput: 0, windowOutput: 0,
      }
      const windowMs = Math.max(1, Number(settings.get().windowHours) || 24) * 3600 * 1000
      const expired = at - (row.windowStart ?? at) > windowMs
      const next = {
        ...row,
        input: row.input + (input ?? 0),
        output: row.output + (output ?? 0),
        reasoning: row.reasoning + (reasoning ?? 0),
        cacheRead: row.cacheRead + (cacheRead ?? 0),
        calls: row.calls + 1,
        failed: row.failed + (ok ? 0 : 1),
        lastAt: at,
        windowStart: expired ? at : (row.windowStart ?? at),
        windowCalls: (expired ? 0 : row.windowCalls) + 1,
        windowInput: (expired ? 0 : row.windowInput) + (input ?? 0),
        windowOutput: (expired ? 0 : row.windowOutput) + (output ?? 0),
      }
      endpoints[key] = next
      return { ...state, endpoints }
    })
  }

  function recordFailure({ provider, model, code, message }) {
    const at = Date.now()
    const safe = redactSecrets(message)
    ledger.edit(state => {
      const failures = Array.isArray(state.failures) ? state.failures.slice(-199) : []
      failures.push({ at, provider, model, code, message: safe.slice(0, 300) })
      return { ...state, failures }
    })
    const cooldown = Number(settings.get().cooldownMs) || 0
    upsertEndpoint(provider, model, {
      lastError: `${code}: ${safe.slice(0, 120)}`,
      exhaustedAt: at,
      blockedUntil: cooldown > 0 ? at + cooldown : 0,
    })
  }

  function recordSwitch({ from, to, reason, code }) {
    const at = Date.now()
    ledger.edit(state => {
      const switches = Array.isArray(state.switches) ? state.switches.slice(-199) : []
      switches.push({ at, from, to, reason, code })
      return { ...state, switches }
    })
  }

  /* ── 同名备用接口解析 ─────────────────────────────────────── */

  /**
   * 给定一个接口，找出「同名模型的其他接口」：
   *   同一 model 名，provider 不同，且当前不在冷却期、额度未耗尽。
   * 排序：同 lane 优先，其次剩余额度多的，最后才是从没用过的。
   */
  /**
   * 「同名模型」的判定：把带 lane 后缀的 id 归一化后比较。
   *
   * 同一个模型在不同接口上的 id 并不总是逐字相同，实测形态：
   *   - 免费车道：`deepseek-v4.1-flash-free`（多了 `-free`）；
   *   - 渠道/聚合层：`deepseek-v4.1-flash`；
   *   - 官方：`deepseek-flash`、`deepseek-v4-pro`。
   * 只按字符串全等会漏掉第一类，于是「同名备用接口」永远找不到，直接落到
   * 官方兜底——那正是自检第一次跑出来的现象。这里按 `-free` 后缀剥掉后再比，
   * 官方兜底不做同义映射（它是兜底，不是同名接口）。
   */
  function modelFamily(model) {
    return String(model ?? '')
      .trim()
      .toLowerCase()
      .replace(/-free$/, '')
      .replace(/-(preview|latest|stable)$/, '')
  }

  function alternativesFor(provider, model) {
    const now = Date.now()
    const family = modelFamily(model)
    const currentLane = endpointIndex.get(endpointKey(provider, model))?.lane ?? ''
    const rows = []
    for (const entry of endpointIndex.values()) {
      if (entry.provider === provider) continue
      if (entry.provider === (settings.get().officialFallback?.provider ?? '')) continue
      if (family === '' || modelFamily(entry.model) !== family) continue
      const blocked = (entry.blockedUntil ?? 0) > now
      const exhausted = entry.quotaKnown === true && entry.quotaRemaining <= 0
      if (blocked || exhausted) continue
      rows.push(entry)
    }
    return rows.sort((a, b) => {
      // 同 lane 优先（同一条免费车道内的兄弟接口通常共享额度模型），
      // 其次剩余额度多的，最后是最近没用过的。
      const laneA = a.lane === currentLane ? 0 : 1
      const laneB = b.lane === currentLane ? 0 : 1
      if (laneA !== laneB) return laneA - laneB
      if (a.quotaKnown && b.quotaKnown) return b.quotaRemaining - a.quotaRemaining
      if (a.quotaKnown !== b.quotaKnown) return a.quotaKnown ? -1 : 1
      return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0)
    })
  }

  /**
   * 该切到哪去。返回值是 `{ provider, model }` 或 null。
   * 兜底：全部第三方接口不可用时，落 officialFallback。
   */
  function decideTarget(provider, model) {
    const alternatives = alternativesFor(provider, model)
    if (alternatives.length > 0) {
      const target = alternatives[0]
      return { provider: target.provider, model: target.model, reason: 'same-model-alternative' }
    }
    const official = settings.get().officialFallback ?? {}
    if (typeof official.provider === 'string' && typeof official.model === 'string'
      && official.provider !== '' && official.model !== '') {
      return { provider: official.provider, model: official.model, reason: 'official-fallback' }
    }
    return null
  }

  /* ── 钩子：agent/request 与 agent/request-error ─────────────── */

  /**
   * 待生效的切换：`${agentId}:${turn}:${step}` -> `{ provider, model }`。
   * request-error 里决定，下一个 agent/request 里落地——这是 dsh-llm-fallbacks
   * 验证过的同一套时序（前者拿到失败，后者改写 seed config）。
   */
  const pendingSwitch = new Map()

  /**
   * 每个 agent 当前请求路由的旁注：`agentId -> { provider, model, at }`。
   * `agent/request-error` 的 payload 不带 model，只能用这里补。
   * agent 数量有限，但仍设上限并淘汰最旧，防止长跑实例里只增不减。
   */
  const lastRoute = new Map()
  const MAX_AGENT_ENTRIES = 256

  function lastRouteFor(agentId) {
    return (agentId === '' ? undefined : lastRoute.get(agentId)) ?? {}
  }

  function recordLastRoute(agentId, provider, model) {
    if (agentId === '' || typeof agentId !== 'string') return
    lastRoute.set(agentId, { provider, model, at: Date.now() })
    if (lastRoute.size > MAX_AGENT_ENTRIES) {
      const drop = Math.ceil(MAX_AGENT_ENTRIES / 4)
      let removed = 0
      for (const key of lastRoute.keys()) {
        lastRoute.delete(key)
        removed += 1
        if (removed >= drop) break
      }
    }
  }

  function budgetKey(agentId, turn, step) {
    return `${agentId}:${turn}:${step}`
  }

  /**
   * 包一层异步分片流：把 `usage` 分片抄一份记进台账，finished/失败时落一条。
   *
   * 必须做成 transparent 的 —— 消费方是 agent loop，它按 chunk 逐条渲染，
   * 任何重排或缓冲都会让流式输出卡住。因此这里只旁听，不改变原值：
   *   - 正常结束：用最后一个 `usage` 记一次 ok；
   *   - `finish.reason.kind === 'error'`：记一次失败（error 分片里的 code
   *     供 recordFailure 用，真正的重试决策在 agent/request-error 里做）。
   * 一个流只记一次，靠 recorded 位。
   */
  async function* observeStream(source, provider, model) {
    let usage = null
    let failure = null
    let recorded = false
    const commit = ok => {
      if (recorded) return
      recorded = true
      recordUsage({
        provider,
        model,
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        reasoning: usage?.reasoningTokens ?? 0,
        cacheRead: usage?.cacheReadTokens ?? 0,
        ok,
        // 上游错误消息可能回显凭据（401 body 常见），落盘前先脱敏。
        error: failure === null ? '' : redactSecrets(`${failure.code ?? ''} ${failure.message ?? ''}`.trim()),
      })
    }
    try {
      // 内核的 adapterStream 返回 async generator；测试桩与某些宿主可能交回
      // Promise。两种都接受，否则一个桩子写法就能把整条流打断。
      const iterable = await source
      for await (const chunk of iterable) {
        if (chunk !== null && typeof chunk === 'object') {
          if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
            usage = chunk.usage
          } else if (chunk.type === 'finish') {
            const reason = chunk.reason ?? {}
            if (reason.kind === 'error' || reason.kind === 'aborted') {
              failure = reason.failure ?? { code: reason.kind }
            }
            commit(reason.kind !== 'error' && reason.kind !== 'aborted')
          }
        }
        yield chunk
      }
      commit(failure === null)
    } catch (error) {
      failure = { code: 'TRANSPORT', message: messageOf(error) }
      commit(false)
      throw error
    }
  }

  function attachAgentHooks(parent) {
    const disposers = []

    // 0) 用量检测：`llm/stream` 是 waterfall，包一层就能看到每次真实调用的
    //    provider/model 与适配器回报的 `usage` 分片，不必解析会话日志。
    //    这是「实时检测每次对话所接模型及其接口的消耗」的唯一权威来源。
    disposers.push(parent.on('llm/stream', (options, next) => {
      // 先把内层流取到手，再决定要不要包装。
      //
      // 这里绝不能写成「try 里 return observeStream(next(), ...)，catch 里再
      // return next()」：next() 一旦被调用过，catch 里再调就会把下游整条链
      // 再执行一遍。所以 next() 只调一次。
      //
      // 注意 next() 可能是**返回被拒绝 Promise**的 async 函数：同步 try/catch
      // 抓不到那种拒绝，只能让它原样往下传（不 catch、不替换）。因此这里不包
      // try —— 任何失败都直接穿透给调用方，符合「hook 只旁听、不改变语义」。
      const provider = String(options?.provider ?? '')
      const model = String(options?.model ?? '')
      const source = next()
      if (!settings.get().enabled || provider === '' || model === '') return source
      // observeStream 是 async generator：调用只创建对象，不会抛。
      return observeStream(source, provider, model)
    }))

    // 1) 记住每个 agent 当前的路由，供 request-error 补 model（它的 payload
    //    不带 model）。同时这也是「同名备用接口」判定用的当前路由。
    //
    //    ⚠️ 注册顺序是正确性的一部分：cordis 的 waterfall 里**先注册者在外层**
    //    （cordis/lib/index.js:317-325：`cbs.shift()`，外层先跑，`await next()`
    //    返回的才是内层结果）。所以本监听器必须排在「改写路由」那个监听器
    //    **之前**注册，才能在外层 `await next()` 拿到改写后的 seed。
    //
    //    反过来的后果（契约审计实测）：lastRoute 永远记着**切走前**的路由，
    //    于是失败记账与下一次 decideTarget 都基于错误的 model。
    //
    //    catch 里绝不能再调一次 next()：next() 已经被 await 过，再调会二次
    //    下沉整条链（重复执行下游监听器），只能把错误原样抛出去。
    disposers.push(parent.on('agent/request', async (payload, next) => {
      try {
        const seed = await next()
        const agentId = payload?.agent?.id ?? payload?.agentId ?? ''
        if (agentId !== '' && seed !== null && typeof seed === 'object') {
          recordLastRoute(agentId, seed.provider, seed.model)
        }
        return seed
      } catch (error) {
        // 下游抛错时原样抛出去（这是它们的责任），我们只保证自己不死。
        logger.warn?.(`[ofm-quota] last-route hook contained: ${messageOf(error)}`)
        throw error
      }
    }))

    // 2) 落地切换：在请求真正派发前改写 provider/model。
    //
    //    seed 是 loop 组装好的 LlmCallConfig（`{ provider, model,
    //    reasoningEffort?, maxTokens? }`）。换路时必须**丢掉 seed 的
    //    reasoningEffort**：那是上一条路由自己的思考档位，目标适配器可能
    //    根本不认这个 id，留着会直接报无效参数（dsh-llm-fallbacks 的
    //    overrideConfig 同样这么做，见 dist/index.js:1553-1571）。
    //
    //    它注册在 (1) 之后 = 处于内层，改写结果会作为 (1) 的 `seed` 被记录。
    disposers.push(parent.on('agent/request', async (payload, next) => {
      const seed = await next()
      try {
        if (!settings.get().enabled) return seed
        const key = budgetKey(payload?.agent?.id ?? payload?.agentId ?? '', payload?.turn, payload?.step)
        const pending = pendingSwitch.get(key)
        if (pending === undefined) return seed
        pendingSwitch.delete(key)
        recordSwitch({
          from: endpointKey(seed.provider, seed.model),
          to: endpointKey(pending.provider, pending.model),
          reason: pending.reason,
          code: pending.code,
        })
        const { reasoningEffort: _routeOwned, ...withoutInheritedEffort } = seed
        return {
          ...withoutInheritedEffort,
          provider: pending.provider,
          model: pending.model,
        }
      } catch (error) {
        logger.warn?.(`[ofm-quota] agent/request hook contained: ${messageOf(error)}`)
        return seed
      }
    }))

    // 2) 决定是否切换。`agent/request-error` 是 waterfall：返回
    //    `{ kind: 'retry' }` 时 loop 会 `continue`，同一 turn/step 重新走
    //    prepareRequest —— 这正是「对话不中断」的接缝。
    //
    //    payload 形状（dsh-agent-loop/lib/index.js:1136-1146）：
    //    `{ turn, step, provider, failure, retryPolicy, signal }`，注意**没有
    //    model 字段**，agent 要从 payload.agent 取。
    disposers.push(parent.on('agent/request-error', async (payload, next) => {
      try {
        if (!settings.get().enabled) return next()
        // 已取消的请求不得重试：返回 retry 会让 loop 再跑一次被中止的 step。
        // (dsh-llm-retry 与 dsh-llm-fallbacks 都在入口先查 signal.aborted。)
        if (payload?.signal?.aborted === true) return next()
        const agentId = payload?.agent?.id ?? payload?.agentId ?? ''
        const provider = String(payload?.provider ?? '')
        const failure = payload?.failure ?? {}
        const code = String(failure?.code ?? '')
        // payload 没有 model，用上一次请求头里记录的当前路由兜底。
        const model = String(payload?.model ?? lastRouteFor(agentId).model ?? '')

        // CONTEXT_WINDOW_EXCEEDED 是请求级失败：它只说明这次上下文塞不进这个
        // 窗口，不代表接口没额度。因此**不打冷却**（否则一个 1M 窗口的接口会
        // 被几轮长对话误判成不可用），但仍允许换到窗口更大的同名接口。
        const requestScoped = code === 'CONTEXT_WINDOW_EXCEEDED'
        if (!requestScoped) recordFailure({ provider, model, code, message: failure?.message })

        const configured = settings.get()
        if (!configured.autoSwitch) return next()
        if (!Array.isArray(configured.triggerCodes) || !configured.triggerCodes.includes(code)) return next()

        const key = budgetKey(agentId, payload?.turn, payload?.step)
        const used = switchBudget.get(key) ?? 0
        const cap = Number(configured.maxSwitchesPerStep) || 0
        if (cap > 0 && used >= cap) {
          logger.warn?.(`[ofm-quota] switch budget exhausted for step ${key} — passing failure through`)
          return next()
        }

        const target = decideTarget(provider, model)
        if (target === null) return next()

        switchBudget.set(key, used + 1)
        pendingSwitch.set(key, { ...target, code })
        pruneTurnMaps()
        logger.info?.(`[ofm-quota] ${code} on ${endpointKey(provider, model)} → switching to ${endpointKey(target.provider, target.model)} (${target.reason})`)
        return { kind: 'retry' }
      } catch (error) {
        logger.warn?.(`[ofm-quota] agent/request-error hook contained: ${messageOf(error)}`)
        return next()
      }
    }))

    parent.on?.('dispose', () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 已经释放 */ }
      }
    })

    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 已经释放 */ }
      }
    }
  }

  /* ── HTTP API ─────────────────────────────────────────────── */

  /**
   * 请求信任围栏。
   *
   * 为什么必须有：本插件注册的 `/api/ofm-quota` 比内核的 `/api` 更长，而
   * webServer 的派发是 longest-prefix-wins —— 我们的 handler 会**先于**
   * connection 自己的准入检查执行。不自己围栏，本机任何进程（或恶意网页
   * 借 DNS rebinding / 跨站请求）就能 POST /settings 改行为、/reset 清台账、
   * /balances 反复打上游。
   *
   * 两层，与 dsh-our-free-model/src/trust.js 同构：
   *   1. 组合里有 `connection` 服务时，用它自己的 `admit(req)` / 
   *      `requestRejection(req)` —— 那是内核给 `/api` 用的同一份裁决
   *      （信任围栏 + 浏览器认证 cookie），插件不会比宿主更弱；
   *   2. 没有该服务时退化为结构化复刻：只接受 loopback Host、拒绝跨站
   *      `sec-fetch-site`、要求 Origin（若有）与 Host 同 authority。
   *
   * applyHandler 只接受 loopback 地址，因此这里不需要额外处理反代。
   */
  const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

  function rejectionFor(req) {
    // 第一层：宿主自己的准入裁决。
    //
    // 这里必须用 try 包住**整个**取服务 + 裁决的过程。原写法
    // `scope.connection ?? scope.get?.(...)` 有一个致命细节：cordis 在未 inject
    // 的 ctx 上**读取属性本身就会抛** `cannot get property "connection" without
    // inject`，而 `??` 救不了——左操作数先抛。更糟的是它在 api() 的 try 之外，
    // 于是一个「降级分支」把自己变成了全线 500。（契约审计第 1 条，实测复现。）
    let connection = null
    try {
      const scope = connectionScope ?? parentForRoutes
      if (scope !== null && scope !== undefined) {
        // 属性访问包在 try 里：未 inject 时抛错只意味着「本作用域没有」，
        // 不是错误，落到结构化复刻即可。
        try {
          connection = scope.connection ?? null
        } catch {
          connection = null
        }
        if (connection === null && typeof scope.get === 'function') {
          try {
            connection = scope.get('connection', false) ?? null
          } catch {
            connection = null
          }
        }
      }
    } catch {
      connection = null
    }
    if (connection !== null && connection !== undefined) {
      try {
        if (typeof connection.admit === 'function') {
          const admission = connection.admit(req)
          if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
            return admission.rejection
          }
          // admit 成功（返回 { peer }）即放行。
          return undefined
        }
        if (typeof connection.requestRejection === 'function') {
          const status = connection.requestRejection(req)
          return status === undefined ? undefined : status
        }
      } catch {
        // 裁决本身抛错时按拒绝处理（fail-closed），绝不 fail-open。
        return 403
      }
    }
    // 第二层：结构化复刻。
    return structuralRejection(req)
  }

  function structuralRejection(req) {
    const headers = req?.headers ?? {}
    const hostHeader = String(headers.host ?? '').trim()
    const authority = authorityOf(hostHeader)
    if (authority === null || !LOOPBACK_NAMES.has(authority.hostname)) return 403
    // 跨站请求一律拒绝（防御 CSRF）。
    const site = String(headers['sec-fetch-site'] ?? '').trim().toLowerCase()
    if (site === 'cross-site') return 403
    const origin = typeof headers.origin === 'string' ? headers.origin.trim() : ''
    if (origin !== '') {
      const originAuthority = authorityOf(origin)
      if (originAuthority === null) return 403
      // 必须比到**端口**，不能只比 hostname。
      //
      // 只比 hostname 的话，本机任意端口上的页面（比如 127.0.0.1:9000 的
      // 开发服务器）都算「同源」：它与宿主 127.0.0.1:6724 的 hostname 相同，
      // 而且 sec-fetch-site 给的是 same-site 而非 cross-site，两道都没拦住。
      // 这类越权**不需要** DNS rebinding。内核的 isSameAuthorityOrigin 比的
      // 是含端口的 `host`（dsh-client-connection/lib/index.js:258-269），
      // 这里对齐同一语义：把 port 按 scheme 归一化后整体比较。
      if (originAuthority.host !== authority.host) return 403
    }
    return undefined
  }

  /**
   * 解析 authority，同时给出**归一化后的 host**（含端口）。
   *
   * 归一化的必要性：`http://127.0.0.1:80` 与 `http://127.0.0.1` 是同一个
   * authority，`url.port` 对默认端口返回空串而显式写出时返回 "80"。直接比
   * 原始串会把它们当成不同源（false reject），而比 hostname 又把不同端口当
   * 同源（false accept）。这里统一走 `url.host`（WHATWG 保证默认端口已剥离）。
   */
  function authorityOf(value) {
    const raw = String(value ?? '').trim()
    if (raw === '') return null
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
    try {
      const url = new URL(candidate)
      return {
        hostname: url.hostname.toLowerCase(),
        port: url.port,
        // url.host = hostname[:port]，默认端口已归一化掉。
        host: url.host.toLowerCase(),
      }
    } catch {
      return null
    }
  }

  /** 诊断只带固定字段，绝不回显 header/URL（里面有 token 与凭据）。 */
  function requestSource(req) {
    return `${String(req?.method ?? '')} ${String(req?.url ?? '').split('?')[0]}`.slice(0, 120)
  }

  /**
   * mountRoutes 拿到的 ctx（即 webServer 所在的那个 cordis 作用域）。
   * 余额读取要在它上面取 `connection`；保存下来供 api handler 复用。
   */
  let parentForRoutes = null

  function mountRoutes(parent) {
    const server = parent.webServer ?? parent.get?.('webServer')
    if (server === undefined || server === null || typeof server.register !== 'function') {
      return () => {}
    }
    parentForRoutes = parent
    const dispose = server.register({ kind: 'prefix', path: '/api/ofm-quota', handler: api })
    return () => {
      parentForRoutes = null
      try { dispose?.() } catch { /* 已经释放 */ }
    }
  }

  async function api(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // 严格解析：前缀精确匹配，剩余部分只能是单段路由名。
    //
    // 原来的 `replace(/^\/api\/ofm-quota\/?/, '')` 不锚定结尾，形状松散；
    // 虽说畸形路径最终会落到 404，但让「围栏看到的字符串」与「路由解析出的
    // 名字」用同一条规则更安全，否则将来任何按前缀分流的改动都可能让两者
    // 不一致（安全审计 M-3）。
    const prefixMatch = /^\/api\/ofm-quota(?:\/([A-Za-z-]+))?\/?$/.exec(url.pathname)
    const route = prefixMatch === null ? null : (prefixMatch[1] ?? '')
    const send = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        // 这个接口从不该被跨源页面读到；补一层浏览器侧防御。
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(payload))
    }
    // 准入检查放在最前面：一条都不该在围栏外执行。
    const rejection = rejectionFor(req)
    if (rejection !== undefined) {
      logger.warn?.(`[ofm-quota] request rejected status=${rejection} source=${requestSource(req)}`)
      return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    }
    try {
      if (req.method === 'GET' && (route === 'status' || route === '')) {
        return send(200, buildStatus())
      }
      if (req.method === 'GET' && route === 'endpoints') {
        return send(200, { endpoints: buildEndpointRows() })
      }
      if (req.method === 'POST' && route === 'sync') {
        return send(200, await syncCatalog())
      }
      // 读渠道真实余额（TRAE 的「剩余积分 382」这类）。body 可给 provider
      // （只刷这一个）或 force（强制刷新，绕过 30 秒新鲜缓存）。
      if (req.method === 'POST' && route === 'balances') {
        const body = await readOptionalJson(req)
        const requested = typeof body?.provider === 'string' ? body.provider.trim() : ''
        if (requested !== '' && !isKnownProvider(requested)) {
          // 白名单。否则随机 provider 名会让每个请求都真的打一次上游并挂满
          // 90 秒超时（安全审计的 H-2）：既是上游 DoS，也让 inFlightBalances
          // 的去重失效——因为键就是那个随机名字，每次都不同。
          return send(400, { error: `unknown provider "${requested.slice(0, 60)}"` })
        }
        const force = body?.force === true
        const results = await refreshAllBalances(
          parentForRoutes,
          requested === '' ? [] : [requested],
          { force },
        )
        const rows = buildEndpointRows()
        return send(200, {
          ok: results.some(item => item.ok === true),
          results,
          channels: requested === '' ? undefined : buildChannelCards(rows).filter(card => card.provider === requested),
        })
      }
      if (req.method === 'POST' && route === 'settings') {
        const body = await readJson(req)
        const patch = sanitizeSettingsPatch(body)
        if (patch === null) return send(400, { error: 'body must be a JSON object' })
        return send(200, { ok: true, settings: settings.update(patch) })
      }
      if (req.method === 'POST' && route === 'quota') {
        const body = await readJson(req)
        const applied = applyManualQuota(body)
        if (applied === null) return send(400, { error: 'provider/model/remaining required' })
        // 返回视图行（带 blocked / quotaRemaining 等派生字段），而不是内部记录。
        const row = buildEndpointRows().find(item => item.key === applied.key) ?? applied
        return send(200, { ok: true, endpoint: row })
      }
      if (req.method === 'POST' && route === 'provider-quota') {
        const body = await readJson(req)
        const applied = applyProviderQuota(body)
        if (applied === null) return send(400, { error: 'provider/remaining required' })
        return send(200, { ok: true, ...applied })
      }
      if (req.method === 'POST' && route === 'unblock') {
        const body = await readJson(req)
        const provider = safeKeyPart(body?.provider, 64)
        const model = safeKeyPart(body?.model, 200)
        if (provider === null || model === null) return send(400, { error: 'provider/model required' })
        // 只清 blockedUntil 是不够的：`alternativesFor` 还会用
        // `quotaKnown && quotaRemaining <= 0` 把「余额读到 0」的接口排除掉，
        // 于是这种接口永远解不开、永远选不到。解除冷却必须同时把额度标记
        // 重置为「未知」，让它重新参与选择（用户按了「解除」，语义就是
        // 「别再拿旧读数挡路」）。
        upsertEndpoint(provider, model, {
          blockedUntil: 0,
          exhaustedAt: 0,
          lastError: '',
          quotaKnown: false,
          quotaRemaining: 0,
          quotaTotal: 0,
          quotaUsed: 0,
          quotaSource: 'unknown',
        })
        return send(200, { ok: true })
      }
      if (req.method === 'POST' && route === 'reset') {
        ledger.update({ endpoints: {}, switches: [], failures: [], imported: {}, accounts: {} })
        // 内存里的状态必须一起清，否则「重置」只清了磁盘：endpointIndex 里
        // 的额度读数与冷却标记还在，面板继续显示旧余额、切换继续避开旧接口
        // （死代码审计 M-8）。接口清单（provider/model 有哪些）保留——那是
        // 结构信息，不是台账数据。
        for (const entry of endpointIndex.values()) {
          endpointIndex.set(entry.key, {
            ...entry,
            quotaKnown: false,
            quotaSource: 'unknown',
            quotaRemaining: 0,
            quotaTotal: 0,
            quotaUsed: null,
            quotaTotalUnknown: false,
            exhaustedAt: 0,
            blockedUntil: 0,
            lastError: '',
            lastUsedAt: 0,
          })
        }
        return send(200, { ok: true })
      }
      return send(404, { error: `unknown route "${route}"` })
    } catch (error) {
      // 客户端发来的 body 不合法是 400，不该算服务端错误。
      if (error instanceof BadRequest) return send(400, { error: error.message })
      return send(500, { error: messageOf(error) })
    }
  }

  /** 区分「客户端发来的 body 不合法」与「服务端自己出错」——前者是 400。 */
  class BadRequest extends Error {}

  async function readJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1_000_000) throw new BadRequest('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) {
      // POST 必须带 body；空 body 按 {} 处理会上游误判成「什么都没改」。
      throw new BadRequest('request body is required')
    }
    const text = Buffer.concat(chunks).toString('utf8')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new BadRequest('request body is not valid JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequest('request body must be a JSON object')
    }
    return parsed
  }

  /**
   * body 可选的路由用这个：完全不给 body 时返回 {}，给了就必须是合法 JSON。
   * 不能用 `readJson(req).catch(() => ({}))` —— 那会把「body 畸形」和
   * 「body 超出上限」也静默当成空请求，等于吞掉客户端错误。
   */
  async function readOptionalJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1_000_000) throw new BadRequest('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    let parsed
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new BadRequest('request body is not valid JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequest('request body must be a JSON object')
    }
    return parsed
  }

  function sanitizeSettingsPatch(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
    const patch = {}
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body.autoSwitch === 'boolean') patch.autoSwitch = body.autoSwitch
    if (typeof body.syncCatalog === 'boolean') patch.syncCatalog = body.syncCatalog
    if (Array.isArray(body.triggerCodes)) {
      patch.triggerCodes = body.triggerCodes.filter(code => typeof code === 'string' && code !== '').slice(0, 20)
    }
    if (Number.isInteger(body.maxSwitchesPerStep) && body.maxSwitchesPerStep >= 0 && body.maxSwitchesPerStep <= 20) {
      patch.maxSwitchesPerStep = body.maxSwitchesPerStep
    }
    if (Number.isFinite(body.cooldownMs) && body.cooldownMs >= 0) {
      patch.cooldownMs = Math.min(Number(body.cooldownMs), 24 * 3600 * 1000)
    }
    if (Number.isFinite(body.windowHours) && body.windowHours >= 1) {
      patch.windowHours = Math.min(Number(body.windowHours), 24 * 30)
    }
    if (body.officialFallback !== null && typeof body.officialFallback === 'object') {
      const provider = String(body.officialFallback.provider ?? '').trim()
      const model = String(body.officialFallback.model ?? '').trim()
      if (provider !== '' && model !== '') patch.officialFallback = { provider, model }
    }
    return patch
  }

  /**
   * 校验并规范化用户提交的 provider / model。
   *
   * 这两个字符串会成为 `manualQuota` / `endpointIndex` 的**对象键**，因此：
   *   1. 拒绝 `__proto__` / `constructor` / `prototype` —— 虽然当前的
   *      `provider/model` 拼接里带斜杠让字面污染不成立，但那是巧合，
   *      一旦重构掉斜杠就成了真的原型污染（安全审计的 M-1）；
   *   2. 拒绝控制字符与超长值，避免把怪异字符串写进磁盘与面板；
   *   3. 只允许常规标识符字符集（provider/model 实际就是这些）。
   */
  function safeKeyPart(value, maxLength) {
    const text = String(value ?? '').trim()
    if (text === '' || text.length > maxLength) return null
    if (FORBIDDEN_KEYS.has(text)) return null
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) return null
    if (!/^[A-Za-z0-9_.:@\/-]+$/.test(text)) return null
    return text
  }

  /** 用户手填某个接口的剩余额度（渠道积分查不到时的唯一可信来源）。 */
  function applyManualQuota(body) {
    if (body === null || typeof body !== 'object') return null
    const provider = safeKeyPart(body.provider, 64)
    const model = safeKeyPart(body.model, 200)
    const remaining = Number(body.remaining)
    if (provider === null || model === null || !Number.isFinite(remaining)) return null
    const total = Number.isFinite(Number(body.total)) ? Number(body.total) : remaining
    // 无原型对象：即便键怪到能命中原型链，也落不到 Object.prototype 上。
    const manual = Object.assign(Object.create(null), settings.get().manualQuota ?? {})
    manual[endpointKey(provider, model)] = { remaining, total, at: Date.now() }
    settings.update({ manualQuota: manual })
    const entry = upsertEndpoint(provider, model, {
      quotaKnown: true,
      // 手填来源必须显式标记，否则会被「observed 优先」的判定当成真实读数
      // 而永久压住后续真实刷新（死代码审计 M-6）。
      quotaSource: 'manual',
      quotaRemaining: remaining,
      quotaTotal: total,
      quotaUsed: Math.max(0, total - remaining),
      quotaTotalUnknown: false,
      quotaUnit: typeof body.unit === 'string' && body.unit !== '' ? body.unit : quotaUnitOf(provider, 'channel'),
      exhaustedAt: remaining <= 0 ? Date.now() : 0,
      blockedUntil: remaining <= 0 ? Date.now() + (Number(settings.get().cooldownMs) || 0) : 0,
    })
    return entry
  }

  /**
   * 用户在本机直接从渠道包读到余额后，可以把「provider 级」的余额写进来。
   * 与 applyManualQuota 的区别：那条针对单个 provider/model，这条针对整个
   * 渠道（同一渠道的多个模型共享一份积分池），并会广播给该渠道下所有接口。
   */
  function applyProviderQuota(body) {
    if (body === null || typeof body !== 'object') return null
    const provider = String(body.provider ?? '').trim()
    const remaining = Number(body.remaining)
    if (provider === '' || !Number.isFinite(remaining)) return null
    const total = Number.isFinite(Number(body.total)) ? Number(body.total) : remaining
    const unit = typeof body.unit === 'string' && body.unit !== '' ? body.unit : 'credits'
    const manual = { ...(settings.get().manualQuota ?? {}) }
    const at = Date.now()
    let touched = 0
    for (const entry of endpointIndex.values()) {
      if (entry.provider !== provider) continue
      manual[entry.key] = { remaining, total, at, unit, providerLevel: true }
      upsertEndpoint(entry.provider, entry.model, {
        quotaKnown: true,
        // 手填来源必须标清楚。原来这里不设 quotaSource，于是上一轮「observed
        // 优先于 manual」的优先级判断会把它当成真实读数，手填值反而永远压
        // 住之后的真实刷新（死代码审计 M-6）。
        quotaSource: 'manual',
        quotaRemaining: remaining,
        quotaTotal: total,
        quotaUsed: Math.max(0, total - remaining),
        quotaTotalUnknown: false,
        quotaUnit: unit,
        exhaustedAt: remaining <= 0 ? at : 0,
        blockedUntil: remaining <= 0 ? at + (Number(settings.get().cooldownMs) || 0) : 0,
      })
      touched += 1
    }
    settings.update({ manualQuota: manual })
    return { provider, remaining, total, unit, touched }
  }

  /* ── 视图 ─────────────────────────────────────────────────── */

  function buildEndpointRows() {
    const now = Date.now()
    const ledgerState = ledger.get()
    const stats = ledgerState.endpoints ?? {}
    const imported = ledgerState.imported ?? {}
    const manual = settings.get().manualQuota ?? {}
    const rows = []
    for (const entry of endpointIndex.values()) {
      const used = stats[entry.key] ?? null
      // 渠道包自己记的当日真实用量：有它就以它为准（更权威），否则用我们
      // 旁听 llm/stream 得到的计数。两者都只用于展示，不做额度扣减。
      const external = imported[entry.key] ?? null
      // 额度来源的优先级（重要，别弄反）：
      //   1. 真实读取到的（refreshProviderBalances 写进 endpointIndex）——最可信；
      //   2. 用户手填的（settings.manualQuota）——只在读不到真实值时兜底。
      // 反过来的话，手填一次旧数字就会永久盖住之后每次真实刷新。
      const manualRow = manual[entry.key] ?? null
      const observed = entry.quotaKnown === true && entry.quotaSource === 'observed'
      const quotaFromManual = manualRow !== null && !observed
      const calls = external !== null ? external.requests : (used?.calls ?? 0)
      const input = external !== null ? external.input : (used?.input ?? 0)
      const output = external !== null ? external.output : (used?.output ?? 0)
      const reasoning = external !== null ? external.reasoning : (used?.reasoning ?? 0)
      const cacheRead = external !== null ? external.cacheRead : (used?.cacheRead ?? 0)
      const account = providerAccounts.get(entry.provider) ?? null
      rows.push({
        key: entry.key,
        provider: entry.provider,
        model: entry.model,
        name: entry.displayName,
        lane: entry.lane,
        unit: (quotaFromManual ? manualRow.unit : undefined)
          ?? (entry.quotaUnit !== 'unknown' ? entry.quotaUnit : quotaUnitOf(entry.provider, entry.lane)),
        quotaKnown: observed || manualRow !== null,
        quotaTotal: (quotaFromManual ? manualRow.total : undefined) ?? entry.quotaTotal ?? 0,
        quotaRemaining: (quotaFromManual ? manualRow.remaining : undefined) ?? entry.quotaRemaining ?? 0,
        // 上游只给「还剩多少」时总额是未知的：不能伪造成 used=0（那会让进度条
        // 恒满、已用恒 0）。这里如实给 null，让前端画不定态（死代码审计 H-4）。
        quotaUsed: quotaFromManual
          ? Math.max(0, (manualRow.total ?? 0) - (manualRow.remaining ?? 0))
          : (entry.quotaUsed ?? null),
        quotaTotalUnknown: entry.quotaTotalUnknown === true,
        quotaSource: observed ? 'observed' : (manualRow !== null ? 'manual' : 'unknown'),
        blocked: (entry.blockedUntil ?? 0) > now,
        blockedUntil: entry.blockedUntil ?? 0,
        exhaustedAt: entry.exhaustedAt ?? 0,
        lastError: entry.lastError ?? '',
        lastUsedAt: external !== null ? (ledgerState.tokenLedgerAt ?? 0) : (used?.lastAt ?? entry.lastUsedAt ?? 0),
        // 该接口所属渠道在本机的登录状态（只对 channel 车道有意义）。
        account: account === null ? null : {
          count: account.accounts,
          enabled: account.enabled === true,
          nickname: account.nickname,
          expiresAt: account.expiresAt,
        },
        calls,
        failed: used?.failed ?? 0,
        errors: external !== null ? external.errors : 0,
        input,
        output,
        reasoning,
        cacheRead,
        windowCalls: used?.windowCalls ?? 0,
        windowInput: used?.windowInput ?? 0,
        windowOutput: used?.windowOutput ?? 0,
        usageSource: external !== null ? 'channel-pack' : (used === null ? 'none' : 'plugin'),
      })
    }
    return rows.sort((a, b) => {
      if (a.lane !== b.lane) return String(a.lane).localeCompare(String(b.lane))
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
      return a.model.localeCompare(b.model)
    })
  }

  /**
   * 卡片主视图：**每个已登录渠道账号一行余额**，而不是每个模型一行。
   *
   * 理由（用户反馈）：同一渠道的几十个模型共享一份积分池，按模型列出来只会
   * 得到几十行「额度未知」——那些数字本来就不存在，因为它不在模型粒度上。
   * 用户真正要看的只有一件事：这个已登录账号还剩多少。
   *
   * 数据来源两路合并，后者覆盖前者：
   *   1. `channel-pack/state.json` 的账号清单（知道有哪些账号、谁过期）；
   *   2. 上次 `credits.balances` 的结果（真实剩余额，来自 ledger.accounts）。
   * 从未刷新过余额时如实标 `quotaKnown: false`，而不是编一个数字。
   */
  function buildChannelCards(endpointRows) {
    const at = Date.now()
    const snapshot = ledger.get().accounts ?? {}
    // 端点行只算一次，供「该渠道下有几个模型」用。
    const allRows = Array.isArray(endpointRows) ? endpointRows : buildEndpointRows()
    const modelCount = new Map()
    for (const row of allRows) modelCount.set(row.provider, (modelCount.get(row.provider) ?? 0) + 1)
    const cards = []
    const providers = new Set([...providerAccounts.keys(), ...Object.keys(snapshot)])
    for (const provider of providers) {
      const accounts = providerAccounts.get(provider) ?? null
      const cached = snapshot[provider] ?? null
      const allPackages = []
      const rows = []
      // 以「余额快照的账号行」为准，没有快照就退化成账号清单（余额未知）。
      const cachedRows = Array.isArray(cached?.rows) ? cached.rows : []
      if (cachedRows.length > 0) {
        for (const row of cachedRows) {
          if (Array.isArray(row.packages)) {
            for (const item of row.packages) allPackages.push({ ...item, accountId: row.accountId })
          }
          rows.push({
            accountId: row.accountId ?? '',
            nickname: row.nickname ?? '',
            remaining: typeof row.remaining === 'number' ? row.remaining : null,
            total: typeof row.total === 'number' ? row.total : null,
            unit: row.unit ?? cached?.unit ?? 'credits',
            error: row.error ?? '',
            expiredTotal: Number(row.expiredTotal) || 0,
          })
        }
      } else {
        rows.push({
          accountId: '',
          nickname: accounts?.nickname ?? '',
          remaining: null,
          total: null,
          unit: quotaUnitOf(provider, 'channel'),
          error: '',
          expiredTotal: 0,
        })
      }
      const knownRows = rows.filter(row => typeof row.remaining === 'number')
      const remaining = knownRows.reduce((sum, row) => sum + row.remaining, 0)
      cards.push({
        provider,
        displayName: providerLabelOf(provider),
        accountCount: accounts?.accounts ?? cachedRows.length,
        enabled: accounts === null ? cachedRows.length > 0 : accounts.enabled === true,
        expiresAt: accounts?.expiresAt ?? 0,
        quotaKnown: knownRows.length > 0,
        remaining,
        unit: cached?.unit ?? quotaUnitOf(provider, 'channel'),
        refreshedAt: cached?.at ?? 0,
        stale: cached?.at === undefined ? true : at - cached.at > 30 * 60 * 1000,
        rows,
        packages: allPackages.filter(item => item.remaining > 0),
        // 这个渠道下有几个模型可用（只作为一行小字，不再每个模型占一行）。
        models: modelCount.get(provider) ?? 0,
      })
    }
    return cards.sort((a, b) => {
      if (a.quotaKnown !== b.quotaKnown) return a.quotaKnown ? -1 : 1
      if (b.remaining !== a.remaining) return b.remaining - a.remaining
      return a.provider.localeCompare(b.provider)
    })
  }

  /** 渠道包的十二个 provider 的显示名（与 Our Free Model 卡片一致）。 */
  const PROVIDER_LABELS = CHANNEL_PROVIDER_LABELS

  function providerLabelOf(provider) {
    return PROVIDER_LABELS[provider] ?? provider
  }

  /**
   * `/balances` 的 provider 白名单：只允许渠道包真实支持的 provider。
   *
   * 不能「只要 body 里给了就刷」——随机名字会让每次请求都真的打一次上游并
   * 挂满 90 秒超时，还绕过 inFlightBalances 去重（键就是那个随机名）。
   * 白名单是**静态表**，不来自请求体；另外把已在本机登录/已同步进来的
   * provider 也认作已知，避免用户手工同步的新渠道被拒。
   */
  function isKnownProvider(provider) {
    if (typeof provider !== 'string' || provider === '') return false
    if (Object.prototype.hasOwnProperty.call(CHANNEL_PROVIDER_LABELS, provider)) return true
    if (providerAccounts.has(provider)) return true
    const snapshot = ledger.get().accounts ?? {}
    return Object.prototype.hasOwnProperty.call(snapshot, provider)
  }

  function buildStatus() {
    const state = ledger.get()
    const rows = buildEndpointRows()
    const currentSettings = settings.get()
    const byLane = new Map()
    for (const row of rows) {
      const lane = row.lane === '' ? 'unknown' : row.lane
      const bucket = byLane.get(lane) ?? { lane, endpoints: 0, known: 0, blocked: 0, calls: 0, input: 0, output: 0 }
      bucket.endpoints += 1
      if (row.quotaKnown) bucket.known += 1
      if (row.blocked) bucket.blocked += 1
      bucket.calls += row.calls
      bucket.input += row.input
      bucket.output += row.output
      byLane.set(lane, bucket)
    }
    return {
      enabled: currentSettings.enabled === true,
      autoSwitch: currentSettings.autoSwitch === true,
      triggerCodes: currentSettings.triggerCodes ?? [],
      maxSwitchesPerStep: currentSettings.maxSwitchesPerStep ?? 0,
      cooldownMs: currentSettings.cooldownMs ?? 0,
      windowHours: currentSettings.windowHours ?? 24,
      officialFallback: currentSettings.officialFallback ?? null,
      catalogSyncedAt: state.catalogSyncedAt ?? 0,
      tokenLedgerAt: state.tokenLedgerAt ?? 0,
      /** 卡片的主视图：每个已登录渠道账号一行余额。见 buildChannelCards。 */
      channels: buildChannelCards(rows),
      endpoints: rows,
      lanes: [...byLane.values()].sort((a, b) => a.lane.localeCompare(b.lane)),
      switches: (state.switches ?? []).slice(-20).reverse(),
      failures: (state.failures ?? []).slice(-20).reverse(),
      /**
       * 额度可得性说明，直接呈现在卡片顶部。
       *
       * 这是实测结论，不是猜测：五条车道里只有 channel-pack 的十二个渠道
       * 能真实读到积分余额；free / EAC 个人 / Kilo / aggregate 都没有额度
       * 端点，只能靠失败反馈与用户手填。
       */
      quotaSources: [
        { lane: 'channel', readable: true, how: '渠道包 credits.balances（需已登录渠道账号）' },
        { lane: 'free', readable: false, how: '无可读额度端点，只有 429 反馈' },
        { lane: 'eac', readable: false, how: '只有 GitHub 授权状态与池级容量' },
        { lane: 'kilo', readable: false, how: '没有额度概念' },
        { lane: 'aggregate', readable: false, how: '需对每个 provider 单独实现余额查询' },
      ],
      totals: {
        endpoints: rows.length,
        known: rows.filter(row => row.quotaKnown).length,
        blocked: rows.filter(row => row.blocked).length,
        calls: rows.reduce((sum, row) => sum + row.calls, 0),
        input: rows.reduce((sum, row) => sum + row.input, 0),
        output: rows.reduce((sum, row) => sum + row.output, 0),
        errors: rows.reduce((sum, row) => sum + row.errors, 0),
      },
    }
  }

  return {
    attachAgentHooks,
    attachConnection,
    mountRoutes,
    syncCatalog,
    bootstrap,
    buildStatus,
    buildEndpointRows,
    buildChannelCards,
    recordUsage,
    recordFailure,
    decideTarget,
    alternativesFor,
    upsertEndpoint,
    endpointIndex,
    // 渠道真实余额（TRAE/Qoder 等）：走 connection 的 owner Peer，绕开
    // exact route 对非 owner 的 403。
    callChannelRpc,
    refreshProviderBalances,
    refreshAllBalances,
    /** 自检探针：确认几个按 turn/agent 记的 Map 有界。非公开 API。 */
    __debugMapSizes: () => ({
      switchBudget: switchBudget.size,
      pendingSwitch: pendingSwitch.size,
      lastRoute: lastRoute.size,
      inFlightBalances: inFlightBalances.size,
    }),
  }
}
