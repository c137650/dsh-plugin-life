/**
 * 跨会话记忆(captain.db)的端到端测试。
 *
 * 需要 python 环境(torch + transformers)和 bge-small-zh-v1.5 模型。
 * 没装的话会用纯规则跑 —— 这样也能测,只是判重/提及检测测不了,
 * 相应的断言会跳过并给出提示。
 *
 * LLM 那一步用假的 llm 服务顶替:这里要测的是"压缩前后发生了什么",
 * 不是模型写得好不好。
 *
 * 用法: node test/captain-memory.test.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createCaptainMemory } from '../lib/captain/index.js'
import { gate, loadRules } from '../lib/captain/rules.js'

let failures = 0
let skipped = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS  ' + name)
  else {
    failures++
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''))
  }
}
const skip = (name, why) => {
  skipped++
  console.log('  SKIP  ' + name + '(' + why + ')')
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(dbFile, predicate, timeoutMs = 25000) {
  const t0 = Date.now()
  let last = []
  while (Date.now() - t0 < timeoutMs) {
    try {
      const db = new DatabaseSync(dbFile)
      const rows = db.prepare('SELECT * FROM facts ORDER BY id').all()
      db.close()
      last = rows
      if (predicate(rows)) return rows
    } catch {
      /* 表还没建好 */
    }
    await wait(120)
  }
  return last
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-captain-'))
const dbFile = join(dir, 'captain.db')
writeFileSync(join(dir, 'user.md'), '# 舰长\n沉默、爱写代码、讨厌噪音。\n', 'utf8')

console.log('=== 规则闸门(不依赖模型) ===')
{
  const rules = loadRules(dir)
  const yes = ['我下周要去杭州出差', '我最近总是失眠', '我明天要演讲,特别紧张', '我不喜欢喝咖啡']
  const no = ['帮我改一下这个函数的 bug', '这个阈值太高了,降低到10%', '重启一下程序', '把数据库的上限改小']
  const miss = yes.filter((t) => !gate(t, rules).store)
  const wrong = no.filter((t) => gate(t, rules).store)
  check('该收的都收了', miss.length === 0, JSON.stringify(miss))
  check('不该收的都没收', wrong.length === 0, JSON.stringify(wrong))
}

console.log('\n=== 假的 llm 服务 ===')
const llmCalls = []
let llmReply = '舰长下周要去杭州出差,顺道想去西湖,这趟他有点紧张。'
let llmEnabled = true
const mockCtx = {
  get: (name) => {
    if (name !== 'llm' || !llmEnabled) return undefined
    return {
      stream: (opts) => {
        llmCalls.push(opts)
        return (async function* () {
          yield { type: 'text-delta', text: llmReply }
          yield { type: 'finish', reason: 'stop' }
        })()
      },
    }
  },
}

const captain = createCaptainMemory({
  dir,
  ctx: mockCtx,
  getRoute: () => (llmEnabled ? { provider: 'mock', model: 'mock' } : undefined),
  getPersona: () => ({ text: '你是布洛妮娅·扎伊切克。' }),
  log: (m) => console.log('    [log] ' + m),
  warn: (m) => console.log('    [warn] ' + m),
})
check('创建成功', !!captain)
if (!captain) process.exit(1)

captain.warm()
{
  // 冷启动要 import torch 再加载模型,机器在忙的时候实测到过 20 秒以上。
  // 等太短会把"慢"误判成"没有嵌入服务",然后一堆断言被跳过 —— 看起来像过了一半。
  const t0 = Date.now()
  const LIMIT_MS = 60000
  while (!captain.embedReady() && Date.now() - t0 < LIMIT_MS) await wait(200)
  const took = Date.now() - t0
  if (captain.embedReady()) console.log('  (嵌入服务就绪,用了 ' + (took / 1000).toFixed(1) + ' 秒)')
}
const hasEmbed = captain.embedReady()
if (!hasEmbed) console.log('  (嵌入服务没起来 —— 判重/提及相关的断言会跳过)')

const readAll = () => {
  const db = new DatabaseSync(dbFile)
  const rows = db.prepare('SELECT * FROM facts ORDER BY id').all()
  db.close()
  return rows
}

