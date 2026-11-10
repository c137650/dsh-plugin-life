/**
 * 嵌入服务到底能不能出向量。
 *
 * captain.db 里 7 条记录的 vec 全是空的 —— 判重因此从来没生效过,
 * 所以"相似的事件"全都入了库。
 *
 * 这一步要查清楚:是服务没就绪、请求超时、还是解码坏了。
 */
import { createEmbedBridge } from '../lib/embed.js'

const bridge = createEmbedBridge({
  log: (m) => console.log('[log]', m),
  dataDir: 'C:\\Users\\34230\\.dsh\\dsh-plugin-life',
})

console.log('刚建好: isReady =', bridge.isReady(), '| isUsable =', bridge.isUsable())

bridge.warm()
const t0 = Date.now()
while (!bridge.isReady() && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 300))
console.log('就绪用了', ((Date.now() - t0) / 1000).toFixed(1), '秒 | isReady =', bridge.isReady())

console.log('\n=== 请求三个向量 ===')
const t1 = Date.now()
const vecs = await bridge.embed(['舰长正推进RoboMaster视觉项目', '舰长想用上交视频当工业相机画面实测', '舰长习惯使用语音输入'])
console.log('耗时', Date.now() - t1, 'ms')
console.log('返回:', vecs === null ? 'null' : Array.isArray(vecs) ? vecs.length + ' 个' : typeof vecs)
if (Array.isArray(vecs)) {
  for (const v of vecs) {
    if (!v) {
      console.log('  这一条是 null')
      continue
    }
    console.log('  维度', v.length, '| 模长', Math.sqrt(v.reduce((s, x) => s + x * x, 0)).toFixed(4))
  }
  // 顺便看看相似度对不对
  if (vecs[0] && vecs[1] && vecs[2]) {
    const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
    console.log('\n  相似度 #1×#2(RoboMaster 两件事):', cos(vecs[0], vecs[1]).toFixed(3))
    console.log('  相似度 #1×#3(不相干的两件事):', cos(vecs[0], vecs[2]).toFixed(3))
  }
} else {
  console.log('\n=== 服务说"没就绪"时的行为 ===')
  console.log('embed() 在 !ready 时直接返回 null(不排队、不等)—— 这就是向量全空的原因')
}

bridge.dispose()
process.exit(0)
