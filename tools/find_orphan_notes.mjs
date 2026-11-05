/**
 * 找出"已经被压缩掉的事件"曾经对应的笔记文件。
 *
 * 为什么要单独做:压缩时 detail 会被清空,清空之后就看不出这条事件
 * 当初存了哪些笔记了。只能从备份库(压缩前的那份)里还原。
 *
 * 用法: node tools/find_orphan_notes.mjs <备份库路径> [--delete]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const backupDbPath = process.argv[2]
const DELETE = process.argv.includes('--delete')
if (!backupDbPath || !existsSync(backupDbPath)) {
  console.error('用法: node tools/find_orphan_notes.mjs <备份 life.db> [--delete]')
  process.exit(2)
}

const HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const DATA = path.join(HOME, 'dsh-plugin-life')
const READING = path.join(DATA, 'reading')
const LIVE_DB = path.join(DATA, 'life.db')

const files = new Set(readdirSync(READING).filter((n) => n.endsWith('.md')))
console.log('reading 目录里的笔记:', files.size, '个')

// 备份库里哪些事件被压缩了:正文已经没了的那些
const bk = new DatabaseSync(backupDbPath)
const compressed = bk
  .prepare('SELECT id, title, detail FROM events WHERE detail IS NOT NULL')
  .all()
  .filter((r) => {
    // 只看现在已经被压缩掉的(拿当前库对比)
    return true
  })
bk.close()

const live = new DatabaseSync(LIVE_DB)
const stillFull = new Set(
  live
    .prepare('SELECT id FROM events WHERE content IS NOT NULL')
    .all()
    .map((r) => Number(r.id)),
)
live.close()

// 被压缩过的事件 = 不在 stillFull 里的
const gone = compressed.filter((r) => !stillFull.has(Number(r.id)))
console.log('被压缩掉的事件:', gone.length, '条')

// 从 detail 里把文件路径捞出来
const referenced = new Set()
const grab = (obj) => {
  if (!obj) return
  if (typeof obj === 'string') {
    const m = obj.match(/([0-9]{4}-[0-9]{2}-[0-9]{2}-[^"\\]+?\.md)/g)
    if (m) for (const x of m) referenced.add(path.basename(x))
    return
  }
  if (Array.isArray(obj)) return obj.forEach(grab)
  if (typeof obj === 'object') return Object.values(obj).forEach(grab)
}

for (const r of gone) {
  try {
    grab(JSON.parse(r.detail))
  } catch {
    grab(String(r.detail))
  }
}

console.log('这些事件的 detail 里提到过的笔记:', referenced.size, '个')

const orphans = [...files].filter((n) => referenced.has(n))
console.log('\n=== 已经没有事件引用的笔记 ===')
for (const n of orphans) console.log('  ' + n)
console.log('共', orphans.length, '个')

if (!DELETE) {
  console.log('\n(预演。加 --delete 会先备份再删。)')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupDir = path.join(HOME, 'reading-backup-' + stamp)
mkdirSync(backupDir, { recursive: true })
for (const n of orphans) {
  copyFileSync(path.join(READING, n), path.join(backupDir, n))
}
console.log('\n备份到:', backupDir)

let removed = 0
for (const n of orphans) {
  try {
    unlinkSync(path.join(READING, n))
    removed++
  } catch {
    /* ignore */
  }
}
console.log('已删除:', removed, '个')