// ---------- 1 ----------
console.log('\n=== 第一轮:入库的是压缩后的那句话 ===')
captain.onUserTurn('s1', '我下周要去杭州出差,顺便看看西湖', 'k1')
captain.onAssistantText('s1', '杭州这几天有雨,记得带伞。紧张的话可以提前把要讲的内容过一遍。')
captain.onTurnEnd('s1')
{
  const rows = await waitFor(dbFile, (rs) => rs.length > 0)
  check('入库了一条', rows.length === 1, String(rows.length))
  const row = rows[0]
  check('正文是压缩后的句子', row.content === llmReply, String(row.content))
  check('正文不是原话', !row.content.includes('顺便看看西湖'), String(row.content))
  check('没超过 60 字', row.content.length <= 60, String(row.content.length))
  check('不是退化写入', row.degraded === 0, String(row.degraded))
  check('kind 是 plan', row.kind === 'plan', String(row.kind))
  if (hasEmbed) check('有 512 维向量', row.vec?.byteLength === 512 * 4, String(row.vec?.byteLength))
  else skip('有 512 维向量', '没有嵌入服务')

  const sent = JSON.stringify(llmCalls[llmCalls.length - 1])
  check('压缩时带上了人格(system)', sent.includes('你是布洛妮娅'))
  check('压缩时喂了用户的话', sent.includes('我下周要去杭州出差'))
  check('压缩时也喂了回复', sent.includes('杭州这几天有雨'))
  check('压缩要求里有字数上限', sent.includes('60 个字'))
  check('压缩要求里不许照抄', sent.includes('不要照抄'))
}

// ---------- 2 ----------
console.log('\n=== 第二轮:同一件事换个说法 -> 算提及,不新增 ===')
llmReply = '舰长下周要去杭州出差,那趟他有点紧张。'
captain.onUserTurn('s1', '下周杭州那趟出差我有点紧张', 'k2')
captain.onAssistantText('s1', '布洛妮娅记下了这件事。')
captain.onTurnEnd('s1')
if (hasEmbed) {
  const rows = await waitFor(dbFile, (rs) => (rs.length && rs[0].mention_count > 0 ? rs : null))
  check('没有新增行', rows.length === 1, String(rows.length))
  check('记了一次提及', rows[0]?.mention_count === 1, String(rows[0]?.mention_count))
  check('正文没被原话污染', !rows[0]?.content?.includes('我有点紧张'), String(rows[0]?.content))
} else {
  skip('没有新增行 / 记了一次提及', '没有嵌入服务')
}

// ---------- 3 ----------
console.log('\n=== 第三轮:纯任务指令 -> 不调模型、不入库 ===')
{
  const before = llmCalls.length
  captain.onUserTurn('s1', '帮我改一下这个函数的 bug,重启一下程序', 'k3')
  captain.onAssistantText('s1', '好的。')
  captain.onTurnEnd('s1')
  await wait(2500)
  check('没有新增', readAll().length === 1, String(readAll().length))
  check('没有为任务句花模型调用', llmCalls.length === before, `${before} -> ${llmCalls.length}`)
}

// ---------- 4 ----------
console.log('\n=== 第四轮:全新的事 -> 再入一条 ===')
llmReply = '舰长不喜欢咖啡,喝茶也睡不着。'
captain.onUserTurn('s1', '我不喜欢喝咖啡,喝茶也睡不着', 'k4')
captain.onAssistantText('s1', '那晚上就喝温水。')
captain.onTurnEnd('s1')
{
  const rows = await waitFor(dbFile, (rs) => rs.length === 2)
  check('入库第二条', rows.length === 2, String(rows.length))
  check('第二条也是压缩过的', rows[1]?.content === llmReply, String(rows[1]?.content))
}

// ---------- 5 ----------
console.log('\n=== 挂载 ===')
{
  const block = captain.buildBlock()
  check('有档案', block.includes('沉默、爱写代码'), block.slice(0, 200))
  check('有「最近说过的」', block.includes('最近说过的'))
  check('杭州那件挂上了', block.includes('杭州'))
  check('咖啡那件挂上了', block.includes('咖啡'))
  check('挂载里没有原话', !block.includes('顺便看看西湖'), block.slice(0, 400))
}

