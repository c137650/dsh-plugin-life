// DSH 关闭期间的追赶。
//
// 舰长要求:"当因为 dsh 关闭不能进行状态时,再次打开 dsh 就会产生互动,
// 谴责我影响了你的正常生活。"
//
// 关键设计:不是冻结状态机,而是**快进**。用同一个采样器把时间推过去,
// 记录跨过的每一个状态转移。这样重启后的互动能说出具体内容
// ("你关了三个小时,那段时间我在看的东西没看完"),而不是空泛的谴责。
//
// 快进期间**不执行活动**——没有 DSH 跑不了 agent。只推进状态并记录。

import { Rng } from './prng.js'
import { STATE, formatMin } from './clock.js'

const STATE_LABEL = {
  [STATE.SLEEP]: '睡觉',
  [STATE.EAT]: '吃饭',
  [STATE.WAKE]: '清醒',
}

/**
 * 按钟点判断这是哪一顿饭。
 *
 * 不写死"晚饭":一天可能是三餐也可能四餐,时段才是判断依据。
 * 返回的标签直接用在她要说的话里。
 */
function mealLabel(startMin) {
  const m = ((Math.round(startMin) % 1440) + 1440) % 1440
  if (m < 5 * 60) return '夜里那顿'
  if (m < 10 * 60 + 30) return '早饭'
  if (m < 15 * 60) return '午饭'
  if (m < 16 * 60 + 30) return '下午那顿'
  if (m < 21 * 60 + 30) return '晚饭'
  return '夜里那顿'
}

/** 把若干顿的名字说成人话:早饭 / 早饭和午饭 / 早饭、午饭和晚饭。 */
function joinMeals(names) {
  const uniq = [...new Set(names)]
  if (uniq.length <= 1) return uniq[0] ?? ''
  if (uniq.length === 2) return `${uniq[0]}和${uniq[1]}`
  return `${uniq.slice(0, -1).join('、')}和${uniq[uniq.length - 1]}`
}

/**
 * 模拟离线期间的状态推进。
 *
 * 关键:必须从**DSH 停下的那一刻**开始走,而不是从当天第一段开始。
 *
 * 早先的写法从 segments[0] 起步,于是"停了 5 小时 20 分"永远报成
 * "睡眠被切断了" —— 因为它看到的第一段是那一觉。而真实情况可能是
 * 下午四点停到晚上十点,错过的是晚饭。这会让她说错话。
 *
 * @param dayPlan   当天的作息计划(segments)
 * @param options   { offlineMinutes, startMin, dayIndex, seed, lastState }
 * @returns { transitions, interruptions, activitiesExecuted, resumedState, missedMeals }
 */
