/**
 * 修 captain.db 里已有的记录。
 *
 * 两件事:
 *   1. 补向量 —— 之前嵌入服务是坏的,vec 全是空的。没有向量,
 *      判重永远命中不了历史,于是相似的事件全都各存一份。
 *   2. 改 title —— 原来 title 就是 content 的前 60 字,7 条全都一样。
 *      现在 title 取短标签,content 保持整句。
 *
 * 只补,不改内容本身。删不删由舰长定。
 *
 * 用法: node tools/repair_captain.mjs [--dry]
 */
import { DatabaseSync } from 'node:sqlite'
import { createEmbedBridge } from '../lib/embed.js'
import { shortTitle, looksLikeFact } from '../lib/captain/quality.js'
import { vecToBlob } from '../lib/captain/engine.js'

const DRY = process.argv.includes('--dry')
const DB = 'C:\\Users\\34230\\.dsh\\dsh-plugin-life\\captain.db'

const db = new DatabaseSync(DB)
const rows = db.prepare('SELECT * FROM facts ORDER BY ts').all()

console.log('=== 现在的情况 ===')
console.log('  总条数:', rows.length)
console.log('  有向量的:', rows.filter((r) => r.vec).length)
console.log('  title 和 content 相同的:', rows.filter((r) => String(r.title) === String(r.content)).length)

console.log('\n=== 逐条体检 ===')
const bad = []
for (const r of rows) {
  const q = looksLikeFact(r.content ?? '')
  const same = String(r.title) === String(r.content)
  const tag = !q.ok ? '  ← 不合格(' + q.why + ')' : ''
  console.log(
    '  #' + String(r.id).padEnd(3) +
      (same ? ' title重复' : ' title已分开') +
      (r.vec ? ' 有向量' : ' 无向量') +
      tag,
  )
  console.log('      ' + String(r.content).replace(/\n/g, '⏎').slice(0, 70))
  if (!q.ok) bad.push({ ...r, why: q.why })
}

if (DRY) {
  console.log('\n(预演。加 --dry 去掉就是真改)')
  db.close()
  process.exit(0)
}

// ---- 补向量 ----
const needVec = rows.filter((r) => !r.vec)
if (needVec.length) {
  const bridge = createEmbedBridge({
    log: (m) => console.log('  [embed]', m),
    dataDir: 'C:\\Users\\34230\\.dsh\\dsh-plugin-life',
  })
  bridge.warm()
  const t0 = Date.now()
  while (!bridge.isReady() && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 300))
  if (!bridge.isReady()) {
    console.log('嵌入服务没起来,向量补不了')
    db.close()
    process.exit(1)
  }
  const vecs = await bridge.embed(needVec.map((r) => String(r.content ?? r.title)))
  const up = db.prepare('UPDATE facts SET vec = ? WHERE id = ?')
  let n = 0
  for (let i = 0; i < needVec.length; i++) {
    if (!vecs?.[i]) continue
    up.run(vecToBlob(vecs[i]), needVec[i].id)
    n++
  }
  console.log(`\n向量补了 ${n} 条`)
  bridge.dispose()
}

// ---- 改 title ----
const upTitle = db.prepare('UPDATE facts SET title = ? WHERE id = ?')
let m = 0
for (const r of rows) {
  const t = shortTitle(r.content ?? '')
  if (!t || t === r.title) continue
  upTitle.run(t, r.id)
  m++
}
console.log(`title 改了 ${m} 条`)

const after = db.prepare('SELECT * FROM facts ORDER BY ts').all()
console.log('\n=== 改完之后 ===')
console.log('  有向量的:', after.filter((r) => r.vec).length, '/', after.length)
console.log('  title 和 content 相同的:', after.filter((r) => String(r.title) === String(r.content)).length)
for (const r of after) {
  console.log('  #' + r.id + '  title=' + r.title)
  console.log('        content=' + String(r.content).replace(/\n/g, '⏎').slice(0, 60))
}

db.close()
