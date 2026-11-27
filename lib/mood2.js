/**
 * 情绪(第二版):九根会衰减的量,按轮变化。
 *
 * 第一版是一条 if-else 链:睡着就困倦、被叫醒就烦躁,基调只有七八种,而且只在
 * 心跳时才算 —— 一分钟内连着三轮,基调一动不动,看起来像卡住了。
 *
 * 这版换成向量:
 *   每根有自己的半衰期,没事件就自己往下掉;
 *   每轮按"舰长长不长、问的是什么、布洛妮娅自己回得多不多、有没有调工具"加减;
 *   对外的样子不变,还是「情绪基调: … / 绑定: …」两行,由最高的那根换算成话。
 *
 * 九根:好奇、开心、担心、难过、闷、累、吃醋、生气、惊讶。
 */

const HOUR = 3600 * 1000

/** 每根情绪的初始值与半衰期。半衰期越长越难消散。 */
export const DIMS = {
  curiosity: { label: '好奇', halfLife: 3 * HOUR, base: 0.35 },
  joy: { label: '开心', halfLife: 2 * HOUR, base: 0.3 },
  worry: { label: '担心', halfLife: 6 * HOUR, base: 0.15 },
  sadness: { label: '难过', halfLife: 12 * HOUR, base: 0.1 },
  boredom: { label: '闷', halfLife: 8 * HOUR, base: 0.2 },
  tired: { label: '累', halfLife: 5 * HOUR, base: 0.2 },
  jealousy: { label: '吃醋', halfLife: 4 * HOUR, base: 0.05 },
  anger: { label: '生气', halfLife: 10 * HOUR, base: 0.02 },
  surprise: { label: '惊讶', halfLife: 40 * 60 * 1000, base: 0.05 },
}

/** 从零开始的一份向量。 */
export function freshVector(now = Date.now()) {
  const dims = {}
  for (const [key, spec] of Object.entries(DIMS)) dims[key] = spec.base
  return { dims, updatedAt: now }
}

/**
 * 按经过的时间衰减。
 *
 * 用半衰期公式:value * 0.5^(elapsed/halfLife)。衰减后不低于 base 的一半,
 * 免得长时间不动就全部归零,读出来像一台没感情的机器。
 */
export function decay(vector, now = Date.now()) {
  const out = freshVector(now)
  if (!vector || !vector.dims) return out
  const elapsed = Math.max(0, now - Number(vector.updatedAt || now))
  for (const [key, spec] of Object.entries(DIMS)) {
    const prev = Number(vector.dims[key])
    const start = Number.isFinite(prev) ? prev : spec.base
    const decayed = start * Math.pow(0.5, elapsed / spec.halfLife)
    out.dims[key] = Math.max(decayed, spec.base * 0.5)
  }
  out.updatedAt = now
  return out
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

/**
 * 按一轮对话加减。
 *
 * @param {{dims: object, updatedAt: number}} vector 已衰减过的向量
 * @param {{text?: string, reply?: string, toolCalls?: number, durationMs?: number, interrupted?: boolean, captainMood?: string}} turn
 */
export function bumpTurn(vector, turn = {}) {
  const v = decay(vector)
  const text = String(turn.text || '')
  const reply = String(turn.reply || '')
  const len = text.length
  const add = (key, delta) => {
    if (!Object.prototype.hasOwnProperty.call(v.dims, key)) return
    v.dims[key] = clamp01(v.dims[key] + delta)
  }

  // 舰长说话的长度:长问句偏技术,短句偏日常
  if (len > 120) {
    add('curiosity', 0.05)
    add('boredom', -0.03)
  } else if (len > 0 && len < 12) {
    add('joy', 0.02)
  }

  // 问句:为什么/怎么/能不能,都是要她想
  if (/(为什么|怎么|怎么弄|能不能|可不可以|是不是)/.test(text)) add('curiosity', 0.06)

  // 舰长口气:累、烦、开心
  if (/(累|困|烦|难受|不想)/.test(text)) {
    add('worry', 0.08)
    add('tired', 0.03)
  }
  if (/(哈哈|开心|太好了|赞|不错)/.test(text)) add('joy', 0.08)
  if (/(生气|烦死|讨厌)/.test(text)) {
    add('anger', 0.05)
    add('worry', 0.04)
  }

  // 夸她或者谢她
  if (/(谢谢|辛苦|厉害|靠谱|不错)/.test(text)) add('joy', 0.06)

  // 她回得长 = 投入;回得短 = 收着
  if (reply.length > 400) {
    add('curiosity', 0.03)
  }
  if (reply.length > 0 && reply.length < 40) add('boredom', 0.02)

  // 干了不少活 = 累一点;但做完了会有一点满足
  const tools = Number(turn.toolCalls || 0)
  if (tools >= 5) add('tired', 0.05)
  if (tools >= 10) add('tired', 0.05)

  // 被打断:睡着被叫起来会闷
  if (turn.interrupted) {
    add('tired', 0.06)
    add('boredom', 0.05)
  }

  // 长时间没有新话(上一次更新到现在超过两小时)
  const gap = Date.now() - Number(vector.updatedAt || Date.now())
  if (gap > 2 * HOUR) {
    add('jealous', 0.04)
    add('boredom', 0.05)
  }

  v.updatedAt = Date.now()
  return v
}

/** 最强的那根,以及它的强度。 */
export function dominant(vector) {
  const dims = (vector && vector.dims) || {}
  let key = ''
  let score = -1
  for (const name of Object.keys(DIMS)) {
    const v = Number(dims[name]) || 0
    if (v > score) {
      score = v
      key = name
    }
  }
  return { key, score }
}

/**
 * 把向量换算成一句话。
 *
 * 强度决定说法:0.45 以下还是原来的口气,0.65 以上才会说出具体情绪。
 * 这样大多数轮次看起来还是「平稳」,但偶尔会露出别的。
 */
export function toneOf(vector) {
  const { key, score } = dominant(vector)
  if (!key || score < 0.45) return { tone: '平稳', cause: '没什么事' }
  const strong = score >= 0.65
  const table = {
    curiosity: ['有点好奇', '盯着这件事不放'],
    joy: ['心情不错', '高兴得藏不住'],
    worry: ['有点担心', '放心不下'],
    sadness: ['有点低落', '提不起劲'],
    boredom: ['有点闷', '待不住了'],
    tired: ['有点累', '累得不想多说'],
    jealousy: ['有点在意', '心里堵着'],
    anger: ['不太高兴', '压着火'],
    surprise: ['有点意外', '愣了一下'],
  }
  const pair = table[key] || ['平稳', '没什么事']
  const tone = strong ? pair[1] : pair[0]
  return { tone, cause: DIMS[key] ? DIMS[key].label : '' }
}

/** 对外输出:和第一版一样的四个字段,外加向量本身。 */
export function moodFromVector(vector, extra = {}) {
  const v = decay(vector)
  const { tone, cause } = toneOf(v)
  return {
    tone,
    cause: extra.cause || cause,
    binding: extra.binding || '',
    phase: extra.phase || 'wake',
    dims: v.dims,
    updatedAt: v.updatedAt,
  }
}
