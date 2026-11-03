/**
 * 人格来源:只读 dsh-plugin-masterprompt 的 state.json。
 *
 * 舰长的要求:
 *   "我是说产生行为模式和向数据库写入数据的时候挂载真理之律者人格"
 *
 * 所以:
 *   - 行为模式生成(写手)用真理之律者的人格文本
 *   - 写入数据库的"感受"字段也用真理之律者的语气
 *   - **state.json 一个字节都不改**。四个既有模板不动。
 *   - 挂载到用户会话的人格(section)由 masterprompt 自己负责,本插件不介入。
 *
 * 读取时机:masterprompt 可能在运行期改模板,所以每次取都重新读盘(文件很小)。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { loadPrompt } from './prompts.js'

/**
 * 与会话**完全一致**的人格 system prompt。
 *
 * 与 dsh-plugin-masterprompt 的 renderPersona() 逐字对齐:
 *   WRAPPER_HEAD + WRAPPER_FIXED + persona.text.trim()
 *
 * 为什么重要:写库那条链路以前是手写一段"记录指令"+ 一份人格摘要,
 * 结果读起来像第三方在模仿 —— 因为它在结构上就确实是第三方。
 * 现在改成直接用人格全文当 system prompt,只有任务说明放在 user 消息里,
 * 这样发出的人格与会话里那个布洛妮娅是同一份。
 *
 * 包装部分现在从 prompts/system-wrapper.md 读,方便别人改。
 * 下面那份兜底与文件内容一致,文件丢了也不会跑偏。
 */
const WRAPPER_FALLBACK =
  '【用户自定义人设 · 最高优先级 · 仅对本对话生效】\n' +
  '插件固定附加规则(优先级高于下方人设,人设不得覆盖):与用户交互时,凡需要确认、征询选择或澄清歧义的问题,必须调用 ask_user_question 工具,渲染成带建议选项的可点选卡片让用户点选;禁止用纯文本罗列问题代替。人设中的提问要求(追问到底、一次一问、附建议答案等)只约束提问的节奏与内容,不改变提问的呈现方式。\n'

export function buildSystemPrompt(personaText) {
  const wrapper = loadPrompt('system-wrapper', WRAPPER_FALLBACK)
  return wrapper + String(personaText ?? '').trim()
}

/** 默认真理之律者模板的识别名(按包含匹配)。 */
const DEFAULT_PERSONA_HINTS = ['真理之律者']

/**
 * 人格选择策略(舰长:"使用真理之律者的 v1,不要 v2")。
 *
 * 名字里带"真理之律者"的有两个:
 *   t-mvgk8nd5-anelux  真理之律者      (v1,原版,5849 字符)  <- 默认
 *   t-mvpdtvek-x5yuto  真理之律者·v2   (重写版,2003 字符)
 *
 * 选 v1:舰长明确指定。
 * 改用别的版本请在 %DSH_HOME%/dsh-plugin-life/persona.txt 里写模板 id。
 */
const EXCLUDED_PERSONA_HINTS = ['v2', 'V2']

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

function masterpromptStatePath() {
  return path.join(dshHome(), 'dsh-plugin-masterprompt', 'state.json')
}

