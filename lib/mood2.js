/**
 * 情绪(第三版):主要是她自己,舰长的话只算一份影响。
 *
 * 前两版错在比例上 —— 每轮全靠舰长说了什么加减,读出来像是专门为回话而摆脸色。
 * 这一版把权重分开:
 *   她自己在过什么日子(睡没睡够、几点、手上有没有事、累不累)决定底色,权重 0.10-0.20;
 *   舰长说的话只是影响,权重 0.02-0.06,一句话翻不了盘。
 *
 * 九根:好奇、开心、担心、难过、闷、累、吃醋、生气、惊讶。
 * 对外还是「情绪基调 / 绑定」两行,说法用平常词:很开心、累了、有点闷。
 */

const HOUR = 3600 * 1000

export const DIMS = {
  curiosity: { label: '好奇', halfLife: 3 * HOUR, base: 0.30 },
  joy: { label: '开心', halfLife: 2 * HOUR, base: 0.28 },
  worry: { label: '担心', halfLife: 6 * HOUR, base: 0.15 },
  sadness: { label: '难过', halfLife: 12 * HOUR, base: 0.1 },
  boredom: { label: '闷', halfLife: 8 * HOUR, base: 0.18 },
  tired: { label: '累', halfLife: 5 * HOUR, base: 0.18 },
  jealousy: { label: '在意', halfLife: 4 * HOUR, base: 0.05 },
  anger: { label: '生气', halfLife: 10 * HOUR, base: 0.02 },
  surprise: { label: '意外', halfLife: 40 * 60 * 1000, base: 0.05 },
}

export function freshVector(now = Date.now()) {
  const dims = {}
  for (const [key, spec] of Object.entries(DIMS)) dims[key] = spec.base
  return { dims, updatedAt: now }
}

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

function add(vector, key, delta) {
  if (!Object.prototype.hasOwnProperty.call(vector.dims, key)) return
  vector.dims[key] = clamp01(vector.dims[key] + delta)
}

/**
 * 她自己的日子。这一层才是主导。
 *
 * @param {{dims: object, updatedAt: number}} vector
 * @param {{phase?: string, hour?: number, idleHours?: number, toolCalls?: number, interrupted?: boolean, sleptHours?: number, busy?: boolean}} ctx
 */
export function driftContext(vector, ctx = {}) {
  const v = decay(vector)
  const hour = Number.isFinite(Number(ctx.hour)) ? Number(ctx.hour) : new Date().getHours()
  const phase = String(ctx.phase || 'wake')
  const idleHours = Number(ctx.idleHours) || 0
  const tools = Number(ctx.toolCalls) || 0

  // 睡着了:困,别的都往下压
  if (phase === 'sleep') {
    add(v, 'tired', 0.16)
    add(v, 'curiosity', -0.06)
    add(v, 'boredom', -0.05)
    if (ctx.interrupted) {
      add(v, 'tired', 0.08)
      add(v, 'anger', 0.05)
    }
    v.updatedAt = Date.now()
    return v
  }

  // 几点:清晨清醒、午后容易困、深夜累
  if (hour >= 6 && hour < 10) add(v, 'curiosity', 0.08)
  if (hour >= 13 && hour < 16) add(v, 'tired', 0.14)
  if (hour >= 23 || hour < 6) {
    add(v, 'tired', 0.20)
    add(v, 'boredom', 0.05)
  }

  // 很久没动过:闷、开始在意
  if (idleHours > 3) add(v, 'boredom', 0.12)
  if (idleHours > 6) {
    add(v, 'boredom', 0.12)\\
    add(v, 'jealousy', 0.10)
    add(v, 'curiosity', -0.05)
  }

  // 手上一直有活:投入但累
  if (tools >= 5) add(v, 'tired', 0.12)
  if (tools >= 12) add(v, 'tired', 0.10)
  if (tools >= 3 && tools < 8) add(v, 'joy', 0.04)

  // 手上没活又醒着:无聊多一点
  if (!ctx.busy && idleHours < 1) add(v, 'boredom', 0.03)

  v.updatedAt = Date.now()
  return v
}

/**
 * 舰长这一轮的影响。权重压得小:一句话改不了她的底色,连着几轮才会显出方向。
 *
 * @param {{dims: object, updatedAt: number}} vector
 * @param {{text?: string, reply?: string}} turn
 */
