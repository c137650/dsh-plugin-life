/** 看 captain.db 里到底存了什么：title 和 content 是不是重复、有哪些像任务的条目。 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('C:\\Users\\34230\\.dsh\\dsh-plugin-life\\captain.db')
const rows = db.prepare('SELECT * FROM facts ORDER BY ts').all()

console.log('总共', rows.length, '条\n')

let same = 0
let truncated = 0
for (const r of rows) {
  const t = String(r.title ?? '')
  const c = String(r.content ?? '')
  const isSame = c === t
  const isPrefix = c.startsWith(t.replace(/…$/, ''))
  if (isSame) same++
  if (t.endsWith('…')) truncated++
  const when = new Date(Number(r.ts)).toLocaleString('zh-CN')
  console.log(
    '#' + String(r.id).padEnd(3) +
      when.padEnd(22) +
      'kind=' + String(r.kind).padEnd(11) +
      'degraded=' + String(r.degraded).padEnd(2) +
      '提及' + String(r.mention_count).padEnd(3),
  )
  console.log('   title  (' + t.length + '): ' + t)
  console.log('   content(' + c.length + '): ' + c.slice(0, 90).replace(/\n/g, '⏎'))
  console.log('   → ' + (isSame ? '完全相同' : isPrefix ? 'title 是 content 的前缀' : '两者不同'))
}
console.log('\ntitle 与 content 完全相同的:', same, '/', rows.length)
console.log('title 被截断(带 …)的:', truncated)

const deg = rows.filter((r) => Number(r.degraded) === 1)
console.log('degraded=1(退化写入)的:', deg.length)
for (const d of deg) console.log('   #' + d.id + ' ' + String(d.title).slice(0, 60))

db.close()
