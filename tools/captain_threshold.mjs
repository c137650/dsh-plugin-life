/**
 * 用真库里的实际内容,验判重阈值还合不合适。
 *
 * 之前向量一直是空的,所以判重从来没跑过 ——
 * 阈值 0.65 是在"手挑的 30 对中文句"上量的,不是在这个库的真实数据上量的。
 * 现在嵌入服务修好了,拿真数据重新量一遍。
 */
import { DatabaseSync } from 'node:sqlite'
import { createEmbedBridge } from '../lib/embed.js'

const db = new DatabaseSync('C:\\Users\\34230\\.dsh\\dsh-plugin-life\\captain.db')
const rows = db.prepare('SELECT id, title, content FROM facts ORDER BY ts').all()

const bridge = createEmbedBridge({
  log: (m) => console.log('[log]', m),
  dataDir: 'C:\\Users\\34230\\.dsh\\dsh-plugin-life',
})
bridge.warm()
const t0 = Date.now()
while (!bridge.isReady() && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 300))
if (!bridge.isReady()) {
  console.log('嵌入服务没起来')
  process.exit(1)
}

const vecs = await bridge.embed(rows.map((r) => String(r.content ?? r.title)))
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)

console.log('\n=== 两两相似度(真库数据)===')
const pairs = []
for (let i = 0; i < rows.length; i++) {
  for (let j = i + 1; j < rows.length; j++) {
    pairs.push({ a: rows[i], b: rows[j], s: cos(vecs[i], vecs[j]) })
  }
}
pairs.sort((x, y) => y.s - x.s)
for (const p of pairs) {
  if (p.s < 0.3) break
  const mark = p.s >= 0.65 ? ' ← 会判为同一件事(只记提及)' : p.s >= 0.55 ? ' ← 偏近,够不到阈值' : ''
  console.log('  #' + p.a.id + ' × #' + p.b.id + '  ' + p.s.toFixed(3) + mark)
  console.log('      ' + String(p.a.title).slice(0, 46))
  console.log('      ' + String(p.b.title).slice(0, 46))
}

console.log('\n=== 阈值怎么定 ===')
for (const t of [0.5, 0.55, 0.6, 0.65, 0.7]) {
  const n = pairs.filter((p) => p.s >= t).length
  console.log('  >= ' + t.toFixed(2) + ' : ' + n + ' 对会被判为同一件事')
}

bridge.dispose()
db.close()
process.exit(0)
