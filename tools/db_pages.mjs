/** 文件大小 vs 真实内容 vs 空闲页 —— 解释"压了但文件没变小"。 */
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { contentBytes } from '../lib/db.js'

const DB = 'C:\\Users\\34230\\.dsh\\dsh-plugin-life\\life.db'
const db = new DatabaseSync(DB)

const fileBytes = statSync(DB).size
const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size)
const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count)
const freeList = Number(db.prepare('PRAGMA freelist_count').get().freelist_count)
const total = contentBytes(db)
const comp = contentBytes(db, { onlyCompressible: true })

const rows = db.prepare('SELECT COUNT(*) c FROM events').get().c
const stripped = db.prepare('SELECT COUNT(*) c FROM events WHERE content IS NULL').get().c
const withDetail = db.prepare('SELECT COUNT(*) c FROM events WHERE detail IS NOT NULL').get().c

const kb = (n) => (n / 1024).toFixed(1) + ' KB'

console.log('=== 文件 ===')
console.log('  磁盘大小        ', kb(fileBytes))
console.log('  页大小 × 页数   ', pageSize + ' × ' + pageCount, '=', kb(pageSize * pageCount))
console.log('  空闲页          ', freeList, '页 =', kb(freeList * pageSize), '（占文件 ' + ((freeList / pageCount) * 100).toFixed(1) + '%）')

console.log('\n=== 真实内容 ===')
console.log('  全量内容        ', kb(total))
console.log('  可压缩内容      ', kb(comp), '（压缩看的就是这个）')
console.log('  事件数          ', rows)
console.log('  正文已清空      ', stripped, '条')
console.log('  detail 还在的   ', withDetail, '条')

console.log('\n=== 结论 ===')
console.log('  文件里' + ((freeList / pageCount) * 100).toFixed(0) + '% 是压缩之后腾出来的空闲页 —— SQLite 留着将来复用,不会还给磁盘。')
console.log('  所以文件大小不变是正常的；要看"压没压"，看可压缩内容。')

db.close()
