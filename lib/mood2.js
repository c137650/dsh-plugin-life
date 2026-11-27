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
 * 三件事决定说法:
 *   1) 强度分五档,不是两档;
 *   2) 两根都高的时候用组合词,不是只报最强那根;
 *   3) 同一档里有好几种说法,按时段轮换 —— 读起来不像卡在同一个词上。
 */
const PHRASES = {
  curiosity: [
    ['有点想弄明白', '这件事想再看一眼', '手上这个还没摸透'],
    ['在琢磨', '想弄明白', '被这件事勾住了'],
    ['很想弄清楚', '盯着这点不放', '非要搞明白不可'],
    ['非弄明白不可', '一门心思在这上面', '别的都先放一边'],
  ],
  joy: [
    ['还行', '心情松快', '有点轻快'],
    ['心情不错', '挺高兴', '顺畅'],
    ['高兴', '藏不住的开心', '心情很好'],
    ['高兴得有点过', '整个人都亮了', '乐在其中'],
  ],
  worry: [
    ['有一点点挂心', '隐隐不太放心', '留了个心眼'],
    ['有点担心', '放心不下', '在留意'],
    ['担心', '心里悬着', '一直惦记'],
    ['很担心', '放不下心', '就怕出岔子'],
  ],
  sadness: [
    ['有一点点低落', '气有点沉', '没什么劲'],
    ['有点低落', '提不起劲', '不太想说话'],
    ['低落', '心里闷着', '沉下来了'],
    ['很难过', '整个人沉下去', '一时缓不过来'],
  ],
  boredom: [
    ['有点闲', '手上没劲', '等着事做'],
    ['有点闷', '待不住了', '想找点事'],
    ['闷', '烦得慌', '坐不住'],
    ['闷到极点', '一分钟都待不住', '想出去走走'],
  ],
  tired: [
    ['有点倦', '精神一般', '慢了半拍'],
    ['有点累', '想歇一会儿', '撑得有点勉强'],
    ['累', '不想多说', '注意力散了'],
    ['很累', '撑不住了', '只想躺下'],
  ],
  jealousy: [
    ['有点在意', '留意了一眼', '心里动了一下'],
    ['有点在意', '心里堵着', '不是滋味'],
    ['在意得明显', '心里不痛快', '有点酸'],
    ['很在意', '压不住这点情绪', '一直想着'],
  ],
  anger: [
    ['有点不痛快', '脸色不太好', '压着一点'],
    ['不太高兴', '压着火', '说话会变短'],
    ['生气', '不想绕弯', '火气上来了'],
    ['很生气', '懒得装', '话会很硬'],
  ],
  surprise: [
    ['有点意外', '没想到', '愣了一下'],
    ['意外', '有点被惊到', '没料到'],
    ['很意外', '真没想到', '一时没接上'],
    ['完全没料到', '愣住了', '反应慢了半拍'],
  ],
}

/** 两根同时高的时候用组合,比单报一根准。 */
const COMBOS = [
  [['curiosity', 'tired'], ['想弄明白,但有点撑不住', '还在追,力气快没了', '想接着看,眼睛先累了']],
  [['curiosity', 'joy'], ['好奇又高兴', '越看越有意思', '摸得正起劲']],
  [['worry', 'tired'], ['挂着心又累', '放不下,也没力气', '心里有事,人也乏']],
  [['anger', 'worry'], ['又气又担心', '火里带着挂心', '嘴上硬,心里悬着']],
  [['boredom', 'jealousy'], ['闲得想找人说话', '有点空,也有点在意', '手上没事,心里有事']],
  [['joy', 'surprise'], ['又惊又喜', '比预期好', '没料到的好']],
  [['sadness', 'tired'], ['又低落又累', '什么都不想动', '沉而且乏']],
]

function band(score) {
  if (score < 0.38) return -1
  if (score < 0.52) return 0
  if (score < 0.66) return 1
  if (score < 0.80) return 2
  return 3
}

/** 按时段轮换说法:二十分钟换一次,同一个状态下不会一直用同一句。 */
function pick(list, at) {
  if (!list || !list.length) return ''
  const slot = Math.floor((Number(at) || Date.now()) / (20 * 60 * 1000))
  return list[(() => {
    let n = slot % list.length
    if (n < 0) n += list.length
    return n
  })()]
}

export function toneOf(vector, at = Date.now()) {
  const dims = (vector && vector.dims) || {}
  const ranked = Object.keys(DIMS)
    .map((key) => ({ key, score: Number(dims[key]) || 0 }))
    .sort((a, b) => b.score - a.score)
  const top = ranked[0] || { key: '', score: 0 }
  const second = ranked[1] || { key: '', score: 0 }

  // 两根都在中档以上,先看组合
  if (top.score >= 0.48 && second.score >= 0.48) {
    const pair = [top.key, second.key].sort().join('+')
    const found = COMBOS.find(([keys]) => [...keys].sort().join('+') === pair)
    if (found) {
      return {
        tone: pick(found[1], at),
        cause: DIMS[top.key].label + '＋' + DIMS[second.key].label,
        combo: true,
        key: top.key,
        score: top.score,
      }
    }
  }

  const level = band(top.score)
  if (level < 0 || !top.key) return { tone: '平稳', cause: '没什么事', key: '', score: top.score }
  return {
    tone: pick(PHRASES[top.key] && PHRASES[top.key][level], at),
    cause: DIMS[top.key] ? DIMS[top.key].label : '',
    combo: false,
    key: top.key,
    score: top.score,
  }
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
