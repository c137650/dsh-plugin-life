/**
 * 写入时把相对时间换算成绝对日期。
 *
 * 舰长指出的问题,原话:
 *   "我在上周晚上说的下周,但是到这周就成这周了"
 *
 * 库里那条「舰长下周日要去 WePlay 游戏展」是 11 月 11 日晚上写的,
 * 那个「下周日」指的是 11 月 22 日。五天后再读,「下周日」已经可以读成
 * 这周日或者上周日 —— 这不是模型写错,是记录里存了一个会过期的东西。
 *
 * 记忆要被留到以后读,所以时间必须在写库那一刻钉死。
 *
 * 基准就是写库时间:压缩发生在写库前一步,和说话是同一刻,所以"这周三"
 * 按字面取本日历周三就行,不做"是不是已经过去了"的猜测。
 *
 * 这里是确定性的:同样的句子和同样的基准,必然得到同样的日期。
 * 认不出来的说法原样留着,不猜 —— 挂载时每一行都带绝对日期,读的人仍然能对上。
 */

const DAY = 86400_000

const WEEKDAY_INDEX = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7,
}

/**
 * 习惯词。
 *
 * 句子里出现这些,说明说的是常态而不是某一天里的某件事,
 * 里面的"今天、明天"是泛指,不能换算成日期。
 */
const HABIT_WORDS = /习惯|每天|总是|老是|一贯|通常|一般|经常|常常|喜欢|讨厌|受不了|从不|从来不|固定/

/** 当天零点。 */
function dayStart(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本周周一零点。中文的"这周"从周一开始。 */
function mondayOf(ts) {
  const d = new Date(dayStart(ts))
  const shift = (d.getDay() + 6) % 7
  return dayStart(ts) - shift * DAY
}

/** 目标日期 → "11 月 22 日",跨年补上年份。 */
function fmtDate(target, base) {
  const t = new Date(target)
  const b = new Date(base)
  const head = t.getFullYear() === b.getFullYear() ? '' : `${t.getFullYear()} 年 `
  return `${head}${t.getMonth() + 1} 月 ${t.getDate()} 日`
}

function addDays(ts, n) {
  return dayStart(ts) + n * DAY
}

/** n 个月后,取第 day 号;那个月没有这一天就落到月末。 */
function addMonths(ts, n, day) {
  const b = new Date(ts)
  const first = new Date(b.getFullYear(), b.getMonth() + n, 1)
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day, lastDay)).getTime()
}

/** 当月最后一天。 */
function monthEnd(ts, n = 0) {
  return addMonths(ts, n + 1, 1) - DAY
}

/**
 * 把一句话里的相对时间换成绝对日期。
 *
 * @param text    概括出来的那句话
 * @param baseTs  写库时刻(说话那一刻)
 * @returns {{ text, resolved: string[] }}  resolved 是"原来 → 换成"的对照,给日志用
 */
export function resolveDates(text, baseTs = Date.now()) {
  const resolved = []
  let s = String(text ?? '')
  if (!s) return { text: '', resolved }

  const push = (from, to) => resolved.push(`${from} → ${to}`)

  const today = dayStart(baseTs)
  const monday = mondayOf(baseTs)

  // ---- 周末先做:里面的"末"不在星期表里,不会被下面那条抢先 ----
  s = s.replace(/(下下|下|这|本|上)?(?:个)?周末/g, (m, prefix) => {
    const weeks = prefix === '下' ? 1 : prefix === '下下' ? 2 : prefix === '上' ? -1 : 0
    const out = fmtDate(monday + weeks * 7 * DAY + 5 * DAY, baseTs)
    push(m, out)
    return out
  })

  // ---- 下周日 / 这周三 / 下下周六 / 上周一 ----
  s = s.replace(/(下下|下|这|本|上)(?:个)?(?:周|星期|礼拜)([一二三四五六日天1-7])/g, (m, prefix, dayChar) => {
    const idx = WEEKDAY_INDEX[dayChar]
    if (!idx) return m
    const weeks = prefix === '下' ? 1 : prefix === '下下' ? 2 : prefix === '上' ? -1 : 0
    const out = fmtDate(monday + weeks * 7 * DAY + (idx - 1) * DAY, baseTs)
    push(m, out)
    return out
  })

  // ---- 下个月 22 日 ----
  s = s.replace(/(下|这|本|上)(?:个)?月\s*(\d{1,2})\s*[日号]/g, (m, prefix, dayStr) => {
    const months = prefix === '下' ? 1 : prefix === '上' ? -1 : 0
    const out = fmtDate(addMonths(baseTs, months, Number(dayStr)), baseTs)
    push(m, out)
    return out
  })

  // ---- 月底 / 月初(不写前缀就是本月) ----
  //
  // 前面紧挨着数字或"月"的跳过:"11 月底"已经说了月份,再套本月就对不上。
  s = s.replace(/(下|这|本|上)?(?:个)?月[底末]/g, (m, prefix, offset, whole) => {
    const prev = whole.slice(0, offset).replace(/\s+$/, '').slice(-1)
    if (/\d/.test(prev) || prev === '月') return m
    const months = prefix === '下' ? 1 : prefix === '上' ? -1 : 0
    const out = fmtDate(monthEnd(baseTs, months), baseTs)
    push(m, out)
    return out
  })
  s = s.replace(/(下|这|本|上)?(?:个)?月初/g, (m, prefix, offset, whole) => {
    const prev = whole.slice(0, offset).replace(/\s+$/, '').slice(-1)
    if (/\d/.test(prev) || prev === '月') return m
    const months = prefix === '下' ? 1 : prefix === '上' ? -1 : 0
    const out = fmtDate(addMonths(baseTs, months, 1), baseTs)
    push(m, out)
    return out
  })

  // ---- 大后天 / 后天 / 明天 / 昨天 / 前天 ----
  //
  // 习惯句里的"今天、明天"不是日期,是泛指。
  // 库里那条「舰长习惯打开日程时优先查看今天,并重视避免日期未加载时误记到明天」
  // 就是被这条规则误伤过的:换完之后变成"优先查看 11 月 11 日",意思全没了。
  // 所以句子里有习惯词就整段跳过,"下周X""周末"那种仍然照换 —— 那是具体日子。
  const habit = HABIT_WORDS.test(s)
  const dayWords = habit
    ? []
    : [
        [/大后天/g, 3],
        [/后天/g, 2],
        [/明天|明日|明儿/g, 1],
        [/昨天|昨日|昨儿/g, -1],
        [/前天|前日/g, -2],
      ]
  for (const [re, off] of dayWords) {
    s = s.replace(re, (m) => {
      const out = fmtDate(addDays(baseTs, off), baseTs)
      push(m, out)
      return out
    })
  }

  // ---- 今晚 / 昨夜(带时段的,单独处理,别把"晚"吃掉) ----
  if (!habit) {
    s = s.replace(/今晚|今夜|今天晚上/g, (m) => {
      const out = fmtDate(today, baseTs) + '晚'
      push(m, out)
      return out
    })
    s = s.replace(/昨晚|昨夜/g, (m) => {
      const out = fmtDate(today - DAY, baseTs) + '晚'
      push(m, out)
      return out
    })

    // ---- 今天 / 今日 放最后:前面那些带"今"的说法已经换掉了 ----
    s = s.replace(/今天|今日/g, (m) => {
      const out = fmtDate(today, baseTs)
      push(m, out)
      return out
    })
  }

  return { text: s, resolved }
}
