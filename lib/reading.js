/**
 * reading/ 目录的维护。
 *
 * 之前是个只进不出的泄漏:每抓一次网页就写一个 .md,从没有任何代码删过它。
 * 事件被压缩到只剩元数据之后(正文和感受都清空、detail 也清掉),
 * 对应的笔记文件就成了孤儿,却还躺在磁盘上。
 *
 * 两条策略:
 *   1. 孤儿回收 —— 没有任何事件的 detail.savedFile 指向它的文件删掉。
 *   2. 总量上限 —— 超过上限就按修改时间从旧到新淘汰。
 *
 * 只处理目录**顶层**的 .md;_reset-* 这类归档子目录不碰。
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

/**
 * @param dir reading 目录
 * @param referenced 仍然被事件引用的文件名集合(只要 basename)
 * @param options { maxBytes }
 * @returns {{orphans: string[], evicted: string[], freedBytes: number, keptBytes: number}}
 */
export function pruneReading(dir, referenced, options = {}) {
  const result = { orphans: [], evicted: [], freedBytes: 0, keptBytes: 0 }
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024

  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return result // 目录还不存在
  }

  const files = []
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md')) continue
    const full = path.join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    files.push({ name, full, size: st.size, mtimeMs: st.mtimeMs })
  }

  // 1) 孤儿
  const alive = new Set(referenced)
  for (const f of files) {
    if (alive.has(f.name)) continue
    try {
      unlinkSync(f.full)
      result.orphans.push(f.name)
      result.freedBytes += f.size
    } catch {
      /* 删不掉就留着,下次再说 */
    }
  }

  // 2) 总量上限(按 mtime 从旧到新淘汰)
  const survivors = files.filter((f) => alive.has(f.name)).sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = survivors.reduce((a, f) => a + f.size, 0)
  for (const f of survivors) {
    if (total <= maxBytes) break
    try {
      unlinkSync(f.full)
      result.evicted.push(f.name)
      result.freedBytes += f.size
      total -= f.size
    } catch {
      /* ignore */
    }
  }
  result.keptBytes = total
  return result
}

/**
 * 当场删掉指定的笔记文件。
 *
 * 压缩事件的时候用:舰长的要求是"某个事件一旦出现被压缩,
 * 这个事件在 reading 里的源内容就会被删除" —— 不能等下一次孤儿回收
 * (那要等到下次活动跑完,可能隔了几个小时)。
 *
 * @param dir reading 目录
 * @param names 文件名(basename)
 * @returns {{removed: string[], freedBytes: number}}
 */
export function removeReadingFiles(dir, names) {
  const result = { removed: [], freedBytes: 0 }
  if (!Array.isArray(names) || !names.length) return result
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue
    // 只删目录**顶层**的 .md,别被路径穿越骗了。
    const base = path.basename(name)
    if (base !== name || !base.toLowerCase().endsWith('.md')) continue
    const full = path.join(dir, base)
    try {
      const st = statSync(full)
      unlinkSync(full)
      result.removed.push(base)
      result.freedBytes += st.size
    } catch {
      /* 不存在或者删不掉 —— 下面的孤儿回收会兜住 */
    }
  }
  return result
}

/**
 * 从事件库里收集仍然被引用的笔记文件名。
 *
 * detail 是 JSON,里面 savedFile 存的是绝对路径。detail 被压缩清空之后,
 * 这条引用就消失,对应文件自然变成孤儿。
 */
export function referencedReadingFiles(db) {
  const names = new Set()
  let rows = []
  try {
    rows = db.prepare('SELECT detail FROM events WHERE detail IS NOT NULL').all()
  } catch {
    return names
  }
  for (const row of rows) {
    try {
      const d = JSON.parse(row.detail)
      const p = d?.savedFile
      if (typeof p === 'string' && p) names.add(path.basename(p))
      for (const page of d?.pages ?? []) {
        if (typeof page?.savedFile === 'string' && page.savedFile) names.add(path.basename(page.savedFile))
      }
    } catch {
      /* 坏 JSON 跳过 */
    }
  }
  return names
}
