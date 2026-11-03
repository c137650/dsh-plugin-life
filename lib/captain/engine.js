/**
 * 冷热记忆引擎。
 *
 * 舰长的要求,原话:
 *   "每次会挂载近一周内全部事件 + 热记忆"
 *   "我希望不存在一直都会被挂载的事件"
 *   "提及次数少的事件就会被逐步压缩、沉底然后不再自动挂载,除非我又主动提及"
 *   "热事件如果一直提及就一直挂载"
 *
 * 所以这里只有两条规则:
 *
 *   挂载 = 近一周内写的  ∪  热度 >= 1
 *   热度 = 每次"被舰长再次提到"贡献 exp(-Δt/τ),半衰期 14 天
 *
 * 推论(这才是舰长要的东西):
 *   - 一件事写进库,一周内一定挂载。
 *   - 一周之后,只有在"最近半衰期里被提到过一次"以上的才继续挂载。
 *   - 没有任何 keep 标记,所以没有任何事件能一直挂载 —— 包括最新的那件。
 *   - 沉底不是删除。标题和向量都留着,舰长下次再提,热度升回来就又挂上了。
 *     沉掉的只有正文 —— 就像人记得"这事有过",细节想不起来了。
 */

/** 半衰期:14 天。τ = 14 / ln2 ≈ 20.2 天。 */
const HALF_LIFE_DAYS = 14
const TAU = (HALF_LIFE_DAYS * 86400_000) / Math.LN2

/** 近一周内写的,无条件挂载。 */
const RECENT_DAYS = 7

/**
 * 热度到这个数才算"热"。
 *
 * 这里踩过一个坑:最初定成 1.0,结果**任何一条刚被提过的记忆都够不到** ——
 * 一次提及的热度是 exp(0)=1.0,但只要 `now` 比那条提及时间晚几毫秒,
 * 算出来就是 0.99999999,`>= 1.0` 判不过。于是"热"永远为空。
 *
 * 正确的定义是:**一个半衰期内被提过**。半衰期 14 天,
 * 所以阈值取 0.5 —— 刚提过是 1.0,7 天前提过 0.79,14 天前 0.50,
 * 21 天前 0.32 就不热了。
 */
const HOT_HEAT = 0.5

/** 低于这个热度就该沉底了(约等于两次半衰期没被提到)。 */
const COLD_HEAT = 0.25

/** 比较热度时的容差,避免浮点误差把边界判反。 */
const EPS = 1e-9

/**
 * 判重 / 提及的阈值。
 *
 * 实测(30 对真实中文句):
 *   同一件事的不同说法   0.703 ~ 0.800
 *   完全不同的两件事     0.293 ~ 0.547
 * 中间那段空得很宽,所以 0.65 是个安全位置 ——
 * 比"不同的事"的最高值高 0.10,比"同一件事"的最低值低 0.05。
 *
 * 不要凭感觉把这个数往上调:说同一件事的两次,措辞往往差很远
 * ("我下周要去杭州出差" vs "下周杭州那趟出差我有点紧张" 是 0.79)。
 */
const MENTION_SIM = 0.65

/** 沉底:超过这么多天没被提到、且热度低于底线,就把正文剥掉。 */
const COLD_DAYS = 14

/** 热度:把每一次提及按时间衰减后加起来。 */
export function heatOf(marks, now) {
  let sum = 0
  for (const ts of marks) sum += Math.exp(-Math.max(0, now - ts) / TAU)
  return sum
}

