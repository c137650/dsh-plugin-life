/**
 * 活动那边的主题查重,以前是不是也一直没生效。
 *
 * 同一个嵌入服务、同一个编码 bug —— recentIntentVectors 会把没向量的行全滤掉,
 * 于是 findRepeatedTopic 永远返回 null,"同一片地 7 天内走过就换方向"这条规则形同虚设。
 *
 * 这里拿 life.db 里真实跑过的活动,量一下有多少是"重复的"。
 */
import { DatabaseSync } from 'node:sqlite'
import { createEmbedBridge } from '../lib/embed.js'
import { TOPIC_SIM, TOPIC_WINDOW_DAYS } from '../lib/topic.js'

const db = new DatabaseSync('C:\\Users\\34230\\.dsh\\dsh-plugin-life\\life.db')
const rows = db
  .prepare(
    `SELECT id, ts, category, intent FROM events
     WHERE kind = 'activity' AND intent IS NOT NULL AND length(trim(intent)) > 0
     ORDER BY ts DESC`,
  )
  .all()

console.log('活动总数(有意图的):', rows.length)
console.log('查重窗口:', TOPIC_WINDOW_DAYS, '天 | 阈值:', TOPIC_SIM)

const bridge = createEmbedBridge({
  log: (m) => console.log('[log]', m),
  dataDir: 'C:\\Users\\34230\\.dsh\\dsh-plugin-life',
})
bridge.warm()
const t0 = Date.now()
while (!bridge.isReady() && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 300))
if (!bridge.isReady()) {
  console.log('嵌入服务没起来')
  process.exit(1)
}

const vecs = await bridge.embed(rows.map((r) => String(r.intent)))
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)

console.log('\n=== 窗口内互相撞的(模拟"该换方向却没换")===')
let hits = 0
for (let i = 0; i < rows.length; i++) {
  for (let j = i + 1; j < rows.length; j++) {
    const days = Math.abs(Number(rows[i].ts) - Number(rows[j].ts)) / 86400_000
    if (days > TOPIC_WINDOW_DAYS) continue
    const s = cos(vecs[i], vecs[j])
    if (s < TOPIC_SIM) continue
    hits++
    console.log(
      '  #' + rows[i].id + ' × #' + rows[j].id + '  相似 ' + s.toFixed(3) +
        '  (相隔 ' + days.toFixed(1) + ' 天)',
    )
    console.log('      ' + String(rows[i].intent).slice(0, 50))
    console.log('      ' + String(rows[j].intent).slice(0, 50))
  }
}
console.log('\n窗口内重复对数:', hits, '/ 活动数', rows.length)

bridge.dispose()
db.close()
process.exit(0)
