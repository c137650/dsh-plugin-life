/**
 * 删掉 captain.db 里不合格的记录。
 *
 * 判据用 lib/captain/quality.js 的同一套 —— 以后新写进来的也要过这道闸,
 * 这里只是把历史上漏网的清掉。
 *
 * 用法: node tools/prune_captain.mjs [--dry]
 */
import { DatabaseSync } from 'node:sqlite'
import { looksLikeFact } from '../lib/captain/quality.js'

const DRY = process.argv.includes('--dry')
const DB = 'C:\\Users\\34230\\.dsh\\dsh-plugin-life\\captain.db'

const db = new DatabaseSync(DB)
const rows = db.prepare('SELECT * FROM facts ORDER BY ts').all()

const bad = rows.filter((r) => !looksLikeFact(r.content ?? '').ok)

console.log('=== 不合格的 ===')
if (!bad.length) console.log('  (没有)')
for (const r of bad) {
  const q = looksLikeFact(r.content ?? '')
  console.log('  #' + r.id + ' [' + q.why + '] ' + String(r.content).replace(/\n/g, '⏎').slice(0, 60))
}

if (DRY) {
  console.log('\n(预演)')
  db.close()
  process.exit(0)
}

const del = db.prepare('DELETE FROM facts WHERE id = ?')
const delM = db.prepare('DELETE FROM mentions WHERE fact_id = ?')
for (const r of bad) {
  delM.run(r.id)
  del.run(r.id)
}
console.log('\n删了', bad.length, '条')

const left = db.prepare('SELECT COUNT(*) c FROM facts').get().c
console.log('现在剩', left, '条')
for (const r of db.prepare('SELECT id, title FROM facts ORDER BY ts').all()) {
  console.log('  #' + r.id + ' ' + r.title)
}
db.close()
