/**
 * 立刻跑一次压缩。
 *
 * 平时压缩是在写完一条事件之后顺手触发的,只在"可压缩内容超过上限"时才动。
 * 这个脚本用来手动催一次 —— 比如刚把上限调低,想马上看到效果。
 *
 * DSH 正在跑也没关系:库是 WAL 模式,第二个连接可以写。
 * 但仍然设了 busy_timeout,遇到锁就等,不硬来。
 *
 * 用法: node tools/compress_now.mjs [上限KB,默认 200] [--vacuum]
 *
 * --vacuum:压缩之后把空闲页还给磁盘(文件会变小)。
 *           不给这个参数的话,压缩照样发生,但文件大小不变 ——
 *           SQLite 把腾出来的页留着复用,这是它的正常行为。
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'

import { compressIfNeeded } from '../lib/compress.js'
import { contentBytes } from '../lib/db.js'
import { removeReadingFiles } from '../lib/reading.js'

const LIMIT_KB = Number(process.argv[2] ?? 200)
const DO_VACUUM = process.argv.includes('--vacuum')
const HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const DB = path.join(HOME, 'dsh-plugin-life', 'life.db')

if (!existsSync(DB)) {
  console.error('找不到 life.db:', DB)
  process.exit(1)
}

const limitBytes = LIMIT_KB * 1024
const db = new DatabaseSync(DB)
db.exec('PRAGMA busy_timeout = 8000')

const before = contentBytes(db, { onlyCompressible: true })
const beforeAll = contentBytes(db)
const rowsBefore = db.prepare('SELECT COUNT(*) c FROM events').get().c

console.log('=== 压缩前 ===')
console.log('  可压缩内容:', (before / 1024).toFixed(1), 'KB / 上限', LIMIT_KB, 'KB')
console.log('  全量内容:', (beforeAll / 1024).toFixed(1), 'KB')
console.log('  事件数:', rowsBefore)

const r = compressIfNeeded(db, { limitBytes })

// 删掉这些事件的源笔记。
//
// 插件里这一步在 recordEvent 里做(compressIfNeeded 只把"该删哪些"报出来)。
// 手动跑的时候必须自己补上,否则事件被剥了、笔记却留着 —— 一堆没人引用的孤儿文件。
let freed = { removed: 0, freedBytes: 0 }
if (r.compressed && Array.isArray(r.releasedFiles) && r.releasedFiles.length) {
  freed = removeReadingFiles(path.join(HOME, 'dsh-plugin-life', 'reading'), r.releasedFiles)
}

console.log('\n=== 结果 ===')
console.log('  触发了吗:', r.compressed)
console.log('  可压缩内容:', (r.before / 1024).toFixed(1), '→', (r.after / 1024).toFixed(1), 'KB')
console.log('  被剥落:', r.stripped, '条')
console.log('  完整保留(前 10%):', r.kept, '条')
console.log('  彻底删除(第三次压缩):', r.deleted ?? 0, '条')
console.log('  释放的笔记文件:', (r.releasedFiles ?? []).length, '个 → 实际删掉', freed.removed, '个(' + (freed.freedBytes / 1024).toFixed(1) + ' KB)')

const rowsAfter = db.prepare('SELECT COUNT(*) c FROM events').get().c
const c1 = db.prepare('SELECT COUNT(*) c FROM events WHERE compressed = 1').get().c
const c2 = db.prepare('SELECT COUNT(*) c FROM events WHERE compressed = 2').get().c
const noBody = db.prepare('SELECT COUNT(*) c FROM events WHERE content IS NULL').get().c
console.log('\n=== 压缩后 ===')
console.log('  事件数:', rowsAfter)
console.log('  压缩过 1 次:', c1, '| 压缩过 2 次:', c2)
console.log('  正文已清空:', noBody)
console.log('  可压缩内容:', (contentBytes(db, { onlyCompressible: true }) / 1024).toFixed(1), 'KB')

// 收空间。
//
// SQLite 清空数据之后,腾出来的页只进"空闲页列表"留着复用,文件不会变小。
// 想让它真的小下去只能 VACUUM —— 整库重写一遍,只留活跃的页。
if (DO_VACUUM) {
  const beforeFile = statSync(DB).size
  const pages = Number(db.prepare('PRAGMA page_count').get().page_count)
  const free = Number(db.prepare('PRAGMA freelist_count').get().freelist_count)
  console.log('\n=== VACUUM 前 ===')
  console.log('  文件:', (beforeFile / 1024).toFixed(1), 'KB |', pages, '页,其中空闲', free, '页')
  db.exec('VACUUM')
  // WAL 模式:VACUUM 的结果先落在 -wal 里,主库要 checkpoint 才真的截短。
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* 不是 WAL 模式 */
  }
  const afterFile = statSync(DB).size
  console.log('=== VACUUM 后 ===')
  console.log('  文件:', (afterFile / 1024).toFixed(1), 'KB(省了 ' + ((beforeFile - afterFile) / 1024).toFixed(1) + ' KB)')
  console.log('  页数:', db.prepare('PRAGMA page_count').get().page_count, '空闲', db.prepare('PRAGMA freelist_count').get().freelist_count)
}

db.close()