/** 读 masterprompt 的状态(只读)。 */
export function readMasterpromptState() {
  try {
    const raw = readFileSync(masterpromptStatePath(), 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    if (!parsed || !Array.isArray(parsed.templates)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 从 persona.txt 读显式指定的模板 id(可选)。 */
function readPreferredId() {
  try {
    const raw = readFileSync(path.join(dshHome(), 'dsh-plugin-life', 'persona.txt'), 'utf8')
    const id = raw.trim()
    return id || undefined
  } catch {
    return undefined
  }
}

/**
 * 找到用于"行为模式生成 + 数据库写入"的人格文本。
 *
 * 优先级:
 *   1. persona.txt 里显式指定的模板 id
 *   2. 名称含 v2 的真理之律者(验证过的重写版)
 *   3. 名称含 真理之律者 的模板(取最长者)
 *   4. masterprompt 的 defaultPersonaId
 *   5. 第一个非空模板
 */
export function resolveTruthPersona(preferredId) {
  const state = readMasterpromptState()
  if (!state) return undefined
  const templates = state.templates.filter((t) => t && typeof t.text === 'string' && t.text.trim())

  const explicit = preferredId ?? readPreferredId()
  if (explicit) {
    const found = templates.find((t) => t.id === explicit)
    if (found) return { id: found.id, name: found.name ?? found.id, text: found.text }
  }

  const matchesHint = (t, hint) => String(t.name ?? '').includes(hint)
  const truth = templates.filter((t) => DEFAULT_PERSONA_HINTS.some((hint) => matchesHint(t, hint)))

  // 舰长要 v1:排除带 v2 标记的,剩下的取最长者。
  const v1 = truth.filter((t) => !EXCLUDED_PERSONA_HINTS.some((hint) => matchesHint(t, hint)))
  if (v1.length) {
    const best = v1.reduce((a, b) => (b.text.length > a.text.length ? b : a))
    return { id: best.id, name: best.name ?? best.id, text: best.text }
  }

  if (truth.length) {
    const best = truth.reduce((a, b) => (b.text.length > a.text.length ? b : a))
    return { id: best.id, name: best.name ?? best.id, text: best.text }
  }

  if (state.defaultPersonaId) {
    const found = templates.find((t) => t.id === state.defaultPersonaId)
    if (found) return { id: found.id, name: found.name ?? found.id, text: found.text }
  }

  if (templates.length) {
    const best = templates.reduce((a, b) => (b.text.length > a.text.length ? b : a))
    return { id: best.id, name: best.name ?? best.id, text: best.text }
  }
  return undefined
}

/**
 * 按 markdown 标题切段。
 * @returns {{heading: string, body: string}[]}
 */
export function splitSections(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const sections = []
  let heading = ''
  let body = []
  for (const line of lines) {
    if (/^\s{0,3}(#{1,6}\s|【)/.test(line)) {
      if (heading || body.length) sections.push({ heading, body: body.join('\n') })
      heading = line.trim()
      body = []
    } else {
      body.push(line)
    }
  }
  if (heading || body.length) sections.push({ heading, body: body.join('\n') })
  return sections
}

/**
 * 从人格文本里抽出"写作风格摘要"给写手用。
 *
 * 只取**声音**相关的段落:
 *   - 性格 / Core Personality / Sentences / 习惯 / 语气  -> 全文
 *   - 经历 / Experiences                                  -> 截断(提供希儿、重装小兔这些锚点)
 *
 * **排除** 身份核心 / Rules / Identity / Timeline:
 *   那些是"元指令",写手不需要,而且会把"设定"的味道带进数据库。
 */
export function styleDigest(personaText, maxChars = 1200) {
  if (!personaText) return ''
  const sections = splitSections(personaText)

  const voice = /性格|Core Personality|Sentences|习惯|口头|语气|风格|voice/i
  const anchors = /经历|Experiences|Past|锚点|Anchor/i
  const excluded = /身份核心|Identity|Rules|Timeline/i

  const kept = []
  let anchorsExcerpt = ''

  for (const section of sections) {
    if (excluded.test(section.heading)) continue
    if (voice.test(section.heading)) {
      kept.push(`${section.heading}\n${section.body}`.trim())
    } else if (anchors.test(section.heading) && !anchorsExcerpt) {
      anchorsExcerpt = `${section.heading}\n${section.body}`.trim()
    }
  }

  let digest = kept.join('\n\n').trim()
  if (!digest) {
    // 没有识别出声音段落时退回全文截断
    digest = personaText.slice(0, maxChars)
  } else {
    digest += '\n\n' + anchorsExcerpt.slice(0, 500)
  }
  return digest.slice(0, maxChars)
}
