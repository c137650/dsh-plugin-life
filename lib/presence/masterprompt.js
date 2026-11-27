/**
 * 读出 masterprompt 那一整套内容:人格正文、语言习惯、首句模板、思考链。
 *
 * life 和在场判断都要用它 —— 光有人格正文,模型只知道自己是谁,不知道自己
 * 该怎么说话、怎么想。masterprompt 把这几段分开存在 state.json 里,
 * 这里直接读文件,不去依赖插件之间的调用。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const STATE = path.join(homedir(), '.dsh', 'dsh-plugin-masterprompt', 'state.json')

function lines(list) {
  return (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
}

/** 选一份模板:先看指名的,再看默认的,最后退到第一份。 */
function pickTemplate(state, preferId) {
  const templates = Array.isArray(state.templates) ? state.templates : []
  if (!templates.length) return null
  if (preferId) {
    const hit = templates.find((t) => t && t.id === preferId)
    if (hit) return hit
  }
  if (state.defaultPersonaId) {
    const hit = templates.find((t) => t && t.id === state.defaultPersonaId)
    if (hit) return hit
  }
  return templates[0]
}

/**
 * @param {{templateId?: string, chainFallback?: string}} [options]
 * @returns {{ok: boolean, name: string, text: string, style: {should: string[], openers: string[], chain: string}, full: string}}
 */
export function readMasterPrompt(options = {}) {
  const empty = { ok: false, name: '', text: '', style: { should: [], openers: [], chain: '' }, full: '' }
  let state
  try {
    if (!existsSync(STATE)) return empty
    state = JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return empty
  }
  const template = pickTemplate(state, options.templateId)
  if (!template) return empty
  const text = String(template.text || '').trim()
  const style = template.style && typeof template.style === 'object' ? template.style : {}
  const should = lines(style.should)
  const openers = lines(style.openers)
  const chain =
    typeof style.chain === 'string' && style.chain.trim()
      ? style.chain.trim()
      : (typeof options.chainFallback === 'string' ? options.chainFallback : '')

  const full = [
    text,
    should.length ? should.join('\n') : '',
    chain,
    openers.length ? openers.join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return { ok: Boolean(text), name: String(template.name || ''), text, style: { should, openers, chain }, full }
}

/**
 * 给发起活动用的版本:只保留能影响判断的部分,裁到指定字数。
 * 全量太长,塞进一次性任务的提示里会把指令挤没。
 */
export function masterPromptBrief(limit = 3000, options = {}) {
  const bundle = readMasterPrompt(options)
  if (!bundle.ok) return ''
  const parts = [bundle.text]
  if (bundle.style.should.length) parts.push(bundle.style.should.join('\n'))
  if (bundle.style.chain) parts.push(bundle.style.chain)
  const joined = parts.filter(Boolean).join('\n\n')
  return joined.length > limit ? joined.slice(0, limit) + '…' : joined
}
