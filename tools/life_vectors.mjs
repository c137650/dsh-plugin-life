/** life.db 那边有没有存向量 —— 用来判断是嵌入服务的问题还是 captain 路径的问题。 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('C:\\Users\\34230\\.dsh\\dsh-plugin-life\\life.db')
const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name)
console.log('events 表:', cols.join(', '))

const total = Number(db.prepare('SELECT COUNT(*) c FROM events').get().c)
console.log('事件总数:', total)

for (const c of ['fingerprint', 'intent']) {
  if (!cols.includes(c)) continue
  const n = Number(
    db.prepare(`SELECT COUNT(*) c FROM events WHERE ${c} IS NOT NULL AND ${c} <> ''`).get().c,
  )
  console.log(`  ${c} 有值的行:`, n)
  const rows = db
    .prepare(`SELECT id, ${c} v FROM events WHERE ${c} IS NOT NULL AND ${c} <> '' LIMIT 4`)
    .all()
  for (const r of rows) console.log('    #' + r.id + ' ' + String(r.v).slice(0, 60))
}

db.close()
