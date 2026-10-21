/**
 * 离线校验浏览器半身：在假 ModuleLoader + 假 slots/sidebarRightTabs 上跑
 * client.js 的 apply，确认它注册了一个原生 tab 类型 + 两个 keyed 席位。
 *
 * 跑法：node scripts/client-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const registered = { tabs: [], slots: [] }
let entry = null

const reactStub = {
  createElement: () => null,
  useEffect: () => {},
  useMemo: fn => fn(),
  useRef: () => ({ current: true }),
  useState: value => [value, () => {}],
}

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      entry = definition.factory(() => reactStub)
    },
  },
}
globalThis.document = {
  head: { appendChild() {} },
  documentElement: { lang: 'zh' },
  // 反代目录前缀下的页面 base：routeUrl 必须相对它解析，而不是钉在 origin root。
  baseURI: 'https://example.test/dataops/proxy/3080/',
  createElement: () => ({ setAttribute() {}, style: {}, parentNode: { removeChild() {} } }),
}
// Node 内置的 navigator 是只读 getter，用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh' },
  writable: true,
  configurable: true,
})

// eval 而不是 import：client.js 是 ModuleLoader bundle，不是 ESM。
new Function(source)()

if (entry === null) throw new Error('client.js 未调用 __ModuleLoader__.load')
if (!Array.isArray(entry.inject)) throw new Error('client 必须声明 inject 数组')
if (typeof entry.apply !== 'function') throw new Error('client 必须导出 apply')

const slots = {
  inject(_seat, callback) {
    callback()
    return () => {}
  },
  register(descriptor, component) {
    registered.slots.push({ descriptor, component })
    return () => {}
  },
}

const tabs = {
  register(descriptor) {
    registered.tabs.push(descriptor)
    return () => {}
  },
}

const ctx = {
  effect(run) {
    run()
    return () => {}
  },
  get(name) {
    if (name === 'slots') return slots
    if (name === 'sidebarRightTabs') return tabs
    return undefined
  },
}

entry.apply(ctx)

// ── 断言 ────────────────────────────────────────────────────
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

assert(registered.tabs.length === 1, `应注册且仅注册一个 tab 类型，实际 ${registered.tabs.length}`)
const tab = registered.tabs[0]
assert(tab.id === 'dsh-ofm-quota', `tab id 应为包名，实际 ${tab.id}`)
assert(tab.kind === 'dsh-ofm-quota:panel', `tab kind 应为 ${tab.kind}`)
assert(Array.isArray(tab.guide) && tab.guide.length === 1, 'guide 条目必填（缺了宿主会静默降级）')
assert(typeof tab.guide[0].id === 'string' && tab.guide[0].id !== '', 'guide 条目必须有 id')
assert(typeof tab.title === 'function', 'title 应为函数以跟随语言')
assert(typeof tab.title() === 'string' && tab.title() !== '', 'title 必须返回非空字符串')

const seats = registered.slots.map(item => item.descriptor.name).sort()
assert(seats.length === 2, `应注册两个席位，实际 ${seats.join(',')}`)
assert(seats[0] === 'sidebar.right.pane.tab', `缺少 body 席位：${seats.join(',')}`)
assert(seats[1] === 'sidebar.right.pane.tab.title', `缺少 title 席位：${seats.join(',')}`)
for (const item of registered.slots) {
  assert(item.descriptor.key === 'dsh-ofm-quota', `席位 key 必须与 tab id 一致：${item.descriptor.key}`)
  assert(typeof item.component === 'function', '席位必须注册组件')
}

// 组件在最小 props 下不得抛错（宿主会传 { useTabInfo } / sessionId）。
const body = registered.slots.find(item => item.descriptor.name === 'sidebar.right.pane.tab').component
const title = registered.slots.find(item => item.descriptor.name === 'sidebar.right.pane.tab.title').component
body({ useTabInfo: () => ({ tab: { visible: false } }), sessionId: 's1' })
body({ sessionId: 's1' })
title({ useTabInfo: () => ({ tab: { title: 'x' } }) })
title({})

// ── 路由 URL：绝不能带前导斜杠 ───────────────────────────────
//
// 这条锁住一个真实部署缺陷：`fetch('/api/ofm-quota/...')` 钉死在 origin root，
// 反代目录前缀下 404、Electron 的 dsh-app:// 壳下跨源。routeUrl 必须相对
// document.baseURI 解析。
//
// 上一版这里是**无效断言**：它靠「渲染组件 → useEffect 发请求」观察 URL，
// 但 react stub 的 useEffect 是空函数，于是 requested 恒为空数组，
// `if (requested.length > 0)` 从不成立，这条检查从未验证过任何东西
// （死代码审计 M-12）。
//
// 现在改成直接验证 routeUrl 的行为：从 bundle 里取出这个纯函数调用，
// 不依赖 React 渲染。为此 client.js 在 exports 上暴露了内部工具函数。
const { routeUrl } = entry.__internal ?? {}
if (typeof routeUrl !== 'function') throw new Error('client 必须暴露 routeUrl 供测试')

{
  const url = routeUrl('status')
  assert(!url.startsWith('/'), `路由 URL 不得以斜杠开头，实际 ${url}`)
  assert(url.startsWith('https://example.test/dataops/proxy/3080/api/ofm-quota/'),
    `路由 URL 必须相对 document.baseURI 解析，实际 ${url}`)
  // 前导斜杠的 pathname 也必须被正确拼到 base 之后，而不是顶掉目录前缀。
  const withSlash = routeUrl('/status')
  assert(withSlash.startsWith('https://example.test/dataops/proxy/3080/api/ofm-quota/'),
    `带前导斜杠的入参也必须剥掉，实际 ${withSlash}`)
  // 反向对照：以 base 为 null 时应退回相对路径（不抛错）。
  const savedBase = document.baseURI
  document.baseURI = ''
  try {
    const fallback = routeUrl('status')
    assert(!fallback.startsWith('/'), `无 baseURI 时也必须返回相对路径，实际 ${fallback}`)
  } finally {
    document.baseURI = savedBase
  }
}

console.log('client-test PASS')
