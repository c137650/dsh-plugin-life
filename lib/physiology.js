// 生理约束边界。
//
// 这是整个系统里**唯一**允许写死的地方,而且写死的不是"决策",是"边界"。
//
// 舰长的要求:"算法不允许使用写死的东西",但同时"要符合正常的生理过程,
// 比如不能只睡4个小时不吃饭"。
// 这两条不矛盾:边界是物理事实(成年人每天需要睡 6 小时以上),
// 边界内的取值来自历史统计与随机采样。
//
// 如果这里出现了"每天 7 点起床"这种值,就是设计被破坏了。
// 自检:见 tools/simulate.mjs 的 assertPhysiology()。

export const PHYSIOLOGY = {
  // ---- 睡眠 ----
  // 低于 6 小时是病理性的(长期),高于 10 小时则不再是健康睡眠。
  sleepMinutes: { min: 360, max: 600 },

  // 连续清醒的上限。
  //
  // 注意:这个区间**必须由 sleepMinutes 推出**,不能独立写死。
  // 一天只有 1440 分钟,醒了多久 = 1440 - 睡眠时长:
  //   sleepMinutes [360, 600]  =>  清醒 [840, 1080](14 - 18 小时)
  //
  // 早先这里写的是 [780, 960](13 - 16 小时),和睡眠区间互相矛盾
  // (6 小时睡眠意味着清醒 18 小时,却超出 16 小时的上限),
  // 而且入睡时刻是从它推出来的,导致 06:27 起床的人 19:37 就入睡。
  maxContinuousAwake: { min: 1440 - 600, max: 1440 - 360 },

  // ---- 进食 ----
  // 一顿饭的时长。
  eatMinutes: { min: 15, max: 45 },

  // 两餐之间的最短间隔:太密会撑。
  minGapBetweenMeals: { min: 240, max: 420 },

  // 两餐之间的最长间隔:超过会饿到影响状态。
  maxGapBetweenMeals: { min: 480, max: 660 },

  // 一天至少几餐、至多几餐。
  mealsPerDay: { min: 3, max: 4 },

  // ---- 精力 ----
  // 活动之间的基础间隔(分钟),会被精力消耗放大。
  baseActivityGap: { min: 25, max: 70 },
}

// 每餐的相对时间分布(一天内的钟点,分钟)。第 1 天用作种子,之后由模型调整。
export const MEAL_WINDOWS = [
  { name: 'breakfast', center: 8 * 60, spread: 45 },
  { name: 'lunch', center: 12 * 60 + 30, spread: 40 },
  { name: 'dinner', center: 18 * 60 + 30, spread: 50 },
]

// 第 1 天的基线种子(唯一允许的"确定值")。
export const BASELINE = {
  wakeMinutes: 7 * 60,
  sleepMinutes: 23 * 60,
}

/** 把值钳制到区间内。 */
export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value
}

/**
 * 从区间配置里挑一个具体边界。
 * 边界本身也有随机性(个体差异),但始终在生理区间内。
 */
export function pickBoundary(rng, range) {
  return rng.int(range.min, range.max)
}

/** 校验一个时长是否落在生理区间内。 */
export function within(minutes, range) {
  return minutes >= range.min && minutes <= range.max
}
