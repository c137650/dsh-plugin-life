/**
 * 跨会话记忆的质量闸 —— 测试。
 *
 * 这一套判据每一条都来自真库里实际出现过的坏例子:
 *
 *   「舰长正推进RoboMaster视觉项目…」   ← 工作相关(舰长定的:全不记)
 *   「有问题。1."听到了。(ᗜ ˰ ᗜ)…」    ← 混进了布洛妮娅自己的语气
 *   「舰长继续为桌面」                    ← 半句话
 *   title == content                     ← 两列一模一样,白存
 *
 * 用法: node test/captain-quality.test.mjs
 */
import { looksLikeFact, shortTitle, detailWithoutHead, isWorkRelated } from '../lib/captain/quality.js'
import { renderFact } from '../lib/captain/engine.js'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS  ' + name)
  else {
    failures++
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''))
  }
}

console.log('=== 质量闸:该挡的挡住 ===')
{
  const bad = [
    ['太短', '舰长继续为桌面'],
    ['不是第三人称', '有问题。1."听到了。(ᗜ ˰ ᗜ) 重装小兔的拾音器一直开着'],
    ['带布洛妮娅的语气', '舰长听到���(ᗜ ˰ ᗜ)之后觉得好笑'],
    ['像代码', '舰长用 const x = require("fs") 解决了这个问题'],
    ['工作相关', '舰长正推进RoboMaster视觉项目，要求布洛妮娅依据官方资料作答'],
  ]
  for (const [why, text] of bad) {
    const r = looksLikeFact(text)
    check('挡下「' + why + '」', !r.ok, r.ok ? '放行了' : '')
  }
}

console.log('\n=== 质量闸:该留的留下 ===')
{
  const good = [
    '舰长习惯使用语音输入，停顿稍长时容易重复说同一句话。',
    '舰长每天晚上画一小时画，这是他保持自我的方式。',
    '舰长跑步能坚持下来，靠的是固定的作息而不是意志力。',
  ]
  for (const t of good) {
    const r = looksLikeFact(t)
    check('放行「' + t.slice(0, 14) + '…」', r.ok, r.ok ? '' : r.why)
  }
}

console.log('\n=== 机器人比赛那些也要挡掉 ===')
{
  // 舰长定的规则:工作相关的全不记。
  // 这几条看起来"像人的状态",但说的是工作项目,所以一样不留。
  const work = [
    '舰长面对赛制突变的新装甲板一度慌乱，却不接受放弃结论，坚持追问可行替代方案。',
    '舰长想用上交视频当工业相机画面实测，但更在意数据是否可信，倾向把验证做扎实。',
    '舰长能准确指出语音播报逻辑的偏差，并给出更合理的判定顺序。',
  ]
  for (const t of work) {
    const r = looksLikeFact(t)
    check('挡下「' + t.slice(0, 14) + '…」', !r.ok && r.why.startsWith('work-related'), r.ok ? '放行了' : r.why)
  }
}

console.log('\n=== 工作相关的识别 ===')
{
  const w = isWorkRelated('舰长在调机器视觉的参数')
  check('命中工作词', w.work === true, JSON.stringify(w.hits))
  const p = isWorkRelated('舰长习惯使用语音输入')
  check('不误伤个人习惯', p.work === false, JSON.stringify(p.hits))
}

console.log('\n=== 短标签 ===')
{
  const cases = [
    ['舰长正推进RoboMaster视觉项目，要求布洛妮娅依据官方资料作答，关心工业相机画面。', '舰长正推进RoboMaster视觉项…'],
    ['舰长习惯使用语音输入，停顿稍长时容易重复说同一句话。', '舰长习惯使用语音输入'],
    ['舰长继续为桌面', '舰长继续为桌面'],
  ]
  for (const [text, want] of cases) {
    const got = shortTitle(text)
    check('「' + text.slice(0, 12) + '…」→ ' + got, got === want, '期望 ' + want)
  }
  check('title 和 content 不再一样', shortTitle('舰长习惯使用语音输入，停顿稍长时容易重复。') !== '舰长习惯使用语音输入，停顿稍长时容易重复。')
}

console.log('\n=== 细节去掉重复的开头 ===')
{
  const body = '舰长习惯使用语音输入，停顿稍长时容易重复说同一句话。'
  const head = '舰长习惯使用语音输入'
  const d = detailWithoutHead(body, head)
  check('去掉标签前缀', d === '停顿稍长时容易重复说同一句话。', d)
}

console.log('\n=== 挂载时的样子 ===')
{
  const f = {
    ts: Date.now() - 3 * 86400_000,
    title: '舰长习惯使用语音输入',
    content: '舰长习惯使用语音输入，停顿稍长时容易重复说同一句话。',
  }
  const out = renderFact(f, Date.now())
  console.log('    ' + out.replace(/\n/g, '\n    '))
  check('有标签行', out.startsWith('- [3 天前] 舰长习惯使用语音输入'), out)
  check('细节行不重复标签', !out.includes('「舰长习惯使用语音输入，'), out)
  check('细节保留了内容', out.includes('停顿稍长时容易重复说同一句话'), out)
}

console.log('\n=== 老数据(title==content)也要正常显示 ===')
{
  const f = {
    ts: Date.now() - 3 * 86400_000,
    title: '舰长习惯使用语音输入，停顿稍长时容易重复说同一句话。',
    content: '舰长习惯使用语音输入，停顿稍长时容易重复说同一句话。',
  }
  const out = renderFact(f, Date.now())
  console.log('    ' + out.replace(/\n/g, '\n    '))
  check('不重复输出', out.split('舰长习惯使用语音输入').length - 1 === 1, out)
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
if (failures) process.exit(1)