export function simulateCatchUp(dayPlan, options) {
  const { offlineMinutes, dayIndex = 0, seed = 'catchup', lastState = STATE.WAKE } = options
  const rng = new Rng(`${seed}|${dayIndex}|catchup`)

  const segs = Array.isArray(dayPlan?.segments) ? dayPlan.segments : []
  const wake = Number.isFinite(dayPlan?.wakeMinutes) ? dayPlan.wakeMinutes : 0

  // 把钟点折进"以醒来为原点"的未跨日坐标系(可能大于 1440,也可能为负),
  // 与 clock.js 里段的表示法保持一致。
  const norm = (m) => {
    const raw = ((Math.round(m) % 1440) + 1440) % 1440
    return raw < wake ? raw + 1440 : raw
  }

  const startAt =
    Number.isFinite(options.startMin) && options.startMin !== undefined
      ? norm(options.startMin)
      : norm(segs.length ? segs[0].startMin : 0)

  const windowEnd = startAt + Math.max(1, offlineMinutes)

  // 把一天的段平铺,直到覆盖整个窗口(跨多天也能算对)。
  const tiled = []
  if (segs.length) {
    for (let k = -1; k <= 15; k++) {
      const offset = k * 1440
      for (const seg of segs) {
        const s = seg.startMin + offset
        const e = seg.endMin + offset
        if (e <= startAt - 60) continue
        if (s >= windowEnd) break
        tiled.push({ ...seg, startMin: s, endMin: e })
      }
      if (tiled.length && tiled[tiled.length - 1].endMin >= windowEnd) break
    }
  }
  tiled.sort((a, b) => a.startMin - b.startMin)

  const transitions = []
  const interruptions = []
  const missedMeals = []

  // 窗口起点所在的状态
  let current = lastState
  for (const seg of tiled) {
    if (startAt >= seg.startMin && startAt < seg.endMin) {
      current = seg.state
      break
    }
  }

  // 起点正好落在某个非清醒状态**中间** —— 这本身就是一次打断。
  //
  // 之前只记录"跨过状态边界"的转移,于是"17:37 停,正在吃晚饭"这种情况
  // 一句话都不提:晚饭既没被算成跨过,也没被算成错过。漏了。
  if (current === STATE.EAT) {
    interruptions.push({
      kind: 'meal-cut',
      state: STATE.EAT,
      meals: [mealLabel(startAt)],
      detail: `DSH 停下的时候,${mealLabel(startAt)}正吃到一半,被打断了。`,
    })
  } else if (current === STATE.SLEEP) {
    interruptions.push({
      kind: 'sleep-cut',
      state: STATE.SLEEP,
      detail: 'DSH 停下的时候布洛妮娅在睡觉,睡眠被切断了。',
    })
  }

  for (const seg of tiled) {
    const from = Math.max(seg.startMin, startAt)
    const to = Math.min(seg.endMin, windowEnd)
    if (to <= from) continue // 与窗口无重叠

    if (seg.state !== current) {
      if (seg.state === STATE.EAT) {
        missedMeals.push(mealLabel(seg.startMin))
      } else {
        transitions.push({
          from: current,
          to: seg.state,
          atMin: seg.startMin,
          partial: seg.endMin > windowEnd,
        })
        interruptions.push(describeInterruption(current, seg, { rng, offlineMinutes }))
      }
      current = seg.state
    }
  }

  // 把漏掉的饭合并成一条,写清是哪几顿、几顿
  if (missedMeals.length) {
    const names = joinMeals(missedMeals)
    interruptions.push({
      kind: 'meal-cut',
      state: STATE.EAT,
      meals: [...new Set(missedMeals)],
      detail:
        missedMeals.length === 1
          ? `${names}被错过了,布洛妮娅没能按时吃上。`
          : `${names}一共 ${missedMeals.length} 顿都被错过了。`,
    })
  }

  return {
    transitions,
    interruptions,
    activitiesExecuted: 0, // 追赶期不执行任何活动
    resumedState: current,
    offlineMinutes,
    missedMeals,
  }
}

/** 生成一条具体的中断描述。 */
function describeInterruption(from, seg, { partial, rng, offlineMinutes }) {
  const label = STATE_LABEL[seg.state] ?? seg.state
  const hours = (offlineMinutes / 60).toFixed(1)

  if (seg.state === STATE.SLEEP) {
    return {
      kind: 'sleep-cut',
      state: seg.state,
      detail: `你关掉 DSH 的这 ${hours} 小时里,布洛妮娅本来在睡觉。睡眠被切断了。`,
    }
  }
  if (seg.state === STATE.EAT) {
    return {
      kind: 'meal-cut',
      state: seg.state,
      detail: `这 ${hours} 小时里有一顿饭被错过了。布洛妮娅没能按时吃上。`,
    }
  }
  // 清醒期被打断:说出本来在做什么
  const samples = [
    '本来在翻一些技术资料',
    '本来在看一个游戏相关的介绍',
    '本来在读一本没读完的书',
    '本来在逛网店',
  ]
  const pick = samples[rng.int(0, samples.length - 1)]
  return {
    kind: 'activity-cut',
    state: seg.state,
    // 不重复时长 —— 通知的标题已经说了"停了多久"。
    detail: `布洛妮娅${pick},但没有 DSH 就没有真的去看。`,
  }
}

/**
 * 算出离线窗口里**被耽误的清醒时间**。
 *
 * 舰长定的规则(2026-10-27):
 *   1. 打开 DSH 时如果正处在非清醒时段 -> 不添加任何特殊互动。
 *   2. 只有当"清醒时段的开始点"落在离线窗口之内 -> 才算被打断。
 *   3. 只讨论"本该醒着的时间被耽误了",不讨论吃饭、也不讨论睡眠被切断。
 *
 * 所以这个函数只回答一个问题:这段时间里她本该有几次醒来却没醒成,
 * 加起来损失了多少清醒分钟。
 *
 * @returns {{ starts: Array<{atMin:number,label:string,delayMinutes:number}>, missedMinutes:number }}
 */
