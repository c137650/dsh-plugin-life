/**
 * 话题查重:这次想做的事,最近是不是已经做过了。
 *
 * 为什么需要它:写手每 3-4 小时换一次说法,但说的常常是同一件事。
 * 实测有 5 天里做了 10 次"生成艺术"的记录 ——
 * 每次 intent 都不一样("了解创作工作流" / "梳理技术谱系" / "找视频看"),
 * 但都是同一片地。
 *
 * 为什么不用标题:库里原来那套去重比的是标题的 token 重叠(Jaccard ≥ 0.85)。
 * 实测 33 条事件里标题最高相似度只有 0.56,**一次都没命中过**。
 * 因为同一件事的两次记录,标题长得完全不一样:
 *   "布洛妮娅检索生成式艺术资料并阅读两份创意编程资源页面"
 *   "布洛妮娅打开 OpenProcessing 的流场作品列表页,抓取作品清单并存成笔记"
 *
 * 换成意图的向量就分得开。实测(真实数据里的 17 对):
 *   同一话题   0.616 ~ 0.856
 *   不同话题   0.322 ~ 0.461
 *
 * 阈值取 0.62,不是 0.70。
 *
 * 一开始定的是 0.70,实测漏了一条:"她想弄清生成式艺术里规则系统怎么变成作品"
 * 和"她想探索生成式艺术在实时图形中的创作实践"只有 0.669 —— 恰恰是最该拦的那种。
 *
 * 为什么敢往下调:两类之间的空隙很宽(0.461 → 0.616)。
 * 而两种错的代价不对等:
 *   误拦 —— 这一轮不做,45 分钟后再来,代价是一次空转
 *   漏拦 —— 多一条重复记忆,占着挂载预算好几天
 * 所以宁可偏严。
 */

import { cosine } from './embed.js'

/** 往前看几天。 */
export const TOPIC_WINDOW_DAYS = 7
/** 相似度到多少算"同一片地"。 */
export const TOPIC_SIM = 0.62
/** 相似度到多少算"值得在重挑时明说出来"。 */
export const TOPIC_AVOID_SIM = 0.45
/** 向量缓存有多长。事件一旦入库它的 intent 就不会变,所以按 id 缓存。 */
const CACHE_MAX = 600

/** eventId -> Float32Array */
const vecCache = new Map()

/** 测试用:清掉缓存。 */
export function clearTopicCache() {
  vecCache.clear()
}

/**
 * 取最近几天活动的意图向量。
 *
 * 一次查出最近 40 条,缺向量的**批量**补一次 —— 不要一条一次往返。
 * 服务没起来、模型没装,就返回空数组:调用方当作"这次没有查重能力",
 * 照常去做事,不要因为查不了重就不让她做事。
 */
export async function recentIntentVectors(db, embedder, now, options = {}) {
  const days = options.windowDays ?? TOPIC_WINDOW_DAYS
  const limit = options.limit ?? 40
  const since = now - days * 86400_000
  const rows = db
    .prepare(
      `SELECT id, ts, category, intent FROM events
       WHERE kind = 'activity' AND ts >= ?
         AND intent IS NOT NULL AND length(trim(intent)) > 0
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(since, limit)

  const missing = rows.filter((r) => !vecCache.has(Number(r.id)))
  if (missing.length) {
    const vecs = await embedder.embed(missing.map((r) => String(r.intent)))
    if (Array.isArray(vecs) && vecs.length === missing.length) {
      missing.forEach((r, i) => {
        if (vecs[i]) vecCache.set(Number(r.id), vecs[i])
      })
      while (vecCache.size > CACHE_MAX) {
        vecCache.delete(vecCache.keys().next().value)
      }
    }
  }
  return rows.map((r) => ({ ...r, vec: vecCache.get(Number(r.id)) })).filter((r) => r.vec)
}

/**
 * 这次的意图,最近做过吗?
 *
 * @returns {{sim:number, event:object} | null}
 */
export async function findRepeatedTopic(db, embedder, intentText, now, options = {}) {
  if (!intentText || !embedder) return null
  const mine = await embedder.embed([String(intentText)])
  if (!Array.isArray(mine) || !mine[0]) return null
  const rows = await recentIntentVectors(db, embedder, now, options)
  const threshold = options.threshold ?? TOPIC_SIM
  let best = null
  for (const r of rows) {
    const sim = cosine(mine[0], r.vec)
    if (!best || sim > best.sim) best = { sim, event: r }
  }
  return best && best.sim >= threshold ? best : null
}

/** 和这次意图相近的几个方向(重挑时告诉写手别往这些地方去)。 */
export async function similarIntents(db, embedder, intentText, now, options = {}) {
  if (!intentText || !embedder) return []
  const limit = options.limit ?? 4
  const mine = await embedder.embed([String(intentText)])
  if (!Array.isArray(mine) || !mine[0]) return []
  const rows = await recentIntentVectors(db, embedder, now, options)
  return rows
    .map((r) => ({ sim: cosine(mine[0], r.vec), intent: String(r.intent) }))
    .filter((x) => x.sim >= (options.avoidSim ?? TOPIC_AVOID_SIM))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map((x) => x.intent)
}
