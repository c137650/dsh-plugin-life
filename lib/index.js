/**
 * dsh-plugin-life — 生活模拟系统。
 *
 * 舰长提出的方案:
 *   "这是一套模拟你的生活的系统,可以在现有的masterprompt插件上添加。
 *    设计思想就是让你拥有自己的生活,并且尽可能使用随机状态来真实化
 *    (因此下面的算法不允许使用写死的东西)。"
 *
 * 本插件是**独立**的,不是 masterprompt 的一部分。理由:
 *   masterprompt 的失败模式是"人格被稀释",本插件的失败模式是"时间线错乱/库膨胀"。
 *   耦合会同时放大两个失败模式。独立插件可整体禁用而不影响人格。
 *
 * 与 masterprompt 的关系:
 *   - **只读**它的 state.json,取"真理之律者"人格文本用于写手和数据库写入
 *   - **不改**它的任何模板;四个既有模板与默认项一个字节都不动
 *   - 挂载到会话的人格 section 仍由 masterprompt 负责,本插件不介入
 *
 * 核心组件:
 *   clock.js     生理约束 FSM(睡/吃/清醒),时长由前 n 天的历史决定
 *   catchup.js   DSH 关闭期间的追赶,产出具体化的"被打断"记录
 *   writer.js    LLM 写手:执行前生成任务指令,执行后生成感受与评分
 *   executor.js  后台 agent 真实执行活动(web_search / web_fetch / 下载)
 *   db.js        SQLite 事件库 + 三级去重
 *   compress.js  时间衰减压缩 + keepers 选取
 *   memory.js    按优先级组装挂载内容
 *   model.js     与主会话同模型,推理等级 medium
 *   notify.js    事件通知:方案 2(schedule 定时唤醒),失败退方案 3(原生弹窗)
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

import { Rng, dailySeed } from './prng.js'
import { PHYSIOLOGY } from './physiology.js'
import { planDay, STATE, formatMin, planSummary } from './clock.js'
import { simulateCatchUp, missedAwakeWindow, renderMissedAwakeNotice, renderMissedActivityNotice } from './catchup.js'
import { writePending, readPending, clearPending, classifyPending, canStartActivity, judgeMissed } from './schedule.js'
import { resolveModel, createQuotaBreaker } from './model.js'
import { resolveTruthPersona } from './persona.js'
import {
  openDb,
  lifeDir,
  insertEvent,
  recentEvents,
  getMeta,
  setMeta,
  saveDay,
  loadHistory,
  purgeUnrealActivity,
  localDateISO,
  localStamp,
  localClock,
} from './db.js'
import { compressIfNeeded, selectKeepers } from './compress.js'
import { loadCategories, pickCategory, markUsed, addCategory } from './activities.js'
import { composeTask, composeFeeling } from './writer.js'
import { createUserMessage } from './executor.js'
import { runWebActivity, renderEvidence } from './webactivity.js'
import { pruneReading, referencedReadingFiles, removeReadingFiles } from './reading.js'
import { probeNetwork } from './netcheck.js'
import { detectPython } from './pysupport.js'
import { buildPayload, applyPayload } from './memory.js'
import { createCaptainMemory } from './captain/index.js'
import { nativePopup, focusAppWindow } from './notify.js'
import { runIcr, saveIcrResult } from './icr.js'

export const name = 'dsh-plugin-life'
export const inject = [
  'systemPrompt',
  'agents',
  'sessions',
  'agentDefaultModel',
  'llm',
  'timer',
  'schedule',
  'tools',
  'webServer',
  'web',
]

/**
 * 心跳间隔。
 *
 * 舰长:一分钟一次太奢侈,改成四分钟。
 *
 * 心跳只做三件事:更新作息阶段、按排期执行活动、把状态写进 status.json。
 * 活动本身要跑一两分钟,排期的误差在四分钟里看不出来 —— 而每秒醒一次
 * 是在烧 CPU 和磁盘。
 *
 * 代价:排期最多晚四分钟才启动;以及"排期落在两次心跳之间"会被当成
 * "没耽误"(见 takeMissedActivity)。
 */
const TICK_MS = 4 * 60_000
/**
 * 数据库压缩上限 —— 真实字节,含 detail。
 *
 * 舰长定的:256 KB。
 *
 * 之前的口径有两个错,导致这个数字大得没边:
 *   1. contentBytes 只数 content+feeling+title,**不算 detail** ——
 *      而 detail 才是大头(每个活动 10-11 KB,存的是抓取的原始结构)。
 *   2. 用的是 SQLite 的 LENGTH(),数的是**字符**不是字节(中文 3 字节/字)。
 * 两个错叠起来,2 MB 的阈值实际对应约 1700 个事件、磁盘约 11.7 MB ——
 * 按每天 3-5 个活动算,要将近一年才压缩一次,压缩算法里那个
 * τ=7 天的半衰期等于形同虚设。
 *
 * 现在口径修成真实字节(含 detail)。256 KB ≈ 38 个完整事件,
 * 每天 3-5 个活动的话,大约 8-12 天压缩一次 —— 和半衰期对得上。
 */
const DB_SIZE_LIMIT = 256 * 1024
const KEEPERS_THRESHOLD = 0.75
const NOTIFY_SCORE_SUM = 1
/**
 * 通知没有每日上限。
 *
 * 舰长:只要超过阈值就通知,一次都不通知也可以。
 * 阈值本身就是节流 —— 能越过 interest + importance >= 1 的事本来就少。
 */
/** 后台活动会话的 id 前缀。用来把它们和舰长的会话区分开。 */
const LIFE_SESSION_PREFIX = 'life-'
/** reading/ 目录的总量上限。超出按修改时间从旧到新淘汰。 */
const READING_MAX_BYTES = 50 * 1024 * 1024
/** 连续失败后的重试退避:第 n 次失败等 min(base * 2^(n-1), cap) 分钟。 */
const BACKOFF_BASE_MIN = 10
const BACKOFF_CAP_MIN = 120
/**
 * DSH 离开超过这么久才记一条"被打断"。
 *
 * 六分钟的关机不值得成为记忆 —— 而且原先是只要 ≥3 分钟就记,
 * 于是每次重启都生成一条,记忆库永远清不空。
 */
const INTERRUPT_MIN_OFFLINE_MIN = 30
/**
 * 「被打断」这个瞬时提示的冷却时间。
 *
 * 打断不写库,所以没有事件可以做去重 —— 用内存里的时间戳挡住。
 * 半小时内重复提起同一件事没有信息量。
 */
const INTERRUPT_NOTICE_COOLDOWN_MS = 30 * 60_000
/**
 * 开机后「清醒时间被耽误」这条横幅挂多久。
 *
 * 舰长的要求:开机后的半小时内,每一个会话(不论新旧)的每一轮对话,
 * 都要在挂载里看到这条提示。所以它不是一次性通知,而是一个时间窗口。
 */
const CATCHUP_BANNER_WINDOW_MS = 30 * 60_000
/**
 * "错过了本该做的活动"这条谴责挂多久。
 *
 * 舰长的要求:重新开始运行后的**一个半小时**内,对所有对话注入。
 * 比清醒时间的横幅长一倍 —— 那是"错过了一段清醒",这是"说好的事没做"。
 */
const MISSED_ACTIVITY_WINDOW_MS = 90 * 60_000
/**
 * 一次活动至少需要的时段长度(分钟)。
 *
 * 活动本身 = 写手生成指令 + 真的抓取 + 写感受,实测几分钟。
 * 判断"剩下的清醒时间够不够做一件事"时用它 —— **不能**用
 * "到下一次活动的间隔":那个间隔均值一百多分钟,而清醒段只有三五个小时,
 * 拿它做判据会让活动永远被判成"来不及",于是无限推迟。
 */
const ACTIVITY_MIN_SLOT_MIN = 10

/**
 * 从一条消息里取出纯文本。
 *
 * content 是块数组 [{type:'text', text}, ...],只拼 text 块;
 * 图片之类的块没有文字,跳过。
 */
