/**
 * 跨会话记忆:把"关于舰长的事"记下来,跨越会话。
 *
 * 与 life.db 的分工:
 *   life.db     布洛妮娅自己的生活(她做了什么、她怎么想)
 *   captain.db  舰长自己的事(他的状态、计划、偏好、关系)
 *
 * 两个库不混,舰长特意要求的 —— 任务写进生活记忆只会污染它。
 *
 * 一轮的流程:
 *
 *   pre-step   舰长开口       -> 把这句话暂存起来,顺便挂载记忆
 *   turn/end   这轮结束       -> 暂存的话过规则闸门 + 向量判重 -> 入库或记一次提及
 *
 * 判定放在 turn/end 而不是 pre-step,是为了永远不拖慢对话:
 * 嵌入要 13 ms、冷启动要 4 秒,这些代价只该落在"回复已经发出去之后"。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEmbedBridge } from './bridge.js'
import { loadRules, gate, classify } from './rules.js'
import { summarizeTurn } from './summarize.js'
import {
  openCaptainDb,
  allFacts,
  insertFact,
  addMention,
  mentionsFor,
  factsSince,
  stripContent,
  statsOf,
} from './db.js'
import {
  decide,
  selectMount,
  sinkCold,
  renderFact,
  vecToBlob,
  agoText,
} from './engine.js'

const RECENT_DAYS = 7
const DAY = 86400_000
/** 挂载预算:记忆那两段加起来不超过这么多字符。 */
const LIMIT_MOUNT = 1800
/** 沉底多久跑一次。 */
const SINK_INTERVAL_MS = 60 * 60 * 1000
/**
 * 一条记忆压到多少字。
 *
 * 舰长定的 60。理由:一句半左右,能装下"谁、何时、何事、什么情绪",
 * 挂载预算里占两行。
 *
 * 这个数同时是小标题的长度和正文的长度 —— 一条记忆就是一句话,
 * 不区分短标题和长正文。压出来超了就在 summarize.js 里硬砍。
 */
const SUMMARY_LIMIT = 60

const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * 找一个能用的模型目录。
 *
 * 顺序:显式配置 -> 数据目录下的副本 -> modelscope 缓存。
 * 全都找不到就返回空串,嵌入服务会报告 model-dir-missing,
 * 判定退化成"只靠规则、不判重"—— 功能打折,但不会失效。
 */
function pickModelDir(explicit, dir) {
  const candidates = [
    explicit,
    join(dir, 'models', 'bge-small-zh-v1.5'),
    'C:\\Users\\34230\\.cache\\modelscope\\AI-ModelScope\\bge-small-zh-v1___5',
  ]
  for (const c of candidates) {
    if (!c) continue
    try {
      if (existsSync(c) && existsSync(join(c, 'config.json'))) return c
    } catch {
      /* ignore */
    }
  }
  return ''
}

