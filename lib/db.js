/**
 * SQLite 事件库。
 *
 * 用 Node 24 内置的 node:sqlite(DatabaseSync),零外部依赖。
 * 已验证可用(有 ExperimentalWarning,但功能完整)。
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  day         TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  category    TEXT,
  title       TEXT    NOT NULL,
  content     TEXT,
  feeling     TEXT,
  tools_used  INTEGER DEFAULT 0,
  bytes_read  INTEGER DEFAULT 0,
  energy      REAL,
  importance  REAL DEFAULT 0,
  interest    REAL DEFAULT 0,
  fingerprint TEXT,
  -- 压缩次数:0=没压过 1=压过一次 2=压过两次(第三次被压缩时删掉整行)
  compressed  INTEGER DEFAULT 0,
  keep        INTEGER DEFAULT 0,
  occurrences INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);
CREATE INDEX IF NOT EXISTS idx_events_ts  ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_keep ON events(keep);
CREATE INDEX IF NOT EXISTS idx_events_fp   ON events(fingerprint);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 每天的作息记录。条件采样的输入:第 n 天的时长由前 n 天的这些列决定。
CREATE TABLE IF NOT EXISTS days (
  day          TEXT PRIMARY KEY,
  sleepMinutes INTEGER NOT NULL,
  wakeMinutes  INTEGER NOT NULL,
  sleepStart   INTEGER,
  mealOffsets  TEXT,
  created      INTEGER
);

CREATE TABLE IF NOT EXISTS categories (
  name        TEXT PRIMARY KEY,
  weight      REAL DEFAULT 1,
  uses        INTEGER DEFAULT 0,
  last_used   INTEGER,
  introduced  INTEGER
);
`

/** 打开(或创建)事件库。 */
export function openDb(dir) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'life.db'))
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/**
 * 轻量迁移:补上后来新增的列。
 *
 * events 表在旧库里已经存在,CREATE TABLE IF NOT EXISTS 不会加列,
 * 所以这里按 pragma 检查后逐列 ALTER。幂等,可以每次启动都跑。
 */
