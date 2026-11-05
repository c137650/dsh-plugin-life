/**
 * 清掉当前的永久记忆。
 *
 * 做什么:
 *   1. 把 life.db / keepers.md / captain.db 备份到 .dsh 下一个带时间戳的目录
 *   2. 记下要删的是哪几条(输出出来,留个底)
 *   3. 删掉 events 里 keep = 1 的行
 *   4. 删掉 keepers.md
 *
 * 不动 reading/ 里的笔记 —— 那是活动存下来的原始材料,
 * 和"永久记忆"是两回事。要一起清再说一声。
 *
 * 用法: node tools/clear_keepers.mjs [--apply]
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const APPLY = process.argv.includes('--apply')
const HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const DATA = path.join(HOME, 'dsh-plugin-life')
const DB = path.join(DATA, 'life.db')

// 安全检查:绝对路径必须真的是那个库
if (!path.resolve(DB).endsWith(path.join('dsh-plugin-life', 'life.db'))) {
  console.error('路径不对,停下:', DB)
  process.exit(1)
}
if (!existsSync(DB)) {
  console.error('找不到 life.db:', DB)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupDir = path.join(HOME, 'life-backup-' + stamp)

const db = new DatabaseSync(DB)
db.exec('PRAGMA busy_timeout = 5000')

const keepers = db.prepare('SELECT id, ts, category, title, importance FROM events WHERE keep = 1 ORDER BY id').all()

console.log('=== 现在被标成永久记忆的 ===')
if (!keepers.length) {
  console.log('  (没有)')
} else {
  for (const k of keepers) {
    console.log(
      '  #' + String(k.id).padEnd(3) +
        new Date(Number(k.ts)).toLocaleString('zh-CN').padEnd(22) +
        'imp=' + String(k.importance).padEnd(5) +
        '[' + (k.category ?? '-') + '] ' + String(k.title).slice(0, 40),
    )
  }
}

if (!APPLY) {
  console.log('\n(这是预演。加 --apply 才会真的备份并删除。)')
  db.close()
  process.exit(0)
}

// ---- 备份 ----
mkdirSync(backupDir, { recursive: true })
for (const name of ['life.db', 'keepers.md', 'captain.db']) {
  const from = path.join(DATA, name)
  if (existsSync(from)) {
    copyFileSync(from, path.join(backupDir, name))
    console.log('  备份', name)
  }
}
writeFileSync(
  path.join(backupDir, 'deleted-keepers.txt'),
  keepers
    .map((k) => `#${k.id}\t${new Date(Number(k.ts)).toISOString()}\t${k.category ?? '-'}\timp=${k.importance}\t${k.title}`)
    .join('\n') + '\n',
  'utf8',
)

// ---- 删除 ----
const del = db.prepare('DELETE FROM events WHERE keep = 1').run()
console.log('\n=== 已删除 ===')
console.log('  事件行:', del.changes, '条')

const left = db.prepare('SELECT COUNT(*) c FROM events WHERE keep = 1').get().c
const maxImp = db.prepare('SELECT MAX(importance) m FROM events WHERE keep = 0').get().m
console.log('  剩下 keep=1 的:', left)
console.log('  剩下事件里最高的 importance:', maxImp)
db.close()

const km = path.join(DATA, 'keepers.md')
if (existsSync(km)) {
  rmSync(km)
  console.log('  keepers.md 已删除')
} else {
  console.log('  keepers.md 本来就不在')
}

console.log('\n备份在:', backupDir)