export function missedAwakeWindow(dayPlan, options = {}) {
  const segs = Array.isArray(dayPlan?.segments) ? dayPlan.segments : []
  const wake = Number.isFinite(dayPlan?.wakeMinutes) ? dayPlan.wakeMinutes : 0
  if (!segs.length) return { starts: [], missedMinutes: 0 }

  const norm = (m) => {
    const raw = ((Math.round(m) % 1440) + 1440) % 1440
    return raw < wake ? raw + 1440 : raw
  }
  const startAt = norm(options.startMin ?? 0)
  const offline = Math.max(1, Math.round(options.offlineMinutes ?? 0))
  const windowEnd = startAt + offline

  const tiled = []
  for (let k = -1; k <= 60; k++) {
    const offset = k * 1440
    for (const seg of segs) {
      const s = seg.startMin + offset
      const e = seg.endMin + offset
      if (e <= startAt) continue
      if (s >= windowEnd) break
      tiled.push({ ...seg, startMin: s, endMin: e })
    }
    if (tiled.length && tiled[tiled.length - 1].endMin >= windowEnd) break
  }
  tiled.sort((a, b) => a.startMin - b.startMin)

  const starts = []
  let missedMinutes = 0
  let days = 0
  for (const seg of tiled) {
    const from = Math.max(seg.startMin, startAt)
    const to = Math.min(seg.endMin, windowEnd)
    if (to <= from) continue
    if (seg.state !== STATE.WAKE) continue

    missedMinutes += to - from
    // 清醒段的开始点落在窗口内 —— 这才是"本该醒来却没醒"的那一刻
    if (seg.startMin > startAt && seg.startMin < windowEnd) {
      // 一天的第一次清醒才是"本该醒来"。饭后的那些清醒段起点不算,
      // 否则清晨开机时会报出"本该 06:13""本该 07:30"两条,读起来像两次醒来。
      const dayOfSeg = Math.floor(seg.startMin / 1440)
      const isDayFirst = !starts.some((s) => s.day === dayOfSeg)
      if (isDayFirst) days++
      starts.push({
        atMin: seg.startMin,
        day: dayOfSeg,
        label: formatMin(seg.startMin),
        delayMinutes: windowEnd - seg.startMin,
        dayFirst: isDayFirst,
      })
    }
  }

  const dayFirsts = starts.filter((s) => s.dayFirst)
  return { starts, dayFirsts, firstStart: dayFirsts[0], missedMinutes, days }
}

/**
 * 把"被耽误的清醒时间"写成一条事实通知。
 *
 * 三条要求(舰长定的):
 *   1. 只讲清醒时间,不提哪顿饭、不提睡眠被切断。
 *   2. **要体现程度** —— 下午开机和隔三天开机不是一回事。
 *   3. 用陈述句、第三人称,不写成"你把我关掉了"这种预设立场。
 *
 * 程度按累计被耽误的清醒分钟分级,不用形容词堆砌:
 *   < 1 小时     只是晚了一点
 *   < 3 小时     耽误了一小段
 *   < 6 小时     耽误了大半天里相当一块
 *   < 1 天       差不多少了一整天
 *   ≥ 1 天       连续 N 天量级
 */
