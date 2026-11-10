/**
 * 空闲页要收 —— 测试。
 *
 * 舰长问过:"压缩了为什么数据库大小不变?"
 *
 * 答案:SQLite 清空数据之后,腾出来的页进"空闲页列表"留着复用,
 * **文件不会变小**。空着的页要 VACUUM 才还回磁盘。
 *
 * 这条测试盯三件事:
 *   1. 删/清数据之后文件不变小(这是 SQLite 的行为,不是 bug)
 *   2. 空闲页会被算出来,能据此判断"值不值得收"
 *   3. VACUUM + checkpoint(TRUNCATE) 之后文件真的变小、空闲页清零
 *
 * 用法: node test/reclaim.test.mjs
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

const dir = mkdtempSync(join(tmpdir(), 'dsh-reclaim-'))
const file = join(dir, 't.db')
const kb = (n) => (n / 1024).toFixed(1)

const db = new DatabaseSync(file)
db.exec('PRAGMA journal_mode = WAL')
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)')
const ins = db.prepare('INSERT INTO t (body) VALUES (?)')
for (let i = 0; i < 800; i++) ins.run('x'.repeat(4000))

const pageCount = () => Number(db.prepare('PRAGMA page_count').get().page_count)
const freeCount = () => Number(db.prepare('PRAGMA freelist_count').get().freelist_count)

console.log('=== 写满 ===')
console.log('  文件', kb(statSync(file).size), 'KB |', pageCount(), '页')
const full = statSync(file).size

console.log('\n=== 清掉大部分正文(置空) ===')
// 注意:UPDATE 置空**不会**产生空闲页 ——
// 行还在,只是列没了,空间还在页内。这种"空"是收不回来的,
// 因为 SQLite 认为那些页还被表占着。
db.prepare('UPDATE t SET body = NULL WHERE id > 10').run()
const afterUpdate = statSync(file).size
console.log('  文件', kb(afterUpdate), 'KB | 空闲', freeCount(), '页')
check('文件没变小(SQLite 就是这样)', afterUpdate >= full * 0.9, kb(afterUpdate))
check('置空不产生空闲页(空间还在页内)', freeCount() === 0, String(freeCount()))

console.log('\n=== 删掉大部分行(这时才有空闲页) ===')
db.prepare('DELETE FROM t WHERE id > 10').run()
const afterDelete = statSync(file).size
console.log('  文件', kb(afterDelete), 'KB | 空闲', freeCount(), '页')
check('文件还是没变小', afterDelete >= full * 0.9, kb(afterDelete))
check('空闲页被算出来了', freeCount() > 0, String(freeCount()))

console.log('\n=== 判断值不值得收 ===')
const pages = pageCount()
const worth = freeCount() >= Math.max(4, Math.ceil(pages * 0.1))
check('空闲页过半,该收', worth === true, freeCount() + '/' + pages)

console.log('\n=== 收 ===')
db.exec('VACUUM')
// WAL 模式:VACUUM 的结果先落在 -wal 里,主库要 checkpoint 才真的截短。
// 少了这一步,文件大小纹丝不动 —— 实测 4008 KB → 4008 KB。
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
const afterVacuum = statSync(file).size
console.log('  文件', kb(afterVacuum), 'KB | 空闲', freeCount(), '页')
check('文件明显变小', afterVacuum < afterDelete * 0.6, kb(afterDelete) + ' → ' + kb(afterVacuum))
check('空闲页清零', freeCount() === 0, String(freeCount()))
check('数据没丢', Number(db.prepare('SELECT COUNT(*) c FROM t').get().c) === 10)

console.log('\n=== 空闲页很少的时候不该折腾 ===')
const small = freeCount()
const worth2 = small >= Math.max(4, Math.ceil(pageCount() * 0.1))
check('刚收完不值得再收', worth2 === false, small + '/' + pageCount())

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
if (failures) process.exit(1)
