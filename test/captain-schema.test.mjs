/**
 * captain.db 的表结构迁移测试。
 *
 * 这条必须测:CREATE TABLE IF NOT EXISTS 对已存在的表什么都不做,
 * 所以后加的列在老库上不会出现,而代码里写着它 —— 每次写入都抛
 * "no such column",异常又被吞掉,库里空得像"还没聊到值得记的事"。
 *
 * 这个 bug 真的发生过,静默了好几天。
 *
 * 用法: node test/captain-schema.test.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  openCaptainDb,
  migrate,
  schemaStatus,
  insertFact,
  allFacts,
  addMention,
  statsOf,
} from '../lib/captain/db.js'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS  ' + name)
  else {
    failures++
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''))
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-captain-schema-'))

/** 造一个 11 月 2 日那版的老库:没有 degraded 列。 */
function makeOldDb(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE facts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      kind          TEXT    NOT NULL DEFAULT 'fact',
      title         TEXT    NOT NULL,
      content       TEXT,
      vec           BLOB,
      mention_count INTEGER NOT NULL DEFAULT 0,
      last_mention  INTEGER,
      compressed    INTEGER NOT NULL DEFAULT 0,
      session       TEXT,
      turn          TEXT
    );
    CREATE TABLE mentions (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_id INTEGER NOT NULL,
      ts      INTEGER NOT NULL
    );
  `)
  // 里面放一条旧数据,确认迁移不会把它弄丢
  db.prepare('INSERT INTO facts (ts, kind, title, content) VALUES (?, ?, ?, ?)').run(
    Date.now() - 86400_000,
    'plan',
    '旧数据要保住',
    '这条是在老库里写的',
  )
  db.close()
}

console.log('=== 老库在迁移之前确实是坏的 ===')
{
  const file = join(dir, 'old1.db')
  makeOldDb(file)
  const db = new DatabaseSync(file)
  const cols = db.prepare('PRAGMA table_info(facts)').all().map((r) => r.name)
  check('老库没有 degraded 列', !cols.includes('degraded'), cols.join(','))

  // 代码里的 insert 会用到 degraded —— 这一步必须抛错,证明确实坏过
  let threw = null
  try {
    db.prepare(
      `INSERT INTO facts (ts, kind, title, content, vec, mention_count, last_mention, degraded, session, turn)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
    ).run(Date.now(), 'fact', 'x', 'y', null, 0, null, null)
  } catch (e) {
    threw = e
  }
  check(
    '写入会抛「没有这一列」',
    // node:sqlite 的措辞是 "table facts has no column named degraded",
    // 别的驱动可能是 "no such column" —— 两种都认
    !!threw && /no column named|no such column/i.test(String(threw.message)),
    threw ? threw.message : '居然没抛',
  )
  db.close()
}

console.log('\n=== 迁移之后就好了 ===')
{
  const file = join(dir, 'old1.db')
  const added = []
  const db = openCaptainDb(file, { onMigrate: (a) => added.push(...a) })
  check('报告补了 facts.degraded', added.includes('facts.degraded'), JSON.stringify(added))
  check('schemaStatus 说结构对得上', schemaStatus(db).ok === true, JSON.stringify(schemaStatus(db)))

  // 旧数据还在
  const rows = allFacts(db)
  check('旧数据没丢', rows.length === 1 && rows[0].title === '旧数据要保住', JSON.stringify(rows.map((r) => r.title)))
  check('旧数据的 degraded 补成 0', rows[0].degraded === 0, String(rows[0].degraded))

  // 现在写入能成功
  const id = insertFact(db, {
    ts: Date.now(),
    kind: 'plan',
    title: '迁移后写的',
    content: '应该能写进来',
    vec: null,
  })
  check('写入成功了', typeof id === 'number' && id > 0, String(id))

  const after = allFacts(db)
  check('现在有两条', after.length === 2, String(after.length))
  const fresh = after.find((r) => r.id === id)
  check('degraded 默认 0', fresh.degraded === 0, String(fresh.degraded))

  // 提及也能记
  addMention(db, id, Date.now())
  check('记提及成功', allFacts(db).find((r) => r.id === id).mention_count === 1)

  const st = statsOf(db)
  check('统计正常', st.total === 2, JSON.stringify(st))
  db.close()
}

console.log('\n=== 再开一次不会重复补(幂等)===')
{
  const file = join(dir, 'old1.db')
  const added = []
  const db = openCaptainDb(file, { onMigrate: (a) => added.push(...a) })
  check('第二次没有补任何列', added.length === 0, JSON.stringify(added))
  db.close()
}

console.log('\n=== 全新的库直接就是对的 ===')
{
  const file = join(dir, 'fresh.db')
  const added = []
  const db = openCaptainDb(file, { onMigrate: (a) => added.push(...a) })
  check('新库不需要迁移', added.length === 0, JSON.stringify(added))
  check('结构正确', schemaStatus(db).ok === true, JSON.stringify(schemaStatus(db)))
  const id = insertFact(db, { ts: Date.now(), kind: 'fact', title: '全新', content: '全新' })
  check('新库能写', id > 0, String(id))
  db.close()
}

console.log('\n=== 缺表也能被指出来 ===')
{
  const file = join(dir, 'broken.db')
  const raw = new DatabaseSync(file)
  raw.exec('CREATE TABLE facts (id INTEGER)') // 只有一列
  const st = schemaStatus(raw)
  check('报告缺列', st.ok === false && st.missing.length > 0, JSON.stringify(st.missing).slice(0, 120))
  raw.close()

  // 用 openCaptainDb(先跑 SCHEMA 建缺失的表,再 migrate 补列)—— 这才是插件的真实路径
  const added = []
  const db = openCaptainDb(file, { onMigrate: (a) => added.push(...a) })
  check('能补的都补上了', added.length > 0, JSON.stringify(added.slice(0, 4)))
  check('补完结构正确', schemaStatus(db).ok === true, JSON.stringify(schemaStatus(db)))
  // 这种残缺库的旧数据没有列声明,补出来的列都是空的 —— 至少要能写新的
  const id = insertFact(db, { ts: Date.now(), kind: 'fact', title: '残缺库也能写', content: 'x' })
  check('残缺库补完能写新数据', id > 0, String(id))
  db.close()
}

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
if (failures) process.exit(1)
