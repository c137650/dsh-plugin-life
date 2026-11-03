/**
 * prompt 加载器。
 *
 * 舰长的要求:"把写手和所有涉及人格的地方都单独拉一个 md 文件,方便别人更改。"
 *
 * 所以所有会塑造"她说的话"的文字都从 prompts/*.md 读,代码里只留一份兜底。
 * 改 md 不用改代码,也不用重启 —— 每次调用都 stat 一下 mtime,变了就重读。
 *
 * 兜底策略:文件不在、读不出来、被清空了,就用代码里那份默认值,
 * 并打一条警告。一个 md 文件写坏了不该让整个插件不工作。
 */

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** prompts 目录在插件根目录下,不在 lib 里 —— 方便别人一眼看到。 */
const PROMPT_DIR = path.join(HERE, '..', 'prompts')

const cache = new Map() // name -> { text, mtime }

/** 警告只打一次,别每条都刷。 */
const warned = new Set()

/**
 * 读一个 prompt 模板。
 *
 * @param name     prompts/ 下的文件名(不带 .md)
 * @param fallback 文件缺失时的默认文本
 */
export function loadPrompt(name, fallback) {
  const file = path.join(PROMPT_DIR, name + '.md')
  try {
    const st = statSync(file)
    const hit = cache.get(name)
    if (hit && hit.mtime === st.mtimeMs) return hit.text
    const text = readFileSync(file, 'utf8')
    if (text.trim()) {
      cache.set(name, { text, mtime: st.mtimeMs })
      return text
    }
  } catch {
    /* 落到兜底 */
  }
  if (!warned.has(name)) {
    warned.add(name)
    try {
      console.warn?.(`dsh-plugin-life: prompts/${name}.md 读不到,使用内置默认值`)
    } catch {
      /* ignore */
    }
  }
  return fallback
}

/**
 * 把模板里的 {{KEY}} 换成值。
 *
 * 只做字面替换,不做逻辑。找不到的键原样留着 ——
 * 让人一眼看出模板里写了个不存在的占位符,而不是悄悄变成空字符串。
 */
export function render(template, vars) {
  return String(template ?? '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => {
    if (!(key in (vars ?? {}))) return m
    const v = vars[key]
    return v === undefined || v === null ? '' : String(v)
  })
}

/** 测试和排查用:清掉缓存,下次一定重读。 */
export function clearPromptCache() {
  cache.clear()
}
