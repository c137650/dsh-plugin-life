/**
 * 排期的落盘与判定。
 *
 * 为什么必须落盘:排期只存在内存里的话,DSH 一下线,那个"本该在几点做的事"
 * 就跟着消失了 —— 也就无从知道它被错过了。
 *
 * 记录格式:
 *   { at: 计划执行的时刻(ms), state: 'scheduled' | 'running' }
 *
 * 'running' 表示活动已经开工但没做完(中途断电/被杀)—— 同样算错过,
 * 因为那件事实际上没有完成。
 *
 * 这个模块是纯函数 + 一条 SQL,不依赖插件的其它部分,便于单独测。
 */
import { getMeta, setMeta } from './db.js'

export const PENDING_KEY = 'pendingActivity'

/**
 * 写下排期。
 * @param {object} db
 * @param {number} at     计划执行的时刻(ms)
 * @param {'scheduled'|'running'} state
 * @param {boolean} [fits] 这个活动在它排定的时刻放不放得下当前清醒段。
 *   放不下 = 它本来就在边界上(离下一段开始不到一个活动那么久),
 *   开机时判断"该不该谴责"要用 —— 这种活动没做成不算被耽误。
 */
export function writePending(db, at, state = 'scheduled', fits = true) {
  setMeta(db, PENDING_KEY, JSON.stringify({ at: Math.round(at), state, fits: fits !== false }))
}

/** 读回排期。读不到或格式不对就返回 null。 */
export function readPending(db) {
  const raw = getMeta(db, PENDING_KEY, '')
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    if (!obj || !Number.isFinite(Number(obj.at))) return null
    return {
      at: Number(obj.at),
      state: obj.state === 'running' ? 'running' : 'scheduled',
      // 老记录没有这个字段 —— 当时还没这个判断,一律当成"放得下"。
      fits: obj.fits === false ? false : true,
    }
  } catch {
    return null
  }
}

/** 清掉排期。 */
export function clearPending(db) {
  setMeta(db, PENDING_KEY, '')
}

/**
 * 判定排期现在算什么。
 *
 * @param {null|{at:number,state:string}} pending
 * @param {number} now
 * @returns {{kind:'none'|'future'|'missed', at?:number, delayMinutes?:number, state?:string}}
 *
 *   none   —— 没有排期记录
 *   future —— 还没到点,排期仍然有效(重启不该打乱作息)
 *   missed —— 已经过了,这件事没做成
 */
export function classifyPending(pending, now = Date.now()) {
  if (!pending || !Number.isFinite(Number(pending.at))) return { kind: 'none' }
  const at = Number(pending.at)
  if (at > now) return { kind: 'future', at, state: pending.state }
  return {
    kind: 'missed',
    at,
    state: pending.state,
    delayMinutes: Math.max(0, Math.round((now - at) / 60_000)),
  }
}

/**
 * 到点了,但这一轮**还该不该做**活动?
 *
 * 只看一件事:剩下的清醒时间够不够做完一次活动。
 *
 * 注意**不能**拿"到下一次活动的间隔"做判据 ——
 * 那个间隔的均值有一百多分钟(nextGapMinutes(0.5) ≈ 119),
 * 而清醒段通常只有三五个小时,拿它做判据会几乎永远判成"来不及",
 * 活动就一直被推迟,排期反复往后挪。
 * 实测(2026-10-28 上午 10:44):距下一顿饭还有 65 分钟,被判成"来不及",
 * 于是 10:43:34 的活动被推到 10:55:34,再推、再推。
 *
 * @param {number} minutesNow      当前是当天第几分钟
 * @param {number} nextBoundaryMin 下一个时段(吃饭/睡觉)开始的分钟
 * @param {number} slotMin         一次活动至少需要的时长
 */
export function canStartActivity(minutesNow, nextBoundaryMin, slotMin = 10) {
  return minutesNow + slotMin < nextBoundaryMin
}

/**
 * 一个过期的排期,到底算不算"被耽误"?
 *
 * 舰长定的三条:
 *   1) 排期落在**本次与上一次心跳之间** → 心跳只是还没轮到,没耽误
 *      (四分钟一次的心跳,到点后最多晚四分钟才被看见 —— 这不算耽误)
 *   2) 排期**本来就在边界上** → 它本来也会被推迟,没做成不算耽误
 *   3) 其余 → 真的被耽误了 → 挂一条随延迟加重的谴责
 *
 * 规则 1 要配一个前提:**迟到量不超过一个心跳周期**。
 * 只看"落在两次心跳之间"是不够的 —— 关机三小时,排期恰好落在
 * 最后一次心跳和这次开机之间,字面上符合,但那显然是耽误。
 * 加上这个前提之后,"没耽误"只剩下一种情形:
 * 电脑只离线了很短一段,活动到点时心跳还没轮到,开机后几分钟内就补上了。
 *
 * @param {object} p
 * @param {number} p.scheduledAt 排期时刻(ms)
 * @param {number} p.lastTickAt  上一次心跳的时刻(ms),0 = 从来没心跳过
 * @param {boolean} p.atBoundary 这个活动排定时放不放得下当前清醒段
 * @param {number} p.now         现在
 * @param {number} p.tickMs       心跳周期
 */
export function judgeMissed({
  scheduledAt,
  lastTickAt = 0,
  atBoundary = false,
  state = 'scheduled',
  now = Date.now(),
  tickMs = 240_000,
}) {
  const lateness = Math.max(0, now - scheduledAt)
  // 排期落在"上一次心跳"和"本次心跳"之间 —— 本次心跳是第一个能抓得住它的。
  const betweenHeartbeats = lastTickAt > 0 && scheduledAt > lastTickAt
  // 迟到量没有超过一个心跳周期 —— 真的只是心跳还没轮到。
  const withinTick = lateness <= tickMs
  const heartbeatLate = betweenHeartbeats && withinTick
  // 活动进行到一半 DSH 下线 —— 那件事不是"没做成",是"做了一半被掐断"。
  // 上线把它接着做完就是了,不该挂谴责(舰长:"不产生任何其他结果")。
  const interrupted = state === 'running'
  const delayed = !heartbeatLate && !atBoundary && !interrupted
  return {
    betweenHeartbeats,
    withinTick,
    heartbeatLate,
    interrupted,
    atBoundary: !!atBoundary,
    delayed,
    delayMinutes: Math.round(lateness / 60_000),
  }
}
