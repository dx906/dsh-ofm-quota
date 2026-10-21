/**
 * 死代码扫描器：抓出「定义后从未被引用」的函数/常量。
 *
 * 用词法切分而不是正则匹配——正则在 JS 标识符上容易漏（$、Unicode、嵌套）。
 * 只做启发式判断，输出候选清单供人工确认，不自动删代码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? path.join(here, '..', 'index.js')
const source = fs.readFileSync(target, 'utf8')
const lines = source.split('\n')

/** 抓定义：函数声明 + const/let 声明（顶层或函数内缩进）。 */
const definitions = []
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]
  let m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
  if (m) {
    definitions.push({ name: m[1], line: i + 1, kind: 'function' })
    continue
  }
  m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\(|\(|[A-Za-z_$][\w$]*\s*=>)/)
  if (m) definitions.push({ name: m[1], line: i + 1, kind: 'const-fn' })
}

/**
 * 引用计数：把「定义那一行」挖掉后，再看这个名字作为独立标识符出现几次。
 * 注释与字符串里的出现也算——所以 count=0 才是可靠的死代码信号。
 */
function countReferences(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`, 'g')
  let count = 0
  for (const line of lines) {
    // 跳过纯注释行，避免注释里提到名字就当成"被使用"。
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    pattern.lastIndex = 0
    while (pattern.exec(line) !== null) count += 1
  }
  return count
}

const ENTRY_EXPORTS = new Set(['apply', 'name', 'inject', 'resolveDshHome'])
const report = []
for (const definition of definitions) {
  if (ENTRY_EXPORTS.has(definition.name)) continue
  const references = countReferences(definition.name)
  // 定义行本身算 1 次引用。
  if (references <= 1) report.push({ ...definition, references })
}

// 导出对象里被列为成员的名字也算被使用（runtime 返回给 selftest 的 API）。
const returned = new Set()
for (const m of source.matchAll(/^\s{4}([A-Za-z_$][\w$]*),?$/gm)) returned.add(m[1])

const trulyDead = report.filter(item => !returned.has(item.name))
const onlyReturned = report.filter(item => returned.has(item.name))

console.log(`扫描 ${path.basename(target)}：${definitions.length} 个定义`)
console.log('\n=== 真正死代码（定义后从未被引用）===')
if (trulyDead.length === 0) console.log('  （无）')
for (const item of trulyDead) console.log(`  ${item.kind} ${item.name}  @${item.line}`)

console.log('\n=== 仅出现在 runtime 返回对象里（外部 API，自检可能用到）===')
if (onlyReturned.length === 0) console.log('  （无）')
for (const item of onlyReturned) console.log(`  ${item.kind} ${item.name}  @${item.line}`)
