/**
 * 把一整轮对话压成一条"关于舰长"的记忆。
 *
 * 舰长的理由:"如果只是我的原话,就会导致有时候我说的话多,
 * 拼到上下文里面占的权重就大,这不公平。"
 *
 * 这个判断是对的。原话直存等于把"啰嗦"当成"重要" ——
 * 一段五百字的吐槽和一句"我下周去杭州"占的预算差了十倍,
 * 但后者才是要记住的那件事。
 *
 * 所以这里改成:用真理之律者的人格,把**舰长和布洛妮娅两个人的那一轮**
 * 压成一句第三人称的短句,并且钉死字数上限。
 *
 * 三条硬约束:
 *   1. system 就是会话里那份人格,一字不改(和 writer.js 一致)
 *   2. 不许照抄原句 —— 照抄等于没压
 *   3. 超字数就硬砍,不信任模型自己数
 */

import { buildSystemPrompt } from '../persona.js'
import { loadPrompt, render } from '../prompts.js'
import { callText } from '../model.js'
import { resolveDates } from './datefix.js'

/**
 * 兜底文本:prompts/captain-summary.md 缺失时用。
 * 正常要改的是那个 md,不是这里。
 */
const SUMMARY_FALLBACK =
  '【这一次的任务】\n把下面这一轮对话,压成一条"关于舰长"的记忆。\n\n' +
  '现在是 {{NOW}}。\n\n' +
  '要求:\n1. 只保留关于舰长这个人的持久信息:状态、情绪、习惯、偏好、性格、经历、和布洛妮娅的关系。\n' +
  '   工作、项目、技术实现一律不要。\n' +
  '2. 不要照抄原话。\n3. 以"舰长"为主语写第三人称。\n' +
  '4. 不超过 {{LIMIT}} 个字。\n5. 没有持久信息就只输出:无\n' +
  '6. 时间对着"现在是"换算成绝对日期(说"明天"就写那一天的具体日期),\n' +
  '   不许留"今天、明天、昨天、下周、上周、周末、这个月、今年"这类词。\n' +
  '7. 只输出那一句话。\n\n' +
  '【舰长说】\n{{CAPTAIN}}\n\n【你(布洛妮娅)回】\n{{ASSISTANT}}'

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 把写入时刻写成"2026 年 11 月 17 日 星期二 09:23"。
 *
 * 压缩的时候必须把"现在是几点"告诉模型:「下周日」是相对说话那一刻算的,
 * 换算成绝对日期只能以那一刻为基准。用写库时间就够了 —— 压缩就在写库前一步。
 */
export function formatNow(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ` +
    `星期${WEEKDAY[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`
  )
}

/** 模型自己数不准字数,所以返回后再硬砍一刀。 */
function clamp(text, limit) {
  const s = String(text ?? '')
    .replace(/^["「『']|["」』']$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  return s.length > limit ? s.slice(0, limit) : s
}

/**
 * 压一轮对话。
 *
 * 返回:
 *   { ok: true, text }   压好了(可能是空串,表示这一轮没有值得记的东西)
 *   { ok: false, reason } 没压成(没有模型、配额用尽、报错)
 */
export async function summarizeTurn(ctx, route, input) {
  const limit = input.limit ?? 60
  const now = input.now ?? Date.now()
  const personaText = input.persona?.text

  if (!route) return { ok: false, reason: 'no-route' }

  const system = buildSystemPrompt(personaText)

  const said = String(input.captainText ?? '').trim().slice(0, 3000)
  const replied = String(input.assistantText ?? '').trim().slice(0, 2000)

  // 任务说明从 prompts/captain-summary.md 读。
  const user = render(loadPrompt('captain-summary', SUMMARY_FALLBACK), {
    LIMIT: limit,
    NOW: formatNow(now),
    CAPTAIN: said,
    ASSISTANT: replied || '(这一轮没有回复)',
  })
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n')

  const messages = [
    { role: 'system', content: [{ type: 'text', text: system }] },
    { role: 'user', content: [{ type: 'text', text: user }] },
  ]

  const call = await callText(ctx, route, messages, { maxTokens: 200 }, input.breaker)
  if (!call.ok) {
    return { ok: false, reason: call.skipped ? 'quota' : call.error ?? 'call-failed' }
  }

  // 相对时间先换成绝对日期,再砍字数。
  // 反过来的话,砍到一半正好落在日期上就废了。
  const { text: fixedText, resolved } = resolveDates(clamp(call.text, limit * 2), now)
  const text = clamp(fixedText, limit)
  if (!text || text === '无' || text === '无。') return { ok: true, text: '' }
  return { ok: true, text, resolved }
}
