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

import { createEmbedBridge } from '../embed.js'
import { loadRules, gate, classify } from './rules.js'
import { summarizeTurn } from './summarize.js'
import { looksLikeFact, shortTitle } from './quality.js'
import {
  openCaptainDb,
  schemaStatus,
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

// 模型目录的选择搬到 lib/embed.js 了 —— 活动和对话共用同一个嵌入服务,
// 路径逻辑不该在两个地方各有一份。

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
  let migrated = []
  try {
    db = openCaptainDb(dbPath, {
      onMigrate: (added) => {
        migrated = added
        // 补了列要喊一声 —— 沉默地补会让人以为一直是好的,
        // 而这个库曾经因为缺一列静默失败了好几天。
        log('captain: 补上缺失的列 ' + added.join(', '))
      },
    })
  } catch (e) {
    warn('captain: 打不开记忆库 ' + String(e?.message ?? e))
    return null
  }
  const schema = schemaStatus(db)
  if (!schema.ok) {
    warn('captain: 库结构和代码对不上,缺 ' + schema.missing.join(', '))
  }

  const rules = loadRules(dir)

  // 嵌入服务由宿主创建、两边共用(活动和对话都要用同一个模型)。
  // 没传就自己建一个 —— 单独用这个模块也能跑。
  const ownsBridge = !options.embedder
  const bridge =
    options.embedder ??
    createEmbedBridge({
      log,
      dataDir: dir,
      modelDir: options.modelDir,
      pythonPath: options.pythonPath,
    })
  // 嵌入服务**不在加载插件时就拉起来**。
  //
  // 它是个 python + torch 的常驻进程(冷启动 4 秒、常驻内存两百多兆)。
  // 如果 DSH 开机之后什么都没发生,这几百兆就不该被占着。
  // 所以推迟到"真正需要它"的时候才预热:舰长开口,或者第一次活动去重。
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
        // **不入库。**
        //
        // 以前这里是退化成"原话截断 60 字"存进去。库里那两条垃圾就是这么来的:
        // 一条是布洛妮娅自己的语气(「(ᗜ ˰ ᗜ)」),一条是半句话。
        //
        // 退化成原话,恰好是这套设计最想避免的东西 ——
        // 舰长要的是"用你的话概括",原话直存等于把啰嗦当重要。
        // 宁可不记,也不写垃圾:库里多一行,以后每次挂载都得背着它。
        warn(`captain: 压缩失败(${result.reason}),这一轮不入库`)
        return
      }
    } catch (e) {
      degraded = true
      warn('captain: 压缩抛错 ' + String(e?.message ?? e))
      return
    }
    if (closed) return

    // 质量闸:模型写出来的话也不一定合格。
    //
    // 见过「舰长继续为桌面」这种半句话,和混进布洛妮娅语气的句子。
    // 不合格的宁可丢,也不要挂载给舰长看。
    const quality = looksLikeFact(summary)
    if (!quality.ok) {
      warn('captain: 概括不合格(' + quality.why + '),不入库:' + summary.slice(0, 40))
      return
    }

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
      // title 是短标签,content 是完整的那句话。
      //
      // 以前 title 就是 content 的前 60 字 —— 而 SUMMARY_LIMIT 正好是 60,
      // 所以两列**永远一模一样**(7 条记录,7 条相同)。既浪费,
      // 挂载的时候也没有"先扫标题、再看细节"的效果。
      //
      // 现在:title 取第一句第一个逗号之前的那一截(通常就是"谁在做什么"),
      // content 保留整句,挂载时把重复的开头去掉。
      const title = shortTitle(summary)
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
      if (n > 0) {
        log(`captain: ${n} 条记忆冷掉了,剥掉正文沉底`)
        // 剥正文会留下空洞。SQLite 把那些页留着复用,文件不会变小 ——
        // 舰长在 life.db 那边问过同一件事("压缩了怎么大小不变"),
        // 这边是同一个道理,所以沉底之后顺手收一收。
        reclaimSpace()
      }
      lastStats = statsOf(db)
      return n
    } catch (e) {
      warn('captain: 沉底失败 ' + String((e && e.message) || e))
      return 0
    }
  }

  /**
   * 有空闲页就 VACUUM 一次,还给磁盘。
   *
   * SQLite 清空数据之后,腾出来的页进"空闲页列表"留着复用,文件只增不减。
   * 空得少就不折腾(VACUUM 要重写整库),超过 10% 才收。
   */
  function reclaimSpace(force = false) {
    try {
      const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count)
      const freePages = Number(db.prepare('PRAGMA freelist_count').get().freelist_count)
      if (!freePages) return { reclaimed: false, freePages: 0 }
      if (!force && freePages < Math.max(4, Math.ceil(pageCount * 0.1))) {
        return { reclaimed: false, freePages }
      }
      db.exec('VACUUM')
      // WAL 模式:结果先落在 -wal 里,主库要 checkpoint 才真的截短
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* 不是 WAL 模式 */
      }
      log(`captain: 空闲页 ${freePages} 页收掉`)
      return { reclaimed: true, freePages }
    } catch (e) {
      warn('captain: vacuum skipped ' + String((e && e.message) || e))
      return { reclaimed: false, error: String((e && e.message) || e) }
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
    // 嵌入服务是宿主给的就不该由这里关掉 —— 活动去重还在用它。
    if (ownsBridge) {
      try {
        bridge.dispose()
      } catch {
        /* ignore */
      }
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
    schema: () => schemaStatus(db),
    migrated: () => migrated.slice(),
    embedReady: () => bridge.isReady(),
  }
}
