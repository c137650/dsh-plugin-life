/**
 * 时间衰减压缩。
 *
 * 舰长的要求:
 *   "压缩是确定的,时间久远的细节损失程度大,时间近的损失程度小"
 *   "根据板鸭人格应该产生一部分事件被写入一个新的文件,这部分事件对板鸭产生了足够大的影响"
 *
 * 算法:
 *   retention(age) = exp(-age / τ)          τ = 半衰期
 *   综合分 = importance·0.6 + retention·0.4
 *   分数前 10%  → 完整保留(不算"被压缩",计数不动)
 *   中间 70%     → 只留 title + feeling
 *   底部 20%    → 只留元数据一行
 *   keep = 1    → 永久完整保留,不参与删减
 *
 * 三档,舰长定的:
 *   第一次被压缩 → 按上面的档位剥落
 *   第二次被压缩 → 再剥一次
 *   第三次被压缩 → **彻底删掉整行**
 *
 *   舰长:"反正如果这个事情没有被永久记录就证明没那么重要"。
 *   计数存在 events.compressed 这一列里(0/1/2)。
 *
 * 关键性质:importance 高的旧事件仍然保住 —— 这就是"人格在压缩算法里的体现"。
 * 对布洛妮娅重要的事,时间抹不掉。
 *
 * 压缩是确定性的:同样的输入必然得到同样的输出。
 */

import { allEvents, contentBytes } from './db.js'
import path from 'node:path'

const HALF_LIFE_DAYS = 7
/**
 * 完整保留的比例(分数前 10%)。
 *
 * 舰长:"20% 阈值太高了",从 20% 降到 10%。
 *
 * 降下来之后被完整保护的更少,更多事件会掉进剥落档,
 * 三档倒计时也就走得更普遍。
 */
const KEEP_RATIO = 0.1
/** 最底部那档(只剩标题)的比例。 */
const STRIP_RATIO = 0.2

/**
 * 计算某事件的保留分数。
 * @param importance 0..1
 * @param ageMs 距今多久
 */
export function retentionScore(importance, ageMs) {
  const ageDays = Math.max(0, ageMs) / 86400_000
  const retention = Math.exp((-Math.LN2 * ageDays) / HALF_LIFE_DAYS)
  return importance * 0.6 + retention * 0.4
}

/**
 * 压缩事件库到目标字节数以内。
 *
 * @param db 事件库
 * @param options { limitBytes, now }
 * @returns {{ compressed: boolean, before: number, after: number, stripped: number, kept: number,
 *            releasedFiles: string[] }}
 *
 * releasedFiles:这次压缩清掉 detail 的那些事件所引用的笔记文件名。
 * 舰长的要求:"某个事件一旦出现被压缩,这个事件在 reading 里的源内容就会被删除" ——
 * 所以调用方要**当场**把文件删掉,不能等下一次孤儿回收(那可能要等几小时)。
 */
