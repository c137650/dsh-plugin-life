/**
 * LLM 写手。
 *
 * 舰长的分工要求:
 *   "产生行为模式和向数据库写入数据的时候挂载真理之律者人格"
 *
 * 写手分两个职责,分别在不同时间发生:
 *
 *   composeTask(...)     执行**之前** —— 决定此刻要去网上看什么。
 *   composeFeeling(...)  执行**之后** —— 根据真实抓到的材料写记录并打分。
 *
 * ## 人格怎么进来(2026-10-27 重写)
 *
 * 以前是"手写一段记录指令 + 一份人格摘要",结果舰长一眼看出来:
 * **不像布洛妮娅自己写的,像第三方在模仿。** 这个判断是对的,而且原因在结构上:
 *
 *   1. 它就是一次独立的 llm.stream 调用,system prompt 是那段手写指令,
 *      **不是**会话里那份人格 —— 所以确实是别人在照着她的语气写日记。
 *   2. 人格摘要里塞了 "P3--Sentences you may prefer to use" 那 12 句现成台词。
 *      把可引用的话列给模型,等于让它照着腔调抄,而不是自己想。
 *   3. 摘要要求"第一人称",而人格本身写着 "Must reply in the third person '布洛妮娅'"。
 *      两种口径同时发出去,出来的是杂交语气。
 *   4. "允许提到身体是什么状态"在鼓励编造 —— 材料里没有"屏幕亮度""眼睛发涩",
 *      那是模型为了显得具体而补的。
 *
 * 现在改为:system prompt 直接用 persona.js 的 buildSystemPrompt(),
 * 与会话里的布洛妮娅**是同一份**(逐字对齐 masterprompt 的 renderPersona)。
 * 指令全部移到 user 消息,不再提供现成台词,人称跟人格自己的规则走,
 * 并明确要求"只写材料里有的"。
 */

import { callText } from './model.js'
import { buildSystemPrompt } from './persona.js'
import { loadPrompt, render } from './prompts.js'

// 兜底文本:prompts/*.md 缺失时用这一份。
// 正常情况下永远是 md 文件说了算 —— 这两份只是"文件被删了也不至于不工作"。
const TASK_FALLBACK =
  '【这一次的任务】\n决定你此刻要去网上看什么。产出是可执行的检索目标,不是散文。\n\n' +
  '现在是 {{CLOCK}}。\n此刻想做的事:「{{CATEGORY}}」。\n{{AVOID}}\n\n' +
  '要求:只输出 JSON,含 intent / searchQuery / urls / proposeNewCategory 四个字段。'

const FEELING_FALLBACK =
  '【这一次的任务】\n把刚才做完的事记下来。这是你自己的记录,不是替舰长办的事。\n\n' +
  '本来想做的事:{{TASK}}\n\n' +
  '要求:只输出 JSON,含 summary / detail / feeling / interesting / important / reason 六个字段。'