/** 余弦相似度。两个向量都已经 L2 归一化,内积就是余弦。 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** BLOB -> Float32Array。 */
export function blobToVec(blob) {
  if (!blob || blob.byteLength === undefined || blob.byteLength % 4 !== 0) return null
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  const out = new Float32Array(buf.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}

/** Float32Array -> BLOB。 */
export function vecToBlob(vec) {
  if (!vec) return null
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}

/**
 * 和已有记忆比一遍,找出最像的那条。
 *
 * 返回 { id, sim } 或 null。跳过没有向量的行(理论上不该有)。
 */
export function bestMatch(facts, vec) {
  if (!vec) return null
  let best = null
  for (const f of facts) {
    const fv = blobToVec(f.vec)
    if (!fv) continue
    const sim = cosine(fv, vec)
    if (!best || sim > best.sim) best = { id: Number(f.id), sim, fact: f }
  }
  return best
}

/**
 * 决定这一轮要做什么。
 *
 * 输入:这轮舰长说的话、这句话的向量(可能为 null)、规则闸门的结论、已有记忆。
 * 输出:{ action: 'insert'|'mention'|'none', ... }
 *
 * 注意区分两件事:
 *   - **提及(mention)**:舰长又在说这件事。哪怕他是在问("杭州那趟怎么样了?"),
 *     也算提到,热度要涨。所以提及检测不经过规则闸门。
 *   - **入库(insert)**:这是一条新信息。要过规则闸门,而且要确认不是重复。
 */
export function decide({ text, vec, gateResult, facts }) {
  const match = bestMatch(facts, vec)

  // 先看是不是在提旧事。没有向量就不敢断定,只能靠规则。
  if (match && match.sim >= MENTION_SIM) {
    // 是同一件事:记一次提及。要不要把这次的说法追加进正文,
    // 交给调用方按规则闸门判断(只有"本身也是一句陈述"才追加)。
    return { action: 'mention', factId: match.id, sim: match.sim, text }
  }

  if (!gateResult.store) return { action: 'none', sim: match?.sim ?? null }

  return { action: 'insert', sim: match?.sim ?? null }
}

/** 这条记忆算不算"热"。 */
export function isHot(marks, now) {
  return heatOf(marks, now) >= HOT_HEAT - EPS
}

/**
 * 选出这次要挂载的记忆。
 *
 * 分两堆,因为它们的意义不一样:
 *   近一周  —— "最近发生的事",不管热不热都该记得
 *   热记忆  —— "老是提到的事",哪怕是一个月前的
 */
export function selectMount(db, helpers, now) {
  const since = now - RECENT_DAYS * 86400_000
  const recent = helpers.factsSince(db, since)
  const seen = new Set(recent.map((f) => Number(f.id)))

  const all = helpers.allFacts(db)
  const marks = helpers.mentionsFor(
    db,
    all.map((f) => Number(f.id)),
  )

  const hot = []
  for (const f of all) {
    const id = Number(f.id)
    if (seen.has(id)) continue
    if (f.ts >= since) continue
    const m = marks.get(id) ?? []
    if (m.length && isHot(m, now)) hot.push({ ...f, heat: heatOf(m, now), marks: m })
  }
  hot.sort((a, b) => b.heat - a.heat)

  return { recent, hot, marks }
}

/**
 * 沉底:冷掉的记忆剥掉正文。
 *
 * 只剥正文,不删行。舰长要"以后主动提及还能捞回来",
 * 那行和它的向量必须留着 —— 否则再也认不出"他又在说这件事"。
 *
 * 返回被剥的条数。
 */
export function sinkCold(db, helpers, now) {
  const cutoff = now - COLD_DAYS * 86400_000
  const all = helpers.allFacts(db)
  const marks = helpers.mentionsFor(
    db,
    all.map((f) => Number(f.id)),
  )
  const cold = []
  for (const f of all) {
    if (f.content === null) continue
    const id = Number(f.id)
    const last = Number(f.last_mention ?? f.ts)
    if (last > cutoff) continue
    if (heatOf(marks.get(id) ?? [], now) >= COLD_HEAT - EPS) continue
    cold.push(id)
  }
  if (!cold.length) return 0
  return helpers.stripContent(db, cold)
}

/** "多久以前"的人话。 */
export function agoText(ts, now) {
  const mins = Math.max(0, Math.floor((now - ts) / 60000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  return `${months} 个月前`
}

/** 一条记忆挂载时的样子:一句话 + 多久以前。 */
export function renderFact(f, now) {
  const when = agoText(Number(f.ts), now)
  const body = typeof f.content === 'string' && f.content.trim() ? f.content.trim() : ''
  const head = f.title || body.slice(0, 60)
  // 压缩之后正文通常就是那句话本身,不必再加一行引号。
  if (!body || body === head) return `- [${when}] ${head}`
  const flat = body.replace(/\s+/g, ' ')
  const detail = flat.length > 120 ? flat.slice(0, 120) + '…' : flat
  return `- [${when}] ${head}\n  「${detail}」`
}
