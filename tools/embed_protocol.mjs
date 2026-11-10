/**
 * 直接跟嵌入服务说协议,把原始响应打出来。
 *
 * 现象:桥那边 embed() 2 毫秒就返回 null —— 服务端明明回得这么快,
 * 说明它回了点什么,但 JS 那边解不开。
 *
 * 这个脚本不走桥,自己 spawn python,自己发一行,自己看回什么。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PY = 'E:\\anaconda\\envs\\tts0\\python.exe'
const MODEL = 'C:\\Users\\34230\\.cache\\modelscope\\AI-ModelScope\\bge-small-zh-v1___5'

const child = spawn(PY, ['-u', path.join(HERE, '..', 'lib', 'embed_server.py'), MODEL], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let buf = ''
const seen = []
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line) seen.push(line)
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => {
  const s = c.trim()
  if (s && !s.includes('Skipping import') && !s.includes('Redirects')) console.log('[stderr]', s.slice(0, 200))
})

console.log('已起,等就绪...')
await new Promise((r) => setTimeout(r, 15000))

console.log('\n收到的就绪行:', seen[0])
if (!seen[0]) {
  console.log('没收到就绪行')
  child.kill()
  process.exit(1)
}

console.log('\n发请求 {"id":1,"texts":["舰长习惯使用语音输入"]}')
child.stdin.write(JSON.stringify({ id: 1, texts: ['舰长习惯使用语音输入'] }) + '\n')

await new Promise((r) => setTimeout(r, 3000))

const resp = seen[1]
console.log('\n=== 原始响应 ===')
if (!resp) {
  console.log('没有响应')
} else {
  console.log('长度', resp.length, '| 前 200 字:')
  console.log('  ' + resp.slice(0, 200))
  try {
    const m = JSON.parse(resp)
    console.log('\n解析成功')
    console.log('  id =', m.id)
    console.log('  error =', m.error ?? '(没有)')
    console.log('  vectors 类型 =', Array.isArray(m.vectors) ? '数组,长度 ' + m.vectors.length : typeof m.vectors)
    if (Array.isArray(m.vectors) && m.vectors[0]) {
      const b64 = m.vectors[0]
      const raw = Buffer.from(b64, 'base64')
      console.log('  base64 长度', b64.length, '| 解出来', raw.byteLength, '字节')
      console.log('  字节数是 4 的倍数吗:', raw.byteLength % 4 === 0, '  ← 不是的话 Float32Array 会直接抛错')
      try {
        const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
        console.log('  Float32Array 造出来了吗: 是,长度', f.length)
        console.log('  前 3 个分量:', f[0].toFixed(4), f[1].toFixed(4), f[2].toFixed(4))
        const norm = Math.sqrt(f.reduce((s, x) => s + x * x, 0))
        console.log('  模长:', norm.toFixed(4), '  ← 归一化了就该是 1.0')
      } catch (e) {
        console.log('  !! Float32Array 抛错了:', e.message)
      }
    }
  } catch (e) {
    console.log('JSON 解析失败:', e.message)
  }
}

child.kill()
process.exit(0)
