/**
 * prompt 加载器的测试。不依赖模型、不依赖网络,秒过。
 *
 * 用法: node test/prompts.test.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadPrompt, render, clearPromptCache } from '../lib/prompts.js'
import { buildSystemPrompt } from '../lib/persona.js'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS  ' + name)
  else {
    failures++
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''))
  }
}

console.log('=== 从 md 读 ===')
{
  const text = loadPrompt('writer-task', 'FALLBACK')
  check('读到了 writer-task', text !== 'FALLBACK', text.slice(0, 40))
  check('里面有任务说明', text.includes('这一次的任务'), text.slice(0, 80))
  check('带上了占位符', text.includes('{{CLOCK}}'), '')
}

console.log('\n=== 占位符替换 ===')
{
  const out = render('现在是 {{CLOCK}},要做 {{CATEGORY}}。', { CLOCK: '10:00', CATEGORY: '技术' })
  check('两个都换了', out === '现在是 10:00,要做 技术。', out)
  check('缺失的键原样保留', render('{{NOPE}}', {}) === '{{NOPE}}', render('{{NOPE}}', {}))
  check('null 换成空串', render('a{{X}}b', { X: null }) === 'ab', render('a{{X}}b', { X: null }))
  check('数字也能替换', render('{{N}}', { N: 60 }) === '60', render('{{N}}', { N: 60 }))
}

console.log('\n=== 文件缺失时用兜底 ===')
{
  const fallback = loadPrompt('__不存在的模板__', '这是兜底')
  check('返回兜底文本', fallback === '这是兜底', fallback)
}

console.log('\n=== 改了 md 不用重启 ===')
{
  // 直接改真文件,改完再改回去 —— 测的是 mtime 缓存有没有生效
  const file = new URL('../prompts/writer-task.md', import.meta.url)
  const before = loadPrompt('writer-task', 'FALLBACK')
  const probe = before + '\n【临时探针】\n'
  writeFileSync(file, probe, 'utf8')
  // mtime 在同一毫秒内可能不变,等一小会儿
  const wait = Date.now() + 20
  while (Date.now() < wait) {
    /* spin */
  }
  try {
    const after = loadPrompt('writer-task', 'FALLBACK')
    check('改完立刻生效', after.includes('【临时探针】'), after.slice(-40))
  } finally {
    writeFileSync(file, before, 'utf8')
    clearPromptCache()
  }
  check('改回来也对', !loadPrompt('writer-task', 'FALLBACK').includes('【临时探针】'))
}

console.log('\n=== 人格包装 ===')
{
  const p = buildSystemPrompt('你是某某。')
  check('包装层在最前', p.startsWith('【用户自定义人设'), p.slice(0, 30))
  check('固定规则在', p.includes('ask_user_question'), '')
  check('人格正文在最后', p.trim().endsWith('你是某某。'), p.slice(-20))
  check('空人格也能组装', buildSystemPrompt(undefined).includes('ask_user_question'))
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
if (failures) process.exit(1)