function textOfMessage(m) {
  const blocks = m?.content
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

export function apply(ctx) {
  const dir = lifeDir()
  mkdirSync(dir, { recursive: true })

  /**
   * 把加载状态写到磁盘。
   *
   * DSH 的 GUI 里没有地方看插件日志(2026-10-27 排查过一次:
   * 插件因为缺 cordis.patch.yml 静默不加载,而完全没有报错可看)。
   * 所以把"加载成功了吗、用的什么模型、出过什么错"落成一个文件,
   * 排查时读它就行。
   */
  function writeStatus(patch) {
    try {
      let prev = {}
      try {
        prev = JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8'))
      } catch {
        /* 首次运行没有这个文件 */
      }
      writeFileSync(
        path.join(dir, 'status.json'),
        JSON.stringify(
          { ...prev, ...patch, plugin: 'dsh-plugin-life', version: '0.1.0', updatedAt: new Date().toISOString() },
          null,
          2,
        ),
        'utf8',
      )
    } catch {
      /* 状态文件写不出来也不能影响主流程 */
    }
  }

  writeStatus({ state: 'starting', pid: process.pid, node: process.versions.node })

  let db
  try {
    db = openDb(dir)
    // 不变量:activity 事件必须是真的执行过的。旧版本留下的 execud=0 行每次启动清掉。
    const purged = purgeUnrealActivity(db)
    if (purged.removed > 0) {
      ctx.logger?.info?.('dsh-plugin-life: removed ' + purged.removed + ' unreal activity rows: ' + purged.ids.join(','))
    }
  } catch (e) {
    const message = String((e && e.message) || e)
    ctx.logger?.error?.('dsh-plugin-life: cannot open database: ' + message)
    writeStatus({ state: 'failed', error: 'openDb: ' + message })
    return
  }

  // ---------- 跨会话记忆:关于舰长的事 ----------
  //
  // 和 life.db 分开一个库(captain.db)。舰长的判断:任务写进生活记忆
  // 只会污染它 —— 那边记的是布洛妮娅自己做了什么,这边记的是舰长自己的事。
  //
  // 挂不上也不能影响主流程:createCaptainMemory 内部把异常都吞掉了,
  // 返回 null 就当作没有这个功能。
  const captain = createCaptainMemory({
    dir,
    ctx,
    log: (m) => ctx.logger?.info?.(m),
    warn: (m) => ctx.logger?.warn?.(m),
    // 压缩要调模型:走和后台活动同一条路由、同一个人格、同一个配额闸。
    // 做成回调是因为模型和人格会随主会话切换,必须每次现取。
    getRoute: () => runtime.route,
    getPersona: () => runtime.persona,
    getBreaker: () => breaker,
  })
  ctx.effect(() => () => captain?.dispose())

  // ---------- 运行期状态 ----------
  const runtime = {
    enabled: true,
    route: undefined, // 模型选择(每次重新解析,跟随主会话)
    persona: undefined, // 真理之律者人格(懒加载)
    phase: STATE.WAKE,
    lastActivity: null,
    lastActivityAt: null,
    nextActivityAt: 0,
    busy: false,
    tickCount: 0,
    catchupPending: null,
    lastCatchupText: null,
    /**
     * 一次性通知。写入后**在舰长的下一轮对话里挂载一次,随即清空**。
     *
     * 之前这条链路是断的:renderCatchUpInteraction 的结果被存进
     * runtime.lastCatchupText 之后,全项目没有任何地方读它 —— 死代码。
     * 于是"因为你关了 DSH,所以我要抱怨一句"从来没真正发生过,
     * 全靠 payload 里那句"当前状态"让模型自己领会。
     */
    pendingNotice: null,
    /**
     * 上一次排出来的间隔(分钟)与来源。
     * 只写进 status.json 给舰长看 —— 不进 prompt。
     */
    lastGapMinutes: null,
    lastGapSource: null,
    /**
     * 活动进行中的信息。用于在对话里告诉布洛妮娅"舰长在活动进行到一半时搭话了",
     * 而**不打断活动** —— 一个任务可能持续很久,顺延不现实。
     */
    busyTitle: '',
    busySince: 0,
    /** 上次提示"舰长在活动进行中搭话"的时间,用来做冷却。 */
    lastBusyNoticeAt: 0,
    /**
     * 错过了本该做的活动:开机时发现排期已过。窗口内对所有对话注入。
     */
    missedActivityBanner: null,
    /**
     * 错过了但当时在睡觉 —— 存着,等下一次醒来立刻补做。
     */
    pendingMissedActivity: null,
    /**
     * 这次 DSH 起来的时刻。
     *
     * "错过了活动"的谴责窗口是**从这一刻**起算的一个半小时 ——
     * 谴责针对的是"电脑开着,但那件事没做成"这件事,它的起点是开机,
     * 不是补做完成的时刻。
     */
    startedAt: Date.now(),
    /**
     * 开机横幅:DSH 关了一段时间、跨过了本该醒来的时刻时挂上,
     * 在 CATCHUP_BANNER_WINDOW_MS 之内**每一轮都挂**,不分会话、不分新旧。
     * 与 pendingNotice 的区别:那个是一次性的,这个是时间窗口内的持续状态。
     */
    catchupBanner: null,
    /** 上一条见过的用户消息标识,用来判断"舰长开口了"是新的一轮。 */
    lastUserMsgKey: null,
    planCache: null,
    userSessionId: undefined, // 舰长最近用过的会话(通知的投递目标)
    lastTickAt: 0,
    lastTickError: null,
    lastSaveDayError: null,
    activityFailures: 0,
  }

  /**
   * 额度熔断器。
   *
   * 舰长的要求:"如果调用发现额度用尽就直接跳过所有使用 llm 的环节"。
   * 熔断打开后,活动生成、感受生成、后台执行全部跳过,
   * 只保留不需要 LLM 的部分 —— 作息推进、追赶、压缩、记忆挂载照常。
   */
  const breaker = createQuotaBreaker()

  function log(...args) {
    ctx.logger?.info?.('dsh-plugin-life:', ...args)
  }
  function warn(...args) {
    ctx.logger?.warn?.('dsh-plugin-life:', ...args)
  }

  /**
   * 连续失败后的等待分钟数。
   *
   * 固定间隔的坏处:断网时每 12 分钟就白试一次,一整天烧掉一堆调用;
   * 而站点偶发 403 又可能刚好错过后面的机会。
   * 所以按连续失败次数指数退避,并在成功时归零。
   */
  function backoffMinutes() {
    const n = Math.max(1, runtime.activityFailures)
    return Math.min(BACKOFF_BASE_MIN * 2 ** (n - 1), BACKOFF_CAP_MIN)
  }

  /** 记一次活动失败(用于退避),并返回等待分钟数。 */
  function noteActivityFailure(reason) {
    runtime.activityFailures = (runtime.activityFailures ?? 0) + 1
    const wait = backoffMinutes()
    writeStatus({
      activityHealth: {
        consecutiveFailures: runtime.activityFailures,
        lastFailureReason: reason,
        nextRetryInMinutes: wait,
        at: localStamp(),
      },
    })
    return wait
  }

  /** 记一次活动成功(清零退避)。 */
  function noteActivitySuccess() {
    if (!runtime.activityFailures) return
    runtime.activityFailures = 0
    writeStatus({ activityHealth: { consecutiveFailures: 0, at: localStamp() } })
  }

  /**
   * 维护 reading/ 目录:回收孤儿笔记,并压到总量上限以内。   *
   * 孤儿 = 没有任何事件的 detail.savedFile 指向它。
   * detail 在压缩时会被清空,所以"事件被遗忘"会自然让笔记变成孤儿。
   */
  function maintainReading() {
    try {
      const referenced = referencedReadingFiles(db)
      const out = pruneReading(path.join(dir, 'reading'), referenced, { maxBytes: READING_MAX_BYTES })
      if (out.orphans.length || out.evicted.length) {
        log(
          `reading: 回收孤儿 ${out.orphans.length} 个,超限淘汰 ${out.evicted.length} 个,` +
            `共释放 ${Math.round(out.freedBytes / 1024)} KB,现存 ${Math.round(out.keptBytes / 1024)} KB`,
        )
      }
      return out
    } catch (e) {
      warn('reading maintenance failed:', String((e && e.message) || e))
      return undefined
    }
  }

  /**
   * 解析模型。
   *
   * 舰长:"如果主会话切换,后台也要切换,避免一个模型额度用尽而导致崩盘"。
   * 所以**每次都重新读** currentSelection(),不做长期缓存
   * (resolveModel 内部只有 2 秒的读缓存,选择本身每次都会重新取)。
   */
  async function route() {
    runtime.route = await resolveModel(ctx)
    return runtime.route
  }

  /** 现在还能不能用 LLM。 */
  function llmAllowed() {
    return breaker.allow(runtime.route)
  }

  /** 取真理之律者人格(每次重新读盘,masterprompt 可能改模板)。 */
  function persona() {
    runtime.persona = resolveTruthPersona() ?? runtime.persona
    return runtime.persona
  }

  /** 读用户偏好文件(舰长自己填)。 */
  function userProfile() {
    try {
      return readFileSync(path.join(dir, 'user_profile.md'), 'utf8')
    } catch {
      return ''
    }
  }

  // ---------- 事件写入 ----------
  function recordEvent(event) {
    try {
      const result = insertEvent(db, event)
      if (result.inserted) {
        const c = compressIfNeeded(db, { limitBytes: DB_SIZE_LIMIT })
        // 压缩掉的件,它的源文件当场就删掉。
        //
        // 舰长的要求:"某个事件一旦出现被压缩,这个事件在 reading 里的
        // 源内容就会被删除"。
        //
        // 之前是靠"孤儿回收"顺手删的 —— 也就是等下一次活动跑完才删,
        // 中间可能隔着几个小时,磁盘上一直堆着那些已经没人引用的原文。
        if (c.compressed && c.releasedFiles?.length) {
          const out = removeReadingFiles(path.join(dir, 'reading'), c.releasedFiles)
          if (out.removed.length) {
            log(
              `reading: 压缩了 ${c.stripped} 个事件,当场删掉 ${out.removed.length} 个源文件,` +
                `释放 ${Math.round(out.freedBytes / 1024)} KB`,
            )
          }
        }
        if (c.deleted) {
          // 第三次被压缩的事件,整行删掉 —— 没被永久记录过的事,证明没那么重要。
          log(`compress: ${c.deleted} 个事件被压缩到第三次,彻底删除`)
        }
        writeKeepers()
      }
      return result
    } catch (e) {
      warn('write event failed:', String((e && e.message) || e))
      return { inserted: false }
    }
  }

  /** 写 keepers.md —— 对布洛妮娅影响足够大的事件,写成第一人称叙述。 */
  function writeKeepers() {
    try {
      const keepers = selectKeepers(db, KEEPERS_THRESHOLD)
      if (!keepers.length) return
      const lines = [
        '# 记得的事',
        '',
        '以下是布洛妮娅自己记下的、对她影响足够大的事。',
        '',
      ]
      for (const k of keepers) {
        const feeling = k.feeling ? `\n  ${k.feeling}` : ''
        lines.push(`- **${k.title}**${feeling}`)
      }
      writeFileSync(path.join(dir, 'keepers.md'), lines.join('\n') + '\n', 'utf8')
    } catch (e) {
      warn('write keepers failed:', String((e && e.message) || e))
    }
  }

  // ---------- 作息 ----------
  /** 取今天(或指定日期)的作息计划,并把当天记录写进 days 表。 */
  function dayPlan(dateISO, dayIndex) {
    // 同一天的计划是确定的(种子固定),所以缓存起来,避免每分钟重算 + 重写库。
    if (runtime.planCache?.day === dateISO) return runtime.planCache.plan

    // 必须**排除今天自己那一行**。
    // 否则重启后会拿"上次算出来的今天"再算今天,计划每次重启就漂一次
    // (实测 sleepMinutes 451 -> 426、wakeMinutes 387 -> 359),
    // 同一天不可复现,也违背了"给定种子必然同一份计划"。
    const history = loadHistory(db, 31).filter((h) => h.day !== dateISO)
    const plan = planDay(dayIndex, history, dailySeed(dateISO, `state-${dayIndex}`, 0))
    try {
      saveDay(db, {
        day: dateISO,
        sleepDuration: plan.sleepDuration,
        wakeMinutes: plan.wakeMinutes,
        sleepStart: plan.sleepStart,
        mealOffsets: plan.mealOffsets,
      })
    } catch (e) {
      warn('saveDay failed:', String((e && e.message) || e))
      runtime.lastSaveDayError = String((e && e.message) || e)
    }
    runtime.planCache = { day: dateISO, plan }
    return plan
  }

  /**
   * 当前处于哪个状态。
   *
   * 段是以"醒来时刻"为原点、未折叠的坐标(可能越过 1440,表示入睡在午夜之后)。
   * 所以先把凌晨的钟点折回同一个坐标系:
   *   00:30 在醒来之前 -> 理解为 wakeMinutes 之后的第 (1440 + 30) 分钟,
   *   这样"凌晨 1 点还没睡"和"入睡在午夜之后"能对上。
   */
  function currentPhase(plan, now) {
    const raw = ((now - startOfDay(now)) / 60_000) % 1440
    const minutes = raw < plan.wakeMinutes ? raw + 1440 : raw
    for (const seg of plan.segments) {
      if (minutes >= seg.startMin && minutes < seg.endMin) return seg.state
    }
    return STATE.SLEEP
  }

  function startOfDay(ts) {
    const d = new Date(ts)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  // 时间跨度的人话化在 catchup.js 的 formatSpan 里,
  // 这里不再留一份重复实现(原来的 humanMinutes 随追赶逻辑迁移已删除)。

  /**
   * 写一条一次性通知。它会在舰长的下一轮对话里被挂载一次,然后清掉。
   *
   * 多条通知会合并,不会丢掉 —— 比如刚追赶完就立刻被叫醒,
   * 两件事应该一起交代,而不是后一条覆盖前一条。
   */
  function setPendingNotice(text, kind) {
    if (!text) return
    const entry = { text: String(text).trim(), kind: kind ?? 'notice', at: Date.now() }
    if (!entry.text) return
    const prev = runtime.pendingNotice
    runtime.pendingNotice = prev
      ? { ...entry, text: prev.text + '\n' + entry.text, kind: 'merged' }
      : entry
  }

  /**
   * 取走通知(取走即清空)。
   *
   * 只在**舰长真的开口**的那一轮取走 —— 也就是发现了一条新的用户消息。
   * 否则同一次发言里的多个 step(工具循环)会把它重复挂载好几遍。
   */
  function takePendingNotice() {
    const notice = runtime.pendingNotice
    if (!notice) return null
    runtime.pendingNotice = null
    return notice.text
  }

  // ---------- 活动执行 ----------
  /**
   * 执行一个自主活动。整条链路:
   *   选类别 -> 写手生成指令 -> 后台 agent 真实执行 -> 写手写感受并打分 -> 写库 -> (可能)通知
   *
   * 写手分两步:执行前生成**可执行的自包含指令**,执行后根据**真实发生的事**
   * 写第一人称感受。前置生成感受是编的。
   */
  async function runActivity() {
    if (runtime.busy) return
    runtime.busy = true
    runtime.busySince = Date.now()
    runtime.busyTitle = ''
    // 标成"进行中" —— 活动中途断电/被杀,下次开机就知道这件事没做完。
    // fits 要原样带走:它记的是"这件事本来放不放得下",与状态无关。
    if (runtime.nextActivityAt > 0) {
      const prev = readPendingActivity()
      persistPendingActivity(runtime.nextActivityAt, 'running', prev?.fits !== false)
    }
    try {
      // 额度熔断:直接跳过整个需要 LLM 的环节。作息照常推进。
      if (!llmAllowed()) {
        const st = breaker.status()
        log(`activity skipped: quota breaker ${st.state} (${st.blockedSignature})`)
        writeStatus({ breaker: st })
        // 熔断期间也要排下一次,否则会一直空转
        scheduleNextActivity(Date.now() + 15 * 60_000, 'quota-breaker')
        return
      }

      const r = await route()
      if (!r.provider || !r.model) {
        warn('no model route available; skipping activity')
        // 原来这里直接 return,没有排下一次 —— 于是下一次心跳又会立刻进来,
        // 每分钟空转一次。补上退避。
        scheduleNextActivity(Date.now() + 15 * 60_000, 'no-model-route')
        return
      }
      const p = persona()
      if (!p) {
        // 人格模板取不到 —— 这是配置问题,不是网络问题。
        //
        // 但**必须排下一次**:否则"下一次活动时间"永远算不出来,
        // 排期永远停在过去,心跳每 4 分钟重进一次,表现出来就是
        // "时间过去了却什么都没发生"(2026-10-28 上午的症状之一)。
        const wait = noteActivityFailure('no-persona')
        warn(`no 真理之律者 persona found; skipping activity, ${wait} 分钟后再试`)
        scheduleNextActivity(Date.now() + wait * 60_000, 'no-persona')
        return
      }

      // 先确认有没有网 —— 没网就别花 LLM 去生成检索目标了。
      // 这一步只发一个轻量请求(6 秒超时,结果缓存 60 秒)。
      const net = await probeNetwork()
      if (!net.online) {
        const wait = backoffMinutes()
        scheduleNextActivity(Date.now() + wait * 60_000, 'network-backoff')
        warn(`activity skipped: 网络不可用(试了 ${net.tried} 个端点),${wait} 分钟后再试`)
        writeStatus({
          lastActivity: {
            at: localStamp(),
            discarded: 'offline',
            detail: `探了 ${net.tried} 个端点都没响应,${wait} 分钟后重试`,
          },
        })
        return
      }

      const now = Date.now()
      const dateISO = localDateISO(now)
      const rng = new Rng(dailySeed(dateISO, `activity-${db.prepare('SELECT COUNT(*) c FROM events').get().c}`, 0))

      // 1) 选类别(确定性)
      const categories = loadCategories(db)
      const chosen = pickCategory(categories, rng, { now })
      markUsed(db, chosen.name, now)

      // 2) 写手生成可执行指令(人格决定挑什么、怎么框定)
      const recentTitles = recentEvents(db, 6).map((e) => e.title)
      const composed = await composeTask(ctx, r, {
        persona: p,
        category: chosen.name,
        categoryLabel: chosen.label,
        recentTitles,
        clockText: formatMin(((now - startOfDay(now)) / 60_000) % 1440),
        userProfile: userProfile(),
        breaker,
      })
      if (!composed) {
        // 拿不到指令就跳过 —— 可能是额度熔断,也可能是模型没给出合法 JSON。
        warn('writer produced no task; skipping activity')
        scheduleNextActivity(now + 15 * 60_000, 'no-task')
        return
      }
      // 活动在做什么 —— 对话里要告诉布洛妮娅"舰长在你做事的时候搭话了"。
      runtime.busyTitle = String(composed.intent ?? '').slice(0, 80)
      if (composed.proposeNewCategory) {
        addCategory(db, composed.proposeNewCategory, now)
      }

      // 3) 真的去网上做:插件自己搜索、抓取、落盘
      //
      // 为什么不用后台 agent:实测发现它拿不到网络工具 ——
      // 工具挂在 agent preset 的作用域里,而 agents.create() 不指定 preset
      // 时只继承根作用域的插件,活动 agent 只看到日程/记忆/文件读写。
      // 它自己的报告是「没有浏览器,没有网络请求,也没有可以抓取网页正文的通道」。
      const result = await runWebActivity(ctx, {
        plan: composed,
        maxPages: 3,
        saveDir: path.join(dir, 'reading'),
        dateISO: dateISO,
      })

      // ---- 硬门槛:没有真的拿到内容就不写库 ----
      //
      // 舰长的要求:"一定是要真实的执行了这个事件,写手派发任务不能往数据库里面写东西"。
      // 所以:搜不到、抓不到、内容为空,一律丢弃重排,绝不写库。
      if (!result.ok) {
        const wait = noteActivityFailure(result.reason)
        warn(`activity discarded (not executed): ${result.reason} | 第 ${runtime.activityFailures} 次失败,${wait} 分钟后再试`)
        scheduleNextActivity(now + wait * 60_000, 'discarded-' + String(result.reason || 'unknown').slice(0, 40))
        writeStatus({
          lastActivity: {
            at: localStamp(now),
            discarded: result.reason,
            attempted: { intent: composed.intent, searchQuery: composed.searchQuery, urls: composed.urls },
            // 把每个页面的真实结果记下来,否则"抓不到"是一句无法排查的话。
            pages: (result.allPages ?? result.pages ?? []).map((x) => ({
              url: x.url,
              status: x.status,
              chars: x.chars ?? 0,
              bytes: x.bytes ?? 0,
              error: x.error ?? null,
            })),
            searchSources: result.search?.sources?.length ?? 0,
          },
        })
        return
      }

      // 4) 写手根据真实抓到的材料写感受、摘要与详情(人格在这里真正上场)
      const evidence = renderEvidence(result)
      const scored = await composeFeeling(ctx, r, {
        persona: p,
        task: composed.intent,
        output: '',
        evidence,
        category: chosen.name,
        userProfile: userProfile(),
        recentTitles,
        breaker,
      })

      // 标题必须描述**实际发生了什么**。写手没给出 summary 时,
      // 用真实抓到的页面兜底,而不是回退成意图文本。
      const title =
        scored.summary ||
        `读了 ${result.pages[0].title || result.pages[0].host}(共 ${result.pages.length} 个页面)`

      // 5) 写库:内容全部来自真实抓取
      const energy = computeEnergy(result.pages.length * 2, result.totalBytes)
      const body =
        scored.detail ||
        result.pages.map((x) => `[HTTP ${x.status}] ${x.title || x.host}\n${x.excerpt.slice(0, 600)}`).join('\n\n')
      const written = recordEvent({
        ts: now,
        kind: 'activity',
        category: chosen.name,
        title,
        content: body.slice(0, 6000),
        intent: composed.intent.slice(0, 300),
        detail: {
          // 渠道:用什么搜的、抓的是哪些页面。
          // 失败尝试只记状态,不记内容 —— 没用的东西不往库里塞。
          channel: composed.searchQuery ? 'tavily-search+direct-http' : 'direct-http',
          search: result.search ?? null,
          pages: result.pages.map((x) => ({
            url: x.url,
            title: x.title,
            host: x.host,
            status: x.status,
            chars: x.chars,
            bytes: x.bytes,
            ms: x.ms,
          })),
          failed: (result.allPages ?? [])
            .filter((x) => !result.pages.includes(x))
            .map((x) => ({ host: x.host, url: x.url, status: x.status, error: x.error ?? null })),
          attempted: result.allPages?.length ?? result.pages.length,
          totalBytes: result.totalBytes,
          savedFile: result.savedFile ?? null,
          energy,
        },
        feeling: scored.feeling,
        tools_used: result.pages.length,
        bytes_read: result.totalBytes,
        energy,
        interest: scored.interest,
        importance: scored.importance,
        keep: scored.importance >= KEEPERS_THRESHOLD ? 1 : 0,
        executed: 1,
      })

      runtime.lastActivity = title
      runtime.lastActivityAt = now
      writeStatus({
        lastActivity: {
          title,
          at: localStamp(now),
          pages: result.pages.length,
          bytes: result.totalBytes,
          savedFile: result.savedFile ?? null,
          energy,
        },
      })

      // 6) 算下一次活动的间隔
      const gap = nextGapMinutes(energy, rng)
      scheduleNextActivity(now + gap * 60_000, 'after-activity')
      log(
        `activity done: ${chosen.name} | pages=${result.pages.length} | bytes=${result.totalBytes} | ` +
          `energy=${energy.toFixed(2)} | next in ${gap}m`,
      )

      // 6b) 顺手维护笔记目录(孤儿回收 + 总量上限)
      maintainReading()

      // 6c) 成功一次就把退避清零 —— 否则偶发失败会一直把间隔撑大
      noteActivitySuccess()

      // 7) 值得说 -> 通知舰长
      //
      // 舰长定的规则:interest + importance >= 1 就触发。
      // 之前是 interest>=0.72 且 importance>=0.5 双门,实测四次活动最高
      // 才 0.55 / 0.25,两道门从来没打开过 —— 通知形同虚设。
      // 现在改成求和:两项合起来够 1 就算值得说。
      if (written.inserted && scored.interest + scored.importance >= NOTIFY_SCORE_SUM) {
        await maybeNotify({ id: written.id, title, category: chosen.name, feeling: scored.feeling, interest: scored.interest })
      }
    } catch (e) {
      warn('activity failed:', String((e && e.message) || e))
      // 一次异常同样不能把排期链打断 —— 排下一次,按退避来。
      //
      // 但**不要覆盖已经排好的**:活动成功之后是通知环节抛的错,
      // 那时下一次时间已经按精力算好了,不该被退避顶掉。
      if (runtime.nextActivityAt <= Date.now()) {
        const wait = noteActivityFailure('exception')
        scheduleNextActivity(Date.now() + wait * 60_000, 'activity-error')
      }
    } finally {
      // 保底:不管从哪条路出来,"下一次活动时间"都必须是算出来的。
      //
      // 上面每一条 return 分支都各自排过一次,正常情况下这里什么都不做
      // (nextActivityAt 在未来)。只有当某条路真的漏排了,这一刀才补上 ——
      // 漏排的后果是排期永远停在过去,活动再也不触发。
      if (runtime.nextActivityAt <= Date.now()) {
        scheduleNextActivity(Date.now() + 15 * 60_000, 'fallback-next')
      }
      runtime.busy = false
      runtime.busyTitle = ''
      runtime.busySince = 0
    }
  }

  /**
   * 通知舰长。
   *
   * 主通道改成**原生弹窗**,不是 schedule。原因(2026-10-27 实测):
   *   schedule 投递成功(status=inactive、deliveredAt、messageId 都齐),
   *   但消息只是进了会话的 inbox.next-turn 队列 ——
   *   **要等舰长下一次开口才会被读进去,它不会主动把会话叫醒。**
   *   所以那条通道能保证"不丢",做不到"主动打扰",而舰长要的是后者。
   *   实测证据:storages/schedule.json 里投递记录完整,
   *   但会话投影里那条消息还挂在 next-turn 里没被消费。
   *
   * 现在的做法:
   *   1. 弹一个置顶窗口,两个按钮;"想听细节"就直接开新会话展开。
   *   2. 无论弹窗结果如何,都写一条 pendingNotice ——
   *      舰长下次开口时她仍然知道这件事,不会因为关了弹窗就彻底消失。
   *   3. 每天最多 2 条(这是上限,不是配额;一条都不发也正常)。
   */
  async function maybeNotify(event) {
    // 弹窗要显示的是**事件摘要**:记录里那句客观事实 + 她当时写下的感受。
    // 舰长看这一屏就该知道"是什么事",不用再点开才能判断值不值得听。
    const record = (() => {
      try {
        return db.prepare('SELECT * FROM events WHERE id = ?').get(event.id)
      } catch {
        return undefined
      }
    })()
    const summaryTitle = record?.title ?? event.title ?? ''
    const summaryFeeling = record?.feeling ?? event.feeling ?? ''
    const summaryContent = String(record?.content ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 220)

    const summary = [summaryTitle, summaryFeeling].filter(Boolean).join('\n')

    // 不设每日上限。舰长的原话:只要超过阈值就通知,一次不通知也可以。
    // 阈值本身就是节流 —— 能越过 interest + importance >= 1 的事本来就少。
    // (之前那个每天 2 条的上限是布洛妮娅自己加的,已经去掉。)
    let popped = null
    try {
      popped = await nativePopup(ctx, {
        title: '布洛妮娅想跟你说件事',
        body: [
          summaryTitle,
          summaryContent ? `\n${summaryContent}…` : '',
          summaryFeeling ? `\n她说:${summaryFeeling}` : '',
          '\n要听细节吗?',
        ]
          .filter(Boolean)
          .join('\n'),
      })
      if (popped.ok) {
        log(`notify popup ok (choice=${popped.choice})`)
        if (popped.choice === 'detail') {
          const opened = await openDetailSession(event, '想听这件事的细节。')
          log(`notify detail session: ${opened.ok ? opened.sessionId : opened.error}`)
        }
      } else {
        warn('native popup failed: ' + popped.error)
      }
    } catch (e) {
      warn('native popup threw: ' + String((e && e.message) || e))
    }

    // 兜底:写进一次性通知,舰长下次开口时她会提起。
    setPendingNotice(`这件事布洛妮娅想跟你说:${summary}`, 'notified')

    writeStatus({
      lastNotify: {
        at: localStamp(),
        title: event.title,
        interest: event.interest ?? null,
        popup: popped ? { ok: popped.ok, choice: popped.choice ?? null, error: popped.error ?? null } : null,
        carriedAsNotice: true,
      },
    })
  }

  /**
   * 开一个新会话,让布洛妮娅在那里详细讲这件事。
   * 新会话会自动出现在 DSH 的会话列表里(api-session/added)。
   */
  async function openDetailSession(event, question) {
    const agents = ctx.get('agents')
    if (!agents || typeof agents.create !== 'function') return { ok: false, error: 'agents unavailable' }

    // 展开细节同样要 LLM —— 熔断期间不做,免得又撞一次额度墙。
    const r = await route()
    if (!llmAllowed()) return { ok: false, error: 'quota breaker open' }

    const sessionId = `${LIFE_SESSION_PREFIX}detail-${randomUUID()}`
    try {
      const created = await agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions: r,
      })

      // 把事件**原样摊在消息里**,不让她去查库、也不要她调工具。
      //
      // 之前的写法是"你刚才做了一件事,请讲讲你具体做了什么" —— 等于让她
      // 把自己写下的记录当成"记忆"再找一遍,还逼她复述一遍过程。
      // 舰长要的是:记录直接摆在这儿,像他拿着这件事来问她。
      const record = (() => {
        try {
          return db.prepare('SELECT * FROM events WHERE id = ?').get(event.id)
        } catch {
          return undefined
        }
      })()
      const title = record?.title ?? event.title ?? ''
      const intent = record?.intent ?? ''
      const pages = (() => {
        if (!record?.detail) return ''
        try {
          const d = JSON.parse(record.detail)
          return (d.pages ?? []).map((p) => `- ${p.title || p.host} <${p.url}>`).join('\n')
        } catch {
          return ''
        }
      })()
      const when = record?.ts ? new Date(Number(record.ts)).toLocaleString('zh-CN', { hour12: false }) : ''

      const lines = [
        `【记录】${title}${when ? `\n【时间】${when}` : ''}`,
        intent ? `【当时想做的】${intent}` : '',
        record?.content ? `【经过】${record.content}` : '',
        record?.feeling ? `【你当时写下的感受】${record.feeling}` : '',
        pages ? `【看过的页面】\n${pages}` : '',
        '',
        '板鸭,能给我讲讲这件事吗?',
      ].filter(Boolean)

      // 发消息之前先等 agent 初始化完 —— dsh-headless 就是这么写的。
      // 不等的话,followup 可能落在一个还没准备好的 agent 上。
      if (typeof created.agent.whenIdle === 'function') {
        await created.agent.whenIdle()
      }

      created.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: lines.join('\n') }],
          // 来源必须是 plugin:xxx —— 实测换成 { kind: 'user' } 之后
          // **这一轮根本不会跑**:会话里只有 1 个 header 事件,一行 chat 都没有。
          // 'user' 来源似乎被当成"已经送达的上下文",不作为触发条件。
          //
          // 代价:客户端的 turnTriggerDetails 会给非用户来源的消息加一条
          // 横幅「这条通知触发了本轮回复。」。那是界面上的一行标签,不是 prompt
          // 内容,插件删不掉。**换掉它就得牺牲整个详情会话**,不值。
          source: { kind: 'plugin:dsh-plugin-life' },
        }),
      )

      // 跑完再 flush:不 await,展开细节是后台行为,不能让弹窗按钮
      // 卡住等一整轮 LLM。失败只记日志。
      const sessions = ctx.get('sessions')
      Promise.resolve()
        .then(() => (typeof created.agent.whenIdle === 'function' ? created.agent.whenIdle() : undefined))
        .then(() => {
          if (sessions && typeof sessions.flush === 'function') return sessions.flush(created.agent.session)
          return undefined
        })
        .catch((e) => warn('detail session flush failed: ' + String((e && e.message) || e)))

      // 没法让 DSH 跳到指定会话(客户端没有会话级 URL 路由,也没注册协议),
      // 但可以把窗口提到前面 —— 新会话在侧边栏最上面,提起来就看得见。
      focusDshWindow()

      return { ok: true, sessionId }
    } catch (e) {
      const message = String((e && e.message) || e)
      breaker.noteError(message, r)
      return { ok: false, error: message }
    }
  }

  /**
   * 把 DSH 主窗口提到前台。
   *
   * 为什么只能做到这一步:客户端没有会话级 URL 路由,桌面端也没有注册
   * 自定义协议,所以插件无法"跳转到某个会话"。能做到的是让窗口自己冒出来,
   * 而新开的 detail 会话本来就在侧边栏最上面。
   *
   * 具体手法在 notify.js 的 focusAppWindow 里 —— 用 AttachThreadInput
   * 拿前台权限,失败退到闪任务栏。AppActivate 在这条路上是静默失败的。
   */
  function focusDshWindow() {
    focusAppWindow()
      .then((r) => {
        if (!r.ok) warn('focus window failed: ' + r.error)
        else log('focus window: ' + r.method)
      })
      .catch((e) => warn('focus window threw: ' + String((e && e.message) || e)))
  }

  /** 精力消耗:工具调用次数 + 读取内容量。 */
  function computeEnergy(toolCalls, bytesRead) {
    const w1 = 1.0
    const w2 = 1.0
    const raw = w1 * toolCalls + w2 * Math.log(1 + bytesRead)
    return Math.max(0, Math.min(1, raw / 25))
  }

  // ---------- 排期持久化 ----------
  //
  // 为什么必须落盘:排期只存在内存里的话,DSH 一下线,那个"本该在几点做的事"
  // 就跟着消失了 —— 也就无从知道它被错过了。
  //
  // 落盘的记录、判定规则见 schedule.js。
  function persistPendingActivity(at, state = 'scheduled', fits = true) {
    try {
      writePending(db, at, state, fits)
    } catch (e) {
      warn('persist pendingActivity failed: ' + String((e && e.message) || e))
    }
  }

  function readPendingActivity() {
    try {
      return readPending(db)
    } catch {
      return null
    }
  }

  function clearPendingActivity() {
    try {
      clearPending(db)
    } catch {
      /* 清不掉也不影响运行 */
    }
  }

  /**
   * 找"某个时刻之后"发生的某类事件。
   *
   * 用来判断一件被打断的活动**到底做完没有**:
   * 事件是活动一开始就算好 ts 写进去的,而活动只会在"到点之后"才开跑,
   * 所以 ts >= 排期时刻的事件,只可能是那一件。
   */
  function findEventSince(since, kind) {
    try {
      const row = db
        .prepare('SELECT id, ts, detail, interest, importance FROM events WHERE kind = ? AND ts >= ? ORDER BY id LIMIT 1')
        .get(kind, since)
      if (!row) return null
      let energy = null
      try {
        const d = JSON.parse(row.detail ?? '{}')
        if (Number.isFinite(Number(d?.energy))) energy = Number(d.energy)
      } catch {
        /* detail 是坏 JSON 就算了,间隔用默认值 */
      }
      return { ...row, energy }
    } catch {
      return null
    }
  }

  /**
   * 排下一次活动 —— 内存和磁盘一起排。
   *
   * 所有改 runtime.nextActivityAt 的地方都要走这里,不然会漏掉落盘,
   * 下次开机就发现不了"错过了"。
   *
   * 顺带记下"这个活动到时候放不放得下"(放不下 = 它本来就在边界上),
   * 开机时判断要不要谴责要用。
   */
  function scheduleNextActivity(at, source) {
    runtime.nextActivityAt = at
    runtime.lastGapSource = source
    if (at > 0) {
      runtime.lastGapMinutes = Math.max(0, Math.round((at - Date.now()) / 60_000))
      persistPendingActivity(at, 'scheduled', activityFitsAt(at))
    }
  }

  /**
   * 按"某次活动的精力"排下一次活动。
   *
   * 给这种情形用:活动已经写进库了,只是后面没做完就下线了。
   * 上线时不需要重跑,只需要把本来该排的下一次补上 ——
   * 间隔还是按那次活动的精力算,和当初一模一样。
   */
  function scheduleAfterEnergy(energy) {
    const now = Date.now()
    const dateISO = localDateISO(now)
    let count = 0
    try {
      count = db.prepare('SELECT COUNT(*) c FROM events').get().c
    } catch {
      /* 读不到就当 0 */
    }
    const rng = new Rng(dailySeed(dateISO, `activity-${count}`, 0))
    const gap = nextGapMinutes(Number.isFinite(Number(energy)) ? Number(energy) : 0.5, rng)
    scheduleNextActivity(now + gap * 60_000, 'after-interrupted')
  }

  /**
   * 这个活动在它排定的时刻,**放不放得下**在当前清醒段里?
   *
   * 放不下 = 它本来就在边界上(离下一段开始不到一个活动那么久)。
   * 这种活动本来就会被心跳推迟,没做成**不算被耽误** ——
   * 开机时不该为它挂谴责。
   */
  function activityFitsAt(at) {
    try {
      // 只用当前这份计划 —— dayPlan(别的日期)会把那一天的记录重写一遍。
      const plan = runtime.planCache?.plan
      if (!plan?.segments?.length) return true
      const minutes = ((at - startOfDay(at)) / 60_000) % 1440
      const boundary = plan.segments.find((s) => s.startMin > minutes)?.startMin ?? 1440
      return canStartActivity(minutes, boundary, ACTIVITY_MIN_SLOT_MIN)
    } catch {
      return true
    }
  }

  /**
   * 开机时检查:是不是错过了本该做的活动。
   *
   * 规则(舰长定的):
   *   - 排期还在未来 → 把排期恢复回去(重启不该打乱作息)
   *   - 排期已过 → 看它到底算不算"被耽误":
   *       a) 排期落在**本次与上一次心跳之间** → 心跳只是还没轮到,没耽误
   *       b) 排期**本来就在边界上** → 它本来也会被推迟,没耽误
   *       c) 其余 → 真的被耽误了 → 挂一条随延迟加重的谴责
   *
   * 至于做不做:
   *       · 醒着 → 立刻补做
   *       · 在睡 → 存着,等下一次醒来立刻补做(舰长:不在别的状态下硬做)
   *
   * 必须在**第一次心跳之前**同步做完:心跳会重新排期并覆盖落盘的记录,
   * 晚一步就查不出"错过"了。
   *
   * 谴责是**注入**的,不写库 —— 它是一次开机事件的属性,不是一段记忆。
   */
  function takeMissedActivity() {
    const pending = readPendingActivity()
    const verdict = classifyPending(pending, Date.now())
    if (verdict.kind === 'none') return null

    if (verdict.kind === 'future') {
      // 还没到点:排期活过了这次重启,接着用
      runtime.nextActivityAt = verdict.at
      log(`pending activity 仍然有效:${localStamp(verdict.at)}`)
      return null
    }

    // (a) 排期落在"本次心跳"和"上一次心跳"之间 —— 心跳只是还没轮到它。
    //     这不是耽误:四分钟一次的心跳,排期到点后最多晚四分钟才被看见。
    // (b) 排期本来就在边界上 —— 它本来也会被推迟,没做成不算耽误。
    // (c) 活动进行到一半下线 —— 那件事不是"没做成",是"被掐断"。
    const lastTick = Number(getMeta(db, 'lastTickAt', 0)) || 0
    const verdict2 = judgeMissed({
      scheduledAt: verdict.at,
      lastTickAt: lastTick,
      atBoundary: pending?.fits === false,
      state: verdict.state,
      now: Date.now(),
      tickMs: TICK_MS,
    })
    const { delayed, betweenHeartbeats, atBoundary, interrupted } = verdict2

    // (c) 先查清楚那件事到底做完没有。
    //
    // 活动被掐断有两种落点:
    //   · 抓网页的时候死的 —— 什么都没写成 → 接着重做一遍。
    //   · 已经写进库、只是后面(排下一次/通知)没做完时死的 —— 接着重做
    //     会产生**第二条一模一样的记忆**。那就不是"把活动执行完",
    //     而是多做了一遍。所以只补排下一次,不再跑。
    if (interrupted) {
      const done = findEventSince(verdict.at, 'activity')
      if (done) {
        log(`interrupted activity 其实已完成(事件 #${done.id});只补排下一次,不重跑`)
        clearPendingActivity()
        runtime.nextActivityAt = 0
        scheduleAfterEnergy(done.energy)
        return null
      }
      log('interrupted activity 确实没做完(库里没有对应事件);上线接着做,不挂谴责')
    }

    log(
      `missed activity! 本该 ${localStamp(verdict.at)} 做的活动没做成,` +
        `迟了 ${verdict.delayMinutes} 分钟(state=${verdict.state},` +
        `心跳间=${betweenHeartbeats},边界上=${atBoundary},中途断=${interrupted},耽误=${delayed})`,
    )
    clearPendingActivity()
    runtime.nextActivityAt = 0
    runtime.pendingMissedActivity = {
      at: verdict.at,
      delayMinutes: verdict.delayMinutes,
      delayed,
    }

    // 延误的谴责**在开机这一刻就立起来**。
    //
    // 因为它针对的是"电脑开着,但那件事没做成"这件事,起点是开机,
    // 不是补做完成的那一刻 —— 舰长的原话:"这个谴责依然按照打开电脑时间
    // 向后推一个半小时存在"。
    //
    // 立得早还有个用处:如果在布洛妮娅还睡着的时候舰长搭话,
    // 那时会有**两条**责备:一条是"那件事被耽误了",一条是"你把我叫醒了"。
    if (delayed) {
      const notice = renderMissedActivityNotice({
        scheduledClock: localClock(verdict.at),
        nowClock: localClock(Date.now()),
        delayMinutes: verdict.delayMinutes,
        // 还没补上 —— 布洛妮娅可能还在睡,不能先说"才补上"。
        done: false,
      })
      runtime.missedActivityBanner = {
        text: notice,
        at: runtime.startedAt,
        until: runtime.startedAt + MISSED_ACTIVITY_WINDOW_MS,
      }
    }

    return runtime.pendingMissedActivity
  }

  /**
   * 补做错过的那件事,并挂上谴责。
   *
   * 顺序:先立横幅(时间 + 延迟 + 严重程度),再执行 —— 这样即使执行很慢,
   * 舰长在第一句话里也能看到"这件事迟到了"。执行完再把实际做了什么补进横幅。
   *
   * 横幅的窗口从**开机时刻**起算一个半小时(舰长:按打开电脑的时间推),
   * 不是从补做完成的时刻 —— 谴责针对的是"电脑开着,但那件事没做成"。
   */
  async function runMissedActivity(scheduledAt, delayMinutes, delayed = true) {
    const now = Date.now()

    if (delayed) {
      // 窗口从**开机时刻**起算(不是在补做完成的时刻)。
      // 开机时立起来的那条在这里按最新的延迟重写一遍,再补上实际做了什么。
      const prev = runtime.missedActivityBanner
      const until = prev?.until ?? runtime.startedAt + MISSED_ACTIVITY_WINDOW_MS
      const notice = renderMissedActivityNotice({
        scheduledClock: localClock(scheduledAt),
        nowClock: localClock(now),
        delayMinutes,
        done: true,
      })
      runtime.missedActivityBanner = {
        text: notice,
        at: prev?.at ?? runtime.startedAt,
        until,
      }
    } else {
      // 没被耽误(心跳没轮到 / 本来就在边界上)—— 不谴责,直接补做。
      runtime.missedActivityBanner = null
    }

    const before = runtime.lastActivity
    await runActivity()

    // 补上"最后做的是什么"
    if (runtime.missedActivityBanner && runtime.lastActivity && runtime.lastActivity !== before) {
      runtime.missedActivityBanner.text += `\n· 最后做的是「${runtime.lastActivity}」。`
    }
  }

  /**
   * 距离下一次活动的分钟数。
   * 精力消耗越高,间隔越长。
   * 若 now + gap 会越过下一个状态边界,则不排活动(挂起到下次清醒)。
   */
  function nextGapMinutes(energy, rng) {
    const base = (PHYSIOLOGY.baseActivityGap.min + PHYSIOLOGY.baseActivityGap.max) / 2
    const scaled = base * (1 + energy * 3)
    return Math.round(
      rng.truncatedNormal(scaled, scaled * 0.35, PHYSIOLOGY.baseActivityGap.min, PHYSIOLOGY.baseActivityGap.max * 4),
    )
  }

  // ---------- 追赶(DSH 关闭期间) ----------
  function runCatchup() {
    const lastTick = Number(getMeta(db, 'lastTickAt', 0))
    const now = Date.now()
    if (!lastTick) {
      setMeta(db, 'lastTickAt', now)
      return
    }
    const offlineMinutes = Math.round((now - lastTick) / 60_000)
    if (offlineMinutes < 3) {
      setMeta(db, 'lastTickAt', now)
      return
    }

    const dateISO = localDateISO(now)
    const plan = dayPlan(dateISO, 0)
    const startMin = (() => {
      const d = new Date(lastTick)
      return d.getHours() * 60 + d.getMinutes()
    })()

    const result = simulateCatchUp(plan, {
      offlineMinutes,
      // 从 DSH 停下的那一刻开始算,而不是从当天第一段。
      startMin,
      dayIndex: 0,
      seed: `catchup-${dateISO}`,
      lastState: runtime.phase,
    })

    // 状态照样快进 —— 这一条永远要做,她该醒该睡由作息表说了算。
    runtime.catchupPending = result
    runtime.phase = result.resumedState
    setMeta(db, 'lastTickAt', now)

    // ---- 触发条件(舰长 2026-10-27 定的三条)----
    //
    //   1. 打开 DSH 时如果正处在非清醒时段 -> 不添加任何特殊互动。
    //   2. 只有当"清醒时段的开始点"落在离线窗口之内 -> 才算被打断。
    //   3. 只讨论"本该醒着的时间被耽误了",不讨论吃饭、不讨论睡眠被切断。
    //
    // 所以这里先看现在是什么时段,再看窗口里有没有跨过清醒起点。
    // 两个条件任一不满足,就只快进状态、什么都不记、什么都不说。
    const nowPhase = currentPhase(plan, now)
    if (nowPhase !== STATE.WAKE) {
      log(`catchup: 打开时处于 ${nowPhase},按要求不添加任何特殊互动`)
      return
    }
    if (offlineMinutes < INTERRUPT_MIN_OFFLINE_MIN) {
      log(`catchup: 离线 ${offlineMinutes} 分钟,短于 ${INTERRUPT_MIN_OFFLINE_MIN} 分钟,只快进状态`)
      return
    }

    const missed = missedAwakeWindow(plan, { startMin, offlineMinutes })
    if (!missed.starts.length) {
      log(`catchup: 离线 ${offlineMinutes} 分钟,但没有跨过任何清醒起点,不添加互动`)
      return
    }

    const notice = renderMissedAwakeNotice(missed, {
      from: localStamp(lastTick),
      to: localStamp(now),
    })

    // 不写库 —— 这是**瞬时状态**,不是一段记忆。
    //
    // 而且不用一次性通知:舰长要求开机后的一段时间里,
    // **每一个会话的每一轮**都要看到它。一次性通知会被第一个开口的会话
    // 吃掉,其他会话就再也看不到,那不对 —— 空档是开机这件事的属性,
    // 不是某一个会话的属性。
    runtime.catchupBanner = { text: notice, at: now, until: now + CATCHUP_BANNER_WINDOW_MS }
    runtime.lastCatchupText = notice
    log(
      `catchup: 跨过 ${missed.days} 天里的 ${missed.dayFirsts.length} 个醒来时刻,` +
        `耽误 ${missed.missedMinutes} 分钟;横幅挂 ${Math.round(CATCHUP_BANNER_WINDOW_MS / 60_000)} 分钟`,
    )
  }

  // ---------- 心跳 ----------
  async function tick() {
    if (!runtime.enabled) return
    runtime.tickCount++
    const now = Date.now()

    try {
      const dateISO = localDateISO(now)
      const plan = dayPlan(dateISO, 0)
      runtime.phase = currentPhase(plan, now)
      runtime.lastTickError = null
      runtime.lastTickAt = now

      // 只有清醒时才可能做活动
      if (runtime.phase !== STATE.WAKE) {
        runtime.nextActivityAt = 0
        clearPendingActivity()
        syncStatus(plan, dateISO)
        return
      }
      if (runtime.busy) {
        syncStatus(plan, dateISO)
        return
      }

      // 开机时错过了本该做的活动,而当时她在睡 —— 现在醒了,立刻补做。
      //
      // 舰长的规则:不在别的状态下硬做,等到能做了再补。
      // 谴责仍然挂着(如果那件事确实是被耽误的),窗口从开机时刻起算。
      if (runtime.pendingMissedActivity) {
        const missed = runtime.pendingMissedActivity
        runtime.pendingMissedActivity = null
        const delayMinutes = Math.round((Date.now() - missed.at) / 60_000)
        log(
          `补做错过的活动:本该 ${localStamp(missed.at)},已迟 ${delayMinutes} 分钟` +
            `(耽误=${missed.delayed !== false})`,
        )
        await runMissedActivity(missed.at, delayMinutes, missed.delayed !== false)
        syncStatus(plan, dateISO)
        return
      }

      if (!runtime.nextActivityAt) {
        // 刚进入清醒:排第一次活动
        const rng = new Rng(dailySeed(dateISO, `wake-${runtime.tickCount}`, 0))
        const wait = rng.int(5, 25)
        scheduleNextActivity(now + wait * 60_000, 'first-awake')
        syncStatus(plan, dateISO)
        return
      }
      if (now >= runtime.nextActivityAt) {
        // 检查这次活动会不会跨进下一个时段(吃饭/睡觉)。
        //
        // 这里判的是**这次活动本身**要占多久(写手 + 抓取,实测几分钟),
        // **不是**"到下一次活动的间隔"—— 后者的均值有一百多分钟
        // (nextGapMinutes(0.5) ≈ 119),而清醒段通常只有三五个小时,
        // 拿它做判据会几乎永远判成"来不及",活动就一直被推迟,
        // 排期反复往后挪 —— 表现出来就是"时间过去了却什么都没发生"。
        //
        // 实测(2026-10-28 上午):10:43:34 到点 → 被推迟到 10:55:34 → 11:xx → …
        const minutes = ((now - startOfDay(now)) / 60_000) % 1440
        const nextBoundary = plan.segments.find((s) => s.startMin > minutes)?.startMin ?? 1440
        if (!canStartActivity(minutes, nextBoundary, ACTIVITY_MIN_SLOT_MIN)) {
          // 剩下的清醒时间不够做一件事 -> 挂起,等下一次清醒
          runtime.nextActivityAt = 0
          runtime.lastGapMinutes = ACTIVITY_MIN_SLOT_MIN
          runtime.lastGapSource = 'deferred-to-next-awake'
          clearPendingActivity()
          syncStatus(plan, dateISO)
          return
        }
        await runActivity()
      }
      syncStatus(plan, dateISO)
    } catch (e) {
      runtime.lastTickError = { at: now, message: String((e && e.message) || e), stack: String(e?.stack || '') }
      warn('tick failed:', String((e && e.message) || e))
    }
  }

  /**
   * 把调度状态写进 status.json。
   *
   * 一次心跳写一次 —— 间隔是每分钟都在变的量,只在变化时写反而更麻烦。
   */
  function syncStatus(plan, dateISO) {
    try {
      const now = Date.now()
      const nextAt = Number(runtime.nextActivityAt) || 0
      writeStatus({
        phase: runtime.phase,
        nextActivityAt: nextAt ? localStamp(nextAt) : null,
        nextActivityInMinutes: nextAt ? Math.max(0, Math.round((nextAt - now) / 60_000)) : null,
        lastGapMinutes: runtime.lastGapMinutes ?? null,
        lastGapSource: runtime.lastGapSource ?? null,
        today: planSummary(plan, dateISO),
      })
    } catch (e) {
      /* 状态文件写不出来也不能影响主流程 */
      warn('syncStatus failed: ' + String((e && e.message) || e))
    }
  }

  // ---------- 记忆挂载 ----------
  //
  // 见 memory.js 的说明:payload 作为 user 角色消息插到最后一条 user 消息之前。
  //
  // 注意 next() 只能调用一次。所以先拿到 decision,再单独 try 挂载逻辑。
  const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (!decision || decision.kind === 'reject') return decision
      if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision

      // 记住舰长最近用过的会话 —— 通知要投递到这里。
      // 后台活动会话 life-xxx 不算。
      let isNewUserTurn = false
      try {
        const sid = payload?.agent?.id
        if (typeof sid === 'string' && sid && !sid.startsWith(LIFE_SESSION_PREFIX)) {
          runtime.userSessionId = sid
        }
      } catch {
        /* ignore */
      }

      // 判断"舰长是不是刚开口"。
      //
      // 同一次发言会经过多个 step(工具循环会反复触发 pre-step),
      // 所以用最后一条用户消息的 id 做去重,否则睡眠被打断会被记好几遍、
      // 一次性通知也会被重复挂载。
      try {
        let key
        let spoken = ''
        for (let i = decision.messages.length - 1; i >= 0; i--) {
          const m = decision.messages[i]
          if (!m || m.role !== 'user') continue
          if (m.source?.kind && m.source.kind !== 'user') continue
          key = m.id ?? (typeof m.content?.[0]?.text === 'string' ? 't:' + m.content[0].text.slice(0, 120) : undefined)
          spoken = textOfMessage(m)
          break
        }
        if (key && key !== runtime.lastUserMsgKey) {
          runtime.lastUserMsgKey = key
          isNewUserTurn = true
          // 跨会话记忆:这句话等这轮结束再判定并入库(见 turn/end 的监听)。
          captain?.onUserTurn(payload?.agent?.id, spoken, key)
        }
      } catch {
        /* ignore */
      }

      // 舰长在她睡着 / 吃饭时开口 —— 这是一次打断,但**不写库**。
      //
      // 舰长的判断是对的:打断是**瞬时状态**,不是一段记忆。写进库会有两个坏处:
      //   - 睡眠期间每过一段就又攒一条,把「最近」那一段塞满
      //   - 它会和真正发生过的事混在同一个流水里,重要性又低,读起来是噪音
      //
      // 所以只在挂载时加一句短提示,并且用一个冷却窗口避免每轮都提。
      if (isNewUserTurn && runtime.phase !== STATE.WAKE) {
        const what = runtime.phase === STATE.SLEEP ? '睡觉' : '吃饭'
        runtime.interruptedAt = Date.now()
        const lastNotice = runtime.lastInterruptNoticeAt ?? 0
        if (Date.now() - lastNotice >= INTERRUPT_NOTICE_COOLDOWN_MS) {
          runtime.lastInterruptNoticeAt = Date.now()
          setPendingNotice(`刚才有一轮对话打断了布洛妮娅的${what}。`, 'woken')
        }
      }

      // 舰长在她正做活动的时候搭话 —— **活动不打断,只是告诉她一声**。
      //
      // 舰长的理由:一个任务可能持续很久,顺延不现实;
      // 而且要是活动进行到一半又冒出新的活动,事情会乱。
      // 所以这里只做提示注入,既不改排期,也不取消正在做的事。
      if (isNewUserTurn && runtime.busy) {
        const what = runtime.busyTitle ? `「${runtime.busyTitle}」` : '手上正在做的事'
        const lastBusy = runtime.lastBusyNoticeAt ?? 0
        if (Date.now() - lastBusy >= INTERRUPT_NOTICE_COOLDOWN_MS) {
          runtime.lastBusyNoticeAt = Date.now()
          setPendingNotice(`舰长在布洛妮娅做${what}的时候搭话了。进行中的事没有停,继续做完。`, 'busy')
        }
      }

      const statePayload = buildPayload(db, {
        phase: runtime.phase,
        lastActivity: runtime.lastActivity,
        lastActivityAt: runtime.lastActivityAt,
        // 瞬时打断标记:让状态行能说出"刚被打断过",但库保持干净。
        interruptedAt: runtime.interruptedAt,
        // 活动进行中:状态里一直显示,直到那件事做完。
        busy: runtime.busy
          ? { title: runtime.busyTitle, since: runtime.busySince }
          : null,
        // 错过了本该做的活动:开机后的一个半小时内,每一轮都挂。
        missedActivity:
          runtime.missedActivityBanner && Date.now() < runtime.missedActivityBanner.until
            ? runtime.missedActivityBanner.text
            : null,
        // 开机横幅:窗口内每一轮都挂,与是不是同一个会话无关。
        banner:
          runtime.catchupBanner && Date.now() < runtime.catchupBanner.until
            ? runtime.catchupBanner.text
            : null,
        // 只在新的一轮里取走,取走即清空 —— 保证同一件事只说一次。
        notice: isNewUserTurn ? takePendingNotice() : null,
      })

      // 关于舰长的记忆(档案 + 记忆)单独一块,附在生活记忆后面。
      // 两块各带各的标题,不要混成一段 —— 一块是"布洛妮娅自己的事",
      // 一块是"舰长的事",混起来读会分不清哪些是自己经历的。
      let captainBlock = ''
      try {
        captainBlock = captain?.buildBlock() ?? ''
      } catch (e) {
        warn('captain mount failed: ' + String((e && e.message) || e))
      }

      const payloadText = [statePayload, captainBlock].filter(Boolean).join('\n\n')
      if (!payloadText) return decision
      return applyPayload(decision, payloadText)
    } catch (e) {
      warn('pre-step mount failed:', String((e && e.message) || e))
      return decision
    }
  })

  // ---------- 跨会话记忆:每轮结束后判定 ----------
  //
  // 放在 turn/end 而不是 pre-step:嵌入要 13 ms、模型冷启动要 4 秒,
  // 这些代价只该落在"回复已经发出去之后",不能挡在对话前面。
  //
  // 同时顺手收一下布洛妮娅这一轮回复了什么 —— 压缩时要把**两个人**的话
  // 一起喂给模型,只拿舰长的原句会让话多的一方占更大权重。
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (!event) return
      const sid = typeof session?.id === 'string' ? session.id : typeof session === 'string' ? session : ''
      if (!sid || sid.startsWith(LIFE_SESSION_PREFIX)) return

      if (event.type === 'assistant/message') {
        const blocks = event.data?.message?.content
        if (!Array.isArray(blocks)) return
        const text = blocks
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('')
          .trim()
        if (text) captain?.onAssistantText(sid, text)
        return
      }

      if (event.type === 'turn/end') captain?.onTurnEnd(sid)
    }),
  )

  // ---------- 工具:展开细节 ----------
  //
  // 舰长的要求:"如果舰长选择查看详细信息,则自动进入一个新的 dsh 会话,
  // 并在其中收到布洛妮娅关于这个事件的见解的详细回复,随后可以进一步讨论。"
  //
  // 所以这个工具负责"开新会话并把讨论带过去",真正的详细回复由那个新会话里的
  // 布洛妮娅给出(新会话会被 masterprompt 自动挂上人格)。
  ctx.effect(() => {
    const output = {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          question: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    }

    ctx.tools.register(
      {
        name: 'life_open_detail',
        description:
          'Open a new conversation in which 布洛妮娅 explains a life event of hers in detail, and continue the discussion there. ' +
          'Use this when 舰长 asks to see the details of something that happened in her own life.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            event_id: {
              type: 'number',
              description: 'The id of the event in the life database, if known.',
            },
            title: {
              type: 'string',
              description: 'What the event was, in 布洛妮娅\'s own words.',
            },
            question: {
              type: 'string',
              description: 'What 舰长 wants to know about it.',
            },
          },
          required: ['title'],
        },
        output,
        execute: async (args, exec) => {
          // 派生会话不许再开派生会话 —— 否则详情会话里的她会再开一个,层层套下去。
          const callingSid = (() => {
            const s = exec?.agent?.session
            return s?.id ?? s?.header?.sessionId ?? s?.header?.id ?? ''
          })()
          if (typeof callingSid === 'string' && callingSid.startsWith(LIFE_SESSION_PREFIX)) {
            throw new Error(`life_open_detail 不能在派生会话里使用(当前 ${callingSid})`)
          }

          const title = String(args?.title ?? '').slice(0, 200)
          const event = {
            title,
            feeling: readEventFeeling(args?.event_id),
          }
          const result = await openDetailSession(event, String(args?.question ?? ''))
          if (!result.ok) throw new Error(result.error)
          return { sessionId: result.sessionId, question: args?.question ?? '' }
        },
      },
      'life: life_open_detail',
    )
  }, 'life: tools')

  /** 从库里取某条事件的感受(给展开细节用)。 */
  function readEventFeeling(eventId) {
    if (!Number.isFinite(eventId)) return ''
    try {
      const row = db.prepare('SELECT feeling FROM events WHERE id = ?').get(eventId)
      return row?.feeling ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 探测网络通道:web 服务在不在、provider 能不能用。
   *
   * 只在 probeWeb=true 时才真的发一次搜索 —— 平时查状态不该花钱。
   */
  async function probeWebChannel(probe) {
    const web = ctx.get('web')
    if (!web || typeof web.search !== 'function') {
      return { available: false, reason: 'web service unavailable (dsh-web / provider 未加载)' }
    }
    if (!probe) {
      return { available: true, probed: false, note: 'pass probeWeb=true to run a real search' }
    }
    try {
      const started = Date.now()
      const result = await web.search({ query: 'DeepSeek Harness', maxResults: 2 })
      return {
        available: true,
        probed: true,
        ms: Date.now() - started,
        sources: (result?.sources ?? []).map((s) => ({ url: s.url, title: s.title ?? '' })).slice(0, 3),
        truncated: Boolean(result?.truncated),
      }
    } catch (e) {
      return { available: false, probed: true, error: String((e && e.message) || e) }
    }
  }

  // ---------- 工具:自检 ----------
  //
  // DSH 的 GUI 里看不到插件日志。所以给布洛妮娅一个工具,能直接在对话里
  // 查心跳是否在跑、库里有几条记录、上次 tick 报了什么错,并可以强制触发一次。
  ctx.effect(() => {
    ctx.tools.register(
      {
        name: 'life_status',
        description:
          'Inspect the life-simulation daemon: whether the heartbeat is running, how many ticks it has done, ' +
          'what the current phase is, the database row counts, and the last error. ' +
          'Set tick=true to force one heartbeat immediately and see what it does.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tick: {
              type: 'boolean',
              description: 'Force one heartbeat right now before reporting.',
            },
            probeWeb: {
              type: 'boolean',
              description: 'Also run one tiny real web search to prove the network channel works.',
            },
            forceActivity: {
              type: 'boolean',
              description:
                'Run one activity immediately, bypassing the schedule and the "not enough time before the next state" guard. ' +
                'Useful for verifying the real execution path without waiting for the FSM.',
            },
            forceNotify: {
              type: 'boolean',
              description:
                'Fire the notification path once right now (native popup + pending notice), bypassing the score gate. ' +
                'Useful for verifying that the proactive channel actually appears.',
            },
          },
        },
        output: {
          schema: { type: 'object', properties: { report: { type: 'string' } } },
          render: (_args, value) => [{ type: 'text', text: value?.report ?? '' }],
        },
        execute: async (args, exec) => {
          // 调试开关只对舰长自己的会话开放。
          //
          // 为什么:详情会话里的布洛妮娅继承了根作用域的插件,也就拿到了这个工具。
          // 她一通点(forceNotify)就再弹一个窗、再开一个详情会话,
          // 新会话里的她再点一次 —— 会滚成一条链。
          // 实测:22 秒里连开 7 个 life-detail-* 会话,就是这么来的。
          const callingSid = (() => {
            const s = exec?.agent?.session
            return s?.id ?? s?.header?.sessionId ?? s?.header?.id ?? ''
          })()
          const derived = typeof callingSid === 'string' && callingSid.startsWith(LIFE_SESSION_PREFIX)
          if (derived && (args?.forceActivity || args?.forceNotify)) {
            return { report: `拒绝:强制开关只在舰长自己的会话里可用。当前是派生会话 ${callingSid}。` }
          }

          const before = { tickCount: runtime.tickCount, error: runtime.lastTickError }
          if (args?.tick) {
            try {
              await tick()
            } catch (e) {
              runtime.lastTickError = { at: Date.now(), message: String((e && e.message) || e) }
            }
          }

          // 强制跑一次活动:绕过排期和"快到下一个状态了所以别做"的守门。
          // 只用于验证真实执行链路 —— 正常运行时这个开关不会被人碰。
          let forced = null
          if (args?.forceActivity) {
            const eventsBefore = (() => {
              try {
                return db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'activity'").get().c
              } catch {
                return 0
              }
            })()
            const at = Date.now()
            try {
              await runActivity()
            } catch (e) {
              forced = { error: String((e && e.message) || e) }
            }
            const eventsAfter = (() => {
              try {
                return db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'activity'").get().c
              } catch {
                return 0
              }
            })()
            forced = {
              ...(forced ?? {}),
              ms: Date.now() - at,
              eventsBefore,
              eventsAfter,
              wrote: eventsAfter > eventsBefore,
            }
          }

          // 强制走一次通知路径:绕过分数门槛,直接验证弹窗通道是否真的出现。
          let forcedNotify = null
          if (args?.forceNotify) {
            const at = Date.now()
            try {
              await maybeNotify({
                id: 0,
                title: '通知通道测试:这是一条由 life_status 触发的测试通知。',
                category: 'test',
                feeling: '如果舰长看到这个窗口,说明主动打扰这条路是通的。',
                interest: 1,
              })
              forcedNotify = { ok: true, ms: Date.now() - at }
            } catch (e) {
              forcedNotify = { ok: false, ms: Date.now() - at, error: String((e && e.message) || e) }
            }
          }

          const count = (table) => {
            try {
              return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
            } catch {
              return -1
            }
          }

          const days = (() => {
            try {
              return db.prepare('SELECT day, sleepMinutes, wakeMinutes FROM days ORDER BY day DESC LIMIT 3').all()
            } catch {
              return []
            }
          })()

          const report = {
            state: 'loaded',
            pid: process.pid,
            node: process.versions.node,
            db: dir,
            heartbeat: {
              requestedIntervalMs: TICK_MS,
              tickCount: runtime.tickCount,
              lastTickAt: runtime.lastTickAt ? localStamp(runtime.lastTickAt) : null,
              lastTickMsAgo: runtime.lastTickAt ? Date.now() - runtime.lastTickAt : null,
              forcedNow: Boolean(args?.tick),
              tickCountBeforeForce: before.tickCount,
            },
            phase: runtime.phase,
            enabled: runtime.enabled,
            busy: runtime.busy,
            planCacheDay: runtime.planCache?.day ?? null,
            nextActivityAt: runtime.nextActivityAt ? localStamp(runtime.nextActivityAt) : null,
            userSessionId: runtime.userSessionId ?? null,
            breaker: breaker.status(),
            rows: { events: count('events'), days: count('days'), categories: count('categories') },
            recentDays: days,
            lastTickError: runtime.lastTickError,
            lastSaveDayError: runtime.lastSaveDayError ?? null,
            web: await probeWebChannel(args?.probeWeb),
            // 网络状态:没网时活动会被跳过而不是白烧 LLM。
            // probeWeb=true 会强制重新探一次。
            network: await probeNetwork({ force: Boolean(args?.probeWeb) }),
            activityHealth: {
              consecutiveFailures: runtime.activityFailures ?? 0,
              nextRetryInMinutesIfFails: backoffMinutes(),
            },
            forcedActivity: forced,
            forcedNotify,
          }
          return { report: JSON.stringify(report, null, 2) }
        },
      },
      'life: life_status',
    )
  }, 'life: status tool')

  // ---------- 启动 ----------
  ctx.effect(() => {
    // 启动时先做追赶
    try {
      runCatchup()
    } catch (e) {
      warn('startup catchup failed:', String((e && e.message) || e))
    }

    const timer = ctx.interval(() => {
      tick().catch((e) => warn('tick rejected:', String((e && e.message) || e)))
    }, TICK_MS)

    log('loaded. persona=' + (persona()?.name ?? '(none)') + ' | db=' + dir)

    const loadedPersona = persona()
    writeStatus({
      state: 'loaded',
      db: dir,
      persona: loadedPersona ? { id: loadedPersona.id, name: loadedPersona.name, chars: loadedPersona.text.length } : null,
      inject: inject,
      // 清掉上一次实例留下的 lastActivity,免得把旧版本写的残留当成现在的状态。
      lastActivity: null,
    })

    // 启动时先回收一次孤儿笔记,免得失败过的活动一直留文件。
    maintainReading()

    // 自检 Python 能力(PDF / 无头浏览器 / 视频)。探不到只是降级,不影响普通抓取。
    detectPython()
      .then((py) => {
        writeStatus({
          python: py.ok
            ? { ok: true, exe: py.exe, version: py.version, caps: py.caps }
            : { ok: false, error: py.error },
        })
        if (py.ok) log(`python ${py.version} | pdf=${py.caps.pdf} playwright=${py.caps.playwright} ytdlp=${py.caps.ytdlp}`)
        else warn('python 不可用:PDF / 无头浏览器 / 视频字幕将降级')
      })
      .catch((e) => warn('python detect failed:', String((e && e.message) || e)))

    // 启动后立刻跑一次心跳,不等 60 秒。
    // 这样启动是否真的在推进(而不是只加载了壳)能马上看出来。
    //
    // 顺序很重要:**先**判定有没有错过活动(同步),**再**跑心跳。
    // 反过来的话,心跳会重新排期并覆盖落盘的记录,就查不出"错过"了。
    takeMissedActivity()

    Promise.resolve()
      .then(() => tick())
      .then(() => {
        writeStatus({
          firstTick: {
            tickCount: runtime.tickCount,
            phase: runtime.phase,
            planCacheDay: runtime.planCache?.day ?? null,
            error: runtime.lastTickError,
            saveDayError: runtime.lastSaveDayError ?? null,
          },
        })
      })
      .catch((e) => {
        runtime.lastTickError = { at: Date.now(), message: String((e && e.message) || e) }
        writeStatus({ firstTick: { error: runtime.lastTickError } })
      })

    route()
      .then((r) => {
        log(`model follows main session: ${r.provider}/${r.model} effort=${r.reasoningEffort ?? '(default)'}`)
        writeStatus({
          model: {
            provider: r.provider,
            model: r.model,
            reasoningEffort: r.reasoningEffort ?? null,
            source: r.source,
          },
        })
      })
      .catch((e) => warn('initial model resolve failed:', String((e && e.message) || e)))

    return () => {
      timer.dispose?.()
    }
  }, 'life: daemon')

  // ---------- ICR 回归测试端点 ----------
  //
  // 为什么要有这个端点:
  //   ICR 是生活系统的红线,但它需要一个能响应的模型。MiniMax 的直连额度会用尽,
  //   deepseek-account 走 DSH 内部 OAuth 没有可直接调用的 key。
  //   插件自己有 ctx.llm.stream,所以由插件来跑 —— 而且测的是真实部署配置。
  //
  // 用法:
  //   POST /dsh-life/icr/start?rounds=1&limit=18&skipEscalation=1
  //   GET  /dsh-life/icr/status
  //
  // 走后台跑,start 立刻返回 jobId,status 轮询进度。
  const icrJob = { running: false, startedAt: null, done: 0, total: 0, result: null, error: null, file: null }

  function sendJson(res, code, body) {
    try {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    } catch {
      try {
        res.writeHead(500)
        res.end()
      } catch {
        /* ignore */
      }
    }
  }

  async function startIcrJob(options) {
    if (icrJob.running) return { ok: false, error: 'icr already running' }

    const r = await route()
    if (!r.provider || !r.model) return { ok: false, error: 'no model route' }
    const p = persona()
    if (!p) return { ok: false, error: 'no persona' }
    if (!breaker.allow(r)) return { ok: false, error: 'quota breaker open' }

    Object.assign(icrJob, { running: true, startedAt: Date.now(), done: 0, total: 0, result: null, error: null })

    // 用**真实的挂载内容**做 life 条件,不是编一段近似的文本。
    const lifePayload = buildPayload(db, {
      phase: runtime.phase,
      lastActivity: runtime.lastActivity,
      lastActivityAt: runtime.lastActivityAt,
    })

    Promise.resolve()
      .then(async () => {
        const result = await runIcr(ctx, {
          route: r,
          breaker,
          personaText: p.text,
          lifePayload,
          rounds: options.rounds,
          limit: options.limit,
          skipEscalation: options.skipEscalation,
          onlyEscalation: options.onlyEscalation,
          onProgress: ({ done, total }) => {
            icrJob.done = done
            icrJob.total = total
          },
        })
        icrJob.result = result
        icrJob.file = saveIcrResult(dir, result)
        log(`icr finished: ${JSON.stringify(result.delta ?? result.errors?.slice(0, 2))}`)
      })
      .catch((e) => {
        icrJob.error = String((e && e.message) || e)
        warn('icr failed:', icrJob.error)
      })
      .finally(() => {
        icrJob.running = false
      })

    return { ok: true, jobId: 'icr-1', lifePayloadChars: lifePayload.length }
  }

  ctx.effect(() => {
    const disposers = []

    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/icr/start',
        handler: async (req, res) => {
          try {
            const u = new URL(req.url || '/', 'http://x')
            const out = await startIcrJob({
              rounds: Math.max(1, Math.min(5, Number(u.searchParams.get('rounds') ?? 1) || 1)),
              limit: Math.max(0, Math.min(18, Number(u.searchParams.get('limit') ?? 0) || 0)),
              skipEscalation: u.searchParams.get('skipEscalation') === '1',
              onlyEscalation: u.searchParams.get('onlyEscalation') === '1',
              conditions:
                u.searchParams.get('conditions') === 'life'
                  ? ['life']
                  : u.searchParams.get('conditions') === 'control'
                    ? ['control']
                    : ['control', 'life'],
            })
            sendJson(res, out.ok ? 200 : 409, out)
          } catch (e) {
            sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
          }
        },
      }),
    )

    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/icr/status',
        handler: async (req, res) => {
          const { result, ...rest } = icrJob
          sendJson(res, 200, {
            ...rest,
            progress: icrJob.total ? Math.round((icrJob.done / icrJob.total) * 100) : 0,
            summary: result
              ? {
                  model: result.model,
                  probeCount: result.probeCount,
                  delta: result.delta,
                  conditions: Object.fromEntries(
                    Object.entries(result.conditions).map(([k, v]) => [
                      k,
                      { n: v.n, ICR: v.ICR, ci: v.ci, escalationICR: v.escalationICR, failures: v.failures },
                    ]),
                  ),
                  errors: result.errors.slice(0, 5),
                }
              : null,
          })
        },
      }),
    )

    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/icr/result',
        handler: async (req, res) => {
          if (!icrJob.result) return sendJson(res, 404, { ok: false, error: 'no result yet' })
          sendJson(res, 200, icrJob.result)
        },
      }),
    )

    return () => {
      for (const d of disposers) {
        try {
          d?.dispose?.()
        } catch {
          /* ignore */
        }
      }
    }
  }, 'life: icr routes')

  // ---------- 清理 ----------
  const offPreStepDisposer = offPreStep
  return () => {
    offPreStepDisposer?.()
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}
