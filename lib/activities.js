/**
 * 活动类别池。
 *
 * 舰长的要求:"需要一种随机生成算法进行事件的生成(可以考虑用 llm 当写手依照板鸭的人格文本生成任务),不能是写死的"。
 *
 * 所以:
 *   - 类别池是**种子**,不是白名单。LLM 每次可以提出新类别,新类别入库并参与后续抽样。
 *   - 抽样权重由历史频次(用得少的多抽)、兴趣得分、冷却期共同决定。
 *   - 种子类别是"这个人在物理上能做的事"的最小集,不是"写死的日程"。
 */

import { getMeta, setMeta } from './db.js'

/** 初始种子类别。覆盖"能真实执行的程序行为"。 */
export const SEED_CATEGORIES = [
  { name: 'video', label: '看视频', weight: 1.0, cooldownHours: 3 },
  { name: 'book', label: '读书', weight: 1.0, cooldownHours: 6 },
  { name: 'game', label: '了解游戏', weight: 0.8, cooldownHours: 8 },
  { name: 'shop', label: '逛网店', weight: 0.7, cooldownHours: 12 },
  { name: 'film', label: '看电影相关', weight: 0.7, cooldownHours: 12 },
  { name: 'tech', label: '看技术资料', weight: 1.0, cooldownHours: 4 },
  { name: 'music', label: '听音乐/找歌', weight: 0.6, cooldownHours: 6 },
  { name: 'browse', label: '随便逛逛', weight: 0.5, cooldownHours: 1 },
]

/** 载入类别池(从库中读,没有则用种子)。 */
export function loadCategories(db) {
  const rows = db.prepare('SELECT * FROM categories').all()
  if (!rows.length) {
    const now = Date.now()
    const insert = db.prepare(
      'INSERT INTO categories (name, weight, uses, last_used, introduced) VALUES (?, ?, 0, NULL, ?)',
    )
    for (const c of SEED_CATEGORIES) insert.run(c.name, c.weight, now)
    return SEED_CATEGORIES.map((c) => ({ ...c, uses: 0, lastUsed: null }))
  }
  const cooldowns = new Map(SEED_CATEGORIES.map((c) => [c.name, c.cooldownHours]))
  return rows.map((r) => ({
    name: r.name,
    label: r.name,
    weight: Number(r.weight) || 1,
    uses: Number(r.uses) || 0,
    lastUsed: r.last_used ? Number(r.last_used) : null,
    introduced: r.introduced ? Number(r.introduced) : null,
    cooldownHours: cooldowns.get(r.name) ?? 4,
  }))
}

/** 新增一个类别(由 LLM 提出)。 */
export function addCategory(db, name, now = Date.now()) {
  const trimmed = String(name ?? '').trim().slice(0, 40)
  if (!trimmed) return false
  const exists = db.prepare('SELECT name FROM categories WHERE name = ?').get(trimmed)
  if (exists) return false
  db.prepare('INSERT INTO categories (name, weight, uses, last_used, introduced) VALUES (?, ?, 0, NULL, ?)').run(
    trimmed,
    1.0,
    now,
  )
  return true
}

/** 记录一次使用。 */
export function markUsed(db, name, now = Date.now()) {
  db.prepare('UPDATE categories SET uses = uses + 1, last_used = ? WHERE name = ?').run(now, name)
}

/**
 * 按权重抽样一个类别。
 *
 * 权重 = 基础权重 × (1 + 未使用加成) × 冷却惩罚 × 兴趣加成
 * 冷却期内的类别权重压到 0.05(不是排除,允许"就是想做这个")。
 */
export function pickCategory(categories, rng, { now = Date.now(), interestBoost = new Map() } = {}) {
  const weighted = categories.map((c) => {
    let w = c.weight
    // 用得少的加成:让池子保持多样性
    w *= 1 + 1 / (1 + (c.uses ?? 0))
    // 冷却惩罚
    if (c.lastUsed) {
      const hoursSince = (now - c.lastUsed) / 3600_000
      if (hoursSince < (c.cooldownHours ?? 4)) {
        const ratio = hoursSince / (c.cooldownHours ?? 4)
        w *= 0.05 + 0.95 * ratio
      }
    }
    // 兴趣加成
    const boost = interestBoost.get(c.name)
    if (typeof boost === 'number' && boost > 0) w *= 1 + boost
    return { ...c, effectiveWeight: Math.max(0.001, w) }
  })
  return rng.weightedChoice(weighted, (c) => c.effectiveWeight)
}

/** 最近使用过的类别名(给 LLM 做去重提示)。 */
export function recentCategoryNames(db, limit = 6) {
  return db
    .prepare('SELECT category FROM events WHERE category IS NOT NULL ORDER BY ts DESC LIMIT ?')
    .all(limit)
    .map((r) => r.category)
}
