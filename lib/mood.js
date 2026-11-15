/**
 * 情绪基调(mood)。
 *
 * 舰长的要求:"加情绪基调(和 life 中的状态,比如吃饭被打断、正常产生活动一类的,
 * 应该有现成的;以及对话内容绑定),其他先不加。"
 *
 * 所以这里只做两件事:
 *   1. **基调**从 life 已有的状态信号推出来 —— 作息阶段(睡/吃/醒)、有没有被打断、
 *      手上有没有正在做的事。这些信号本来就是现成的,不需要另造一套。
 *   2. **绑定**说明这份基调是冲着什么来的 —— 她此刻在做的事。
 *
 * 不绑舰长的原话(舰长明确要求):基调是她自己的状态,绑的是她自己的手头事,
 * 把舰长说的话抄进来只会在 payload 里多一段复读。
 *
 * 为什么要有绑定:
 *   光有"困倦"两个字是空的。模型知道"她困",但不知道"她因为被叫醒而困,
 *   而且正在谈的是插件改造"。绑定把情绪和内容拴在一起,语气才有着落。
 *
 * 为什么不做成穷举:
 *   判断"这句话是什么情绪"要靠模型,但那会让每轮多一次调用;
 *   而状态信号是**确定**的 —— 她确实在睡、确实刚被叫醒、确实手上还有活。
 *   基调用状态算(免费、确定),绑定用**原文**不重写(舰长的话就是舰长的话),
 *   这样既有内容,又没有维护一份关键词表。
 *
 * 跨会话:基调落在 mood.json 里。新会话的第一轮,状态还在,基调也算得出来;
 *   绑定那一半从上一次留下的 mood.json 接着走 —— 她是连续的人,不是每次开机重置。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/** 打断的"新鲜期":半小时内都算刚被打断过(与 memory.js 里的口径一致)。 */
const INTERRUPT_WINDOW_MS = 30 * 60_000

/** 截断,尽量断在句子上。 */
function clip(text, limit) {
  const s = String(text ?? '').trim()
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf('\n'))
  return (stop > limit * 0.4 ? cut.slice(0, stop) : cut) + '…'
}

/**
 * 最近一次真正执行过的活动。
 *
 * 不用 recentEvents():它不查 kind 也不查 feeling,而这里要的正是
 * "她做过什么、她当时怎么想"。
 */
export function latestActivity(db) {
  try {
    return db
      .prepare('SELECT id, ts, title, feeling FROM events WHERE kind = ? ORDER BY ts DESC LIMIT 1')
      .get('activity')
  } catch {
    return undefined
  }
}

/**
 * 算这一轮的情绪基调。
 *
 * @param {{db: object, state: object, now?: number, previous?: object}} input
 * @returns {{tone: string, cause: string, binding: string, at: number}}
 */
export function computeMood(input) {
  const db = input?.db
  const state = input?.state ?? {}
  const now = Number(input?.now ?? Date.now())
  const previous = input?.previous ?? null

  const phase = state.phase
  const interruptedRecently = Boolean(
    phase && phase !== 'wake' && state.interruptedAt && now - Number(state.interruptedAt) < INTERRUPT_WINDOW_MS,
  )

  let tone = '平稳'
  let cause = '醒着,手上没有活'
  if (phase === 'sleep') {
    tone = interruptedRecently ? '刚被叫醒的困倦' : '困倦'
    cause = interruptedRecently ? '被舰长从睡梦里叫醒' : '还在睡觉'
  } else if (phase === 'eat') {
    tone = interruptedRecently ? '被打断的不耐' : '边吃边想'
    cause = interruptedRecently ? '吃饭时被舰长叫住' : '正在吃饭'
  } else if (state.busy || state.busyTitle) {
    tone = '注意力被占着'
    cause = '手上有事,注意力分了一半'
  }

  // ---- 绑定 ----
  //
  // 绑的是**她此刻在做什么** —— 舰长说的原话不进绑定。
  //
  // 为什么:基调是她自己的状态,绑住的是她自己的手头事。
  // 把舰长的原话抄进来,只会在 payload 里多出一段复读,
  // 还会让语气显得在"回应某句话",而不是"她本来就带着这个心情"。
  //
  // 包装留给 moodLine:它要先和状态那一段去重 ——
  // "最近Doing:「…」"状态里已经有了,就不再来一遍。
  let activity = state.lastActivity || (() => {
    const row = db ? latestActivity(db) : undefined
    return row && row.title ? String(row.title) : ''
  })()
  if (!activity && previous && typeof previous.binding === 'string') {
    activity = previous.binding
  }

  return {
    tone,
    cause,
    phase,
    binding: clip(activity, 40),
    at: now,
  }
}

/** 状态行里的阶段标签。状态那一段一定带着其中一个。 */
const STATE_LABEL = {
  sleep: '在睡觉',
  eat: '在吃饭',
  wake: '醒着',
}

/**
 * 原因是不是状态那一段已经说过的?
 *
 * 是,就不重复 —— 舰长的原话:"如果和 life 重合了,就不加了,只有情绪基调。"
 * 状态那一段永远写着当前阶段(在睡觉/在吃饭/醒着),所以"被叫醒""被叫住"
 * 这类原因都是同一件事的第二种说法,重复只会让 payload 变长、语气变啰嗦。
 */
function causeCovered(mood, stateText) {
  const label = STATE_LABEL[mood.phase]
  if (!label) return false
  return String(stateText ?? '').includes(label)
}

/**
 * 渲染成挂载用的一段。
 *
 * @param {{tone: string, cause: string, binding: string, phase: string}|undefined} mood
 * @param {string} [stateText] - 状态那一段的原文,用来判断重合
 * @returns {string}
 */
export function moodLine(mood, stateText) {
  if (!mood || !mood.tone) return ''
  const state = String(stateText ?? '')

  let head = '情绪基调:' + mood.tone
  if (mood.cause && !causeCovered(mood, state)) head += '(' + mood.cause + ')'
  head += '。'

  // 绑定同理:她此刻在做的事如果状态那一段已经写了,就不再来一遍。
  const binding = typeof mood.binding === 'string' ? mood.binding.trim() : ''
  if (binding && !state.includes(binding)) {
    head += '\n绑定:刚才在做「' + binding + '」。'
  }
  return head
}

/** mood.json 的路径。 */
function moodPath(dir) {
  return path.join(dir, 'mood.json')
}

/** 读上一次的基调(跨会话延续)。读不到就当没有。 */
export function readMood(dir) {
  try {
    const raw = readFileSync(moodPath(dir), 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/** 写下当前基调。写不出来也不能影响对话。 */
export function writeMood(dir, mood) {
  if (!mood) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(moodPath(dir), JSON.stringify(mood, null, 2) + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}
