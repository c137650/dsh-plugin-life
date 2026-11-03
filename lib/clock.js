// 状态机:睡觉 / 吃饭 / 清醒。
//
// 三个基础状态,加上两个累积量驱动的转移:
//   sleepDebt  清醒时累积,睡眠时释放  -> 决定何时入睡
//   hunger     清醒时累积,进食时归零  -> 决定何时进食
//
// 时长不是固定值。第 2 天起由前 n 天的历史经"指数加权 + 收缩"估计均值,
// 再用截断正态采样,最后钳制到生理边界。

import { Rng, invertTruncatedNormalMean } from './prng.js'
import { PHYSIOLOGY, MEAL_WINDOWS, BASELINE, pickBoundary, within } from './physiology.js'

export const STATE = { SLEEP: 'sleep', EAT: 'eat', WAKE: 'wake' }

/** 均值与标准差。 */
function stats(values) {
  if (!values.length) return { mean: 0, variance: 0, n: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.length > 1
    ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
    : 0
  return { mean, variance, n: values.length }
}

/**
 * 由历史估计今天的时长分布参数。
 * 指数加权 + 向先验收缩:样本越多越信自己的历史,样本少则多信生理先验。
 *
 * 关键:返回的 `mu` 是**未截断正态的原始参数**,可以直接传给 truncatedNormal。
 * 不做这一步就会双重截断(偏差施加两次),实测多出 11 分钟/天。
 */
export function estimateDuration(history, prior, windowDays = 7, priorWeight = 0.45, bounds = null) {
  const recent = history.slice(-windowDays)
  const recentStats = stats(recent)
  const allStats = stats(history)

  // 收缩系数:样本少时 priorWeight 大
  const n = recentStats.n
  const shrink = priorWeight / (priorWeight + n * 0.55)

  // 空历史时不能用 allStats.mean(它是 0),必须直接用先验。
  const allMean = allStats.n > 0 ? allStats.mean : prior.mean

  const target = (1 - shrink) * recentStats.mean + shrink * (0.65 * allMean + 0.35 * prior.mean)
  // 标准差同样收缩,并设下限避免退化成点值
  const sigma = Math.max(prior.sigmaMin, Math.sqrt(recentStats.variance) * (1 - 0.5 * shrink))

  // 反解出原始 mu:使截断后的均值恰好等于 target
  const mu = bounds
    ? invertTruncatedNormalMean(target, sigma, bounds.min, bounds.max)
    : target

  return { mu, sigma, n, target }
}

/**
 * 求解一天三餐(或四餐)的时刻。
 *
 * 约束:
 *   - 每餐相对醒来的偏移落在"生理窗口"内(以 MEAL_WINDOWS 为锚)
 *   - 相邻两餐间隔 ∈ [minGapBetweenMeals.min, maxGapBetweenMeals.min] 的可达区间
 *   - 第一餐不早于醒来 + 45 分钟
 *   - **最后一餐必须吃完就快睡了**:结束 + 10 分钟缓冲 <= 入睡
 *   - 总清醒时长 <= maxContinuousAwake.max
 *
 * 餐数要**适应当天的清醒窗口**:四餐最少要占
 *   (第一餐 45 分钟前置) + 3 × (进食上限 45 + 最小间隔 240) = 900 分钟
 * 放不下就退到三餐。生理上 mealsPerDay 是 3~4,退到三餐不是降级。
 *
 * 做法:先按历史惯性采样出"想要的"时刻,再在**双端约束**内逐餐投影。
 * 注意不能用"整体平移 + 回补第一餐"那套 —— 那天放不下时,回补会把平移
 * 完全抵消,约束等于没有(实测:四餐的最后一顿因此吃到了入睡之后 42 分钟)。
 *
 * 投影是确定性的,所以结果仍然可重放。
 */
export function solveMealTimes({ rng, mealCount, wakeMinutes, sleepStart, history }) {
  const phy = PHYSIOLOGY
  const windows = MEAL_WINDOWS

  const gapMin = phy.minGapBetweenMeals.min
  const gapMax = phy.maxGapBetweenMeals.min
  const eatMax = phy.eatMinutes.max
  const eatMin = phy.eatMinutes.min

  // 最后一餐**结束**之后还要留 10 分钟才入睡。
  // 进食时长在求解之后才采样,这里取上限,于是开始时刻的上限是 sleepStart - 10 - eatMax。
  const lastCeiling = sleepStart - 10 - eatMax
  const firstFloor = wakeMinutes + 45

  // 目标偏移:优先用历史的(第2天起由前n天决定),第一天用生理窗口锚
  const histOffsets = history.length ? history[history.length - 1].mealOffsets : null

  // 目标时刻。**一次算全**,减少餐数时从尾部截断 —— 这样 rng 的消耗量不变,
  // 重放仍然一致。
  const targets = []
  for (let i = 0; i < mealCount; i++) {
    const win = windows[Math.min(i, windows.length - 1)]
    let offset
    if (histOffsets && histOffsets.length) {
      // 历史惯性:用历史偏移 + 小幅漂移,保留"前 n 天决定"的性质
      const base = histOffsets[Math.min(i, histOffsets.length - 1)]
      const drift = rng.normal(0, 22)
      offset = base + drift
    } else {
      // 第 1 天:生理窗口 + 抖动
      offset = win.center - BASELINE.wakeMinutes + rng.normal(0, win.spread * 0.6)
    }
    targets.push(wakeMinutes + offset)
  }

  /**
   * 在双端约束内放置 n 餐。
   *
   * 间隔口径是 end-to-start。上一餐的进食时长 d0 ∈ [eatMin, eatMax],
   * 实际空档 = t1 - (t0 + d0)。
   *   下界:要保证空档 >= gapMin,需 t1 >= t0 + eatMax + gapMin
   *   上界:要保证空档 <= gapMax,需 t1 <= t0 + eatMin + gapMax
   * 用 eatMax / eatMin 分别取最坏/最好情况,保证任何 d0 都合法。
   *
   * **必须双向**:
   *   - 反向:从"末餐上限"倒推每一餐最晚能多晚(给后面的餐留出最小间距)
   *   - 正向:按目标放置,并夹在 [前餐下界, 本餐上界] 之间
   *
   * 只做正向会出事:历史偏移每天漂移,目标会越推越晚,
   * 而"下界"来自前一餐、"上界"来自入睡时刻,两者一撞就死结 ——
   * 实测 365 天链上从第 289 天起连续崩,末餐排到了入睡之后一小时。
   */
  const place = (n) => {
    // 反向:最晚时刻
    const latest = new Array(n)
    latest[n - 1] = lastCeiling
    for (let i = n - 2; i >= 0; i--) latest[i] = latest[i + 1] - (eatMax + gapMin)

    // 正向:放置
    const t = []
    t[0] = Math.min(Math.max(targets[0], firstFloor), latest[0])
    for (let i = 1; i < n; i++) {
      const prev = t[i - 1]
      const lo = prev + eatMax + gapMin
      const hi = Math.min(prev + eatMin + gapMax, latest[i])
      // lo <= hi 恒成立(latest[i] >= lo,因为 t[i-1] <= latest[i-1])
      t[i] = Math.min(Math.max(targets[i], lo), Math.max(lo, hi))
    }
    return t
  }

  // 餐数适应清醒窗口:放不下就退一餐,直到可行。
  //
  // n 餐的最小跨度 = (n-1) × (eatMax + gapMin),而且第一餐不能早于 wake+45、
  // 末餐不能晚于 lastCeiling,所以要求:
  //   wake + 45 + (n-1) × 285 <= lastCeiling
  let n = mealCount
  while (n > phy.mealsPerDay.min && firstFloor > lastCeiling - (n - 1) * (eatMax + gapMin)) n--

  return place(n)
}

/**
 * 一天的作息:由若干状态段构成。
 * segments: [{state, startMin, endMin, durationMin}]
 */
export function planDay(dayIndex, history, rngSeedBase) {
  const rng = new Rng(rngSeedBase)

  // ---- 睡眠时长 ----
  const sleepPrior = {
    mean: (PHYSIOLOGY.sleepMinutes.min + PHYSIOLOGY.sleepMinutes.max) / 2,
    sigmaMin: 25,
  }
  const sleepEst = estimateDuration(
    history.map((h) => h.sleepDuration),
    sleepPrior,
    7,
    0.45,
    PHYSIOLOGY.sleepMinutes,
  )
  let sleepDuration = Math.round(
    rng.truncatedNormal(
      sleepEst.mu,
      sleepEst.sigma,
      PHYSIOLOGY.sleepMinutes.min,
      PHYSIOLOGY.sleepMinutes.max,
    ),
  )

  // ---- 醒来时刻 ----
  // 由历史的入睡/醒来时刻分布估计,不是固定 7 点。
  const wakePrior = { mean: BASELINE.wakeMinutes, sigmaMin: 30 }
  const wakeEst = estimateDuration(
    history.map((h) => h.wakeMinutes),
    wakePrior,
    7,
    0.45,
    { min: 4 * 60, max: 11 * 60 },
  )
  let wakeMinutes = Math.round(
    rng.truncatedNormal(wakeEst.mu, wakeEst.sigma, 4 * 60, 11 * 60),
  )

  // ---- 入睡时刻:必须与"醒来时刻"和"睡眠时长"自洽 ----
  //
  // 一天只有 1440 分钟。既然今天 W 点醒来、昨晚睡了 D 分钟,那么
  // 今晚的入睡时刻必然是 W + (1440 - D):这样睡满 D 分钟之后,
  // 明天又在同一时刻醒来,整条时间线闭环。
  //
  // 早先的写法是 sleepStart = wakeMinutes + awakeCap,而 awakeCap 从
  // "最长连续清醒"(13-16 小时)里取 —— 于是 06:27 起床的人被判成 19:37 入睡,
  // 而且和睡眠时长自相矛盾(按 D=451 分钟算应当 22:56 入睡)。
  // 现在 awakeCap 只是"清醒窗口"的另一个说法,不再是独立采样。
  const awakeWindow = 1440 - sleepDuration
  const sleepStart = wakeMinutes + awakeWindow

  // ---- 餐数 ----
  const mealCount = rng.int(PHYSIOLOGY.mealsPerDay.min, PHYSIOLOGY.mealsPerDay.max)

  // ---- 餐点相对清醒起点的偏移 ----
  // 历史上有 mealOffsets(分钟,从醒来算起),第一天用 MEAL_WINDOWS 的基线。
  const mealOffsets = history.length
    ? history[history.length - 1].mealOffsets
    : MEAL_WINDOWS.map((m) => m.center - BASELINE.wakeMinutes)

  const segments = []
  let cursor = wakeMinutes

  // 睡眠段(今天凌晨结束的那一觉)。
  //
  // 锚点必须是**醒来时刻**,不是今晚入睡时刻。
  // 用 sleepStart - sleepDuration 会把这一觉放到白天(例如 12:06-19:37),
  // 并且与后面的清醒段重叠 —— 表现为每天下午都在睡觉。
  // 正确区间 [wakeMinutes - sleepDuration, wakeMinutes],
  // startMin 允许为负(表示跨到前一天),比较时按分钟数直接比即可。
  segments.push({
    state: STATE.SLEEP,
    startMin: wakeMinutes - sleepDuration,
    endMin: wakeMinutes,
    durationMin: sleepDuration,
  })

  // ---- 餐点求解 ----
  //
  // 不能直接用历史偏移:那些偏移本身是上一轮的结果,误差会逐日累积,
  // 表现为餐点全部挤到早上、间隔越界。
  //
  // 正确做法:把一天当成一条**受约束的链**来解。
  //   每餐落在它自己的"生理窗口"内(相对醒来的偏移),
  //   相邻两餐的间隔落在 [minGap, maxGap] 内,
  //   两端锚定:第一餐不能太晚,最后一餐必须早于入睡。
  //
  // 求解方式是**在窗口内采样 + 约束投影**:
  // 先从历史分布采样目标偏移,再把违反间隔约束的部分投影回可行区间。
  // 这样既有历史惯性(第2天起由前n天决定),又不会跑出生理边界。

  const wakeSpan = sleepStart - wakeMinutes
  const mealPlan = solveMealTimes({
    rng,
    mealCount,
    wakeMinutes,
    sleepStart,
    history,
  })

  // 清醒 + 进食交替
  for (let i = 0; i < mealPlan.length; i++) {
    const mealStart = Math.round(mealPlan[i])
    const mealDuration = rng.int(PHYSIOLOGY.eatMinutes.min, PHYSIOLOGY.eatMinutes.max)

    // 清醒段
    if (mealStart > cursor) {
      segments.push({
        state: STATE.WAKE,
        startMin: cursor,
        endMin: mealStart,
        durationMin: mealStart - cursor,
      })
    }
    // 进食段
    const mealEnd = mealStart + mealDuration
    segments.push({
      state: STATE.EAT,
      startMin: mealStart,
      endMin: mealEnd,
      durationMin: mealDuration,
      mealIndex: i,
    })
    cursor = mealEnd
  }

  // 最后的清醒段
  if (sleepStart > cursor) {
    segments.push({
      state: STATE.WAKE,
      startMin: cursor,
      endMin: sleepStart,
      durationMin: sleepStart - cursor,
    })
  }

  // 排序并合并同类
  segments.sort((a, b) => a.startMin - b.startMin)

  const actualSleep = segments
    .filter((s) => s.state === STATE.SLEEP)
    .reduce((a, s) => a + s.durationMin, 0)
  const actualWake = segments
    .filter((s) => s.state === STATE.WAKE)
    .reduce((a, s) => a + s.durationMin, 0)
  const actualMeals = segments.filter((s) => s.state === STATE.EAT)

  // 校验并修正
  // 间隔口径:**上一餐结束到下一餐开始**(真实空档)。
  // 这是生理上"饿多久"的口径,也是约束投影里使用的口径。
  const mealGaps = []
  for (let i = 1; i < actualMeals.length; i++) {
    mealGaps.push(actualMeals[i].startMin - actualMeals[i - 1].endMin)
  }
  const gapViolations = mealGaps.filter(
    (g) => g < PHYSIOLOGY.minGapBetweenMeals.min || g > PHYSIOLOGY.maxGapBetweenMeals.max,
  )

  return {
    dayIndex,
    segments,
    wakeMinutes,
    sleepDuration: actualSleep,
    sleepStart,
    wakeDuration: actualWake,
    mealCount: actualMeals.length,
    mealOffsets: actualMeals.map((m) => m.startMin - wakeMinutes),
    mealGaps,
    gapViolations,
    continuousWakeMax: maxContinuous(segments),
    estimate: { sleepEst, n: sleepEst.n },
  }
}

/** 最长的连续清醒段。 */
export function maxContinuous(segments) {
  let best = 0
  let current = 0
  for (const seg of segments) {
    if (seg.state === STATE.WAKE) {
      current += seg.durationMin
      if (current > best) best = current
    } else {
      current = 0
    }
  }
  return best
}

/**
 * 把一天的计划压成一段可读的节律。
 *
 * 只给舰长看(status.json),**不进 prompt** ——
 * 布洛妮娅自己不该知道"下次活动在几分钟后",那会把调度表混进她的自我认知。
 */
export function planSummary(plan, dateISO) {
  if (!plan) return null
  const clock = (m) => {
    const x = ((Math.round(m) % 1440) + 1440) % 1440
    return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0')
  }
  const segs = (plan.segments || []).map((s) => ({
    state: s.state,
    from: clock(s.startMin),
    to: clock(s.endMin),
    // 原始分钟数:startMin 可能为负或超过 1440,排序要靠它,不能靠钟点字符串
    startMin: Math.round(s.startMin),
    endMin: Math.round(s.endMin),
    durationMin: s.durationMin ?? Math.round(s.endMin - s.startMin),
    // 起点为负 = 这段在前一天就开始了(今天凌晨那觉)
    startsPrevDay: s.startMin < 0,
  }))

  // 今晚的睡眠段不在 segments 里 —— segments 里的那段是"今天凌晨结束的那一觉"。
  // 摘要要完整,所以补上,并标出它跨到明天。
  const sleepStart = Number(plan.sleepStart) || 0
  if (sleepStart > 0) {
    segs.push({
      state: STATE.SLEEP,
      from: clock(sleepStart),
      to: clock(plan.wakeMinutes),
      startMin: Math.round(sleepStart),
      endMin: Math.round(sleepStart) + Math.round(plan.sleepDuration),
      durationMin: plan.sleepDuration,
      startsPrevDay: false,
      tonight: true,
    })
  }

  // 边角:餐点求解器约束的是"餐开始早于入睡",但一餐的**结束**可能越过入睡时刻。
  // 越过去之后那一段作息在时间轴上是重叠的,摘要里如实标出来。
  const lastEatEnd = Math.max(
    0,
    ...(plan.segments || []).filter((s) => s.state === STATE.EAT).map((s) => s.endMin),
  )
  const overrun = lastEatEnd > sleepStart

  return {
    day: dateISO,
    wakeAt: clock(plan.wakeMinutes),
    sleepAt: clock(sleepStart),
    sleepDurationMin: plan.sleepDuration,
    wakeDurationMin: plan.wakeDuration,
    mealCount: plan.mealCount,
    mealGapsMin: plan.mealGaps,
    gapViolations: plan.gapViolations?.length ?? 0,
    mealOverrunsSleepAt: overrun,
    segments: segs,
  }
}

/** 把分钟数格式化成 HH:MM。 */
export function formatMin(min) {
  const m = ((Math.floor(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