/** 从 LLM 响应里抠出 JSON(容忍 ```json 包裹和前后废话)。 */
export function extractJson(text) {
  if (!text) return undefined
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * 第一步:决定"现在要去网上看什么"(执行之前)。
 *
 * 人格参与的方式:决定她此刻会被什么吸引、怎么框定这件事。
 *
 * 产出的不再是"给执行者的自然语言指令",而是**可执行的目标**:
 * 一个搜索词,或者一组具体的 URL。因为真正执行的是插件自己
 * (只用 ctx.web 的 search / fetch),没有会自己理解长句子指令的执行者。
 *
 * @param input { persona, category, categoryLabel, recentTitles, clockText, userProfile }
 * @returns {Promise<{intent, searchQuery?, urls?, proposeNewCategory?}>}
 */
export async function composeTask(ctx, route, input) {
  // system 就是会话里那份人格,一字不改。任务说明全部放到 user 里。
  const system = buildSystemPrompt(input.persona?.text)

  // 任务说明从 prompts/writer-task.md 读 —— 改它不用改代码,也不用重启。
  const user = render(loadPrompt('writer-task', TASK_FALLBACK), {
    CLOCK: input.clockText,
    CATEGORY: input.categoryLabel,
    RECENT: input.recentTitles?.length
      ? `最近做过的事(不要重复):${input.recentTitles.slice(0, 6).join(' / ')}`
      : '',
    PROFILE: input.userProfile ? `你的偏好:\n${input.userProfile.slice(0, 600)}` : '',
    // 话题查重命中后重挑时用:把刚刚判定为"重复"的那几个方向明说出来。
    AVOID: input.avoidIntents?.length
      ? [
          '这几个方向最近已经做过了,这次换一个**完全不同的**方向,不要换个说法接着做同一件事:',
          ...input.avoidIntents.slice(0, 4).map((s) => `- ${String(s).slice(0, 60)}`),
        ].join('\n')
      : '',
  })
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n')

  const messages = [
    { role: 'system', content: [{ type: 'text', text: system }] },
    { role: 'user', content: [{ type: 'text', text: user }] },
  ]

  const call = await callText(ctx, route, messages, { maxTokens: 900 }, input.breaker)
  if (!call.ok) {
    if (call.skipped) ctx.logger?.info?.('dsh-plugin-life: composeTask skipped (quota breaker open)')
    else ctx.logger?.warn?.('dsh-plugin-life: composeTask failed: ' + call.error)
    return undefined
  }

  const parsed = extractJson(call.text)
  if (!parsed) return undefined

  const searchQuery = typeof parsed.searchQuery === 'string' ? parsed.searchQuery.trim().slice(0, 200) : ''
  const urls = Array.isArray(parsed.urls)
    ? parsed.urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim())).map((u) => u.trim()).slice(0, 3)
    : []
  if (!searchQuery && !urls.length) return undefined

  return {
    intent: typeof parsed.intent === 'string' ? parsed.intent.trim().slice(0, 200) : searchQuery || urls[0],
    searchQuery: searchQuery || undefined,
    urls: urls.length ? urls : undefined,
    proposeNewCategory:
      typeof parsed.proposeNewCategory === 'string' ? parsed.proposeNewCategory.slice(0, 20) : undefined,
  }
}

/**
 * 第二步:根据实际发生的事写感受并打分(执行之后)。
 *
 * 这是人格唯一真正"上场"的地方:声音、锚点、以及这件事对她意味着什么。
 *
 * @param input { persona, task, output, trace, category, userProfile, recentTitles }
 * @returns {Promise<{summary, detail, feeling, interest, importance, reason}>}
 */
export async function composeFeeling(ctx, route, input) {
  // system 就是会话里那份人格,一字不改 —— 写出来的东西才真的是她写的。
  const system = buildSystemPrompt(input.persona?.text)

  // 模板在 prompts/writer-feeling.md —— 这是人格真正上场的地方。
  const user = render(loadPrompt('writer-feeling', FEELING_FALLBACK), {
    TASK: input.task,
    OUTPUT: input.output ? `实际发生的事:\n${input.output.slice(0, 1500)}` : '',
    EVIDENCE: input.evidence ? `真实抓取到的材料:\n${input.evidence.slice(0, 4000)}` : '',
    PROFILE: input.userProfile ? `你的偏好:\n${input.userProfile.slice(0, 500)}` : '',
    RECENT: input.recentTitles?.length
      ? `最近做过的其他事:${input.recentTitles.slice(0, 5).join(' / ')}`
      : '',
  })
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n')

  const messages = [
    { role: 'system', content: [{ type: 'text', text: system }] },
    { role: 'user', content: [{ type: 'text', text: user }] },
  ]

  const call = await callText(ctx, route, messages, { maxTokens: 1400 }, input.breaker)
  if (!call.ok) {
    if (call.skipped) ctx.logger?.info?.('dsh-plugin-life: composeFeeling skipped (quota breaker open)')
    else ctx.logger?.warn?.('dsh-plugin-life: composeFeeling failed: ' + call.error)
    // 拿不到措辞就退化为空,由调用方决定要不要入库(没有 summary 就只用事实兜底)。
    return { summary: '', detail: '', feeling: '', interest: 0.5, importance: 0.5, reason: '', degraded: true }
  }

  const parsed = extractJson(call.text)
  if (!parsed) {
    return { summary: '', detail: '', feeling: '', interest: 0.5, importance: 0.5, reason: '', degraded: true }
  }
  const clamp01 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5)
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 120) : '',
    detail: typeof parsed.detail === 'string' ? parsed.detail.trim().slice(0, 3000) : '',
    feeling: typeof parsed.feeling === 'string' ? parsed.feeling.slice(0, 2000) : '',
    interest: clamp01(parsed.interesting ?? parsed.interest),
    importance: clamp01(parsed.important ?? parsed.importance),
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
  }
}