function migrate(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(events)').all().map((r) => r.name))
  const additions = [
    // 想做的是什么(写手的意图)。与"实际发生了什么"分开存,避免把派发的任务
    // 当成已发生的事件。
    ['intent', 'TEXT'],
    // 真实执行的痕迹:工具名、关键参数(URL/查询词/路径)、输出长度等。
    ['detail', 'TEXT'],
    // 执行是否真的成功了。只有 executed=1 的事件才算"发生过"。
    ['executed', 'INTEGER DEFAULT 0'],
  ]
  for (const [name, type] of additions) {
    if (existing.has(name)) continue
    try {
      db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`)
    } catch {
      /* 并发或已存在:忽略 */
    }
  }
}

/** 库所在目录。 */
export function lifeDir() {
  return path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'dsh-plugin-life')
}

/**
 * 本地日期(YYYY-MM-DD)。
 *
 * 绝对不要用 `new Date(ts).toISOString().slice(0,10)` —— 那是 UTC。
 * 东八区的本地 00:00–08:00,UTC 日期还是前一天,于是:
 *   - 凌晨发生的事被记到昨天
 *   - 当天作息在本地 08:00 才换天(不是午夜)
 *   - 通知配额在 08:00 才重置
 * 而 currentPhase 用的是本地午夜,两套基准会打架。
 */
export function localDateISO(ts = Date.now()) {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本地时分(HH:MM),给日志和笔记用。 */
export function localClock(ts = Date.now()) {
  const d = new Date(ts)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

/** 本地时间 + 时区偏移,给落盘的时间戳用(替代 ISO/UTC)。 */
export function localStamp(ts = Date.now()) {
  const d = new Date(ts)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')
  const om = String(Math.abs(off) % 60).padStart(2, '0')
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}:${om}`
  )
}

// ---------- 去重 ----------

/** 规范化标题:去空白、统一大小写、去标点。 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 精确指纹:标题 + 类别 + 时间桶。 */
export function fingerprintOf(title, category, ts, bucketMinutes = 15) {
  const bucket = Math.floor(ts / (bucketMinutes * 60_000))
  return createHash('sha256')
    .update(`${normalizeTitle(title)}|${category ?? ''}|${bucket}`)
    .digest('hex')
    .slice(0, 32)
}

/** 分词(中英混合:英文按词,中文按字 + 二元组)。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = []
  for (const m of s.matchAll(/[a-z0-9]+/g)) tokens.push(m[0])
  for (const m of s.matchAll(/[一-鿿]/g)) tokens.push(m[0])
  const han = [...s.matchAll(/[一-鿿]/g)].map((m) => m[0])
  for (let i = 0; i + 1 < han.length; i++) tokens.push(han[i] + han[i + 1])
  return tokens
}

/** Jaccard 相似度。 */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * 在窗口内查找近似重复的事件。
 *
 * @returns {object | undefined} 命中的旧事件(调用方应给它 occurrences+1)
 */
export function findDuplicate(db, title, category, ts, { windowDays = 7, threshold = 0.85 } = {}) {
  const fp = fingerprintOf(title, category, ts)
  const exact = db.prepare('SELECT * FROM events WHERE fingerprint = ? LIMIT 1').get(fp)
  if (exact) return exact

  const since = ts - windowDays * 86400_000
  const recent = db
    .prepare('SELECT * FROM events WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 400')
    .all(since, ts)
  const tokens = new Set(tokenize(title))
  if (!tokens.size) return undefined

  for (const row of recent) {
    const other = new Set(tokenize(row.title))
    if (jaccard(tokens, other) >= threshold) return row
  }
  return undefined
}

// ---------- 写入 ----------

/**
 * 写入一条事件。若命中去重则不新增,只累加 occurrences。
 * @returns {{inserted: boolean, id?: number}}
 */
export function insertEvent(db, event) {
  const ts = event.ts ?? Date.now()
  const duplicate = findDuplicate(db, event.title, event.category, ts)
  if (duplicate) {
    db.prepare('UPDATE events SET occurrences = occurrences + 1 WHERE id = ?').run(duplicate.id)
    return { inserted: false, id: duplicate.id }
  }
  const day = event.day ?? localDateISO(ts)
  const info = db
    .prepare(
      `INSERT INTO events
       (ts, day, seq, kind, category, title, content, feeling, tools_used, bytes_read,
        energy, importance, interest, fingerprint, compressed, keep, occurrences,
        intent, detail, executed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?)`,
    )
    .run(
      ts,
      day,
      event.seq ?? 0,
      event.kind ?? 'activity',
      event.category ?? null,
      event.title,
      event.content ?? null,
      event.feeling ?? null,
      event.tools_used ?? 0,
      event.bytes_read ?? 0,
      event.energy ?? null,
      event.importance ?? 0,
      event.interest ?? 0,
      fingerprintOf(event.title, event.category, ts),
      event.keep ? 1 : 0,
      event.intent ?? null,
      typeof event.detail === 'string' ? event.detail : event.detail ? JSON.stringify(event.detail) : null,
      event.executed ? 1 : 0,
    )
  return { inserted: true, id: Number(info.lastInsertRowid) }
}

// ---------- 查询 ----------

/**
 * 最近的事件(时间倒序)。
 *
 * 只 SELECT 用得上的列。
 *
 * 原来写的是 SELECT * —— 每次挂载都把 8 行完整行(含 content 和 detail,
 * 每行 10-11 KB)拉进内存,实际只用了标题和时间戳。
 * 挂载发生在**每个 step**(每次模型调用)前,一轮里能跑十几次,
 * 白读的量很可观。
 */
export function recentEvents(db, limit = 5) {
  return db
    .prepare('SELECT id, ts, title, importance, keep FROM events ORDER BY ts DESC LIMIT ?')
    .all(limit)
}

/**
 * 永久记忆(keep = 1)。
 *
 * 舰长:"永久保留的每次全部装载,不论个数。"
 * 所以 limit 省略时**不加 LIMIT 子句** —— 一条都不落。
 *
 * 舰长:"永久记忆应该被加载在一般记忆之前" —— 所以它单独一块,
 * 不和"记得这些事"混在一起。混着的话,一条永久记忆会被
 * 几条"只是重要"的事件按 importance 挤掉。
 */
export function permanentEvents(db, limit = 0) {
  const sql = `SELECT id, ts, title, feeling, importance, keep FROM events
       WHERE keep = 1 ORDER BY importance DESC, ts DESC`
  if (limit > 0) return db.prepare(sql + ' LIMIT ?').all(limit)
  return db.prepare(sql).all()
}

/** 重要事件(按 importance 排序,取 keep 或高重要性)。 */
export function importantEvents(db, limit = 3) {
  return db
    .prepare(
      `SELECT id, ts, title, feeling, importance, keep FROM events
       WHERE keep = 0 AND importance >= 0.5 ORDER BY importance DESC, ts DESC LIMIT ?`,
    )
    .all(limit)
}

/** 全部事件(压缩用)。 */
export function allEvents(db) {
  return db.prepare('SELECT * FROM events ORDER BY ts ASC').all()
}

/**
 * 库的内容体积(真实字节,含 detail)。
 *
 * 舰长指出原来的口径是错的:只数 content+feeling+title,漏掉了 detail ——
 * 而 detail 才是大头(每个活动 10-11 KB)。而且用的是 SQLite 的 LENGTH(),
 * 数的是**字符**不是字节,中文一个字占 3 字节,直接少算三分之二。
 *
 * 两个错叠起来,2 MB 的阈值实际对应 11 MB 磁盘、1700 个事件,
 * 压缩几乎永远不会触发。
 *
 * 现在统一用 length(CAST(x AS BLOB)) 数真实字节,四列全算。
 *
 * options.onlyCompressible:只算**可压缩**的那部分(排除 keep=1 的永久记忆)。
 *
 *   舰长:"那些永久记忆也被算进来了,意味着留给其他事件的地方会被不断压缩。"
 *   永久记忆不占一般事件的名额 —— 它占的是磁盘,不是压缩预算。
 */
export function contentBytes(db, options = {}) {
  const onlyCompressible = options.onlyCompressible === true
  const where = onlyCompressible ? 'WHERE COALESCE(keep, 0) = 0' : ''
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
         length(CAST(COALESCE(content,'') AS BLOB)) +
         length(CAST(COALESCE(feeling,'') AS BLOB)) +
         length(CAST(COALESCE(detail,'')  AS BLOB)) +
         length(CAST(COALESCE(title,'')   AS BLOB))
       ), 0) AS bytes FROM events ${where}`,
    )
    .get()
  return Number(row?.bytes ?? 0)
}

/**
 * 清掉"没有真的执行过"的活动记录。
 *
 * 舰长的规则:数据库里只能有真实发生过的事。
 * executed=0 的 activity 行按定义就不是 —— 它们来自早期版本的代码路径
 * (那时执行失败也会写库,而且输出为空时会把派发的任务文本当内容写进去)。
 * 每次启动跑一遍,保证不变量成立,也让旧库自动恢复干净。
 *
 * @returns {{removed: number, ids: number[]}}
 */
export function purgeUnrealActivity(db) {
  try {
    const rows = db.prepare("SELECT id FROM events WHERE kind = 'activity' AND COALESCE(executed, 0) = 0").all()
    if (!rows.length) return { removed: 0, ids: [] }
    const ids = rows.map((r) => Number(r.id))
    db.prepare("DELETE FROM events WHERE kind = 'activity' AND COALESCE(executed, 0) = 0").run()
    return { removed: ids.length, ids }
  } catch {
    return { removed: 0, ids: [] }
  }
}

/** 读/写一个 meta 值。 */
export function getMeta(db, key, fallback) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : fallback
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  )
}

/**
 * 记录一天的作息。这是条件采样的历史来源。
 * 同一天重复写入覆盖(幂等)。
 */
export function saveDay(db, day) {
  db.prepare(
    `INSERT INTO days (day, sleepMinutes, wakeMinutes, sleepStart, mealOffsets, created)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       sleepMinutes = excluded.sleepMinutes,
       wakeMinutes  = excluded.wakeMinutes,
       sleepStart   = excluded.sleepStart,
       mealOffsets  = excluded.mealOffsets`,
  ).run(
    day.day,
    day.sleepDuration ?? 480,
    day.wakeMinutes ?? 420,
    day.sleepStart ?? null,
    JSON.stringify(day.mealOffsets ?? []),
    day.created ?? Date.now(),
  )
}

/**
 * 读取历史作息(按天升序)。
 *
 * @param limitDays 取最近多少天作为条件采样窗口
 */
export function loadHistory(db, limitDays = 30) {
  const rows = db.prepare('SELECT * FROM days ORDER BY day DESC LIMIT ?').all(limitDays)
  return rows
    .map((r) => ({
      day: r.day,
      sleepDuration: Number(r.sleepMinutes),
      wakeMinutes: Number(r.wakeMinutes),
      sleepStart: r.sleepStart ? Number(r.sleepStart) : undefined,
      mealOffsets: safeParseArray(r.mealOffsets),
    }))
    .reverse()
}

function safeParseArray(text) {
  try {
    const parsed = JSON.parse(text ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