export function compressIfNeeded(db, options = {}) {
  const limitBytes = options.limitBytes ?? 2 * 1024 * 1024
  const now = options.now ?? Date.now()

  // 预算只算**可压缩**的部分。
  //
  // 舰长:"那些永久记忆也被算进来了,意味着留给其他事件的地方会被不断压缩。"
  // keep=1 的事件不参与删减,也不该占一般事件的预算 ——
  // 它占的是磁盘,不是压缩额度。
  const before = contentBytes(db, { onlyCompressible: true })
  if (before <= limitBytes) {
    return { compressed: false, before, after: before, stripped: 0, kept: 0, releasedFiles: [], deleted: 0 }
  }

  const events = allEvents(db)
  if (!events.length) {
    return { compressed: false, before, after: before, stripped: 0, kept: 0, releasedFiles: [], deleted: 0 }
  }

  // 永不压缩的事件:keep = 1
  const permanent = events.filter((e) => e.keep === 1)
  const compressible = events.filter((e) => e.keep !== 1)

  // 打分:importance 高 + 时间近 的排前面
  const scored = compressible
    .map((e) => ({
      row: e,
      score: retentionScore(Number(e.importance) || 0, now - Number(e.ts)),
    }))
    .sort((a, b) => b.score - a.score)

  const keepCount = Math.floor(scored.length * KEEP_RATIO)
  const stripCount = Math.floor(scored.length * STRIP_RATIO)

  const update = db.prepare('UPDATE events SET content = ? WHERE id = ?')
  // 清 detail 用单独一条:detail 里是 URL / 工具痕迹 / 落盘路径,
  // 正文都清掉了却留着这些,既占空间也失去了意义。
  const clearDetail = db.prepare('UPDATE events SET detail = NULL WHERE id = ?')
  // 压缩次数。舰长:"第三次被压缩时就彻底删除" ——
  // 计数器就存在 compressed 这一列里(它原来只是个 0/1 的标志,没人读)。
  const bump = db.prepare('UPDATE events SET compressed = ? WHERE id = ?')
  const drop = db.prepare('DELETE FROM events WHERE id = ?')
  let stripped = 0
  let deleted = 0

  // detail 一清,笔记文件就没有任何事件引用它了 —— 文件名要**趁现在**记下来,
  // 清完就再也读不到了。
  const releasedFiles = new Set()
  const collectFiles = (detail) => {
    try {
      const d = JSON.parse(detail)
      if (typeof d?.savedFile === 'string' && d.savedFile) {
        releasedFiles.add(path.basename(d.savedFile))
      }
      for (const page of d?.pages ?? []) {
        if (typeof page?.savedFile === 'string' && page.savedFile) {
          releasedFiles.add(path.basename(page.savedFile))
        }
      }
    } catch {
      /* 坏 JSON 跳过 */
    }
  }

  scored.forEach((entry, index) => {
    const row = entry.row
    if (index < keepCount) return // 前 20%:完整保留 —— 不算"被压缩",计数也不动

    const passes = Number(row.compressed) || 0

    // 第三次被压缩 —— 彻底删掉整行。
    //
    // 舰长:"反正如果这个事情没有被永久记录就证明没那么重要"。
    // keep=1 的事件不在 compressible 里,永远走不到这一支。
    if (passes >= 2) {
      drop.run(row.id)
      deleted++
      return
    }

    if (index < scored.length - stripCount) {
      // 中间 60%:删正文,留 title + feeling
      if (row.content) {
        update.run(null, row.id)
        stripped++
      }
      if (row.detail) {
        collectFiles(row.detail)
        clearDetail.run(row.id)
      }
    } else {
      // 底部 20%:只留元数据,title 压成一行
      if (row.content || row.feeling) {
        update.run(null, row.id)
        db.prepare('UPDATE events SET feeling = NULL WHERE id = ?').run(row.id)
        stripped++
      }
      if (row.detail) {
        collectFiles(row.detail)
        clearDetail.run(row.id)
      }
    }
    bump.run(passes + 1, row.id)
  })

  const after = contentBytes(db, { onlyCompressible: true })
  return {
    compressed: true,
    before,
    after,
    stripped,
    deleted,
    kept: permanent.length,
    releasedFiles: [...releasedFiles],
  }
}

/**
 * 挑出应该进入 keepers.md 的事件。
 *
 * 舰长:"这部分事件对板鸭产生了足够大的影响,但是这个影响的程度应该被仔细评估"
 *
 * 标准:importance 达到阈值,且不是日常琐事(类别在"琐事"名单里的一律排除)。
 */
export function selectKeepers(db, threshold = 0.75, excludedCategories = ['meal', 'sleep']) {
  return db
    .prepare(
      `SELECT id, ts, kind, category, title, feeling, importance, keep FROM events
       WHERE keep = 1 OR (importance >= ? AND kind NOT IN ('sleep'))
       ORDER BY importance DESC, ts DESC`,
    )
    .all(threshold)
    .filter((e) => !excludedCategories.includes(e.category) || e.keep === 1)
}
