/**
 * 关于舰长的记忆库(captain.db)。
 *
 * 和 life.db 是**两个不同的文件**,舰长特意要求的:
 * 那边是布洛妮娅自己的生活,这边是"关于舰长的事",混在一起会互相污染。
 *
 * 表结构:
 *
 *   facts    一条记忆一行。vec 是 512 维句向量,用来判重和检测"又被提到了"。
 *   mentions 每一次"舰长又提到这件事"的时间戳。
 *            单独一张表而不是只存个计数器 —— 因为热度是带衰减的,
 *            光有次数算不出"最近提得多不多"。
 *
 * 没有任何 keep 标记。舰长:"我希望不存在一直都会被挂载的事件。"
 * 所以这边唯一的存活依据是热度,没有永久。
 */

import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'fact',
  title         TEXT    NOT NULL,
  content       TEXT,
  vec           BLOB,
  mention_count INTEGER NOT NULL DEFAULT 0,
  last_mention  INTEGER,
  compressed    INTEGER NOT NULL DEFAULT 0,
  degraded      INTEGER NOT NULL DEFAULT 0,
  session       TEXT,
  turn          TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_ts ON facts(ts);
CREATE INDEX IF NOT EXISTS idx_facts_mention ON facts(last_mention);

CREATE TABLE IF NOT EXISTS mentions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id INTEGER NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mentions_fact ON mentions(fact_id, ts);
`

/** 打开(或新建)关于舰长的记忆库。 */
export function openCaptainDb(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

/** 所有带向量的记忆(判重要用全量,包括已经沉底的)。 */
export function allFacts(db) {
  return db
    .prepare(
      `SELECT id, ts, kind, title, content, vec, mention_count, last_mention, compressed, degraded
       FROM facts ORDER BY id`,
    )
    .all()
}

/**
 * 插入一条新记忆。
 *
 * degraded = 1 表示这条不是压缩出来的,而是压缩失败时退化的原话截断。
 * 留着这个标记,将来可以筛出来重新压。
 */
export function insertFact(db, row) {
  const stmt = db.prepare(
    `INSERT INTO facts (ts, kind, title, content, vec, mention_count, last_mention, degraded, session, turn)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
  )
  const info = stmt.run(
    row.ts,
    row.kind ?? 'fact',
    row.title,
    row.content ?? null,
    row.vec ?? null,
    row.degraded ? 1 : 0,
    row.session ?? null,
    row.turn ?? null,
  )
  return Number(info.lastInsertRowid)
}

/**
 * 记一次"又被提到了":写时间戳 + 更新计数和最后提及时间。
 *
 * 只动热度,不动正文。
 *
 * 之前这里是"把这次的说法追加进正文",但改成 LLM 压缩之后就不合适了:
 * 正文是一句 60 字的概括,再往里塞原话会把压缩的结果重新撑起来,
 * 又回到"谁话多谁占权重"的老问题。
 *
 * 代价是有信息损失:同一件事后来补充的细节不会进这条记忆。
 * 要补的话得再压一次(把旧概括和新话一起喂给模型),那是另一次调用,
 * 现在没做。
 */
export function addMention(db, factId, ts) {
  db.prepare('INSERT INTO mentions (fact_id, ts) VALUES (?, ?)').run(factId, ts)
  db.prepare(
    `UPDATE facts SET mention_count = mention_count + 1, last_mention = ? WHERE id = ?`,
  ).run(ts, factId)
}

/** 某条记忆的全部提及时间戳(算热度用)。 */
export function mentionsOf(db, factId) {
  return db
    .prepare('SELECT ts FROM mentions WHERE fact_id = ? ORDER BY ts')
    .all(factId)
    .map((r) => Number(r.ts))
}

/** 一批记忆的提及时间戳 —— 挂载时一次查完,不要每条一次查询。 */
export function mentionsFor(db, ids) {
  if (!ids.length) return new Map()
  const marks = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT fact_id, ts FROM mentions WHERE fact_id IN (${marks}) ORDER BY ts`)
    .all(...ids)
  const map = new Map()
  for (const r of rows) {
    const id = Number(r.fact_id)
    if (!map.has(id)) map.set(id, [])
    map.get(id).push(Number(r.ts))
  }
  return map
}

/** 近 N 毫秒内创建的记忆(挂载"最近说过的"那一段)。 */
export function factsSince(db, since) {
  return db
    .prepare(
      `SELECT id, ts, kind, title, content, mention_count, last_mention, compressed
       FROM facts WHERE ts >= ? ORDER BY ts DESC`,
    )
    .all(since)
}

/** 沉底用:把正文剥掉(留标题),返回被剥的条数。 */
export function stripContent(db, ids) {
  if (!ids.length) return 0
  const marks = ids.map(() => '?').join(',')
  const info = db
    .prepare(`UPDATE facts SET content = NULL, compressed = 1 WHERE id IN (${marks}) AND content IS NOT NULL`)
    .run(...ids)
  return Number(info.changes ?? 0)
}

/** 统计,给状态文件和排查用。 */
export function statsOf(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN content IS NOT NULL THEN 1 ELSE 0 END) AS full,
              SUM(CASE WHEN mention_count > 0 THEN 1 ELSE 0 END) AS mentioned
       FROM facts`,
    )
    .get()
  return {
    total: Number(row?.total ?? 0),
    full: Number(row?.full ?? 0),
    mentioned: Number(row?.mentioned ?? 0),
  }
}
