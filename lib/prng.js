// 确定性 PRNG 与采样原语。
// 不用 Math.random():不可重放就无法调试、无法审计、无法解释"那天为什么这么决定"。
//
// 实现:xoshiro128** 4x32bit。种子来自 sha256,保证同输入同输出。

import { createHash } from 'node:crypto'

/** 从任意字符串派生 4 个 uint32 种子。 */
export function seedFrom(str) {
  const digest = createHash('sha256').update(String(str)).digest()
  return [
    digest.readUInt32LE(0),
    digest.readUInt32LE(4),
    digest.readUInt32LE(8),
    digest.readUInt32LE(12),
  ]
}

/** xoshiro128** 发生器。 */
/** 32 位循环左移。 */
function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0
}

/**
 * xoshiro128** 发生器。
 *
 * 状态更新严格按参考实现:
 *   result = rotl(s[1]*5, 7) * 9
 *   t = s[1] << 9          (必须在 xor 链之前捕获)
 *   s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]
 *   s[2] ^= t
 *   s[3] = rotl(s[3], 11)
 */
export class Rng {
  constructor(seedInput) {
    const s = typeof seedInput === 'string' ? seedFrom(seedInput) : seedInput
    if (!Array.isArray(s) || s.length !== 4) throw new Error('Rng seed must be 4 uint32 values')
    this.s = Uint32Array.from(s)
    if ((this.s[0] | this.s[1] | this.s[2] | this.s[3]) === 0) this.s[0] = 1
    this.calls = 0
    // 预热:种子直接填入状态时,前几个输出会带有种子结构。
    // 丢弃 16 个输出再开始使用。
    for (let i = 0; i < 16; i++) this.nextU32()
    this.calls = 0
  }

  /** 下一个 uint32。 */
  nextU32() {
    const s = this.s
    const r1 = Math.imul(s[1], 5) >>> 0
    const result = Math.imul(rotl(r1, 7), 9) >>> 0
    const t = (s[1] << 9) >>> 0
    s[2] ^= s[0]
    s[3] ^= s[1]
    s[1] ^= s[2]
    s[0] ^= s[3]
    s[2] ^= t
    s[3] = rotl(s[3], 11)
    this.calls++
    return result
  }

  /** [0,1) 均匀分布。 */
  float() {
    return this.nextU32() / 4294967296
  }

  /** [lo,hi) 均匀分布。 */
  uniform(lo, hi) {
    return lo + this.float() * (hi - lo)
  }

  /** [lo,hi] 闭区间整数。 */
  int(lo, hi) {
    return lo + Math.floor(this.float() * (hi - lo + 1))
  }

  /** 标准正态(Box-Muller)。 */
  normal(mu = 0, sigma = 1) {
    // 避免 log(0)
    let u = this.float()
    if (u < 1e-12) u = 1e-12
    const v = this.float()
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    return mu + sigma * z
  }

  /** 截断正态:形状由 mu/sigma 决定,硬边界由 lo/hi 钳制。 */
  truncatedNormal(mu, sigma, lo, hi, maxTries = 64) {
    if (lo > hi) throw new Error(`truncatedNormal: lo(${lo}) > hi(${hi})`)
    if (sigma <= 0) return Math.min(hi, Math.max(lo, mu))
    for (let i = 0; i < maxTries; i++) {
      const v = this.normal(mu, sigma)
      if (v >= lo && v <= hi) return v
    }
    // 退化:全部落在边界外,钳制到最近的边界
    return mu < lo ? lo : hi
  }
  /** 指数分布,均值 1/lambda。 */
  exponential(lambda = 1) {
    let u = this.float()
    if (u < 1e-12) u = 1e-12
    return -Math.log(u) / lambda
  }

  /** 按权重抽样。items: [{weight, ...}] 或 (weightOf) 形式。 */
  weightedChoice(items, weightOf = (x) => x.weight) {
    let total = 0
    for (const item of items) total += Math.max(0, weightOf(item))
    if (total <= 0) return items[Math.floor(this.float() * items.length)]
    let r = this.float() * total
    for (const item of items) {
      r -= Math.max(0, weightOf(item))
      if (r <= 0) return item
    }
    return items[items.length - 1]
  }

  /** 泊松分布(Knuth)。用于一天内的事件数。 */
  poisson(lambda) {
    if (lambda <= 0) return 0
    const L = Math.exp(-lambda)
    let k = 0
    let p = 1
    do {
      k++
      let u = this.float()
      if (u < 1e-12) u = 1e-12
      p *= u
    } while (p > L && k < 1000)
    return k - 1
  }
}

/**
 * 截断正态的真实均值 E[X | lo <= X <= hi]。
 *
 * 这是修掉"截断偏差"的关键。
 * 直接从 N(mu,sigma) 采样再钳制到 [lo,hi],得到的实际均值会**高于** mu
 * (因为下界截掉了左尾)。把这个偏差日复一日喂回估计器,均值就会单调爬升
 * (实测 365 天从 409 分钟爬到 483 分钟)。
 *
 * 正确做法:估计器直接用截断后的真实均值作为目标,偏差不再累积。
 */
export function truncatedNormalMean(mu, sigma, lo, hi) {
  if (sigma <= 0) return Math.min(hi, Math.max(lo, mu))
  const alpha = (lo - mu) / sigma
  const beta = (hi - mu) / sigma
  const cdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2))
  const pdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)
  const denom = cdf(beta) - cdf(alpha)
  if (denom < 1e-12) return Math.min(hi, Math.max(lo, mu))
  return mu + sigma * ((pdf(alpha) - pdf(beta)) / denom)
}

/**
 * 反解:求未截断正态的 mu,使截断后的均值等于 target。
 *
 * 用于"我想让采样结果的均值是 X"这种需求:
 * 直接把 X 当 mu 传给 truncatedNormal 会**双重截断**(偏差被施加两次)。
 * 正确做法是反解出原始 mu。
 */
export function invertTruncatedNormalMean(target, sigma, lo, hi) {
  if (sigma <= 0) return Math.min(hi, Math.max(lo, target))
  let a = target - 6 * sigma
  let b = target + 6 * sigma
  for (let i = 0; i < 80; i++) {
    const mid = (a + b) / 2
    if (truncatedNormalMean(mid, sigma, lo, hi) < target) a = mid
    else b = mid
  }
  return (a + b) / 2
}

/** 误差函数(Abramowitz-Stegun 7.1.26 近似,误差 < 1.5e-7)。 */
function erf(x) {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax)
  return sign * y
}

/** 组合今日种子:日期 + 状态哈希 + 事件序号。 */
export function dailySeed(dateISO, stateHash, seq = 0) {
  return `${dateISO}|${stateHash}|${seq}`
}
