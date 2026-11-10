/**
 * 沙箱验证:压缩 + 自动收空间,整条链路跑一遍。
 *
 * 用真库的副本,灌一些大事件把它顶过 200 KB,然后跑 tools/compress_now.mjs。
 * 全程在临时目录里,不碰 C:\Users\34230\.dsh\dsh-plugin-life。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, copyFileSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const REAL = 'C:\\Users\\34230\\.dsh\\dsh-plugin-life\\life.db'
const root = mkdtempSync(join(tmpdir(), 'dsh-sandbox-'))
const dataDir = join(root, 'dsh-plugin-life')
mkdirSync(dataDir, { recursive: true })
mkdirSync(join(dataDir, 'reading'), { recursive: true })
const dbFile = join(dataDir, 'life.db')
copyFileSync(REAL, dbFile)

const kb = (n) => (n / 1024).toFixed(1)

// 灌事件:每条 6 KB detail,40 条 ≈ 240 KB
// day / seq / kind 是 NOT NULL,得给上
const db = new DatabaseSync(dbFile)
const ins = db.prepare(
  `INSERT INTO events (ts, day, seq, kind, category, title, content, detail, feeling, interest, importance, keep, compressed, executed)
   VALUES (?, ?, ?, 'activity', 'tech', ?, ?, ?, ?, 0.5, 0.3, 0, 0, 1)`,
)
const now = Date.now()
for (let i = 0; i < 40; i++) {
  const ts = now - (40 - i) * 3600_000
  const d = new Date(ts)
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  ins.run(
    ts,
    day,
    i,
    `沙箱事件 ${i}`,
    '正文'.repeat(400),
    JSON.stringify({ junk: 'x'.repeat(6000) }),
    '感受'.repeat(100),
  )
}
const beforeFile = statSync(dbFile).size
const beforeContent = Number(
  db
    .prepare(
      `SELECT COALESCE(SUM(length(CAST(COALESCE(content,'') AS BLOB)) + length(CAST(COALESCE(detail,'') AS BLOB))), 0) b
       FROM events WHERE COALESCE(keep,0) = 0`,
    )
    .get().b,
)
db.close()

console.log('=== 沙箱灌完 ===')
console.log('  文件:', kb(beforeFile), 'KB')
console.log('  可压缩内容:', kb(beforeContent), 'KB / 上限 200 KB')

// 跑工具(DSH_HOME 指到临时目录)
const out = execFileSync(process.execPath, ['tools/compress_now.mjs', '200', '--vacuum'], {
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: root, PYTHONIOENCODING: 'utf-8' },
})
console.log('\n=== 工具输出 ===')
for (const line of out.split('\n')) if (line.trim()) console.log('  ' + line)

const afterFile = statSync(dbFile).size
const check = new DatabaseSync(dbFile)
const afterContent = Number(
  check
    .prepare(
      `SELECT COALESCE(SUM(length(CAST(COALESCE(content,'') AS BLOB)) + length(CAST(COALESCE(detail,'') AS BLOB))), 0) b
       FROM events WHERE COALESCE(keep,0) = 0`,
    )
    .get().b,
)
const free = Number(check.prepare('PRAGMA freelist_count').get().freelist_count)
check.close()

console.log('\n=== 结果 ===')
console.log('  文件:', kb(beforeFile), '→', kb(afterFile), 'KB')
console.log('  可压缩内容:', kb(beforeContent), '→', kb(afterContent), 'KB')
console.log('  空闲页:', free)

const pass =
  afterContent < beforeContent / 2 && afterFile < beforeFile && free === 0
console.log('\n' + (pass ? 'PASS 压缩生效、文件变小、无空闲页' : 'FAIL'))

rmSync(root, { recursive: true, force: true })
process.exit(pass ? 0 : 1)
