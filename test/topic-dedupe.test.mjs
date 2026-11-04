/**
 * 话题查重的测试。
 *
 * 需要 python 环境 + bge 模型(和跨会话记忆共用同一个)。没有就跳过。
 *
 * 用法: node test/topic-dedupe.test.mjs
 */
import { DatabaseSync } from 'node:sqlite'

import { createEmbedBridge } from '../lib/embed.js'
import { findRepeatedTopic, similarIntents, clearTopicCache, TOPIC_SIM } from '../lib/topic.js'

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

// 真实数据里出现过的那批意图
const HISTORY = [
  '她想为自己挑选一把安静可靠的机械键盘',
  '她想浏览生成式艺术论文，了解AI如何创造视觉作品',
  '她想探索生成式艺术在实时图形中的创作实践',
  '她想检索生成艺术的发展史与关键节点',
  '她想了解端侧多模态模型的最新研究进展',
  '她想找几本值得细读的科幻小说',
  '她想查阅《2001太空漫游》的三篇分析资料',
]

// 同一片地的说法(应该被拦)
const REPEATS = [
  ['她想弄清生成式艺术里规则系统怎么变成作品', '生成艺术/规则系统'],
  ['她想梳理生成艺术的技术谱系', '生成艺术/技术谱系'],
  ['她想挑选一款适合编程与游戏的高性能机械键盘', '键盘'],
  ['她想了解端侧小语言模型的最新量化与推理技术', '端侧模型'],
  ['她想找几本值得读的科幻小说，了解一下新浪潮那一批作家', '科幻小说'],
]

// 真正的新方向(不该被拦)
const FRESH = [
  '她想看一段城市夜景的延时摄影教程',
  '她想了解法国新浪潮电影的剪辑手法',
  '她想研究咖啡因对睡眠结构的影响',
  '她想找一份开源机械臂的组装文档',
]

const DAY = 86400_000
function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER, kind TEXT, category TEXT, intent TEXT
  )`)
  const now = Date.now()
  const ins = db.prepare('INSERT INTO events (ts, kind, category, intent) VALUES (?,?,?,?)')
  HISTORY.forEach((intent, i) => {
    ins.run(now - (i + 1) * (6 / HISTORY.length) * DAY, 'activity', 'tech', intent)
  })
  return db
}

const embedder = createEmbedBridge({ log: () => {} })
embedder.warm()
{
  const t0 = Date.now()
  while (!embedder.isReady() && Date.now() - t0 < 30000) await wait(200)
}
const ready = embedder.isReady()
if (!ready) console.log('  (嵌入服务没起来 —— 全部断言跳过)')

const db = makeDb()
const now = Date.now()

console.log('=== 阈值 ===')
check('阈值是 0.62', TOPIC_SIM === 0.62, String(TOPIC_SIM))

if (ready) {
  console.log('\n=== 同一片地:应该被拦下 ===')
  for (const [intent, label] of REPEATS) {
    clearTopicCache()
    const hit = await findRepeatedTopic(db, embedder, intent, now)
    check(label, !!hit, hit ? `相似度 ${hit.sim.toFixed(2)}` : '没拦下来')
    if (hit) console.log(`        命中「${String(hit.event.intent).slice(0, 34)}」${hit.sim.toFixed(2)}`)
  }

  console.log('\n=== 新方向:不该被拦 ===')
  for (const intent of FRESH) {
    clearTopicCache()
    const hit = await findRepeatedTopic(db, embedder, intent, now)
    check(intent.slice(0, 24), !hit, hit ? `误伤,相似度 ${hit.sim.toFixed(2)}` : '')
  }

  console.log('\n=== 重挑时给写手的"别去这些地方" ===')
  {
    clearTopicCache()
    const avoid = await similarIntents(db, embedder, '她想梳理生成艺术的技术谱系', now, { limit: 4 })
    check('给出了相近方向', avoid.length > 0, JSON.stringify(avoid.slice(0, 2)))
    check('最多 4 条', avoid.length <= 4, String(avoid.length))
    check('里面有生成艺术', avoid.some((s) => s.includes('生成')), JSON.stringify(avoid))
    check('没有科幻小说', !avoid.some((s) => s.includes('科幻')), JSON.stringify(avoid))
  }

  console.log('\n=== 窗口:7 天以外的不算 ===')
  {
    const old = new DatabaseSync(':memory:')
    old.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER, kind TEXT, category TEXT, intent TEXT
    )`)
    old.prepare('INSERT INTO events (ts, kind, category, intent) VALUES (?,?,?,?)').run(
      now - 30 * DAY,
      'activity',
      'tech',
      '她想弄清生成式艺术里规则系统怎么变成作品',
    )
    clearTopicCache()
    const hit = await findRepeatedTopic(old, embedder, '她想梳理生成艺术的技术谱系', now)
    check('30 天前做过的可以再做', !hit, hit ? `相似度 ${hit.sim.toFixed(2)}` : '')
    old.close()
  }

  console.log('\n=== 服务不可用时不能拦 ===')
  {
    const dead = { embed: async () => null }
    const hit = await findRepeatedTopic(db, dead, '她想梳理生成艺术的技术谱系', now)
    check('没有向量就放行', !hit, String(hit))
    const avoid = await similarIntents(db, dead, '随便什么', now)
    check('没有向量就没有排除列表', avoid.length === 0, String(avoid.length))
  }
} else {
  skip('全部断言', '没有嵌入服务')
}

db.close()
embedder.dispose()

console.log(failures ? `\n${failures} FAILURES` : `\nALL PASS${skipped ? ` (${skipped} 项跳过)` : ''}`)
if (failures) process.exit(1)
