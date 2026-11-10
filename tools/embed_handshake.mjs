/**
 * 盯住嵌入服务的握手。
 *
 * 现象:captain.db 里 7 条记录的 vec 全空 —— 判重从来没生效过,
 * 所以"相似的事件"全都入了库。
 * DSH 自己的 python 明明活着(模型都加载完了,几百 MB),
 * 但桥那边的 ready 一直是 false。
 *
 * 这一步要把每一环都打出来:进程起没起、stdout 有没有收到握手、
 * 收到的是不是能解析的 JSON。
 */
import { createEmbedBridge } from '../lib/embed.js'

const bridge = createEmbedBridge({
  log: (m) => console.log('[' + new Date().toISOString().slice(11, 23) + '] ' + m),
  dataDir: 'C:\\Users\\34230\\.dsh\\dsh-plugin-life',
})

console.log('建好: isReady =', bridge.isReady(), '| isUsable =', bridge.isUsable())
console.log('调用 warm()\n')

bridge.warm()

const t0 = Date.now()
let last = -1
while (Date.now() - t0 < 45000) {
  const r = bridge.isReady()
  if (r !== last) {
    console.log('  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  isReady =', r)
    last = r
  }
  if (r) break
  await new Promise((x) => setTimeout(x, 500))
}

console.log('\n结论: ' + (bridge.isReady() ? '就绪了' : '45 秒还没就绪'))

if (bridge.isReady()) {
  const t1 = Date.now()
  const vecs = await bridge.embed(['舰长正推进RoboMaster视觉项目', '舰长习惯使用语音输入'])
  console.log('embed 耗时', Date.now() - t1, 'ms')
  if (Array.isArray(vecs)) {
    console.log('拿到', vecs.length, '个向量,维度', vecs[0]?.length)
    const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
    console.log('相似度', cos(vecs[0], vecs[1]).toFixed(3))
  } else {
    console.log('embed 返回 null')
  }
}

bridge.dispose()
process.exit(0)