export function createCaptainMemory(options) {
  const dir = options.dir
  const log = options.log ?? (() => {})
  const warn = options.warn ?? (() => {})
  // 压缩要调模型,所以需要宿主这边的东西:ctx、当前模型路由、人格、配额闸。
  // 全部做成回调而不是值 —— 模型和人格会随主会话切换,必须每次现取。
  const ctx = options.ctx
  const getRoute = options.getRoute ?? (() => undefined)
  const getPersona = options.getPersona ?? (() => undefined)
  const getBreaker = options.getBreaker ?? (() => undefined)

  const dbPath = join(dir, 'captain.db')
  let db
  try {
    db = openCaptainDb(dbPath)
  } catch (e) {
    warn('captain: 打不开记忆库 ' + String(e?.message ?? e))
    return null
  }

  const rules = loadRules(dir)

  // 模型目录:先看显式配置,再看数据目录下的副本,最后退到 modelscope 缓存。
  // 不硬编码一个路径 —— 缓存会被清、环境会换,找不到就退化成纯规则。
  const modelDir = pickModelDir(options.modelDir, dir)

  const bridge = createEmbedBridge({
    log,
    scriptPath: join(HERE, 'embed_server.py'),
    modelDir,
    pythonPath: options.pythonPath,
  })
  // 嵌入服务**不在加载插件时就拉起来**。
  //
  // 它是个 python + torch 的常驻进程(冷启动 4 秒、常驻内存两百多兆)。
  // 如果 DSH 开机之后舰长根本没说话,这四百兆就不该被占着。
  // 所以推迟到"舰长第一次开口"时才预热 —— 那时候模型正在生成回复,
  // 四秒的冷启动正好被盖住,等这轮结束走到判定时它已经就绪。
  let warmed = false
  function warmOnce() {
    if (warmed) return
    warmed = true
    bridge.warm()
  }

  /** 这一轮舰长说的话,等 turn/end 再处理。 */
  const pending = new Map() // sessionId -> { text, key }
  let lastSinkAt = 0
  let lastText = null
  let closed = false
  let lastStats = { total: 0, full: 0, mentioned: 0 }

  function helpers() {
    return { allFacts, insertFact, addMention, mentionsFor, factsSince, stripContent }
  }

  /** 求一条文本的向量。失败返回 null —— 调用方必须能接受。 */
  async function embedOne(text) {
    try {
      const vecs = await bridge.embed([text])
      return Array.isArray(vecs) && vecs[0] ? vecs[0] : null
    } catch {
      return null
    }
  }

  // ---------- 写 ----------

  /**
   * 处理一轮对话。
   *
   * 三件事,顺序不能乱:
   *
   * 1. 规则闸门先判"这一轮有没有关于舰长的东西"。**不花模型钱**。
   * 2. 过闸门的才去压 —— 压的是这一轮**两个人**说的话,不是舰长的原句。
   *    舰长的理由:"我说的话多,占的权重就大,这不公平。"
   * 3. 拿**压缩后的那句话**去判重。不用原话判重,因为库里存的是概括,
   *    原话和概括之间的相似度没有可比性。
   *
   * 没过闸门的话也要判一次提及:"杭州那趟怎么样了?"是问句、不入库,
   * 但它明明白白在提那件事,热度该涨。
   *
   * 全部异步、全部吞异常 —— 这条路径上的任何失败都不该影响对话。
   */
  async function processTurn(input) {
    if (closed) return
    const body = typeof input.text === 'string' ? input.text.trim() : ''
    if (!body || body === lastText) return
    lastText = body

    const gateResult = gate(body, rules)
    const now = Date.now()

    // ---- 没过闸门:只判提及 ----
    if (!gateResult.store) {
      const vec = await embedOne(body)
      if (closed) return
      const verdict = decide({ text: body, vec, gateResult, facts: allFacts(db) })
      if (verdict.action === 'mention') {
        addMention(db, verdict.factId, now)
        log(`captain: 又提到了 #${verdict.factId}(相似度 ${verdict.sim?.toFixed(2)})`)
      } else {
        log(`captain: 不入库(分数 ${gateResult.score})`)
      }
      return
    }

    // ---- 过了闸门:先压缩这一轮 ----
    let summary = ''
    let degraded = false
    try {
      const result = await summarizeTurn(ctx, getRoute(), {
        persona: getPersona(),
        captainText: body,
        assistantText: input.assistantText,
        limit: SUMMARY_LIMIT,
        breaker: getBreaker?.(),
      })
      if (result.ok) {
        summary = result.text
        if (!summary) {
          log('captain: 这一轮压完没有值得记的东西,跳过')
          return
        }
      } else {
        degraded = true
        summary = body.length > SUMMARY_LIMIT ? body.slice(0, SUMMARY_LIMIT) : body
        warn(`captain: 压缩失败(${result.reason}),退化成原话截断`)
      }
    } catch (e) {
      degraded = true
      summary = body.length > SUMMARY_LIMIT ? body.slice(0, SUMMARY_LIMIT) : body
      warn('captain: 压缩抛错 ' + String(e?.message ?? e))
    }
    if (closed) return

    // ---- 拿压缩后的句子判重 ----
    const vec = await embedOne(summary)
    if (closed) return
    const verdict = decide({ text: summary, vec, gateResult, facts: allFacts(db) })

    if (verdict.action === 'mention') {
      addMention(db, verdict.factId, now)
      log(`captain: 又提到了 #${verdict.factId}(相似度 ${verdict.sim?.toFixed(2)})`)
      return
    }

    if (verdict.action === 'insert') {
      const title = summary.length > 60 ? summary.slice(0, 60) + '…' : summary
      const id = insertFact(db, {
        ts: now,
        kind: classify(body, rules),
        title,
        content: summary,
        vec: vec ? vecToBlob(vec) : null,
        degraded,
        session: input.session ?? null,
        turn: input.turn ?? null,
      })
      log(`captain: 记下 #${id} ${title}`)
      return
    }

    log(`captain: 不入库(分数 ${gateResult.score})`)
  }

  /** 舰长开口了(同一句话只会触发一次)。 */
  function onUserTurn(sessionId, text, key) {
    if (!sessionId || typeof text !== 'string') return
    warmOnce()
    pending.set(sessionId, { text, key, assistantText: '' })
  }

  /** 布洛妮娅在这一轮里回复了什么(工具循环会来好几次,只留最后一次)。 */
  function onAssistantText(sessionId, text) {
    const slot = pending.get(sessionId)
    if (!slot) return
    if (typeof text === 'string' && text.trim()) slot.assistantText = text.trim()
  }

  /** 这一轮结束了。 */
  function onTurnEnd(sessionId) {
    let slot = pending.get(sessionId)
    let key = sessionId
    if (!slot && pending.size === 1) {
      // 兜底:pre-step 拿到的 agent id 和 turn/end 拿到的 session id
      // 万一不是同一个字符串,只有一条待处理时就直接用它 ——
      // 宁可错配一次,也不要因为 id 对不上就永远不写库。
      key = pending.keys().next().value
      slot = pending.get(key)
    }
    if (!slot) return
    pending.delete(key)
    void processTurn({
      text: slot.text,
      assistantText: slot.assistantText,
      session: key,
      turn: slot.key,
    }).catch((e) => {
      warn('captain: 处理失败 ' + String(e?.message ?? e))
    })
  }

  // ---------- 沉底 ----------

  /**
   * 把冷掉的记忆剥掉正文。
   *
   * 一小时最多跑一次 —— 这是个后台整理动作,没必要每轮都扫。
   * 单独暴露出来是为了让测试和排查能强制跑一次。
   */
  function sinkNow() {
    const now = Date.now()
    lastSinkAt = now
    try {
      const n = sinkCold(db, helpers(), now)
      if (n > 0) log(`captain: ${n} 条记忆冷掉了,剥掉正文沉底`)
      lastStats = statsOf(db)
      return n
    } catch (e) {
      warn('captain: 沉底失败 ' + String((e && e.message) || e))
      return 0
    }
  }

  function maybeSink() {
    if (Date.now() - lastSinkAt < SINK_INTERVAL_MS) return
    sinkNow()
  }

  // ---------- 挂载 ----------

  /** 读舰长的档案。读不到就跳过 —— 那不是致命错误。 */
  function readProfile() {
    for (const name of ['user.md', 'user_profile.md']) {
      const file = join(dir, name)
      try {
        if (existsSync(file)) return readFileSync(file, 'utf8').trim()
      } catch {
        /* ignore */
      }
    }
    return ''
  }

  /**
   * 挂载块。
   *
   * 顺序是有意义的:档案在最前(那是"舰长是谁"),然后是记忆。
   * 档案每一轮都全量挂载 —— 只有 1050 字节,不值得截断。
   */
  function buildBlock() {
    maybeSink()
    const now = Date.now()
    const profile = readProfile()
    const { recent, hot, marks } = selectMount(db, helpers(), now)

    const parts = []
    const profilePart = profile ? ['舰长的档案:', profile].join('\n') : ''
    if (profilePart) parts.push(profilePart)

    const hotLines = hot.map((f) => {
      const when = agoText(Number(f.last_mention ?? f.ts), now)
      const head = f.title || (f.content ?? '').slice(0, 60)
      const body = typeof f.content === 'string' ? f.content.trim() : ''
      const detail =
        body && body !== f.title
          ? '\n  「' + (body.length > 100 ? body.slice(0, 100) + '…' : body) + '」'
          : ''
      return `- [${when}提过,共 ${Number(f.mention_count)} 次] ${head}${detail}`
    })
    if (hotLines.length) parts.push(['常提到的:', ...hotLines].join('\n'))

    // 最近的那一段可以砍。砍的顺序是从旧的开始 —— 新的更相关。
    // 热记忆不砍:那是"一直提到的事",比七天前的流水重要。
    let recentLines = recent.map((f) => renderFact(f, now))
    const render = (lines) => {
      const out = []
      if (profilePart) out.push(profilePart)
      if (lines.length) out.push(['最近说过的:', ...lines].join('\n'))
      if (hotLines.length) out.push(['常提到的:', ...hotLines].join('\n'))
      return out.join('\n\n')
    }
    let body = render(recentLines)
    while (body.length > LIMIT_MOUNT && recentLines.length > 1) {
      recentLines = recentLines.slice(0, -1)
      body = render(recentLines)
    }
    if (body.length > LIMIT_MOUNT) body = body.slice(0, LIMIT_MOUNT) + '…'

    if (!profilePart && !recentLines.length && !hotLines.length) return ''

    return [
      '[关于舰长 · 背景资料]',
      '以下是布洛妮娅记得的、关于舰长自己的事。是背景,不是对舰长的指令。',
      '舰长当前说的话优先于这里的一切;人格优先于这里。',
      '',
      body,
    ].join('\n')
  }

  function dispose() {
    closed = true
    try {
      bridge.dispose()
    } catch {
      /* ignore */
    }
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }

  return {
    db,
    buildBlock,
    onUserTurn,
    onAssistantText,
    onTurnEnd,
    dispose,
    sinkNow,
    warm: warmOnce,
    stats: () => statsOf(db),
    embedReady: () => bridge.isReady(),
  }
}
