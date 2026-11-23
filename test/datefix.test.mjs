/**
 * 相对时间 → 绝对日期。
 *
 * 舰长问的那个问题:「我在上周晚上说的下周,但是到这周就成这周了」。
 * 库里的「舰长下周日要去 WePlay 游戏展」是 11 月 11 日晚上写的,
 * 它指的是 11 月 22 日。五天后再读,这句话已经指不清日子了。
 *
 * 用法: node test/datefix.test.mjs
 */
import { resolveDates } from '../lib/captain/datefix.js'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS  ' + name)
  else {
    failures++
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''))
  }
}

/** 基准:2026 年 11 月 11 日 星期三 21:40,就是那句话被说出来的那一刻。 */
const BASE = new Date('2026-11-11T21:40:00+08:00').getTime()

const cases = [
  ['舰长下周日要去 WePlay 游戏展', '舰长11 月 22 日要去 WePlay 游戏展'],
  ['舰长下周三要去见一位当副总裁的师兄', '舰长11 月 18 日要去见一位当副总裁的师兄'],
  ['舰长明天要去跑步', '舰长11 月 12 日要去跑步'],
  ['舰长后天要考试', '舰长11 月 13 日要考试'],
  ['舰长昨天画了一小时画', '舰长11 月 10 日画了一小时画'],
  ['舰长这周末要画一小时画', '舰长11 月 14 日要画一小时画'],
  ['舰长上周一去出差', '舰长11 月 2 日去出差'],
  ['舰长下个月 3 日有期中考试', '舰长12 月 3 日有期中考试'],
  ['舰长月底要交论文', '舰长11 月 30 日要交论文'],
  ['舰长今晚要冥想', '舰长11 月 11 日晚要冥想'],
]

console.log('=== 钉日期(基准 2026-11-11 星期三)===')
for (const [input, want] of cases) {
  const got = resolveDates(input, BASE).text
  check(input, got === want, `${got}  !=  ${want}`)
}

console.log('\n=== 已经写死的日期不动 ===')
{
  const s = '舰长 11 月 22 日周日要去 WePlay 游戏展'
  const got = resolveDates(s, BASE).text
  check('不重复替换', got === s, got)
}
{
  const s = '舰长 11 月底要交论文'
  const got = resolveDates(s, BASE).text
  check('带月份的月底不套本月', got === s, got)
}

console.log('\n=== 跨年要带年份 ===')
{
  const base = new Date('2026-12-31T20:00:00+08:00').getTime()
  const got = resolveDates('舰长明天要出门', base).text
  check('跨年补年份', got === '舰长2027 年 1 月 1 日要出门', got)
}

console.log('\n=== 认不出来就原样留着,不猜 ===')
{
  const s = '舰长下周面临期中考试'
  const got = resolveDates(s, BASE).text
  check('「下周」没有具体日,不硬套', got === s, got)
}

console.log('\n=== 习惯句里的"今天、明天"是泛指,不是日期 ===')
{
  // 库里真出现过这一条,当年被误换成"优先查看 11 月 11 日",意思全没了。
  const s = '舰长习惯打开日程时优先查看今天，并重视避免日期未加载时误记到明天。'
  const got = resolveDates(s, BASE).text
  check('习惯句不动', got === s, got)
}
{
  const s = '舰长每天六点起床，先跑六点四公里'
  const got = resolveDates(s, BASE).text
  check('常态句不动', got === s, got)
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
if (failures) process.exit(1)