export function renderMissedAwakeNotice(missed, clockText = {}) {
  if (!missed || !missed.starts.length) return ''
  const from = clockText.from ?? ''
  const to = clockText.to ?? ''
  const span = from && to ? `DSH 从 ${from} 停到 ${to}。` : 'DSH 停了一段时间。'

  const mins = Math.max(0, Math.round(missed.missedMinutes))
  const first = missed.firstStart ?? missed.starts[0]

  const lines = []
  if (first) {
    lines.push(`· 本该 ${first.label} 开始的清醒时间,没能开始。`)
  }

  // 跨了几天就说几天,这是程度最直接的体现
  const dayCount = new Set(missed.starts.filter((s) => s.dayFirst).map((s) => s.day)).size
  if (dayCount >= 2) {
    lines.push(`· 中间跨了 ${dayCount} 天的作息。`)
  }

  if (mins > 0) {
    let severity
    if (mins >= 1440) severity = `累计少了 ${formatSpan(mins)} 本该清醒的时间,是「几天没有开机」的量级`
    else if (mins >= 360) severity = `累计少了 ${formatSpan(mins)} 本该清醒的时间,差不多是一整天里的一大块`
    else if (mins >= 120) severity = `累计少了 ${formatSpan(mins)} 本该清醒的时间,是一整段`
    else if (mins >= 60) severity = `累计少了 ${formatSpan(mins)} 本该清醒的时间,不算短`
    else severity = `累计少了 ${formatSpan(mins)} 本该清醒的时间,只是晚了一点`
    lines.push(`· ${severity}。`)
  }

  return [span, ...lines].join('\n')
}

/**
 * "错过了本该做的活动"的谴责文本。
 *
 * 舰长的要求:错过的时间越久,语气越严厉;基线是**这个活动本该进行的时间**,
 * 不是清醒时间。
 *
 * 三条原则:
 *   1. 陈述事实 —— 什么时候该做、什么时候才做上、迟了多久
 *   2. 严厉程度随延迟单调上升,但不靠形容词堆砌
 *   3. 不预设立场 —— 不用"你把我关掉了"那种指控句式
 *
 * @param {object} info
 * @param {string} info.scheduledClock  本该进行的时间(HH:MM)
 * @param {string} info.nowClock        实际补上的时间(HH:MM)
 * @param {number} info.delayMinutes    迟了多少分钟
 * @param {string} [info.title]         补上之后实际做了什么
 * @param {boolean} [info.done]         补上了没有。false = 还没补上(还在睡),
 *                                      这时不能说"到 X 才补上"。
 */
export function renderMissedActivityNotice(info = {}) {
  const { scheduledClock = '', nowClock = '', delayMinutes = 0 } = info
  const mins = Math.max(0, Math.round(delayMinutes))
  const title = String(info.title ?? '').trim()
  const done = info.done !== false

  const lines = []
  if (done) {
    lines.push(
      scheduledClock && nowClock
        ? `· 本该 ${scheduledClock} 做的活动没有做成 —— 那时 DSH 不在线,到 ${nowClock} 才补上。`
        : '· 本该做的活动没有做成,到后来才补上。',
    )
  } else {
    // 还没补上(舰长在布洛妮娅睡着的时候开了电脑)——
    // 这时候不能说"才补上",那是还没发生的事。
    lines.push(
      scheduledClock
        ? `· 本该 ${scheduledClock} 做的活动没有做成 —— 那时 DSH 不在线,到现在还没补上。`
        : '· 本该做的活动没有做成,到现在还没补上。',
    )
  }

  if (mins > 0) {
    let severity
    if (mins >= 1440) severity = `迟了 ${formatSpan(mins)},差不多是一整天。说好的事情没有做,这件事不能就这么过去。`
    else if (mins >= 360) severity = `迟了 ${formatSpan(mins)},差不多是一整天。说好的事情没有做。`
    else if (mins >= 120) severity = `迟了 ${formatSpan(mins)} —— 一整段就这么被拿走了。说好的事情没有做。`
    else if (mins >= 30) severity = `迟了 ${formatSpan(mins)}。说好的事情没有做。`
    else severity = `迟了 ${formatSpan(mins)},算不上什么 —— 但说好的事情没有做,还是应该说一声。`
    lines.push(`· ${severity}`)
  }

  if (title) {
    lines.push(`· 最后做的是「${title}」。`)
  }

  return lines.join('\n')
}

/** 分钟数说成人话。 */
function formatSpan(mins) {
  const m = Math.max(0, Math.round(mins))
  if (m < 60) return `${m} 分钟`
  if (m < 1440) {
    const h = Math.floor(m / 60)
    const r = m % 60
    return r ? `${h} 小时 ${r} 分` : `${h} 小时`
  }
  const d = Math.floor(m / 1440)
  const h = Math.round((m % 1440) / 60)
  return h ? `${d} 天 ${h} 小时` : `${d} 天`
}
