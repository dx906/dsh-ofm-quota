/**
 * 离线自检：不启动宿主，直接在一个假 ctx 上跑 index.js 的运行时。
 *
 * 覆盖 17 组（编号见文件内的 `── N.` 注释）：
 *   1. `llm/stream` 旁听 usage、流原样透传
 *   2. 同名备用接口优先 / `-free` 归一 / 官方路由排除
 *   3. 全部耗尽 → 官方兜底
 *   4. `agent/request-error` retry + 改写 + 丢 reasoningEffort + abort 保护
 *   5. HTTP 路由基本行为
 *   6. 真实落盘文件同步（catalog 三形态 / 渠道账号 / token-ledger）
 *   7. 渠道余额 RPC（owner Peer / 非 owner 403 / null 不写 0 / 无 connection 降级）
 *   8. `connection` 必须独立 inject
 *   9. 路由准入围栏（正反例 + 端口比较 + 无副作用）
 *  10. 有界内存
 *  11. 额度来源优先级（observed 压过 manual）
 *  12. 请求体健壮性（畸形 body / 原型污染 / reset 清全量）
 *  13. 设置迁移（补码 / 不删用户码 / 幂等）
 *  14. `/balances` provider 白名单
 *  15. 凭据脱敏与危险键
 *  16. 契约审计三条（顺序 / 二次 next / 未 inject 抛错）
 *  17. 死代码审计四条（账号累加 / 解除冷却 / 失败回写 / reset）
 *
 * 跑法：node scripts/selftest.mjs（或 pnpm test:host）
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../index.js'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-quota-test-'))
process.env.DSH_HOME = tmpHome

/** 一个足够像 cordis ctx 的替身：收集监听器、支持 waterfall 链。 */
function createFakeCtx() {
  const listeners = new Map()
  const registered = []
  const ctx = {
    logger: { info() {}, warn(m) { console.log('WARN', m) }, debug() {} },
    effect: () => () => {},
    get: () => undefined,
    on(name, callback) {
      const list = listeners.get(name) ?? []
      list.push(callback)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(callback)
        if (index >= 0) current.splice(index, 1)
      }
    },
    /** 按 cordis waterfall 语义跑一遍监听器（最外层先跑，next 下沉）。 */
    async waterfall(name, payload, inner) {
      const list = [...(listeners.get(name) ?? [])]
      const run = async index => {
        if (index >= list.length) return inner()
        return list[index](payload, () => run(index + 1))
      }
      return run(0)
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {
          const index = registered.indexOf(route)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
  }
  return { ctx, listeners, registered }
}

async function chunkStream(chunks) {
  async function* generator() {
    for (const chunk of chunks) yield chunk
  }
  return generator()
}

/** 直接读插件自己的 settings 存储。 */
function settingsNow(shared) {
  return shared.store.settings.get()
}

async function main() {
  const { ctx, listeners } = createFakeCtx()
  const shared = plugin.apply(ctx, {})
  assert.ok(shared !== undefined, 'apply 应返回句柄')
  const runtime = shared.runtime
  
  assert.equal(plugin.name, 'ofm-quota')

  // ── 1. 用量检测 ────────────────────────────────────────────
  const stream = await ctx.waterfall('llm/stream', { provider: 'trae', model: 'deepseek-v4.1-flash' },
    () => chunkStream([
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300, reasoningTokens: 40, cacheReadTokens: 100 } },
      { type: 'finish', reason: { kind: 'completed' } },
    ]))
  const seen = []
  for await (const chunk of stream) seen.push(chunk)
  assert.equal(seen.length, 3, '流必须原样透传，不能吞 chunk')

  const rows = runtime.buildEndpointRows()
  const traeRow = rows.find(row => row.provider === 'trae' && row.model === 'deepseek-v4.1-flash')
  assert.ok(traeRow !== undefined, "应记录 trae 接口")
  assert.equal(traeRow.input, 1200)
  assert.equal(traeRow.output, 300)
  assert.equal(traeRow.cacheRead, 100)
  assert.equal(traeRow.calls, 1)

  // ── 2. 同名备用接口优先 ────────────────────────────────────
  runtime.upsertEndpoint('qoder', 'deepseek-v4.1-flash', { lane: 'channel' })
  runtime.upsertEndpoint('our-free-model', 'deepseek-v4.1-flash-free', { lane: 'free' })
  const decision = runtime.decideTarget('trae', 'deepseek-v4.1-flash')
  assert.ok(decision !== null, '应有切换目标')
  assert.equal(decision.reason, 'same-model-alternative')
  assert.equal(decision.model.startsWith('deepseek-v4.1-flash'), true,
    `应优先同名的其他接口，实际 ${decision.provider}/${decision.model}`)

  // 2b. 免费车道带 -free 后缀也要认成同名（自检第一版就漏了这一类）
  runtime.upsertEndpoint('trae', 'kimi-k3', { lane: 'channel' })
  const sibling = runtime.alternativesFor('trae', 'kimi-k3')
  assert.ok(Array.isArray(sibling), 'alternativesFor 必须返回数组')
  runtime.upsertEndpoint('our-free-model', 'kimi-k3-free', { lane: 'free' })
  const familyMatch = runtime.alternativesFor('trae', 'kimi-k3')
  assert.equal(familyMatch.some(row => row.model === 'kimi-k3-free'), true,
    '-free 后缀的接口应被视为同名备用接口')

  // 2c. 官方路由永远不作为「同名备用接口」（它是兜底）
  runtime.upsertEndpoint('deepseek-official', 'deepseek-v4.1-flash', { lane: 'official' })
  const noOfficial = runtime.alternativesFor('trae', 'deepseek-v4.1-flash')
  assert.equal(noOfficial.some(row => row.provider === 'deepseek-official'), false,
    '官方路由不应出现在同名备用接口里')
  assert.equal(decision.model.startsWith('deepseek-v4.1-flash'), true)

  // ── 3. 全部耗尽 → 官方兜底 ─────────────────────────────────
  // 把所有仍可用的同名接口逐一标记失败，模拟「第三方接口全都没额度了」。
  for (const row of runtime.alternativesFor('trae', 'deepseek-v4.1-flash')) {
    runtime.recordFailure({ provider: row.provider, model: row.model, code: 'ACCOUNT_QUOTA', message: 'out' })
  }
  const fallback = runtime.decideTarget('trae', 'deepseek-v4.1-flash')
  assert.ok(fallback !== null)
  // deepseek-official 在 2c 里被登记过同名行，但它必须被排除在「同名备用接口」
  // 之外，否则兜底永远走不到——这条断言锁住的正是该规则。
  assert.equal(fallback.reason, 'official-fallback', '备用接口全部耗尽时必须走官方兜底')
  assert.equal(fallback.provider, 'deepseek-official')
  assert.equal(fallback.model, 'deepseek-flash')

  // ── 4. request-error 触发 retry 且下一请求被改写 ────────────
  //
  // payload 形状照内核真实签名（dsh-agent-loop/lib/index.js:1136-1146）：
  // `{ turn, step, provider, failure, retryPolicy, signal }` + `agent`，
  // **没有 model**——所以插件必须靠 agent/request 的旁注补 model。
  const retryAction = await ctx.waterfall('agent/request-error', {
    agent: { id: 'agent-1' }, turn: 1, step: 2, provider: 'trae',
    failure: { code: 'ACCOUNT_QUOTA', message: 'quota out' },
    retryPolicy: {}, signal: { throwIfAborted() {} },
  }, async () => undefined)
  assert.deepEqual(retryAction, { kind: 'retry' }, 'ACCOUNT_QUOTA 应返回 retry')
  // 这条断言锁住「triggerCodes 必须含内核真实码 ACCOUNT_QUOTA」——只写
  // QUOTA 的插件在 dsh-llm-deepseek-account 的升格下永远不会触发。
  assert.equal(settingsNow(shared).triggerCodes.includes('ACCOUNT_QUOTA'), true,
    'ACCOUNT_QUOTA 必须在默认触发码里')

  const nextSeed = { provider: 'trae', model: 'deepseek-v4.1-flash', reasoningEffort: 'light', maxTokens: 8192 }
  const rewritten = await ctx.waterfall('agent/request', {
    agent: { id: 'agent-1' }, turn: 1, step: 2, signal: { throwIfAborted() {} },
  }, async () => nextSeed)
  assert.equal(rewritten.provider, 'deepseek-official', '下一请求应被改写为官方兜底')
  assert.equal(rewritten.model, 'deepseek-flash')
  // 换路必须丢掉属于源路由的 reasoningEffort：目标适配器可能不认这个 id。
  assert.equal('reasoningEffort' in rewritten, false,
    '换路后不得继承源路由的 reasoningEffort')
  // 但与路由无关的字段必须原样保留。
  assert.equal(rewritten.maxTokens, 8192, '与路由无关的字段必须保留')

  // 切换记录应落账
  const status = runtime.buildStatus()
  assert.ok(status.switches.length >= 1, '应记录切换')
  assert.equal(status.endpoints.find(row => row.provider === 'qoder').blocked, true, '失败接口应进入冷却')

  // ── 5. HTTP 路由 ──────────────────────────────────────────
  runtime.mountRoutes({ webServer: ctx.webServer })
  // mountRoutes 通过 register 注册；用一个新的 holder 捕获注册项。
  const mountHolder = createFakeCtx()
  const shared2 = plugin.apply(mountHolder.ctx, {})
  shared2.runtime.mountRoutes(mountHolder.ctx)
  assert.equal(mountHolder.registered.length >= 1, true, '应注册 /api/ofm-quota 前缀路由')
  const route = mountHolder.registered[0]
  assert.equal(route.path, '/api/ofm-quota')

  const response = await callRoute(route.handler, 'GET', '/api/ofm-quota/status')
  assert.equal(response.status, 200)
  assert.equal(typeof response.body.enabled, 'boolean')
  assert.ok(Array.isArray(response.body.endpoints), 'status 应带 endpoints')

  const post = await callRoute(route.handler, 'POST', '/api/ofm-quota/settings', { autoSwitch: false })
  assert.equal(post.status, 200)
  assert.equal(post.body.settings.autoSwitch, false)

  const quota = await callRoute(route.handler, 'POST', '/api/ofm-quota/quota',
    { provider: 'trae', model: 'glm-5.3-flash', remaining: 0, total: 100 })
  assert.equal(quota.status, 200)
  assert.equal(quota.body.endpoint.quotaRemaining, 0)
  assert.equal(quota.body.endpoint.blocked, true, '额度为 0 应立即进入冷却')

  // ── 6. 从真实落盘文件同步（真实宿主里唯一的路径） ──────────
  //
  // 这一段用真实的目录结构与真实文件内容验证：catalog.json 的三种 id 形态
  // （entries/sealIds/kiloRows）、channel-pack 的 state.json 账号、
  // token-ledger 的 `direct|provider|accountId|model` 用量。
  const fakeHome = path.join(tmpHome, 'home-fixture')
  fs.mkdirSync(path.join(fakeHome, 'our-free-model'), { recursive: true })
  fs.mkdirSync(path.join(fakeHome, 'channel-pack'), { recursive: true })
  fs.writeFileSync(path.join(fakeHome, 'our-free-model', 'catalog.json'), JSON.stringify({
    version: 1,
    at: Date.now(),
    entries: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'],
    sealIds: ['deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3'],
    kiloRows: [{ id: 'kilo-big-pickle', name: 'Big Pickle' }],
  }))
  fs.writeFileSync(path.join(fakeHome, 'channel-pack', 'state.json'), JSON.stringify({
    accounts: [
      { id: 'trae-1', provider: 'trae', nickname: 'u1', enabled: true, expiresAt: Date.now() + 86400_000 },
      { id: 'qoder-1', provider: 'qodercn', nickname: 'u2', enabled: true },
    ],
  }))
  fs.writeFileSync(path.join(fakeHome, 'channel-pack', 'token-ledger.json'), JSON.stringify({
    schema: 'dsh-codearts-auth/token-ledger/v1',
    days: {
      '2026-10-21': {
        'direct|trae|trae-1|glm-5.3-flash': {
          requests: 42, inputTokens: 900000, outputTokens: 1200,
          reasoningTokens: 300, cacheReadTokens: 50, errors: 1,
        },
      },
    },
  }))

  // 换一个 DSH_HOME 再 apply 一次，让 syncCatalog 读到这份 fixture。
  process.env.DSH_HOME = fakeHome
  const homeHolder = createFakeCtx()
  const sharedHome = plugin.apply(homeHolder.ctx, {})
  const syncResult = await sharedHome.runtime.syncCatalog()
  assert.equal(syncResult.ok, true, 'fixture 存在时同步应成功')
  assert.equal(syncResult.total, 5, '三种 id 形态应全部计入（2 entries + 2 sealIds + 1 kilo）')
  assert.equal(syncResult.channelAccounts, 2, '应读到两个渠道账号')
  assert.equal(syncResult.ledger.ok, true, 'token-ledger 应可导入')

  const homeRows = sharedHome.runtime.buildEndpointRows()
  const freeRow = homeRows.find(row => row.key === 'our-free-model/deepseek-v4.1-flash-free')
  assert.ok(freeRow !== undefined, 'entries 应映射到 our-free-model provider')
  assert.equal(freeRow.lane, 'free')
  const eacRow = homeRows.find(row => row.key === 'deepseek-ai/deepseek-ai/deepseek-v4.1-flash')
  assert.ok(eacRow !== undefined, 'sealIds 应按首段拆 provider')
  assert.equal(eacRow.lane, 'eac')
  const kiloRow = homeRows.find(row => row.provider === 'kilo')
  assert.ok(kiloRow !== undefined, 'kiloRows 应计入')
  assert.equal(kiloRow.lane, 'kilo')
  assert.equal(kiloRow.unit, 'token', 'kilo 车道按 token 计量')

  // token-ledger 的用量应覆盖（比旁听计数更权威）。
  const traeTyped = homeRows.find(row => row.key === 'trae/glm-5.3-flash')
  assert.ok(traeTyped !== undefined, 'token-ledger 的接口应被登记')
  assert.equal(traeTyped.calls, 42, '应使用 token-ledger 的 requests')
  assert.equal(traeTyped.input, 900000, '应使用 token-ledger 的 inputTokens')
  assert.equal(traeTyped.usageSource, 'channel-pack', '用量来源应标为 channel-pack')
  assert.equal(traeTyped.errors, 1, '应保留 errors')

  // 渠道账号应挂到对应 provider 的接口上。
  const qodercnRow = homeRows.find(row => row.provider === 'qodercn')
  if (qodercnRow !== undefined) {
    assert.ok(qodercnRow.account !== null, '已登录渠道应带账号信息')
  }

  // 额度可得性说明必须如实反映「只有 channel 能读到」。
  const homeStatus = sharedHome.runtime.buildStatus()
  const channelSource = homeStatus.quotaSources.find(item => item.lane === 'channel')
  const freeSource = homeStatus.quotaSources.find(item => item.lane === 'free')
  assert.equal(channelSource.readable, true)
  assert.equal(freeSource.readable, false, 'free 车道必须如实标注不可读')

  // ── 7. 渠道真实余额（TRAE「剩余积分 382」）──────────────────
  //
  // 这是本插件唯一能拿到「真额度」的地方：渠道包把余额 RPC 注册成 connection
  // 的 exact Fetch route，而它对非 owner Peer 一律 403。正确姿势是自己造一个
  // owner Peer 再 dispatch。这一段用一个仿真的 connection 验证：
  //   - 非 owner Peer 必须收到 403（锁住「为什么不能直接 fetch」）；
  //   - owner Peer 能拿到 { ok:true, value:{accounts:[...balance.total]} }；
  //   - balance.total 落到接口行的 quotaRemaining 上；
  //   - balance 为 null 且带 error 时**不得写成 0**。
  {
    const calls = []
    const channelResponse = {
      ok: true,
      value: {
        accounts: [
          { accountId: 'trae-1', nickname: 'u1', balance: { total: 382, packages: [{ name: '每月登录赠送', remaining: 382, total: 382, unit: 'credits' }], expiredTotal: 0 } },
        ],
      },
    }
    const connection = {
      createPeer(options) {
        return { principal: options.principal, isOwner: options?.principal?.kind === 'owner' }
      },
      createSharedFetchHandler(channel) {
        return {
          async fetch(request, peer) {
            calls.push({ channel, url: String(request.url), body: await request.json(), owner: peer?.principal?.kind })
            if (peer?.principal?.kind !== 'owner') return new Response('forbidden', { status: 403 })
            return new Response(JSON.stringify({ rpcId: 'x', result: channelResponse }), {
              status: 200, headers: { 'content-type': 'application/json' },
            })
          },
        }
      },
    }

    const balanceCtx = { ...homeHolder.ctx, connection, get: name => (name === 'connection' ? connection : undefined) }
    // 重新 apply 一个实例，把 connection 塞进 ctx。
    const balanceHolder = createFakeCtx()
    balanceHolder.ctx.connection = connection
    const originalGet = balanceHolder.ctx.get
    balanceHolder.ctx.get = name => (name === 'connection' ? connection : originalGet(name))
    const balancePlugin = plugin.apply(balanceHolder.ctx, {})

    // trae 的接口此时已从 catalog 同步进来，需要再同步一次。
    process.env.DSH_HOME = fakeHome
    await balancePlugin.runtime.syncCatalog()

    const ok = await balancePlugin.runtime.refreshProviderBalances(balanceHolder.ctx, 'trae')
    assert.equal(ok.ok, true, `余额刷新应成功：${JSON.stringify(ok)}`)
    assert.equal(ok.remaining, 382, `应读到 382，实际 ${ok.remaining}`)
    assert.equal(ok.unit, 'credits')

    // 请求必须是 POST /api/channel-pack，且封套符合 rpcFetchHandler 要求。
    const call = calls.find(item => item.channel === '/api')
    assert.ok(call !== undefined, '应走 createSharedFetchHandler("/api")')
    assert.equal(call.owner, 'owner', '必须用 owner Peer，否则 exact route 返回 403')
    assert.equal(call.url.endsWith('/api/channel-pack'), true, `URL 应命中渠道包 exact route：${call.url}`)
    assert.equal(call.body.type, 'client-request', '封套 type 必须是 client-request')
    assert.equal(call.body.method, 'channel-pack', '封套 method 必须是 channel-pack')
    assert.equal(call.body.payload.method, 'credits.balances', '内层 method 应是 credits.balances')
    assert.equal(call.body.payload.payload.provider, 'trae', '内层 payload 应带 provider')
    assert.equal(typeof call.body.rpcId, 'string')

    // 余额应落到该 provider 下所有接口行。
    const rowsAfter = balancePlugin.runtime.buildEndpointRows().filter(row => row.provider === 'trae')
    assert.ok(rowsAfter.length > 0, 'trae 应有接口行')
    for (const row of rowsAfter) {
      assert.equal(row.quotaKnown, true, `${row.key} 应标为额度已知`)
      assert.equal(row.quotaRemaining, 382, `${row.key} 剩余额度应为 382`)
      assert.equal(row.unit, 'credits')
    }

    // ── 卡片主视图必须是「渠道账号」，不是「每个模型一行」 ──────
    //
    // 用户反馈：满屏「额度未知」正是因为按模型列出——额度不在模型粒度上，
    // 同一渠道的几十个模型共享一份积分池。
    const cards = balancePlugin.runtime.buildStatus().channels
    assert.ok(Array.isArray(cards), 'status.channels 必须是数组')
    const traeCard = cards.find(card => card.provider === 'trae')
    assert.ok(traeCard !== undefined, '应有一个 TRAE 卡片')
    assert.equal(traeCard.quotaKnown, true, 'TRAE 卡片应显示真实余额')
    assert.equal(traeCard.remaining, 382, `TRAE 卡片余额应为 382，实际 ${traeCard.remaining}`)
    assert.equal(traeCard.unit, 'credits')
    assert.equal(traeCard.displayName, 'TRAE（字节）', '应使用友好显示名')
    assert.ok(traeCard.models > 0, '卡片应记录该渠道下有几个模型（作为小字，不单独占行）')
    assert.ok(Array.isArray(traeCard.rows) && traeCard.rows.length >= 1, '卡片应带账号级明细行')
    assert.equal(traeCard.rows[0].nickname, 'u1', '账号明细应带昵称')
    assert.equal(traeCard.rows[0].remaining, 382, '账号明细应有余额')
    assert.equal(cards.filter(card => card.provider === 'trae').length, 1, '同一渠道只应有一张卡')

    // balance null + error：绝不能写成 0。
    channelResponse.value = {
      accounts: [{ accountId: 'trae-1', nickname: 'u1', balance: null, error: '积分查询失败（凭据失效或响应异常）' }],
    }
    const failed = await balancePlugin.runtime.refreshProviderBalances(balanceHolder.ctx, 'trae')
    assert.equal(failed.ok, false, '全部账号查不到额度时不得报成功')
    assert.equal(typeof failed.reason, 'string')
    {
      const failedCard = balancePlugin.runtime.buildStatus().channels.find(card => card.provider === 'trae')
      assert.equal(failedCard.quotaKnown, false, '查不到时不得标为已知')
      assert.equal(failedCard.rows[0].error.includes('积分查询失败'), true, '应把失败原因带到明细里')
    }

    // 非 owner Peer 必须 403——这是「为什么 host 半身读不到余额」的根因。
    const forbidden = await connection.createSharedFetchHandler('/api')
      .fetch(new Request('http://127.0.0.1/api/channel-pack', { method: 'POST', body: '{}' }), { principal: { kind: 'api' } })
    assert.equal(forbidden.status, 403, '非 owner Peer 必须收到 403')

    // 没有 connection 的宿主：只降级，不抛错。
    const bareHolder = createFakeCtx()
    const barePlugin = plugin.apply(bareHolder.ctx, {})
    const bare = await barePlugin.runtime.refreshProviderBalances(bareHolder.ctx, 'trae')
    assert.equal(bare.ok, false)
    assert.equal(bare.reason, 'no-connection')
  }

  // ── 8. connection 必须单独 inject，而不是复用 webServer 作用域 ──
  //
  // 上一版真实踩到的坑：把 connection 从 webServer 的 scoped ctx 上取，永远
  // 拿不到（cordis 服务按 isolate 键隔离），于是「刷新余额」恒为 no-connection、
  // 余额永远未知。这条锁住 apply 里必须存在独立的 ctx.inject(['connection']).
  {
    const injected = []
    const trackingCtx = {
      logger: { info() {}, warn() {}, debug() {} },
      effect: () => () => {},
      get: () => undefined,
      on: () => () => {},
      inject(services) {
        injected.push(...services)
        // 不调 callback：这里只验证 inject 了哪些服务名。
      },
    }
    plugin.apply(trackingCtx, {})
    assert.ok(injected.includes('llm'), 'inject 应包含 llm（装钩子）')
    assert.ok(injected.includes('webServer'), 'inject 应包含 webServer（挂路由）')
    assert.ok(injected.includes('connection'), 'inject 必须包含 connection（读渠道余额）')
  }

  // ── 9. 路由准入围栏（安全）────────────────────────────────────
  //
  // /api/ofm-quota 比内核 /api 更长，longest-prefix-wins 意味着它会先于
  // connection 的准入检查执行。不自己围栏 = 本机任何进程 / 跨站请求都能
  // 改设置、清台账。这一段锁住「正例放行、反例拒绝」。
  {
    const fenceHolder = createFakeCtx()
    const fencePlugin = plugin.apply(fenceHolder.ctx, {})
    fencePlugin.runtime.mountRoutes(fenceHolder.ctx)
    const fenceRoute = fenceHolder.registered[0]
    assert.equal(fenceRoute.path, '/api/ofm-quota')

    // 正例：loopback + 同源 Origin → 放行。
    const ok = await callRoute(fenceRoute.handler, 'GET', '/api/ofm-quota/status', undefined, {
      host: '127.0.0.1:6724', origin: 'http://127.0.0.1:6724',
    })
    assert.equal(ok.status, 200, 'loopback + 同源应放行')

    // 反例 1：非 loopback Host → 403（DNS rebinding 防线）。
    const badHost = await callRoute(fenceRoute.handler, 'GET', '/api/ofm-quota/status', undefined, {
      host: 'evil.example.com',
    })
    assert.equal(badHost.status, 403, '非 loopback Host 必须拒绝')

    // 反例 2：跨站 sec-fetch-site → 403（CSRF 防线）。
    const crossSite = await callRoute(fenceRoute.handler, 'POST', '/api/ofm-quota/reset', {}, {
      host: '127.0.0.1:6724', 'sec-fetch-site': 'cross-site', origin: 'http://evil.example',
    })
    assert.equal(crossSite.status, 403, '跨站请求必须拒绝')

    // 反例 3：Origin 与 Host 不同 authority → 403。
    const crossOrigin = await callRoute(fenceRoute.handler, 'POST', '/api/ofm-quota/settings', { autoSwitch: false }, {
      host: '127.0.0.1:6724', origin: 'http://attacker.test',
    })
    assert.equal(crossOrigin.status, 403, '异源 Origin 必须拒绝')

    // 反例 3b（安全审计的 C-2，重启也修不好那条）：同 hostname、**不同端口**。
    //
    // 只比 hostname 的话，本机任意端口上的页面（如 127.0.0.1:9000 的 dev server）
    // 都算同源；且 sec-fetch-site 给的是 same-site 而非 cross-site，两道都拦不住，
    // 越权**不需要** DNS rebinding。这里必须比到含端口的 host。
    const sameHostOtherPort = await callRoute(fenceRoute.handler, 'POST', '/api/ofm-quota/settings',
      { autoSwitch: false }, { host: '127.0.0.1:6724', origin: 'http://127.0.0.1:9000', 'sec-fetch-site': 'same-site' })
    assert.equal(sameHostOtherPort.status, 403,
      '同 hostname 不同端口的 Origin 必须拒绝（C-2）')

    // 正例：默认端口归一化——http://host（80）与 host:80 应视为同一 authority。
    const defaultPortA = await callRoute(fenceRoute.handler, 'GET', '/api/ofm-quota/status', undefined,
      { host: '127.0.0.1:6724', origin: 'http://127.0.0.1:6724' })
    assert.equal(defaultPortA.status, 200, '显式同端口应放行')

    // 反例 4：根本没有 Host 头 → 403（畸形请求不得 fail-open）。
    const noHost = await callRoute(fenceRoute.handler, 'GET', '/api/ofm-quota/status', undefined, {})
    assert.equal(noHost.status, 403, '缺 Host 必须拒绝')

    // 关键：被拒绝的请求不得产生副作用（台账不能被清空）。
    const before = fencePlugin.runtime.buildStatus().totals.endpoints
    await callRoute(fenceRoute.handler, 'POST', '/api/ofm-quota/reset', {}, { host: 'evil.example.com' })
    const after = fencePlugin.runtime.buildStatus().totals.endpoints
    assert.equal(after, before, '被拒绝的 /reset 不得清空台账')

    // 有 connection 服务时以它的裁决为准（第一层优先于结构化复刻）。
    let admitCalls = 0
    const denyConnection = {
      admit() { admitCalls += 1; return { rejection: 401 } },
      createPeer() { return {} },
      createSharedFetchHandler() { return { async fetch() { return new Response('{}') } } },
    }
    const connHolder = createFakeCtx()
    connHolder.ctx.connection = denyConnection
    const oldGet = connHolder.ctx.get
    connHolder.ctx.get = name => (name === 'connection' ? denyConnection : oldGet(name))
    const connPlugin = plugin.apply(connHolder.ctx, {})
    connPlugin.runtime.attachConnection(connHolder.ctx)
    connPlugin.runtime.mountRoutes(connHolder.ctx)
    const connRoute = connHolder.registered[0]
    const denied = await callRoute(connRoute.handler, 'GET', '/api/ofm-quota/status', undefined, {
      host: '127.0.0.1:6724', origin: 'http://127.0.0.1:6724',
    })
    assert.equal(denied.status, 401, 'connection 的裁决必须优先（即使 Host 是 loopback）')
    assert.equal(admitCalls, 1, '应调用 connection.admit')
  }

  // #region hidden ── 10. 有界内存 ──
  {
    const memHolder = createFakeCtx()
    const memPlugin = plugin.apply(memHolder.ctx, {})
    // 灌入大量 turn/step，确认 Map 不会无限增长。
    for (let turn = 0; turn < 2000; turn += 1) {
      await memHolder.ctx.waterfall('agent/request-error', {
        agent: { id: 'mem-agent' }, turn, step: 1, provider: 'trae',
        failure: { code: 'ACCOUNT_QUOTA', message: 'x' },
        signal: { aborted: false },
      }, async () => undefined)
    }
    const status = memPlugin.runtime.buildStatus()
    assert.ok(Array.isArray(status.switches), 'switches 仍是数组')
    const sizes = memPlugin.runtime.__debugMapSizes?.()
    assert.ok(sizes !== undefined, '应提供 __debugMapSizes 探针')
    if (sizes !== undefined) {
      assert.ok(sizes.switchBudget <= 600, `switchBudget 必须有界，实际 ${sizes.switchBudget}`)
      assert.ok(sizes.pendingSwitch <= 600, `pendingSwitch 必须有界，实际 ${sizes.pendingSwitch}`)
      assert.ok(sizes.lastRoute <= 300, `lastRoute 必须有界，实际 ${sizes.lastRoute}`)
    }
  }
  // #endregion

  // #region hidden ── 11. 额度来源优先级：真实读取 > 用户手填 ──
  //
  // 上一版用 `manualRow ?? entry`，手填一次旧数字就永久盖住之后每次真实刷新。
  // 正确顺序是「observed 优先，manual 只在读不到时兜底」。
  {
    const priorityHome = path.join(tmpHome, 'priority-home')
    fs.mkdirSync(path.join(priorityHome, 'our-free-model'), { recursive: true })
    fs.mkdirSync(path.join(priorityHome, 'channel-pack'), { recursive: true })
    fs.writeFileSync(path.join(priorityHome, 'our-free-model', 'catalog.json'), JSON.stringify({
      version: 1, at: Date.now(), entries: [], sealIds: [], kiloRows: [],
    }))
    fs.writeFileSync(path.join(priorityHome, 'channel-pack', 'state.json'), JSON.stringify({
      accounts: [{ id: 'trae-1', provider: 'trae', nickname: 'u1', enabled: true }],
    }))
    process.env.DSH_HOME = priorityHome

    let balanceValue = { accounts: [{ accountId: 'trae-1', nickname: 'u1', balance: { total: 382, packages: [] } }] }
    const priorityConnection = {
      createPeer: () => ({ principal: { kind: 'owner' } }),
      createSharedFetchHandler: () => ({
        async fetch() {
          return new Response(JSON.stringify({ rpcId: 'x', result: { ok: true, value: balanceValue } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        },
      }),
    }
    const holder = createFakeCtx()
    holder.ctx.connection = priorityConnection
    const baseGet = holder.ctx.get
    holder.ctx.get = name => (name === 'connection' ? priorityConnection : baseGet(name))
    const inst = plugin.apply(holder.ctx, {})
    inst.runtime.attachConnection(holder.ctx)
    inst.runtime.mountRoutes(holder.ctx)
    const priorityRoute = holder.registered[0]
    await inst.runtime.syncCatalog()
    // 造一个 trae 接口：catalog 为空，用 token-ledger 引出一条。
    inst.runtime.upsertEndpoint('trae', 'deepseek-v4.1-flash', { lane: 'channel' })

    // 1) 先手填一个虚高值。
    const manualRes = await callRoute(priorityRoute.handler, 'POST', '/api/ofm-quota/quota',
      { provider: 'trae', model: 'deepseek-v4.1-flash', remaining: 999999, total: 999999 },
      { host: '127.0.0.1:6724', origin: 'http://127.0.0.1:6724' })
    assert.equal(manualRes.status, 200, `手填应成功：${JSON.stringify(manualRes.body)}`)
    const manualRow = inst.runtime.buildEndpointRows()
      .find(row => row.provider === 'trae' && row.model === 'deepseek-v4.1-flash')
    assert.equal(manualRow.quotaSource, 'manual', '此时来源应是手填')
    assert.equal(manualRow.quotaRemaining, 999999)

    // 2) 真实刷新后，真实值必须压过手填值。
    await inst.runtime.refreshProviderBalances(holder.ctx, 'trae')
    const observedRow = inst.runtime.buildEndpointRows()
      .find(row => row.provider === 'trae' && row.model === 'deepseek-v4.1-flash')
    assert.equal(observedRow.quotaSource, 'observed', '真实读取必须压过手填')
    assert.equal(observedRow.quotaRemaining, 382, '应显示真实余额 382，而不是手填的 999999')
    balanceValue = null
  }
  // #endregion

  // #region hidden ── 12. 请求体健壮性（畸形 body 必须是 400 而不是 500）──
  {
    const bodyHolder = createFakeCtx()
    const bodyPlugin = plugin.apply(bodyHolder.ctx, {})
    bodyPlugin.runtime.mountRoutes(bodyHolder.ctx)
    const bodyRoute = bodyHolder.registered[0]
    const okHeaders = { host: '127.0.0.1:6724', origin: 'http://127.0.0.1:6724' }

    // 非法 JSON → 400
    const badJson = await callRawRoute(bodyRoute.handler, 'POST', '/api/ofm-quota/settings', '{not json', okHeaders)
    assert.equal(badJson.status, 400, `非法 JSON 应为 400，实际 ${badJson.status}`)

    // JSON 数组 / null / 字符串 → 400（不是对象）
    for (const payload of ['null', '[]', '"str"', '42']) {
      const res = await callRawRoute(bodyRoute.handler, 'POST', '/api/ofm-quota/settings', payload, okHeaders)
      assert.equal(res.status, 400, `非对象 body ${payload} 应为 400，实际 ${res.status}`)
    }

    // 空 body 的必填路由 → 400
    const emptyBody = await callRawRoute(bodyRoute.handler, 'POST', '/api/ofm-quota/settings', '', okHeaders)
    assert.equal(emptyBody.status, 400, '必填 body 的路由收到空 body 应为 400')

    // 空 body 的可选路由 → 200（/balances 允许不给 body）
    const optEmpty = await callRawRoute(bodyRoute.handler, 'POST', '/api/ofm-quota/balances', '', okHeaders)
    assert.equal(optEmpty.status, 200, `/balances 空 body 应放行，实际 ${optEmpty.status}`)

    // 合法 body → 200 且只接受白名单字段（原型污染防线）
    const polluted = await callRoute(bodyRoute.handler, 'POST', '/api/ofm-quota/settings',
      { autoSwitch: false, __proto__: { polluted: true }, constructor: { bad: 1 } }, okHeaders)
    assert.equal(polluted.status, 200)
    assert.equal(polluted.body.settings.autoSwitch, false)
    assert.equal(({}).polluted, undefined, '不得污染 Object.prototype')
    assert.equal(polluted.body.settings.polluted, undefined, '未知字段不得进入设置')

    // 未知路由 → 404
    const notFound = await callRoute(bodyRoute.handler, 'GET', '/api/ofm-quota/nope', undefined, okHeaders)
    assert.equal(notFound.status, 404)

    // /reset 现在必须连 imported / accounts 一起清（否则卡片还显示旧余额）
    await bodyPlugin.runtime.syncCatalog()
    const resetRes = await callRoute(bodyRoute.handler, 'POST', '/api/ofm-quota/reset', {}, okHeaders)
    assert.equal(resetRes.status, 200)
    const afterReset = bodyPlugin.runtime.buildStatus()
    assert.equal(afterReset.totals.calls, 0, '/reset 后调用数应归零')
    const anyKnown = afterReset.channels.some(card => card.quotaKnown === true)
    assert.equal(anyKnown, false, '/reset 后不应还留着旧余额快照')
  }
  // #endregion

  // #region hidden ── 13. 设置迁移：落盘旧配置必须被补齐 ──
  //
  // JsonStore 语义是「磁盘值覆盖默认值」，所以改代码里的默认 triggerCodes
  // 对已落盘的旧配置毫无作用。这台机器实测就存着不含 QUOTA_EXHAUSTED 的旧
  // 数组 —— 那会让额度耗尽完全不触发。这条锁住迁移逻辑。
  {
    const migrateHome = path.join(tmpHome, 'migrate-home')
    fs.mkdirSync(path.join(migrateHome, 'ofm-quota'), { recursive: true })
    fs.writeFileSync(path.join(migrateHome, 'ofm-quota', 'settings.json'), JSON.stringify({
      // 老版本写下的清单：缺 QUOTA_EXHAUSTED，且带一个用户自己加的码。
      triggerCodes: ['QUOTA', 'RATE_LIMIT', 'MY_CUSTOM_CODE'],
      enabled: true,
    }))
    process.env.DSH_HOME = migrateHome
    const migrateHolder = createFakeCtx()
    const migratePlugin = plugin.apply(migrateHolder.ctx, {})
    const codes = migratePlugin.store.settings.get().triggerCodes
    assert.ok(Array.isArray(codes))
    assert.ok(codes.includes('QUOTA_EXHAUSTED'),
      `迁移后必须补上 QUOTA_EXHAUSTED（OFM 免费车道的额度耗尽码）：${codes.join(',')}`)
    assert.ok(codes.includes('ACCOUNT_QUOTA'), '迁移后必须补上 ACCOUNT_QUOTA')
    assert.ok(codes.includes('LANE_LOCKED'), '迁移后必须补上 LANE_LOCKED')
    assert.ok(codes.includes('MY_CUSTOM_CODE'), '不得删除用户自己加的码')
    // 幂等：再 apply 一次不应重复追加。
    const second = plugin.apply(createFakeCtx().ctx, {})
    const again = second.store.settings.get().triggerCodes
    assert.equal(again.filter(code => code === 'QUOTA_EXHAUSTED').length, 1, '迁移必须幂等')

    // 默认值本身也必须含有这些码（新装用户同样受益）。
    const freshDefaults = plugin.apply(createFakeCtx().ctx, {}).store.settings.get().triggerCodes
    for (const required of ['QUOTA', 'ACCOUNT_QUOTA', 'QUOTA_EXHAUSTED', 'RATE_LIMIT',
      'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED', 'PERMISSION_DENIED',
      'AUTHORIZATION_REQUIRED', 'LANE_LOCKED']) {
      assert.ok(freshDefaults.includes(required), `默认触发码必须包含 ${required}`)
    }
  }
  // #endregion

  // #region hidden ── 14. /balances 的 provider 白名单（安全审计 H-2）──
  //
  // provider 直接来自 body 且无白名单时，随机名字会让每个请求都真的打一次
  // 上游并挂满 90 秒超时，还绕过 inFlightBalances 去重（键就是那个随机名）。
  {
    let rpcCalls = 0
    const spyConnection = {
      createPeer: () => ({ principal: { kind: 'owner' } }),
      createSharedFetchHandler: () => ({
        async fetch() {
          rpcCalls += 1
          return new Response(JSON.stringify({
            rpcId: 'x',
            result: { ok: true, value: { accounts: [] } },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        },
      }),
    }
    const holder = createFakeCtx()
    holder.ctx.connection = spyConnection
    const baseGet = holder.ctx.get
    holder.ctx.get = name => (name === 'connection' ? spyConnection : baseGet(name))
    const inst = plugin.apply(holder.ctx, {})
    inst.runtime.attachConnection(holder.ctx)
    inst.runtime.mountRoutes(holder.ctx)
    const route = holder.registered[0]
    const headers = { host: '127.0.0.1:6724', origin: 'http://127.0.0.1:6724' }

    // 未知 provider → 400，且**不得**打上游。
    const before = rpcCalls
    const unknown = await callRoute(route.handler, 'POST', '/api/ofm-quota/balances',
      { provider: 'random-evil-provider' }, headers)
    assert.equal(unknown.status, 400, `未知 provider 应为 400，实际 ${unknown.status}`)
    assert.equal(rpcCalls, before, '未知 provider 不得触发任何上游调用')

    // 已知 provider（白名单里的 trae）→ 放行（即使没有账号，也不该 400）。
    const known = await callRoute(route.handler, 'POST', '/api/ofm-quota/balances',
      { provider: 'trae' }, headers)
    assert.equal(known.status, 200, `白名单内的 trae 应放行，实际 ${known.status}`)

    // 空 body → 放行（刷新全部），不带 provider。
    const all = await callRoute(route.handler, 'POST', '/api/ofm-quota/balances', undefined, headers)
    assert.equal(all.status, 200, '空 body 应放行（刷新全部已登录渠道）')
  }
  // #endregion

  // #region hidden ── 15. 凭据脱敏与危险键（安全审计 M-1 / M-2）──
  {
    const dangerHolder = createFakeCtx()
    const dangerPlugin = plugin.apply(dangerHolder.ctx, {})
    dangerPlugin.runtime.mountRoutes(dangerHolder.ctx)
    const dangerRoute = dangerHolder.registered[0]
    const headers = { host: '127.0.0.1:6724', origin: 'http://127.0.0.1:6724' }

    // M-2：上游错误消息里的凭据不得原样落盘。
    dangerPlugin.runtime.recordFailure({
      provider: 'trae',
      model: 'deepseek-v4.1-flash',
      code: 'INVALID_CREDENTIAL',
      message: 'invalid api_key=sk-abcdef1234567890 for request; Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xx.yy',
    })
    const status = dangerPlugin.runtime.buildStatus()
    const failure = status.failures[0]
    assert.ok(failure !== undefined, '应记录失败')
    assert.equal(/sk-abcdef1234567890/.test(failure.message), false,
      `凭据不得出现在落盘消息里：${failure.message}`)
    assert.equal(/eyJhbGciOiJIUzI1NiJ9/.test(failure.message), false,
      `Bearer token 不得出现：${failure.message}`)
    assert.ok(failure.message.includes('[redacted]'), '应保留脱敏标记')
    // 普通诊断文本不该被误伤。
    dangerPlugin.runtime.recordFailure({
      provider: 'trae', model: 'm', code: 'QUOTA_EXHAUSTED', message: 'quota exceeded, retry after 60s',
    })
    const plain = dangerPlugin.runtime.buildStatus().failures
    assert.ok(plain.some(item => item.message.includes('quota exceeded, retry after 60s')),
      '普通错误文本不得被脱敏破坏')

    // M-1：危险对象键必须被拒（不是"靠斜杠侥幸安全"）。
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      const res = await callRoute(dangerRoute.handler, 'POST', '/api/ofm-quota/quota',
        { provider: bad, model: 'x', remaining: 1 }, headers)
      assert.ok(res.status === 400, `危险 provider "${bad}" 必须被拒，实际 ${res.status}`)
    }
    // 畸形字符串（控制字符 / 超长）同样拒绝。
    const controlChar = await callRoute(dangerRoute.handler, 'POST', '/api/ofm-quota/quota',
      { provider: 'a\u0000b', model: 'x', remaining: 1 }, headers)
    assert.equal(controlChar.status, 400, '含控制字符的 provider 必须被拒')
    const tooLong = await callRoute(dangerRoute.handler, 'POST', '/api/ofm-quota/quota',
      { provider: 'a'.repeat(200), model: 'x', remaining: 1 }, headers)
    assert.equal(tooLong.status, 400, '超长 provider 必须被拒')
    // 正常键必须仍然可用（不能防护过度）。
    const normal = await callRoute(dangerRoute.handler, 'POST', '/api/ofm-quota/quota',
      { provider: 'trae', model: 'deepseek-v4.1-flash', remaining: 382, total: 382 }, headers)
    assert.equal(normal.status, 200, `正常键应放行，实际 ${normal.status}`)
  }
  // #endregion

  // #region hidden ── 16. 契约审计的三条（顺序 / 二次 next / 未 inject 抛错）──
  {
    // 16a. lastRoute 必须记录**切换后**的路由，不是切换前。
    //
    // cordis waterfall：先注册者在外层，`await next()` 返回的才是内层结果。
    // 若「记 lastRoute」注册在「改写路由」之后（= 内层），它拿到的是改写前的
    // seed，于是失败记账与下一次选路都基于错误的 model。
    const orderHolder = createFakeCtx()
    const orderPlugin = plugin.apply(orderHolder.ctx, {})
    orderPlugin.runtime.mountRoutes(orderHolder.ctx)
    const orderRoute = orderHolder.registered[0]
    const headers = { host: '127.0.0.1:6724', origin: 'http://127.0.0.1:6724' }

    await orderPlugin.runtime.syncCatalog()
    orderPlugin.runtime.upsertEndpoint('trae', 'switch-model', { lane: 'channel' })
    orderPlugin.runtime.upsertEndpoint('qoder', 'switch-model', { lane: 'channel' })
    orderPlugin.runtime.upsertEndpoint('deepseek-official', 'deepseek-flash', { lane: 'official' })

    // 制造一次待生效切换：request-error 决定 → 下一个 request 落地。
    const retried = await orderHolder.ctx.waterfall('agent/request-error', {
      agent: { id: 'order-agent' }, turn: 5, step: 1, provider: 'trae',
      failure: { code: 'QUOTA_EXHAUSTED', message: 'q' }, signal: { aborted: false },
    }, async () => undefined)
    assert.deepEqual(retried, { kind: 'retry' }, '应返回 retry')

    const finalConfig = await orderHolder.ctx.waterfall('agent/request', {
      agent: { id: 'order-agent' }, turn: 5, step: 1,
    }, async () => ({ provider: 'trae', model: 'switch-model' }))
    // 切换已生效：
    assert.notEqual(finalConfig.provider, 'trae', `应已切走 trae，实际 ${finalConfig.provider}`)

    // 关键断言：request-error 读 lastRoute 补 model 时，拿到的应是切换**后**的路由。
    // 用一个新的 step 触发失败，观察记录里的 model 是否与 finalConfig 一致。
    await orderHolder.ctx.waterfall('agent/request-error', {
      agent: { id: 'order-agent' }, turn: 5, step: 2, provider: finalConfig.provider,
      failure: { code: 'SERVER', message: 'boom' }, signal: { aborted: false },
    }, async () => undefined)
    const failureRows = orderPlugin.runtime.buildStatus().failures
    const recorded = failureRows.find(item => item.code === 'SERVER')
    assert.ok(recorded !== undefined, '应记录 SERVER 失败')
    assert.equal(recorded.model, finalConfig.model,
      `lastRoute 必须记切换后的 model（期望 ${finalConfig.model}，实际 ${recorded.model}）`)

    // 16b. `next()` 只调用一次。
    //
    // 澄清一个审计结论：契约审计说「llm/stream 的 catch 里二次调 next() 会把
    // 下游执行两遍」。实测这个 bug **只在 next() 成功返回后、包装器构造阶段抛错**
    // 时才可达；而真实的 `observeStream` 是 async generator，调用只创建对象、
    // 不会抛，所以可达性极低。代码矛盾仍然是真的（catch 里再调 next 与自己的
    // 注释相悖），已改成「next() 只调一次、失败原样抛出」。
    //
    // 这里锁住的行为是：无论包装是否发生，下游都不得被重复执行。
    let downstreamCalls = 0
    const streamHolder = createFakeCtx()
    plugin.apply(streamHolder.ctx, {})

    // (a) 正常路径：下游一次。
    const wrapped = await streamHolder.ctx.waterfall('llm/stream',
      { provider: 'trae', model: 'm' }, async () => {
        downstreamCalls += 1
        async function* gen() { yield { type: 'finish', reason: { kind: 'completed' } } }
        return gen()
      })
    for await (const _chunk of wrapped) { /* drain */ }
    assert.equal(downstreamCalls, 1, `正常路径下游必须只执行一次，实际 ${downstreamCalls}`)

    // (b) 下游失败（返回被拒绝的 Promise）：必须原样穿透，且只执行一次。
    downstreamCalls = 0
    let rejected = false
    try {
      const result = await streamHolder.ctx.waterfall('llm/stream', { provider: 'trae', model: 'm' }, async () => {
        downstreamCalls += 1
        throw new Error('downstream exploded')
      })
      // 若 hook 把它包成 generator，消费时会重新抛出。
      if (result !== null && typeof result === 'object' && Symbol.asyncIterator in result) {
        for await (const _chunk of result) { /* drain */ }
      }
    } catch {
      rejected = true
    }
    assert.equal(rejected, true, '下游失败必须原样穿透（不得被吞掉）')
    assert.equal(downstreamCalls, 1, `下游失败时也只能执行一次，实际 ${downstreamCalls}`)

    // (c) options 取值抛错：hook 不得因此再调一次 next()。
    downstreamCalls = 0
    const poisoned = {}
    Object.defineProperty(poisoned, 'provider', {
      enumerable: true,
      get() { throw new Error('poisoned option') },
    })
    Object.defineProperty(poisoned, 'model', { enumerable: true, value: 'm' })
    try {
      await streamHolder.ctx.waterfall('llm/stream', poisoned, async () => {
        downstreamCalls += 1
        async function* gen() { yield { type: 'finish', reason: { kind: 'completed' } } }
        return gen()
      })
    } catch { /* hook 把 options 读取错误抛出去是可接受的 */ }
    assert.equal(downstreamCalls <= 1, true,
      `读取 options 抛错时下游不得被执行两次，实际 ${downstreamCalls}`)

    // 16c. 未 inject connection 的作用域上读属性会抛——围栏必须吞住并降级，
    //      绝不能把整条路由变成 500（契约审计实测复现的那个「降级分支自己坏了」）。
    const throwingScope = {
      get() { throw new Error('cannot get property "connection" without inject') },
      get connection() { throw new Error('cannot get property "connection" without inject') },
    }
    const injHolder = createFakeCtx()
    const injPlugin = plugin.apply(injHolder.ctx, {})
    injPlugin.runtime.mountRoutes(injHolder.ctx)
    const injRoute = injHolder.registered[0]
    // 直接让 parentForRoutes 指向会抛的作用域（模拟 webServer 作用域没 inject connection）。
    injPlugin.runtime.attachConnection(throwingScope)
    const res = await callRoute(injRoute.handler, 'GET', '/api/ofm-quota/status', undefined, headers)
    assert.equal(res.status, 200,
      `connection 不可读时必须降级为结构化围栏并正常返回 JSON，实际 ${res.status}`)
    assert.equal(typeof res.body.enabled, 'boolean', '降级后仍须返回正常 JSON')
    // 且降级后的围栏依然生效。
    const denied = await callRoute(injRoute.handler, 'GET', '/api/ofm-quota/status', undefined,
      { host: 'evil.example.com' })
    assert.equal(denied.status, 403, '降级后结构化围栏仍须拒绝非 loopback')
  }
  // #endregion

  // #region hidden ── 17. 死代码审计的四条（账号累加 / 解除冷却 / 失败回写 / reset）──
  {
    const h = createFakeCtx()
    const inst = plugin.apply(h.ctx, {})
    inst.runtime.mountRoutes(h.ctx)
    const route = h.registered[0]
    const headers = { host: '127.0.0.1:6724', origin: 'http://127.0.0.1:6724' }

    // 17a. syncCatalog 重复执行不得把账号数累加（原来 2→4→6）。
    const accHome = path.join(tmpHome, 'acc-home')
    fs.mkdirSync(path.join(accHome, 'our-free-model'), { recursive: true })
    fs.mkdirSync(path.join(accHome, 'channel-pack'), { recursive: true })
    fs.writeFileSync(path.join(accHome, 'our-free-model', 'catalog.json'), JSON.stringify({
      version: 1, at: Date.now(), entries: [], sealIds: [], kiloRows: [],
    }))
    fs.writeFileSync(path.join(accHome, 'channel-pack', 'state.json'), JSON.stringify({
      accounts: [
        { id: 'trae-1', provider: 'trae', nickname: 'u1', enabled: true },
        { id: 'trae-2', provider: 'trae', nickname: 'u2', enabled: true },
      ],
    }))
    process.env.DSH_HOME = accHome
    const accHolder = createFakeCtx()
    const accPlugin = plugin.apply(accHolder.ctx, {})
    const counts = []
    for (let i = 0; i < 3; i += 1) {
      await accPlugin.runtime.syncCatalog()
      counts.push(accPlugin.runtime.buildStatus().channels.find(c => c.provider === 'trae')?.accountCount)
    }
    assert.deepEqual(counts, [2, 2, 2],
      `账号数不得随同步累加（期望 [2,2,2]，实际 ${JSON.stringify(counts)}）`)

    // 17b. 余额读到 0 的接口，/unblock 后必须重新可选。
    process.env.DSH_HOME = tmpHome
    const unlockHolder = createFakeCtx()
    const unlockPlugin = plugin.apply(unlockHolder.ctx, {})
    unlockPlugin.runtime.mountRoutes(unlockHolder.ctx)
    const unlockRoute = unlockHolder.registered[0]
    unlockPlugin.runtime.upsertEndpoint('qoder', 'kimi-k3', { lane: 'channel' })
    unlockPlugin.runtime.upsertEndpoint('trae', 'kimi-k3', { lane: 'channel' })
    // 把 qoder 标成「读到 0」，它就不该再被选为备用接口。
    await callRoute(unlockRoute.handler, 'POST', '/api/ofm-quota/quota',
      { provider: 'qoder', model: 'kimi-k3', remaining: 0, total: 0 }, headers)
    let alts = unlockPlugin.runtime.alternativesFor('trae', 'kimi-k3')
    assert.equal(alts.some(row => row.provider === 'qoder'), false,
      '余额为 0 的接口不应被选为备用接口')
    // 解除之后必须重新可选（原实现只清 blockedUntil，解不开）。
    const unblocked = await callRoute(unlockRoute.handler, 'POST', '/api/ofm-quota/unblock',
      { provider: 'qoder', model: 'kimi-k3' }, headers)
    assert.equal(unblocked.status, 200)
    alts = unlockPlugin.runtime.alternativesFor('trae', 'kimi-k3')
    assert.equal(alts.some(row => row.provider === 'qoder'), true,
      '/unblock 后余额为 0 的接口必须重新可选')

    // 17c. 余额读取失败必须回写「未知」，不能留着旧的成功读数。
    let balanceValue = { accounts: [{ accountId: 't1', nickname: 'u', balance: { total: 382, packages: [] } }] }
    const failingConnection = {
      createPeer: () => ({ principal: { kind: 'owner' } }),
      createSharedFetchHandler: () => ({
        async fetch() {
          return new Response(JSON.stringify({ rpcId: 'x', result: { ok: true, value: balanceValue } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        },
      }),
    }
    const failHome = path.join(tmpHome, 'fail-home')
    fs.mkdirSync(path.join(failHome, 'our-free-model'), { recursive: true })
    fs.mkdirSync(path.join(failHome, 'channel-pack'), { recursive: true })
    fs.writeFileSync(path.join(failHome, 'our-free-model', 'catalog.json'), JSON.stringify({ version: 1, at: Date.now(), entries: [], sealIds: [], kiloRows: [] }))
    fs.writeFileSync(path.join(failHome, 'channel-pack', 'state.json'), JSON.stringify({ accounts: [{ id: 't1', provider: 'trae', enabled: true }] }))
    process.env.DSH_HOME = failHome
    const failHolder = createFakeCtx()
    failHolder.ctx.connection = failingConnection
    const baseGet = failHolder.ctx.get
    failHolder.ctx.get = name => (name === 'connection' ? failingConnection : baseGet(name))
    const failPlugin = plugin.apply(failHolder.ctx, {})
    failPlugin.runtime.attachConnection(failHolder.ctx)
    await failPlugin.runtime.syncCatalog()
    failPlugin.runtime.upsertEndpoint('trae', 'm1', { lane: 'channel' })
    // 先成功读一次，行里留下 382。
    await failPlugin.runtime.refreshProviderBalances(failHolder.ctx, 'trae')
    let row = failPlugin.runtime.buildEndpointRows().find(r => r.key === 'trae/m1')
    assert.equal(row.quotaRemaining, 382)
    // 再失败一次，行必须变成「未知」而不是继续报 382。
    balanceValue = { accounts: [{ accountId: 't1', nickname: 'u', balance: null, error: '凭据失效' }] }
    await failPlugin.runtime.refreshProviderBalances(failHolder.ctx, 'trae')
    row = failPlugin.runtime.buildEndpointRows().find(r => r.key === 'trae/m1')
    assert.equal(row.quotaKnown, false,
      `读取失败后必须回写为未知，不能留着旧的 382（实际 known=${row.quotaKnown}, remaining=${row.quotaRemaining}）`)

    // 17d. /reset 必须同时清内存状态（额度与冷却不得残留）。
    process.env.DSH_HOME = tmpHome
    const resetHolder = createFakeCtx()
    const resetPlugin = plugin.apply(resetHolder.ctx, {})
    resetPlugin.runtime.mountRoutes(resetHolder.ctx)
    const resetRoute = resetHolder.registered[0]
    resetPlugin.runtime.upsertEndpoint('trae', 'm2', {
      lane: 'channel', quotaKnown: true, quotaSource: 'observed',
      quotaRemaining: 5, quotaTotal: 5, blockedUntil: Date.now() + 600_000,
    })
    const resetRes = await callRoute(resetRoute.handler, 'POST', '/api/ofm-quota/reset', {}, headers)
    assert.equal(resetRes.status, 200)
    const afterReset = resetPlugin.runtime.buildEndpointRows().find(r => r.key === 'trae/m2')
    assert.ok(afterReset !== undefined, '/reset 不该把接口清单本身清掉')
    assert.equal(afterReset.quotaKnown, false, '/reset 后额度必须变为未知')
    assert.equal(afterReset.blocked, false, '/reset 后冷却必须清除')
  }
  // #endregion

  console.log('selftest PASS')
}

/** 发原始文本 body（用于测非法 JSON）。 */
async function callRawRoute(handler, method, url, rawBody, headers) {
  const payload = rawBody === '' ? [] : [Buffer.from(rawBody, 'utf8')]
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      end(text) {
        try { resolve({ status: this.status, body: JSON.parse(text) }) } catch (error) { reject(error) }
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

/** 直接把一个假 req/res 喂给路由处理器。 */
async function callRoute(handler, method, url, body, headers = { host: '127.0.0.1:9999' }) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      headers: null,
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(text) {
        try {
          resolve({ status: this.status, body: JSON.parse(text) })
        } catch (error) {
          reject(error)
        }
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

main().then(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
}).catch(error => {
  console.error('selftest FAIL:', error)
  process.exit(1)
})