// ---------- 6 ----------
console.log('\n=== 压缩失败时退化成原话截断 ===')
{
  llmEnabled = false
  captain.onUserTurn('s1', '我每天跑六点四公里,怕哪天丧尸真的来了', 'k5')
  captain.onAssistantText('s1', '布洛妮娅觉得这个理由很合理。')
  captain.onTurnEnd('s1')
  const rows = await waitFor(dbFile, (rs) => rs.length === 3)
  check('照样入库(不丢信息)', rows.length === 3, String(rows.length))
  check('标成退化', rows[2]?.degraded === 1, String(rows[2]?.degraded))
  check('退化也不超过 60 字', (rows[2]?.content?.length ?? 999) <= 60, String(rows[2]?.content?.length))
  llmEnabled = true
}

// ---------- 7 ----------
console.log('\n=== 冷热:30 天前 + 没被提过 -> 沉底且不再挂载 ===')
{
  const db = new DatabaseSync(dbFile)
  db.prepare("UPDATE facts SET ts = ? WHERE content LIKE '%咖啡%'").run(Date.now() - 30 * 86400_000)
  db.close()

  captain.sinkNow()
  const block = captain.buildBlock()
  check('沉底的不再挂载', !block.includes('咖啡'), block.slice(0, 400))
  check('还在 7 天内的照常挂载', block.includes('杭州'))

  const row = readAll().find((r) => r.content === null)
  check('正文被剥掉', !!row)
  check('行还在(能被捞回来)', !!row)
}

// ---------- 8 ----------
console.log('\n=== 重新提及 -> 热度回升 -> 又挂上 ===')
{
  const target = readAll().find((r) => r.title.includes('咖啡'))
  if (!target) skip('重新提及', '找不到目标行')
  else {
    const db = new DatabaseSync(dbFile)
    db.prepare('UPDATE facts SET last_mention = ? WHERE id = ?').run(Date.now(), target.id)
    db.prepare('INSERT INTO mentions (fact_id, ts) VALUES (?, ?)').run(target.id, Date.now())
    db.prepare('UPDATE facts SET mention_count = mention_count + 1 WHERE id = ?').run(target.id)
    db.close()
    const block = captain.buildBlock()
    check('又挂上了', block.includes('咖啡'), block.slice(0, 500))
    check('标出提过几次', block.includes('提过'))
  }
}

// ---------- 9 ----------
console.log('\n=== 没有永久挂载:7 天后且没人提 -> 必然下沉 ===')
{
  const db = new DatabaseSync(dbFile)
  db.prepare('UPDATE facts SET ts = ? WHERE id = 1').run(Date.now() - 8 * 86400_000)
  db.prepare('DELETE FROM mentions WHERE fact_id = 1').run()
  db.prepare('UPDATE facts SET mention_count = 0, last_mention = NULL WHERE id = 1').run()
  db.close()
  const block = captain.buildBlock()
  check('条数没少(不删行)', readAll().length === 3, String(readAll().length))
  check('杭州那条已经不在挂载里', !block.includes('杭州'), block.slice(0, 400))
}

// ---------- 10 ----------
console.log('\n=== 压缩超字数时硬砍 ===')
{
  llmReply = '舰长'.repeat(80)
  captain.onUserTurn('s1', '我明天要演讲,特别紧张,一直睡不着', 'k6')
  captain.onAssistantText('s1', '布洛妮娅陪你想两遍流程。')
  captain.onTurnEnd('s1')
  const rows = await waitFor(dbFile, (rs) => rs.length === 4)
  check('入库第四条', rows.length === 4, String(rows.length))
  check('超长被砍到 60 字', rows[3]?.content?.length === 60, String(rows[3]?.content?.length))
}

console.log('\n=== 统计 ===')
{
  const s = captain.stats()
  check('统计能取出来', typeof s.total === 'number', JSON.stringify(s))
  console.log('    ' + JSON.stringify(s))
}

captain.dispose()
await wait(300)
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  console.log('  (临时目录删不掉,跳过)')
}

console.log(failures ? `\n${failures} FAILURES` : `\nALL PASS${skipped ? ` (${skipped} 项跳过)` : ''}`)
if (failures) process.exit(1)