export function applyCaptainTurn(vector, turn = {}) {
  const v = decay(vector)
  const text = String(turn.text || '')
  const reply = String(turn.reply || '')

  if (/(为什么|怎么|能不能|是不是)/.test(text)) add(v, 'curiosity', 0.04)
  if (/(谢谢|辛苦|厉害|靠谱|不错)/.test(text)) add(v, 'joy', 0.04)
  if (/(哈哈|太好了|开心)/.test(text)) add(v, 'joy', 0.03)
  if (/(累|困|烦|难受|不想)/.test(text)) { add(v, 'worry', 0.05); add(v, 'tired', 0.03) }
  if (/(生气|烦死|讨厌)/.test(text)) {
    add(v, 'anger', 0.03)
    add(v, 'worry', 0.02)
  }
  if (text.length > 120) add(v, 'curiosity', 0.03)
  if (reply.length > 400) add(v, 'curiosity', 0.02)

  v.updatedAt = Date.now()
  return v
}

/** 兼容老调用:没有上下文的时候当成只有舰长这一轮。 */
export function bumpTurn(vector, turn = {}) {
  return applyCaptainTurn(driftContext(vector, turn), turn)
}

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
 * 说法。用平常词,分四档,按时间轮换,两根都高的时候给一句并列的。
 */
const PHRASES = {
  curiosity: [['想知道', '在琢磨'], ['想弄明白', '很想搞清楚'], ['很想弄明白', '一门心思想搞清楚'], ['非弄明白不可', '别的都先放一边']],
  joy: [['开心', '心情松快'], ['挺开心', '心情不错'], ['很高兴', '真的开心'], ['特别开心', '开心得藏不住']],
  worry: [['在意', '担心'], ['有点担心', '不太放心'], ['很担心', '放不下心'], ['特别担心', '一直挂着']],
  sadness: [['闷闷的', '有点低落'], ['低落', '不太好'], ['很难过', '提不起劲'], ['心里沉下去', '什么都不想说']],
  boredom: [['闲', '有点闷'], ['闷', '待不住'], ['无聊', '坐不住'], ['闷得难受', '想找点事做']],
  tired: [['有点累', '有点困了'], ['累', '想歇一会儿'], ['很累', '撑得勉强'], ['累坏了', '只想躺下']],
  jealousy: [['在意', '留意着'], ['不是滋味', '不太痛快'], ['很在意', '心里憋着'], ['压不住这点情绪', '一直想着']],
  anger: [['不高兴', '有点烦'], ['生气', '火气上来了'], ['很生气', '不太想说话'], ['懒得装', '话会很硬']],
  surprise: [['意外', '愣了一下'], ['没想到', '有点被惊到'], ['很意外', '真没料到'], ['完全没料到', '半天没接上']],
}

const CONNECTORS = ['，也有点', '，还有点', '，又有点', '，同时还', '，心里也']

/** 强度分四档:0 微、1 明确、2 强、3 顶。 */
function band(score) {
  if (score < 0.40) return -1
  if (score < 0.55) return 0
  if (score < 0.70) return 1
  if (score < 0.85) return 2
  return 3
}

/** 同一档里换着说:二十分钟换一次。 */
function pick(list, at) {
  if (!Array.isArray(list) || !list.length) return ''
  const slot = Math.floor((Number(at) || Date.now()) / (20 * 60 * 1000))
  let n = slot % list.length
  if (n < 0) n += list.length
  return list[n]
}

/**
 * 说法。几根可以同时在,不是只能报最强那一根。
 *
 * 规则:
 *   取所有到中档(>=0.50)的维度,按强度排,最多三根;
 *   每根按自己的档位选词,用连接词串起来;
 *   一根都没有就是平静。
 */
export function toneOf(vector, at = Date.now()) {
  const dims = (vector && vector.dims) || {}
  const active = Object.keys(DIMS)
    .map((key) => ({ key, score: Number(dims[key]) || 0 }))
    .filter((d) => d.score >= 0.40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  if (!active.length) return { tone: '平静', cause: '没什么事', parts: [] }

  const slot = Math.floor((Number(at) || Date.now()) / (20 * 60 * 1000))
  const words = active.map((d) => {
    const level = Math.max(0, Math.min(3, band(d.score)))
    return pick((PHRASES[d.key] && PHRASES[d.key][level]) || ['有情绪'], at)
  })

  let tone = words[0]
  for (let i = 1; i < words.length; i++) {
    const conn = CONNECTORS[(slot + i) % CONNECTORS.length]
    // 连接词后面接的是"有点累"这种完整说法,去掉重复的"有点"
    const w = words[i].replace(/^有点/, '')
    tone += conn + w
  }

  return {
    tone,
    cause: active.map((d) => DIMS[d.key].label).join('＋'),
    parts: active.map((d) => ({ key: d.key, score: d.score })),
  }
}

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
