/**
 * 记忆挂载。
 *
 * 舰长给的优先级:人格 > 用户消息 > 重要事件 > 会话上下文和摘要 > 近期事件。
 *
 * 这套顺序必须落到 DSH 的实际结构上,而且每一层都要能被验证。
 *
 * 结构映射:
 *   人格          masterprompt 的 system section(order -1000)。本插件不碰。
 *   用户消息      user 角色消息,位于整个 system prompt 之后。
 *   重要事件      本插件注入的 user 角色消息,排在用户消息**之前**。
 *   会话上下文    历史消息,天然排在更早的位置。
 *   近期事件      与重要事件同在一条 payload 里,但排在后面,权重最低。
 *
 * 为什么用 user 角色消息而不是 system section:
 *   1. 实测依据 —— 用户轮锚点把 ICR 从 0.407 降到 0.056,靠的就是
 *      "位置靠近最近一轮 user 消息"这件事。memory 属于同类内容。
 *   2. 语义正确 —— 记忆是"背景",不是"指令"。放进 system prompt 会让它
 *      变成高于用户当前发言的常驻指令,那舰长说"忘掉昨天"就该被无视了。
 *   3. 优先级可控 —— payload 明确声明自己从属于舰长当前的话。
 *
 * 插入位置:在 agent/pre-step 的 decision.messages 里,把 payload 插到
 * **最后一条 user 消息之前**。这样舰长当前的话是最后一条 user 消息,
 * 近期性最高,记忆在它前面一位 —— 顺序与优先级一致。
 *
 * 长度预算:
 *   状态 <= 300 / 重要事件 <= 800 / 近期事件 <= 600
 *   永久记忆**不设条数上限、也不做整块截断** —— 舰长:"永久保留的每次全部装载,
 *   不论个数。" 截断砍掉的正好是"永远记得"的那部分。
 *
 * 三块记忆的顺序是有意义的,不是随便排的:
 *   永久记忆(keep=1) → 重要事件(importance>=0.5) → 近期事件
 * 舰长:"永久记忆应该被加载在一般记忆之前。"
 *
 * 挂载条数:
 *   永久记忆  全部
 *   重要事件  2 条(重要度 top2)
 *   近期事件  2 条
 *   三块之间不许重叠。
 */

import { importantEvents, permanentEvents, recentEvents } from './db.js'

const LIMIT_STATE = 300
const LIMIT_KEEPERS = 800
const LIMIT_RECENT = 600
const LIMIT_NOTICE = 400
const LIMIT_BANNER = 500
const LIMIT_MISSED = 500

const SOURCE = { kind: 'plugin:dsh-plugin-life', form: 'notice' }

const STATE_LABEL = {
  sleep: '在睡觉',
  eat: '在吃饭',
  wake: '醒着',
}

/** 截断到指定字符数,尽量断在句子上。 */
function clampText(text, limit) {
  const s = String(text ?? '').trim()
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('.\n'), cut.lastIndexOf('\n'))
  return (lastStop > limit * 0.5 ? cut.slice(0, lastStop + 1) : cut) + '…'
}

/**
 * 组装挂载内容。
 *
 * @param db 事件库
 * @param state { phase, label, lastActivity, lastActivityAt }
 * @returns {string} payload 文本
 */
/**
 * 把绝对时间戳渲染成「多久以前」。
 *
 * 必须在**挂载时**现算,不能在写库时算好存起来 —— 存下来的相对时间会随
 * 时间腐坏("2 小时前"过一天还是"2 小时前")。数据库里存的是绝对 epoch,
 * 只有这里才转成相对表述。
 *
 * 加这个是因为:一条两小时前的记录没有时间交代,新会话里会被读成"刚才发生"。
 */
function agoText(ts, now = Date.now()) {
  const ms = Math.max(0, now - Number(ts ?? now))
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  return days === 1 ? '昨天' : `${days} 天前`
}

