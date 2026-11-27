/**
 * 存:一天一份原始记录,第二天第一次启动才压缩。
 *
 * 白天不压。压的时候按舰长定的规则来:
 *   取前一天出现频次最高的四条活动,拿去比对跨会话记忆;
 *   重复的当"这次又被提了一次",计数加一、时间刷新;
 *   没有的就新写一条;
 *   然后删掉前一天所有原始记录。
 *
 * 原始记录只留一天,压缩结果进 memories 表(由 life 的 memory 模块管)。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 当天的原始记录文件。 */
function dayFile(dir, day) {
  return path.join(dir, 'raw-' + day + '.jsonl')
}

export function todayKey(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + d
}

/** 追加一条理解结果。写不进去也不能让心跳停。 */
export function appendRaw(dir, entry) {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(dayFile(dir, todayKey()), JSON.stringify(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 读某一天的原始记录。坏行跳过。 */
export function readRaw(dir, day) {
  const file = dayFile(dir, day)
  if (!existsSync(file)) return []
  const out = []
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/**
 * 频次前四。
 *
 * 按"活动名"分组计数;单条占的时长按相邻两条的时间差算,单次封顶 30 分钟,
 * 免得一次坐三小时把别的事全挤掉。排的时候先看次数,次数相同再看总时长。
 */
export function topActivities(entries, limit = 4) {
  const groups = new Map()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const name = String((e && e.activity) || '').trim()
    if (!name) continue
    const at = Number(e.at) || 0
    const next = entries[i + 1] ? Number(entries[i + 1].at) || 0 : at + 8 * 60 * 1000
    const span = Math.min(Math.max(next - at, 0), 30 * 60 * 1000)
    const g = groups.get(name) || { name, count: 0, ms: 0, last: 0 }
    g.count += 1
    g.ms += span
    g.last = Math.max(g.last, at)
    groups.set(name, g)
  }
  return [...groups.values()]
    .sort((a, b) => (b.count - a.count) || (b.ms - a.ms) || (b.last - a.last))
    .slice(0, limit)
}

/** 删掉某一天之后的所有原始记录,只留压缩结果。 */
export function dropRaw(dir, keepDay) {
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('raw-') || !name.endsWith('.jsonl')) continue
      const day = name.slice(4, -6)
      if (day === keepDay) continue
      try {
        rmSync(path.join(dir, name))
        removed += 1
      } catch {
        /* 删不掉留着 */
      }
    }
  } catch {
    /* 目录都不在 */
  }
  return removed
}

/** 标记"这一天的压缩已经做过",避免一天里反复压。 */
export function markCompressed(dir, day, summary) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'compressed-' + day + '.json'), JSON.stringify(summary, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export function isCompressed(dir, day) {
  return existsSync(path.join(dir, 'compressed-' + day + '.json'))
}

/** 昨天是哪天。 */
export function previousDay(now = new Date()) {
  const d = new Date(now.getTime() - 24 * 3600 * 1000)
  return todayKey(d)
}
