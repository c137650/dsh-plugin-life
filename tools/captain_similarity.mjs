/** 库里那几条两两有多像 —— 找出"相似但都入库了"的。 */
import { DatabaseSync } from 'node:sqlite'
import { blobToVec } from '../lib/captain/engine.js'

const db = new DatabaseSync('C:\\Users\\34230\\.dsh\\dsh-plugin-life\\captain.db')
const rows = db.prepare('SELECT id, ts, kind, title, content, vec FROM facts ORDER BY ts').all()

function cos(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return -1
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return d
}

console.log('向量情况:')
for (const r of rows) {
  const v = blobToVec(r.vec)
  console.log('  #' + String(r.id).padEnd(3) + ' vec=' + (v ? v.length + ' 维' : '没有'))
}

const pairs = []
for (let i = 0; i < rows.length; i++) {
  for (let j = i + 1; j < rows.length; j++) {
    pairs.push({ a: rows[i], b: rows[j], s: cos(blobToVec(rows[i].vec), blobToVec(rows[j].vec)) })
  }
}
pairs.sort((x, y) => y.s - x.s)

console.log('\n=== 两两相似度(降序)===')
console.log('  阈值 0.65: >=0.65 判为"同一件事",只记提及不重复入库\n')
for (const p of pairs) {
  if (p.s < 0.2) break
  const mark = p.s >= 0.65 ? '← 会被判为同一件事' : p.s >= 0.55 ? '← 偏近,够不到阈值' : ''
  console.log('  #' + p.a.id + ' × #' + p.b.id + '  ' + p.s.toFixed(3) + '  ' + mark)
  console.log('      ' + String(p.a.title).slice(0, 46))
  console.log('      ' + String(p.b.title).slice(0, 46))
}

console.log('\n=== 按主题看 ===')
for (const r of rows) {
  const t = String(r.title)
  const topic = /RoboMaster|装甲板|工业相机|视觉|语音/.test(t)
  console.log('  #' + String(r.id).padEnd(3) + (topic ? ' [同主题]' : '          ') + ' kind=' + String(r.kind).padEnd(9) + ' ' + t.slice(0, 40))
}
db.close()
