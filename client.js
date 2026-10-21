/**
 * dsh-ofm-quota — 浏览器半身。
 *
 * 注册一个 DSH 原生右侧栏 tab（`ctx.sidebarRightTabs` + keyed slots
 * `sidebar.right.pane.tab` / `.title`），展示各接入接口的剩余额度与实时消耗。
 *
 * 为什么不用 better-sidebar 的 `ctx.betterSidebar.registerTab`：那是一条额外的
 * 硬依赖，而 DSH 0.2.1 起自带原生右侧栏（`ctx.sidebarRightTabs`），
 * dsh-my-guardian 也已从前者迁移到后者。走原生席位意味着本插件不装
 * better-sidebar 也能用；装了的话，两个 tab 各归各，互不影响。
 *
 * 数据源：同源 `GET /api/ofm-quota/status`，tab 可见时轮询。宿主给的
 * `useTabInfo()` 提供 `tab.visible`，不可见就停表，空闲零请求。
 *
 * 手写 ModuleLoader bundle：无构建步骤，只 require 宿主已提供的 `react`。
 * 颜色全部走主题变量，深浅色切换不重画。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ofm-quota',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { createElement, useEffect, useMemo, useRef, useState } = require('react')

    /** 原生页签类型实现身份（官方惯例：包名；全局唯一，也是席位的 key）。 */
    const TAB_ID_PKG = 'dsh-ofm-quota'
    /** 原生 tab kind（宿主侧 openTab 用）。 */
    const TAB_KIND = 'dsh-ofm-quota:panel'
    const TAB_ORDER = 120
    const POLL_MS = 4000

    const t = (zh, en) => (locale().startsWith('en') ? en : zh)

    function locale() {
      try {
        const raw = document.documentElement?.lang || navigator.language || 'zh'
        return String(raw).toLowerCase()
      } catch {
        return 'zh'
      }
    }

    const STYLES = `
.ofmq-root { display:flex; flex-direction:column; gap:6px; padding:6px 8px 12px;
  font:var(--dsw-font-s-14,13px/1.5 system-ui); color:var(--dsw-alias-label-primary,#ddd); }
.ofmq-head { display:flex; align-items:center; gap:6px; padding:2px 2px 4px; }
.ofmq-title { font-weight:600; flex:1; }
.ofmq-badge { font-size:11px; padding:1px 6px; border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14)); opacity:.85; }
.ofmq-btn { border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));
  background:transparent; color:inherit; font:inherit; font-size:12px;
  padding:2px 8px; border-radius:6px; cursor:pointer; }
.ofmq-btn:hover { background:color-mix(in srgb, currentColor 8%, transparent); }
.ofmq-btn:disabled { opacity:.45; cursor:default; }
.ofmq-sum { display:flex; gap:6px; flex-wrap:wrap; padding:0 2px; }
.ofmq-sum span { font-size:11px; opacity:.72; }
.ofmq-list { display:flex; flex-direction:column; gap:4px; }
.ofmq-row { display:flex; flex-direction:column; gap:3px; padding:6px 8px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));
  transition:background 150ms ease; }
.ofmq-row:hover { background:color-mix(in srgb, currentColor 5%, transparent); }
.ofmq-row-blocked { border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#e0a030) 45%, transparent); }
.ofmq-row-exhausted { border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e05252) 45%, transparent); }
.ofmq-line1 { display:flex; align-items:baseline; gap:6px; }
.ofmq-model { font-weight:600; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.ofmq-lane { font-size:10px; padding:0 5px; border-radius:4px; opacity:.75;
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12)); }
.ofmq-line2 { display:flex; align-items:center; gap:6px; font-size:11px; opacity:.75; }
.ofmq-prov { font-family:var(--dsw-font-mono,ui-monospace); font-size:10.5px; }
.ofmq-bar { flex:1; height:4px; border-radius:999px; overflow:hidden;
  background:color-mix(in srgb, currentColor 12%, transparent); }
.ofmq-bar-fill { height:100%; border-radius:999px; transition:width 240ms ease;
  background:var(--dsw-alias-state-success-primary,#4caf72); }
.ofmq-bar-fill.low { background:var(--dsw-alias-state-warn-primary,#e0a030); }
.ofmq-bar-fill.gone { background:var(--dsw-alias-state-error-primary,#e05252); }
.ofmq-empty { padding:16px 8px; text-align:center; font-size:12px; opacity:.6; line-height:1.7; }
.ofmq-section { font-size:11px; opacity:.6; padding:6px 2px 0; letter-spacing:.02em; }
.ofmq-err { font-size:11px; opacity:.7; color:var(--dsw-alias-state-error-primary,#e05252); }
.ofmq-kv { display:flex; justify-content:space-between; gap:8px; font-size:11px; opacity:.75; }
.ofmq-switch { display:flex; align-items:center; gap:6px; font-size:11.5px; opacity:.85; }
.ofmq-switch input { accent-color:var(--dsw-alias-state-success-primary,#4caf72); }
`

    /* ── 数据 ────────────────────────────────────────────────── */

    /**
     * 把插件自己的 host 路由解析成页面可 fetch 的绝对 URL。
     *
     * **绝不能用前导斜杠**（`fetch('/api/ofm-quota/...')`）。那会把自己钉死在
     * ORIGIN ROOT，两种部署下都坏：
     *   - 反代目录前缀（`https://host/proxy/3080/`）下直接 404；
     *   - Electron 壳的页面是 `dsh-app://app/`，壳的 protocol.handle 只把
     *     「相对 base 的路径」转发给 Host。
     * HTTP 必须走「页面 base」（`document.baseURI`）；用 `new URL(path,
     * document.baseURI)` 即可，剥前导斜杠由这里的写法保证。
     * 参考实现：dsh-better-sidebar 的 src/client/host-route-url.ts:46-70。
     */
    function routeUrl(pathname) {
      const relative = `api/ofm-quota/${String(pathname).replace(/^\/+/, '')}`
      try {
        const base = document.baseURI
        if (typeof base === 'string' && base !== '') return new URL(relative, base).toString()
      } catch { /* 拿不到 baseURI 时退回相对路径 */ }
      return relative
    }

    async function getJson(pathname) {
      const response = await fetch(routeUrl(pathname), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function postJson(pathname, body) {
      const response = await fetch(routeUrl(pathname), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /** 单例轮询器：多个 tab 实例共享一条定时器，可见性取并集。 */
    function useQuotaStatus(visible) {
      const [state, setState] = useState({ status: null, error: '', loading: true })
      const mounted = useRef(true)
      useEffect(() => () => { mounted.current = false }, [])
      useEffect(() => {
        if (!visible) return undefined
        let cancelled = false
        let timer = null
        const tick = async () => {
          try {
            const status = await getJson('status')
            if (!cancelled && mounted.current) setState({ status, error: '', loading: false })
          } catch (error) {
            if (!cancelled && mounted.current) {
              setState(previous => ({ ...previous, error: error.message ?? String(error), loading: false }))
            }
          } finally {
            if (!cancelled) timer = setTimeout(tick, POLL_MS)
          }
        }
        void tick()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [visible])
      return state
    }

    /* ── 展示 ────────────────────────────────────────────────── */

    const UNIT_LABEL = {
      credits: () => t('积分', 'credits'),
      requests: () => t('请求', 'requests'),
      token: () => t('token', 'tokens'),
      unknown: () => '',
    }

    function unitLabel(unit) {
      const fn = UNIT_LABEL[unit]
      return fn === undefined ? String(unit ?? '') : fn()
    }

    function formatNumber(value) {
      const n = Number(value) || 0
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
      if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
      return String(Math.round(n))
    }

    function formatTokens(row) {
      const total = (row.input ?? 0) + (row.output ?? 0)
      if (total === 0) return t('尚无消耗', 'no usage yet')
      return `${t('入', 'in')} ${formatNumber(row.input)} / ${t('出', 'out')} ${formatNumber(row.output)}`
    }

    function relativeTime(at) {
      if (!at) return ''
      const diff = Date.now() - at
      if (diff < 60_000) return t('刚刚', 'just now')
      if (diff < 3600_000) return `${Math.round(diff / 60_000)} ${t('分钟前', 'min ago')}`
      if (diff < 86400_000) return `${Math.round(diff / 3600_000)} ${t('小时前', 'h ago')}`
      return `${Math.round(diff / 86400_000)} ${t('天前', 'd ago')}`
    }

    /**
     * 一个已登录渠道的卡片：**余额是这个渠道/账号的属性，不是模型的属性**。
     *
     * 同一渠道下的几十个模型共享一份积分池，所以这里只画一张卡（可展开看
     * 每个账号），而不是为每个模型重复同一个数字——那正是上一版满屏
     * 「额度未知」的来源：额度本来就不在模型粒度上。
     */
    function ChannelCard({ card }) {
      const [open, setOpen] = useState(false)
      const known = card.quotaKnown === true
      // 不画进度条：上游只给「剩余」，不给「总额」，任何比例都是编造的。
      // 之前用 0.5/0.7 常量填宽度，纯粹是假象（死代码审计 M-13）。
      const rowClass = !known
        ? 'ofmq-row'
        : card.remaining <= 0 ? 'ofmq-row ofmq-row-exhausted' : 'ofmq-row'
      const accountLine = card.accountCount > 1
        ? `${card.accountCount} ${t('个账号', 'accounts')}`
        : (card.rows?.[0]?.nickname || t('1 个账号', '1 account'))
      return createElement('div', { className: rowClass },
        createElement('div', { className: 'ofmq-line1' },
          createElement('span', { className: 'ofmq-model' }, card.displayName || card.provider),
          createElement('span', { className: 'ofmq-lane' }, accountLine),
          card.enabled === false
            ? createElement('span', { className: 'ofmq-lane', style: { opacity: 0.55 } }, t('已停用', 'disabled'))
            : null,
        ),
        createElement('div', { className: 'ofmq-line2' },
          known
            ? createElement('span', null,
                `${t('剩余', 'left')} ${formatNumber(card.remaining)} ${unitLabel(card.unit)}`)
            : createElement('span', null,
                card.refreshedAt === 0
                  ? t('余额未读取 · 点「刷新余额」', 'not read yet · press Balances')
                  : t('余额未知', 'quota unknown')),
          createElement('span', null, `${card.models} ${t('个模型', 'models')}`),
        ),
        known
          ? createElement('div', { className: 'ofmq-bar' },
              createElement('div', {
                className: `ofmq-bar-fill ${card.remaining > 0 ? '' : 'gone'}`,
                // 只表达「有/无额度」两态，不伪造比例（总额未知）。
                style: { width: card.remaining > 0 ? '100%' : '0%' },
              }))
          : null,
        createElement('div', { className: 'ofmq-kv' },
          createElement('span', null,
            card.refreshedAt ? `${t('刷新于', 'read')} ${relativeTime(card.refreshedAt)}` : ''),
          createElement('span', null,
            card.rows?.length > 1 || (card.packages?.length ?? 0) > 0
              ? createElement('button', {
                  className: 'ofmq-btn',
                  style: { padding: '0 6px', fontSize: '10.5px' },
                  onClick: () => setOpen(value => !value),
                }, open ? t('收起', 'hide') : t('明细', 'details'))
              : ''),
        ),
        // 明细：每个账号一行余额 + 积分包明细。
        open
          ? createElement('div', null,
              (card.rows ?? []).map((row, index) =>
                createElement('div', { key: `${row.accountId}:${index}`, className: 'ofmq-kv' },
                  createElement('span', null, row.nickname || row.accountId || t('账号', 'account')),
                  createElement('span', null, typeof row.remaining === 'number'
                    ? `${formatNumber(row.remaining)} ${unitLabel(row.unit)}`
                    : (row.error || t('未知', 'unknown'))),
                )),
              (card.packages ?? []).map((item, index) =>
                createElement('div', { key: `pkg:${index}`, className: 'ofmq-kv', style: { opacity: 0.7 } },
                  createElement('span', null, item.name || t('积分包', 'package')),
                  createElement('span', null, `${formatNumber(item.remaining)} / ${formatNumber(item.total)}`),
                )),
              card.expiresAt
                ? createElement('div', { className: 'ofmq-kv', style: { opacity: 0.7 } },
                    createElement('span', null, t('凭据过期', 'credential expires')),
                    createElement('span', null, new Date(card.expiresAt).toLocaleString()))
                : null,
            )
          : null,
      )
    }

    function QuotaRow({ row }) {
      // 「额度已知」的唯一依据是后端给的 quotaKnown 标志，不看 total > 0。
      // 用 total>0 判定会把「余额真的是 0」显示成「额度未知」——那正好是
      // 用户最需要看见的状态（死代码审计 H-5）。
      const known = row.quotaKnown === true
      const totalUnknown = row.quotaTotalUnknown === true || !(row.quotaTotal > 0)
      // 总额未知时只画「剩余」文字，不画进度条（画比例需要总额）。
      const ratio = known && !totalUnknown
        ? Math.max(0, Math.min(1, row.quotaRemaining / row.quotaTotal))
        : 0
      const fillClass = !known ? '' : (row.quotaRemaining <= 0 ? 'gone' : ratio <= 0.2 ? 'low' : '')
      const rowClass = row.blocked
        ? 'ofmq-row ofmq-row-blocked'
        : (known && row.quotaRemaining <= 0 ? 'ofmq-row ofmq-row-exhausted' : 'ofmq-row')
      const account = row.account
      return createElement('div', { className: rowClass, title: row.lastError || undefined },
        createElement('div', { className: 'ofmq-line1' },
          createElement('span', { className: 'ofmq-model' }, row.name || row.model),
          row.lane ? createElement('span', { className: 'ofmq-lane' }, row.lane) : null,
          account !== null && account !== undefined && account.enabled === false
            ? createElement('span', { className: 'ofmq-lane', style: { opacity: 0.55 } }, t('已停用', 'disabled'))
            : null,
        ),
        createElement('div', { className: 'ofmq-line2' },
          createElement('span', { className: 'ofmq-prov' }, row.provider),
          known
            ? createElement('span', null, totalUnknown
                ? `${t('剩余', 'left')} ${formatNumber(row.quotaRemaining)} ${unitLabel(row.unit)}`
                : `剩余 ${formatNumber(row.quotaRemaining)} / ${formatNumber(row.quotaTotal)} ${unitLabel(row.unit)}`)
            : createElement('span', null, t('额度未知', 'quota unknown')),
        ),
        known && !totalUnknown
          ? createElement('div', { className: 'ofmq-bar' },
              createElement('div', { className: `ofmq-bar-fill ${fillClass}`, style: { width: `${Math.round(ratio * 100)}%` } }))
          : null,
        createElement('div', { className: 'ofmq-kv' },
          createElement('span', null, formatTokens(row)),
          createElement('span', null,
            row.blocked && row.blockedUntil
              ? `${t('冷却至', 'cooling until')} ${new Date(row.blockedUntil).toLocaleTimeString()}`
              : (row.lastUsedAt ? relativeTime(row.lastUsedAt) : '')),
        ),
        // 渠道账号：本机登录状态与昵称，便于判断「这个接口到底还通不通」。
        account !== null && account !== undefined
          ? createElement('div', { className: 'ofmq-kv' },
              createElement('span', null,
                `${t('账号', 'account')} ${account.count}${account.nickname ? ` · ${account.nickname}` : ''}`),
              createElement('span', null,
                account.expiresAt ? t('凭据过期', 'expires') + ' ' + relativeTime(account.expiresAt) : ''),
            )
          : null,
        row.lastError
          ? createElement('div', { className: 'ofmq-err' }, row.lastError.slice(0, 120))
          : null,
      )
    }

    function QuotaPanel({ visible }) {
      const { status, error, loading } = useQuotaStatus(visible)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [filter, setFilter] = useState('')
      // 模型级用量默认折叠：主视图是渠道账号余额。
      const [showModels, setShowModels] = useState(false)

      const rows = useMemo(() => {
        const all = Array.isArray(status?.endpoints) ? status.endpoints : []
        const needle = filter.trim().toLowerCase()
        const filtered = needle === '' ? all : all.filter(row =>
          String(row.model).toLowerCase().includes(needle)
          || String(row.provider).toLowerCase().includes(needle)
          || String(row.name ?? '').toLowerCase().includes(needle))
        // 有额度的排前面，冷却中的沉底。
        return filtered.slice().sort((a, b) => {
          if (a.blocked !== b.blocked) return a.blocked ? 1 : -1
          const ka = a.quotaKnown ? a.quotaRemaining / Math.max(1, a.quotaTotal) : 2
          const kb = b.quotaKnown ? b.quotaRemaining / Math.max(1, b.quotaTotal) : 2
          if (ka !== kb) return kb - ka
          return String(a.model).localeCompare(String(b.model))
        })
      }, [status, filter])

      const run = async (name, fn) => {
        setBusy(name)
        setNotice('')
        try {
          const result = await fn()
          setNotice(typeof result === 'string' ? result : t('完成', 'done'))
        } catch (error) {
          setNotice(`${t('失败', 'failed')}: ${error.message ?? error}`)
        } finally {
          setBusy('')
        }
      }

      const head = createElement('div', { className: 'ofmq-head' },
        createElement('span', { className: 'ofmq-title' }, t('接口额度', 'Endpoint quotas')),
        status === null ? null : createElement('span', { className: 'ofmq-badge' },
          `${status.totals?.known ?? 0}/${status.totals?.endpoints ?? 0}`),
        createElement('button', {
          className: 'ofmq-btn',
          disabled: busy !== '',
          title: t('从 Our Free Model 同步接口清单', 'Sync endpoint list from Our Free Model'),
          onClick: () => run('sync', async () => {
            const r = await postJson('sync')
            return r.ok ? t(`已同步 ${r.total} 条`, `synced ${r.total}`) : (r.reason ?? t('同步失败', 'sync failed'))
          }),
        }, busy === 'sync' ? '…' : t('同步', 'Sync')),
        createElement('button', {
          className: 'ofmq-btn',
          disabled: busy !== '',
          title: t('读取已登录渠道的真实剩余积分（走渠道包 credits.balances）', 'Read real channel balances (credits.balances)'),
          onClick: () => run('balances', async () => {
            const r = await postJson('balances')
            if (!r.ok) {
              const first = Array.isArray(r.results) ? r.results.find(item => item.ok !== true) : null
              return t(`余额读取失败：${first?.reason ?? '未知'}`, `balance read failed: ${first?.reason ?? 'unknown'}`)
            }
            const okRows = (r.results ?? []).filter(item => item.ok === true)
            return okRows.length > 0
              ? t(`已读取 ${okRows.length} 个渠道`, `read ${okRows.length} channels`)
              : t('没有可读余额的渠道', 'no readable channel')
          }),
        }, busy === 'balances' ? '…' : t('刷新余额', 'Balances')),
      )

      const controls = status === null ? null : createElement('div', null,
        createElement('label', { className: 'ofmq-switch' },
          createElement('input', {
            type: 'checkbox',
            checked: status.autoSwitch === true,
            onChange: event => run('toggle', async () => {
              const r = await postJson('settings', { autoSwitch: event.target.checked })
              return r.ok ? '' : t('保存失败', 'save failed')
            }),
          }),
          t('余额耗尽自动换接口（同名模型的其他接口优先）', 'Auto-switch on exhaustion (same model, other endpoint first)'),
        ),
        createElement('div', { className: 'ofmq-sum' },
          createElement('span', null, `${t('调用', 'calls')} ${formatNumber(status.totals?.calls ?? 0)}`),
          createElement('span', null, `${t('入', 'in')} ${formatNumber(status.totals?.input ?? 0)}`),
          createElement('span', null, `${t('出', 'out')} ${formatNumber(status.totals?.output ?? 0)}`),
          createElement('span', null, `${t('冷却', 'cooling')} ${status.totals?.blocked ?? 0}`),
        ),
        createElement('div', { className: 'ofmq-sum' },
          createElement('span', null, t('全部用尽则兜底', 'final fallback')),
          createElement('span', { className: 'ofmq-prov' },
            status.officialFallback ? `${status.officialFallback.provider}/${status.officialFallback.model}` : '—'),
        ),
      )

      // 主视图：已登录渠道的账号余额。余额属于渠道/账号，不属于模型。
      const channelCards = Array.isArray(status?.channels) ? status.channels : []
      const channelList = channelCards.length === 0
        ? createElement('div', { className: 'ofmq-empty' },
            t('本机还没有已登录的渠道账号。在 Our Free Model 的设置页登录后点「刷新余额」。',
              'No signed-in channel accounts yet. Sign in from Our Free Model, then press Balances.'))
        : createElement('div', { className: 'ofmq-list' },
            channelCards.map(card => createElement(ChannelCard, { key: card.provider, card })))

      // 次级视图：模型级用量（默认折叠——它回答的是「用了多少」，不是「还剩多少」）。
      const modelList = rows.length === 0
        ? null
        : createElement('div', null,
            createElement('div', { className: 'ofmq-section', style: { cursor: 'pointer' },
              onClick: () => setShowModels(value => !value) },
              `${showModels ? '▾' : '▸'} ${t('模型用量明细', 'per-model usage')} (${rows.length})`),
            showModels
              ? createElement('div', { className: 'ofmq-list' },
                  createElement('input', {
                    className: 'ofmq-btn',
                    style: { width: '100%', textAlign: 'left', padding: '3px 8px' },
                    placeholder: t('搜索模型 / 接口…', 'filter models…'),
                    value: filter,
                    onChange: event => setFilter(event.target.value),
                  }),
                  rows.map(row => createElement(QuotaRow, { key: row.key, row })),
                )
              : null,
          )

      const body = loading && status === null
        ? createElement('div', { className: 'ofmq-empty' }, t('读取中…', 'loading…'))
        : createElement('div', null, channelList, modelList)

      const recent = Array.isArray(status?.switches) && status.switches.length > 0
        ? createElement('div', null,
            createElement('div', { className: 'ofmq-section' }, t('最近切换', 'recent switches')),
            status.switches.slice(0, 5).map((item, index) =>
              createElement('div', { key: `${item.at}:${index}`, className: 'ofmq-kv' },
                createElement('span', { className: 'ofmq-prov' }, `${item.from} → ${item.to}`),
                createElement('span', null, relativeTime(item.at)),
              )),
          )
        : null

      const failures = Array.isArray(status?.failures) && status.failures.length > 0
        ? createElement('div', null,
            createElement('div', { className: 'ofmq-section' }, t('最近失败', 'recent failures')),
            status.failures.slice(0, 5).map((item, index) =>
              createElement('div', { key: `${item.at}:${index}`, className: 'ofmq-kv' },
                createElement('span', { className: 'ofmq-prov' }, `${item.provider}/${item.model}`),
                createElement('span', { style: { opacity: 0.8 } }, item.code),
              )),
          )
        : null

      return createElement('div', { className: 'ofmq-root' },
        head,
        controls,
        notice !== '' ? createElement('div', { className: 'ofmq-kv' }, createElement('span', null, notice)) : null,
        body,
        error !== '' && status !== null ? createElement('div', { className: 'ofmq-err' }, error) : null,
        recent,
        failures,
      )
    }

    /* ── 注册 ────────────────────────────────────────────────── */

    exports.inject = ['slots', 'sidebarRightTabs']

    exports.apply = function apply(ctx) {
      // 样式：一次注入，卸载时移除。
      ctx.effect(() => {
        if (typeof document === 'undefined' || document === null || typeof document.head === 'undefined') {
          return () => {}
        }
        const style = document.createElement('style')
        style.setAttribute('data-dsh-ofm-quota', 'styles')
        style.textContent = STYLES
        document.head.appendChild(style)
        return () => {
          if (style.parentNode) style.parentNode.removeChild(style)
        }
      }, 'dsh-ofm-quota: styles')

      const tabs = ctx.get('sidebarRightTabs', false)
      const slots = ctx.get('slots', false)
      if (tabs === undefined || tabs === null) return
      if (slots === undefined || slots === null) return

      ctx.effect(() => tabs.register({
        id: TAB_ID_PKG,
        kind: TAB_KIND,
        title: () => t('接口额度', 'Endpoint quotas'),
        // guide 条目 id 必填：缺了它注册不报错，但宿主会把 entryId: undefined
        // 传给 sidebar.right.tab.guide.entry 席位（静默降级）。
        guide: [{ id: TAB_ID_PKG, order: TAB_ORDER, title: () => t('接口额度', 'Endpoint quotas') }],
      }), 'dsh-ofm-quota: tab type')

      ctx.effect(() => slots.inject('sidebar.right.pane.tab', () =>
        slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID_PKG }, QuotaTabBody),
      ), 'dsh-ofm-quota: tab body')

      ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () =>
        slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID_PKG }, QuotaTabTitle),
      ), 'dsh-ofm-quota: tab title')
    }

    /** 原生 tab body 席位：适配成 { sessionId, visible } 契约。 */
    function QuotaTabBody(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      return createElement(QuotaPanel, { visible: info?.tab?.visible !== false })
    }

    /** 原生 tab title 席位：宿主给定标题优先，否则回退本插件文案。 */
    function QuotaTabTitle(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      return createElement('span', null, info?.tab?.title ?? t('接口额度', 'Endpoint quotas'))
    }

    exports.QuotaPanel = QuotaPanel
    exports.ChannelCard = ChannelCard
    /**
     * 供离线自检验证的内部工具。宿主不使用这些字段。
     *
     * 之所以要暴露 routeUrl：上一版自检靠「渲染组件 → 观察 fetch URL」来验证
     * 它，但 react stub 的 useEffect 是空函数，那条断言从未真正执行过。
     * 直接测纯函数才是可靠的。
     */
    exports.__internal = { routeUrl }
    return module.exports
  },
})