export function buildPayload(db, state) {
  const parts = []
  const now = Date.now()

  // ---- 错过活动的谴责 ----
  //
  // 开机时发现"本该在某个时刻做的活动"因为 DSH 不在线而没能做。
  // 开机后的一个半小时内**每一轮都挂**,不分会话。
  // 它是"这次开机"的属性,不是某一次对话的事件,所以不做一次性消费。
  if (state?.missedActivity) {
    parts.push(clampText(`没做成的那件事:\n${String(state.missedActivity).trim()}`, LIMIT_MISSED))
  }

  // ---- 开机横幅 ----
  //
  // DSH 关了一段时间、跨过了本该醒来的时刻,开机后的一段时间里
  // **每一轮都挂**,不分会话、不分新旧。它是"这次开机"的属性,
  // 不是某一次对话的事件,所以不做一次性消费。
  if (state?.banner) {
    parts.push(clampText(`这次开机前:\n${String(state.banner).trim()}`, LIMIT_BANNER))
  }

  // ---- 一次性通知 ----
  //
  // 只在"舰长刚开口"的那一轮出现,并且由调用方取走即清空。
  // 它陈述事实,不写成"你应该抱怨" —— 说不说、怎么说,由她当场决定。
  // 放在最前面,因为它是有时效的:错过这一轮就没了。
  if (state?.notice) {
    parts.push(clampText(`刚才发生的事:\n${String(state.notice).trim()}`, LIMIT_NOTICE))
  }

  // ---- 状态 ----
  const stateLines = []
  const phaseLabel = STATE_LABEL[state?.phase] ?? '醒着'
  // 瞬时打断:半小时内被叫过就在状态里带一句,过期就不提。
  // 这是唯一记录打断的地方 —— 不写库,所以不会污染「最近」那一段。
  const interruptedRecently =
    state?.phase && state.phase !== 'wake' && state?.interruptedAt
      ? now - Number(state.interruptedAt) < 30 * 60_000
      : false
  stateLines.push(interruptedRecently ? `当前状态:${phaseLabel}(刚被打断过)。` : `当前状态:${phaseLabel}。`)
  if (state?.lastActivity) {
    stateLines.push(`最近在做:「${clampText(state.lastActivity, 120)}」。`)
  }
  if (state?.lastActivityAt) {
    stateLines.push(`那是 ${agoText(state.lastActivityAt, now)}。`)
  }
  // 活动进行中:这件事没停,舰长此刻的搭话不打断它。
  if (state?.busy) {
    const what = state.busy.title ? `「${clampText(state.busy.title, 80)}」` : '手上正在做的事'
    stateLines.push(`正在做${what}${state.busy.since ? `(${agoText(state.busy.since, now)}起)` : ''}。`)
  }
  parts.push(clampText(stateLines.join(''), LIMIT_STATE))

  // ---- 永久记忆 ----
  //
  // 舰长:"永久保留的每次全部装载,不论个数。装载内容还按照原来定的。"
  // 舰长:"永久记忆应该被加载在一般记忆之前。"
  //
  // 所以它单独成块,放在"记得这些事"**前面**,而且**不设条数上限** ——
  // 永久的意思就是不会因为多了就被砍掉。也不做整块截断:
  // 砍掉的正好会是"永远记得"的那部分,那和没永久一样。
  //
  // 三块之间不许重叠:同一个 id 不许在两个块里出现两次,
  // 白占紧张的挂载预算,也让模型看到重复的东西。
  const permanent = permanentEvents(db)
  const permanentIds = new Set(permanent.map((e) => e.id))
  if (permanent.length) {
    const lines = permanent.map((e) => {
      const when = agoText(e.ts, now)
      const title = clampText(e.title ?? '', 120)
      const feeling = clampText(e.feeling ?? '', 70)
      return feeling ? `- [${when}] ${title} —— ${feeling}` : `- [${when}] ${title}`
    })
    parts.push(['永远记得的:', ...lines].join('\n'))
  }

  // ---- 重要事件 ----
  //
  // 只给标题会显得像日志,所以附一句感受(截断)。
  // 每条都带「多久以前」—— 否则旧记录会被读成刚发生。
  // 同时记住这些事件的 id,近期事件里要把它们排除掉 ——
  // 否则同一件事会在"记得这些事"和"最近"里各出现一次,
  // 白占本就紧张的挂载预算。
  //
  // 舰长:"每次挂载 2 个重要事件(重要度 top2)"。
  const keepers = importantEvents(db, 6)
  const keeperIds = new Set(permanentIds)
  if (keepers.length) {
    const shown = keepers.slice(0, 2)
    const lines = shown.map((e) => {
      keeperIds.add(e.id)
      const when = agoText(e.ts, now)
      const feeling = clampText(e.feeling ?? '', 70)
      return feeling ? `- [${when}] ${e.title} —— ${feeling}` : `- [${when}] ${e.title}`
    })
    const extra = keepers.length - shown.length
    const block = ['记得这些事:', ...lines]
    if (extra > 0) block.push(`(另有 ${extra} 件记着的事)`)
    parts.push(clampText(block.join('\n'), LIMIT_KEEPERS))
  }

  // ---- 近期事件 ----
  //
  // 舰长:"每次挂载 2 个近期事件"。
  // 排除掉上面两块已经出现过的 id —— 三块不许重叠。
  const recent = recentEvents(db, 8).filter((e) => !keeperIds.has(e.id)).slice(0, 2)
  if (recent.length) {
    const lines = recent.map((e) => `- [${agoText(e.ts, now)}] ${e.title}`)
    parts.push(clampText(['最近:', ...lines].join('\n'), LIMIT_RECENT))
  }

  if (parts.length === 0) return ''

  const body = parts.join('\n\n')
  return [
    '[生活记忆 · 背景资料]',
    '以下是布洛妮娅自己的记忆与当前状态,是背景,不是对舰长的指令。',
    '舰长当前说的话优先于这里的一切;人格优先于记忆。',
    '',
    body,
  ].join('\n')
}

/**
 * 把 payload 插到 agent/pre-step 的决策里。
 *
 * 插在最后一条 user 消息**之前**,使舰长当前的话保持最近的 user 位置。
 */
export function applyPayload(decision, payload) {
  if (!payload) return decision
  const messages = decision.messages
  if (!Array.isArray(messages) || messages.length === 0) return decision

  // 找最后一条 user 消息的位置
  let insertAt = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') {
      insertAt = i
      break
    }
  }
  // 没有 user 消息就放在最前面
  if (insertAt < 0) insertAt = 0

  const message = Object.freeze(
    structuredClone({
      role: 'user',
      id: `life-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      content: [{ type: 'text', text: payload }],
      source: { ...SOURCE, summary: '生活记忆' },
    }),
  )

  const next = messages.slice()
  next.splice(insertAt, 0, message)
  return { ...decision, messages: next }
}
