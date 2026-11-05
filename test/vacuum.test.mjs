/**
 * SQLite 的"文件大小"和"真实内容"不是一回事 —— 这条必须固化成测试。
 *
 * 舰长问过:"life.db 大小没有变,理论上不是应该自动压缩了吗?"
 * 压缩确实发生了(可压缩内容 237 KB → 40 KB),但文件一动不动 ——
 * SQLite 把腾出来的页放进空闲页列表留着复用,不还给磁盘。
 *
 * 所以:
 *   - 判断"压没压"只看可压缩内容,不看文件大小
 *   - 想让文件真的变小,只能 VACUUM
 *
 * 用法: node test/vacuum.test.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS  ' + name)
  else {
    failures++
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''))
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-vacuum-'))
const file = join(dir, 't.db')
const kb = (n) => (n / 1024).toFixed(1)

const db = new DatabaseSync(file)
db.exec('PRAGMA journal_mode = WAL')
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)')

// 塞 4 MB 进去
const big = 'x'.repeat(4000)
const ins = db.prepare('INSERT INTO t (body) VALUES (?)')
for (let i = 0; i < 1000; i++) ins.run(big)

const fullSize = statSync(file).size
const fullPages = Number(db.prepare('PRAGMA page_count').get().page_count)
console.log('=== 写满 ===')
console.log('  文件', kb(fullSize), 'KB |', fullPages, '页')

console.log('\n=== 删掉大部分数据 ===')
db.prepare('DELETE FROM t WHERE id > 20').run()
const afterDeleteSize = statSync(file).size
const freePages = Number(db.prepare('PRAGMA freelist_count').get().freelist_count)
const liveBytes = Number(db.prepare("SELECT COALESCE(SUM(length(body)),0) b FROM t").get().b)

console.log('  文件', kb(afterDeleteSize), 'KB | 空闲', freePages, '页 | 真实内容', kb(liveBytes), 'KB')
check('数据真的少了', liveBytes < fullSize / 10, kb(liveBytes))
check('文件没有变小(这是 SQLite 的正常行为)', afterDeleteSize >= fullSize * 0.9, kb(afterDeleteSize))
check('有大量空闲页', freePages > 0, String(freePages))

console.log('\n=== VACUUM 之后 ===')
db.exec('VACUUM')
// WAL 模式:VACUUM 的结果先落在 -wal 文件里,主库要 checkpoint 才真的截短。
// 这一步不做的话,文件看起来完全没变小 —— 实测 4008 KB 纹丝不动。
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
const afterVacuumSize = statSync(file).size
const afterFree = Number(db.prepare('PRAGMA freelist_count').get().freelist_count)
console.log('  文件', kb(afterVacuumSize), 'KB | 空闲', afterFree, '页')
check('文件明显变小', afterVacuumSize < afterDeleteSize * 0.5, kb(afterDeleteSize) + ' → ' + kb(afterVacuumSize))
check('空闲页清零', afterFree === 0, String(afterFree))

// 数据还在
const left = Number(db.prepare('SELECT COUNT(*) c FROM t').get().c)
check('数据还在(VACUUM 不丢数据)', left === 20, String(left))

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
if (failures) process.exit(1)
