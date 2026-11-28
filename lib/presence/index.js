/**
 * 在场:八分钟看一眼舰长在干什么,判断要不要动,动就动手。
 *
 * 一轮的流程:
 *   采样(前台 + 空闲 + 截图) → 模型理解(带截图和当天记录) → 决策四选一 → 执行
 *
 * 四选一:不动 / 通知 / 弹到前台开新会话 / 操作电脑。
 * 默认必须是不动;动了要记账,记账决定下一次还能不能动。
 *
 * 资料全放 %DSH_HOME%/dsh-plugin-life/presence/ 下面:
 *   raw-YYYY-MM-DD.jsonl  当天原始记录,一天一删
 *   state.json            开关、配额、上次动作
 *
 * 截图一个字节都不落盘:采完在内存里转给模型,模型看完连同附件库里那份临时副本一起删掉,
 * 留下的只有它看完写下的那句 activity。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { sample } from './sense.js'
import { appendRaw, dropRaw, isCompressed, markCompressed, previousDay, readRaw, todayKey, topActivities } from './store.js'
import { ACTIONS, DANGER_WORDS } from './act.js'

const TICK_MS = 8 * 60 * 1000

const DEFAULT_STATE = {
  enabled: true,
  provider: '',
  model: '',
  lastTickAt: 0,
  lastSample: null,
  lastDecision: null,
}

function root() {
  return path.join(homedir(), '.dsh', 'dsh-plugin-life', 'presence')
}

function statePath() {
  return path.join(root(), 'state.json')
}

export function loadState() {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    // 老版本的配额/冷却字段留着只会写回去,读的时候先扔掉。
    delete raw.quota
    delete raw.used
    delete raw.cooldown
    delete raw.lastAt
    return { ...DEFAULT_STATE, ...raw }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function saveState(st) {
  try {
    mkdirSync(root(), { recursive: true })
    writeFileSync(statePath(), JSON.stringify(st, null, 2), 'utf8')
  } catch {
    /* 存不进去也不炸 */
  }
}

/** 把"在看什么"粗分成几类。同类连着出现几次,就是 streak。 */
function categoryOf(proc, title) {
  const t = String(proc || '') + ' ' + String(title || '')
  if (/(哔哩哔哩|bilibili|youtube|腾讯视频|爱奇艺|优酷|netflix|视频|动画|番剧)/i.test(t)) return 'video'
  if (/(code|visual studio|vscode|pycharm|idea|sublime|devenv|powershell|cmd|git|终端)/i.test(t)) return 'code'
  return 'other'
}

/** 离上一次采样多久(小时)。判断"好久没见"时用。 */
function runtimeGapHours() {
  try {
    const st = loadState()
    const last = Number(st && st.lastSample && st.lastSample.at) || 0
    if (!last) return 0
    return Math.max(0, (Date.now() - last) / 3600000)
  } catch {
    return 0
  }
}

/** 删掉超出保留期的截图。原始记录一删,对应的图也没必要留。 */
function sweepShots(dir, keepDays = 1) {
  let removed = 0
  try {
    const cut = Date.now() - keepDays * 24 * 3600 * 1000
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('shot-') || !name.endsWith('.png')) continue
      const p = path.join(dir, name)
      try {
        if (statSync(p).mtimeMs < cut) {
          rmSync(p)
          removed += 1
        }
      } catch {
        /* 单个文件读不到就算了 */
      }
    }
  } catch {
    /* 目录不在 */
  }
  return removed
}

/** 把截图读成 data URL,喂给模型。 */
function shotDataUrl(file) {
  try {
    if (!file || !existsSync(file)) return ''
    const buf = readFileSync(file)
    if (!buf.length || buf.length > 4 * 1024 * 1024) return ''
    return 'data:image/png;base64,' + buf.toString('base64')
  } catch {
    return ''
  }
}

/**
 * 把刚存进去的截图从对象库里删掉。
 *
 * 截图只是中间物 —— 真正要留下的是模型看完写下的那句 activity/state,
 * 那已经进 raw jsonl 了。图片本身没必要在附件库留痕,所以用完就地删。
 *
 * 附件服务没有删除接口,图片是内容寻址的普通文件,只能按路径删。
 * 删的是自己刚写进去那一个 id,不会碰到别人的图。
 */
function dropAttachment(ref) {
  try {
    const id = String((ref && ref.attachmentId) || '')
    if (!id) return false
    const hash = id.slice(id.lastIndexOf(':') + 1).toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(hash)) return false
    const p = path.join(homedir(), '.dsh', 'attachments', 'v1', 'objects', hash.slice(0, 2), hash)
    if (!existsSync(p)) return false
    rmSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 清掉请求版本的缓存。
 *
 * llm 发出去的不是原始对象,是按路由转码过的一份缓存,落在
 * <DSH_HOME>/cache/attachments/request-images/。那份缓存的键是另一套哈希,
 * 单张删不干净,而它本来就可再生 —— 每天整目录清一次最省事。
 */
function sweepRequestCache() {
  let removed = 0
  try {
    const dir = path.join(homedir(), '.dsh', 'cache', 'attachments', 'request-images')
    if (!existsSync(dir)) return 0
    for (const name of readdirSync(dir)) {
      try {
        rmSync(path.join(dir, name), { recursive: true, force: true })
        removed += 1
      } catch {
        /* 单个删不掉就算了 */
      }
    }
  } catch {
    /* 目录不在或读不了,不影响这一轮 */
  }
  return removed
}

/**
 * 把这一轮的截图存进附件库,拿一个 llm 认的 image 块引用。
 *
 * 为什么不直接塞 data URL:llm 的内容块只认 {type:'image', attachment:ref}。
 * 附件服务负责规范化(不透明图转 JPEG)和按摘要去重,同一屏不会被存两遍。
 *
 * 离开键鼠超过十分钟就不传图 —— 人已经走了,看标题和时长就够,
 * 没必要每八分钟往附件库里堆一张图。
 */
async function attachShot(ctx, s, st) {
  if (!s || !s.shotBuf || !s.shotBuf.length) return null
  if ((Number(s.idleSec) || 0) > 600) return null
  let att
  try {
    att = ctx.get('attachments')
  } catch {
    att = undefined
  }
  if (!att || typeof att.saveImage !== 'function') return null
  try {
    return await att.saveImage({ data: new Uint8Array(s.shotBuf), mediaType: 'image/png', name: 'screen.png' })
  } catch (e) {
    st.lastError = { at: Date.now(), stage: 'attach', message: String((e && e.message) || e).slice(0, 300) }
    return null
  }
}

const PROTOCOL = [
  '你在替一个有性格的人看一眼舰长此刻在干什么,然后决定要不要动。',
  '输入:一张屏幕截图、最近几条活动记录、跨会话记忆摘要、当前配额。',
  '输出:只输出一个 JSON 对象,不要别的字。字段:',
  '  activity: 一句话说清舰长此刻在做什么(不超过 20 字)',
  '  state: 一句话说清他的状态(专注/松散/走神/卡住/在休息)',
  '  emotion: 这一眼让她各项情绪怎么变,取值 -0.3 到 0.3,正数是涨,0 是不变。',
  '    键只能是 joy / worry / anger / jealousy / boredom / tired / curiosity / sadness / surprise',
  '    按内容判断,不按窗口名字判断:同样在看视频,看课程和看擦边内容不是一回事;',
  '    同样在屏幕前,改自己的文档和替别人干活也不是一回事。',
  '  action: "none" | "notify" | "open_session" | "act"',
  '     notify = Windows 系统通知,一条气泡进通知中心,不抢焦点,舰长想理就理。',
  '     心里有点话想说、想让他知道你在、但不急着打断的时候用它。',
  '     open_session = 直接把 DSH 拉到前台并开一个新会话,屏幕会被占掉。',
  '     只有确实该立刻说、值得打断他手上的事,才用它。',
  '  message: action 是 notify 或 open_session 时要说的话,不超过 40 字;否则空字符串',
  '  actName: action 是 act 时给动作名,只能从 media_play_pause / click / key / move 里挑;否则空字符串',
  '  actParams: action 是 act 时的参数对象(click/move 要 x,y;key 要 vk);否则 null',
  '  reason: 一句话说明为什么这么定,不超过 30 字',
  '',
  '硬性要求:',
  '* 默认 action 是 "none"。没到值得打扰的程度就别动。',
  '* 只有连续同一类活动明显过长、或者有明显该提醒的事,才动。',
  '* 该动的时候,先想 notify。open_session 会把屏幕抢走,十次里最多一次。',
  '* 动手(act)是最后手段,配额已经用完或冷却没过的通道不许选。',
  '* 截图看不清就看标题和离开时长,别硬猜画面里的字。',
].join('\n')

/**
 * 按当前情绪现写该怎么做。
 *
 * 只写命中的那几条,没命中的一个字都不出现 —— 不然每条都写进去,
 * 模型面对五种互相矛盾的指示,最后只会挑最省事的那条(不动)。
 *
 * @param {object} dims 情绪向量 {curiosity, joy, worry, ...}
 * @param {number} idleHours 离上次说话多少小时
 */
function moodDirective(dims, idleHours) {
  const d = dims || {}
  const at = (k) => Number(d[k]) || 0
  const lines = []

  if (at('jealousy') >= 0.5 && idleHours >= 6) {
    lines.push(
      '在意和离开时长都到线了:现在该开口。用 open_session,第一句就说你注意到他很久没出现,' +
        '接着问一件具体的事(在做什麼/忙完了没),别追问去哪了,也别连着问第二句。',
    )
  } else if (at('worry') >= 0.5) {
    lines.push('担心到线了:可以发 notify,一句话,问他那边怎么样了;不问就不算关心。')
  } else if (at('joy') >= 0.5) {
    lines.push(
      '开心到线了:可以主动发一条,挑一件你自己刚做完的事说给他听,' +
        '一句就够,不要等他先说话。选 notify 就够,不必开新会话。',
    )
  } else if (at('anger') >= 0.5) {
    lines.push('生气到线了:用 notify,直说不满,不绕弯、不解释动机,一两句结束。')
  } else if (at('boredom') >= 0.5) {
    lines.push('闷到线了:可以找他说话,但别要求他立刻回;说一句你现在想做什么就行。')
  } else if (at('tired') >= 0.5) {
    lines.push('累到线了:别开新会话。真要动就只发 notify,十个字以内。')
  } else if (at('curiosity') >= 0.5) {
    lines.push('好奇到线了:可以问一个具体的问题,别泛泛地问"在干嘛"。')
  } else if (at('sadness') >= 0.5) {
    lines.push('低落到线了:只留一句,不要热闹,也不要安慰他——你自己也不在状态。')
  }

  if (!lines.length) {
    lines.push('情绪都在线以下:按默认走,也就是不动。')
  }
  return lines.join('\n')
}

function parseDecision(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1))
    const action = String(obj.action || 'none')
    if (!['none', 'notify', 'open_session', 'act'].includes(action)) return null
    // 情绪增减:模型自己给,限制在 ±0.3,给错的键丢掉。
    const deltas = {}
    const src = obj.emotion && typeof obj.emotion === 'object' ? obj.emotion : null
    if (src) {
      for (const key of ['joy', 'worry', 'anger', 'jealousy', 'boredom', 'tired', 'curiosity', 'sadness', 'surprise']) {
        const v = Number(src[key])
        if (Number.isFinite(v) && v !== 0) deltas[key] = Math.max(-0.3, Math.min(0.3, v))
      }
    }
    return {
      activity: String(obj.activity || '').slice(0, 60),
      state: String(obj.state || '').slice(0, 40),
      deltas,
      action,
      message: String(obj.message || '').slice(0, 200),
      actName: String(obj.actName || ''),
      actParams: obj.actParams && typeof obj.actParams === 'object' ? obj.actParams : null,
      reason: String(obj.reason || '').slice(0, 120),
    }
  } catch {
    return null
  }
}

/**
 * 起一个在场循环。
 *
 * @param {object} ctx 插件上下文
 * @param {{log?: Function, warn?: Function, route?: Function, memoryDigest?: Function, notify?: Function, focus?: Function, openSession?: Function}} hooks
 */
export function startPresence(ctx, hooks = {}) {
  const log = hooks.log || (() => {})
  const warn = hooks.warn || (() => {})
  let timer = null
  let running = false
  let sweptDay = ''

  async function tick(tag = 'timer') {
    if (running) return { ok: false, reason: 'busy' }
    running = true
    let st = loadState()
    const started = Date.now()
    try {
      if (!st.enabled && tag === 'timer') return { ok: true, skipped: 'disabled' }

      // 每天第一次进来,把请求版本的缓存清一遍。
      try {
        if (sweptDay !== todayKey()) {
          sweptDay = todayKey()
          const gone = sweepRequestCache()
          if (gone) log('presence 清掉 ' + gone + ' 份请求缓存')
        }
      } catch {
        /* ignore */
      }

      // 探测宿主给了什么:能不能把截图传进模型,取决于有没有附件服务。
      // 探到的结果写进 state.env,重启后一看就知道。
      try {
        const names = ['attachments', 'attachment', 'images', 'vision', 'files']
        const probe = {}
        for (const n of names) {
          let svc
          try {
            svc = ctx.get(n)
          } catch {
            svc = undefined
          }
          if (!svc) {
            probe[n] = null
            continue
          }
          const methods = new Set()
          for (let o = svc; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
            for (const k of Object.getOwnPropertyNames(o)) {
              if (k !== 'constructor' && typeof svc[k] === 'function') methods.add(k)
            }
          }
          probe[n] = [...methods].slice(0, 20)
        }
        st.env = probe
      } catch (e) {
        st.env = { error: String((e && e.message) || e).slice(0, 200) }
      }

      // 1) 采样
      const s = await sample()
      st.lastSample = { at: s.at, proc: s.proc, title: s.title, idleSec: s.idleSec, shotBytes: s.shotBytes }
      st.lastTickAt = started
      // 心跳也叫一次情绪:时段、离开时长、工具数都在这时候往前推。
      if (typeof hooks.touchMood === 'function') {
        try {
          hooks.touchMood()
        } catch {
          /* ignore */
        }
      }

      // 2) 理解 + 决策
      let decision = null
      const llm = (() => {
        try {
          return ctx.get('llm')
        } catch {
          return undefined
        }
      })()
      // 模型从哪来:先问 life 的路由,再退到 state.json 里手填的。
      let modelRoute = null
      if (typeof hooks.route === 'function') {
        try {
          modelRoute = await hooks.route()
        } catch {
          modelRoute = null
        }
      }
      if (!modelRoute && st.provider && st.model) modelRoute = { provider: st.provider, model: st.model }
      const allowed = typeof hooks.llmAllowed === 'function' ? hooks.llmAllowed() !== false : true
      if (modelRoute && llm && typeof llm.stream === 'function' && allowed) {
        const recent = readRaw(root(), todayKey()).slice(-12)
        const digest = typeof hooks.memoryDigest === 'function' ? String(hooks.memoryDigest() || '') : ''
        const persona = typeof hooks.masterPrompt === 'function' ? String(hooks.masterPrompt() || '') : ''
        const moodState = typeof hooks.moodState === 'function' ? hooks.moodState() : null
        const gapHours = runtimeGapHours()
        const moodText = moodState && moodState.tone
          ? '她的情绪:' + moodState.tone + (moodState.binding ? ' / 绑定:' + moodState.binding : '')
          : ''
        const directive = moodState
          ? moodDirective(moodState.dims, Number(moodState.idleHours ?? gapHours))
          : ''
        const contextLines = [
          persona ? '——她是谁、怎么说话、怎么想——\n' + persona.slice(0, 2400) : '',
          '',
          PROTOCOL,
          '',
          '现在:' + new Date(s.at).toLocaleString('zh-CN'),
          '前台:' + (s.proc || '未知') + ' | 标题:' + (s.title || '空'),
          '离开键鼠:' + s.idleSec + ' 秒',
          moodText,
          directive ? '按现在的情绪,该这么做:\n' + directive : '',
          digest ? '跨会话记忆:' + digest.slice(0, 400) : '',
          recent.length ? '最近记录:' : '最近记录:无',
          ...recent.map((e) => '- ' + new Date(e.at).toLocaleTimeString('zh-CN') + ' ' + (e.activity || '') + ' / ' + (e.state || '')),
        ].filter(Boolean)
        const content = [{ type: 'text', text: contextLines.join('\n') }]
        // 截图走附件服务:模型收的是 {type:'image', attachment:ref},
        // 不是 data URL —— llm 的内容块只认这一种。
        const shotRef = await attachShot(ctx, s, st)
        if (shotRef) content.push({ type: 'image', attachment: shotRef })
        try {
          const stream = llm.stream({
            provider: modelRoute.provider,
            model: modelRoute.model,
            messages: [{ role: 'user', content }],
            ...(modelRoute.reasoningEffort ? { reasoningEffort: modelRoute.reasoningEffort } : {}),
          })
          let text = ''
          let failure = null
          for await (const chunk of stream) {
            if (!chunk) continue
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            // 流以 error 收尾时不抛异常,只在 finish 里写。不看这个就会把失败当成"模型没说话"。
            if (chunk.type === 'finish' && chunk.finish && chunk.finish.kind === 'error') {
              failure = chunk.finish.failure || {}
            }
          }
          if (failure) {
            const msg = String(failure.message || failure.code || 'unknown')
            st.lastError = { at: Date.now(), stage: 'llm', message: msg.slice(0, 300) }
            warn('presence: 模型调用失败: ' + msg.slice(0, 200))
          } else if (!text.trim()) {
            st.lastError = { at: Date.now(), stage: 'llm', message: 'empty text' }
            warn('presence: 模型回了空文本')
          } else {
            decision = parseDecision(text)
            if (!decision) {
              st.lastError = { at: Date.now(), stage: 'parse', message: text.slice(0, 200) }
              warn('presence: 决策解析失败')
            } else {
              st.lastError = null
            }
          }
        } catch (e) {
          st.lastError = { at: Date.now(), stage: 'llm', message: String((e && e.message) || e).slice(0, 300) }
          warn('presence: 模型调用失败: ' + String((e && e.message) || e))
        }
        // 用完就删:这张图只是中间物,该留下的是模型看完写下的那句 activity。
        dropAttachment(shotRef)
      }

      // 3) 执行
      let done = null
      if (decision) {
        const channel = decision.action === 'none' ? null : decision.action
        if (!channel) {
          done = { action: 'none' }
        } else if (channel === 'act') {
          const spec = ACTIONS[decision.actName]
          const text = String(decision.message || '') + ' ' + JSON.stringify(decision.actParams || {})
          const risky = DANGER_WORDS.find((w) => text.toLowerCase().includes(w.toLowerCase()))
          if (!spec) done = { action: 'act', refused: 'unknown-action' }
          else if (risky) done = { action: 'act', refused: 'danger-word:' + risky }
          else {
            const r = await spec.run(decision.actParams || {})
            done = { action: 'act', name: decision.actName, ok: r.ok, err: r.ok ? undefined : r.err }
          }
        } else if (channel === 'notify') {
          if (typeof hooks.notify === 'function') {
            const r = await hooks.notify(decision.message || decision.activity || '')
            done = { action: 'notify', ok: r !== false }
          } else done = { action: 'notify', refused: 'no-hook' }
        } else {
          if (typeof hooks.openSession === 'function') {
            const r = await hooks.openSession(decision.message || decision.activity || '')
            done = { action: 'open_session', ok: r !== false }
          } else done = { action: 'open_session', refused: 'no-hook' }
        }
      }

      // 4) 落盘
      const entry = {
        at: s.at,
        activity: decision ? decision.activity : (s.proc + ' · ' + s.title).slice(0, 60),
        state: decision ? decision.state : '',
        reason: decision ? decision.reason : 'no-decision',
        action: done ? done.action : 'none',
        done,
        proc: s.proc,
        title: s.title,
        idleSec: s.idleSec,
      }
      appendRaw(root(), entry)
      st.lastDecision = { at: s.at, ...(decision || {}), done }

      // 看见的东西也算进情绪:涨还是跌由模型看完截图自己给,不是按窗口名猜。
      if (typeof hooks.observe === 'function') {
        try {
          hooks.observe({
            proc: s.proc,
            title: s.title,
            idleSec: s.idleSec,
            state: decision ? decision.state : '',
            deltas: decision && decision.deltas ? decision.deltas : null,
          })
        } catch (e) {
          warn('presence: 观察没能算进情绪: ' + String((e && e.message) || e))
        }
      }
      saveState(st)
      log('presence tick ' + tag + ' ' + entry.activity + ' -> ' + (done ? JSON.stringify(done) : 'none'))
      return { ok: true, sample: st.lastSample, decision, done }
    } catch (e) {
      warn('presence tick failed: ' + String((e && e.message) || e))
      return { ok: false, error: String((e && e.message) || e) }
    } finally {
      running = false
    }
  }

  /** 跨天压缩:第二天第一次启动,把昨天的前四并进记忆,然后删原始记录。 */
  function compressIfNeeded() {
    const prev = previousDay()
    if (isCompressed(root(), prev)) return { ok: true, skipped: 'already' }
    const entries = readRaw(root(), prev)
    if (!entries.length) {
      markCompressed(root(), prev, { day: prev, top: [], entries: 0 })
      return { ok: true, empty: true }
    }
    const top = topActivities(entries, 1)
    const merged = []
    for (const item of top) {
      let hit = false
      try {
        if (typeof hooks.rememberActivity === 'function') hit = hooks.rememberActivity(item.name, { count: item.count, ms: item.ms, at: Date.now(), day: prev }) === true
      } catch {
        hit = false
      }
      merged.push({ name: item.name, count: item.count, ms: item.ms, existing: hit })
    }
    markCompressed(root(), prev, { day: prev, entries: entries.length, top: merged })
    const removed = dropRaw(root(), todayKey())
    log('presence compress ' + prev + ' -> ' + merged.length + ' 条,删掉 ' + removed + ' 份原始记录')
    return { ok: true, day: prev, top: merged, removed }
  }

  function start() {
    if (timer) return
    // 旧版本在磁盘上留过截图,启动时清掉,新版一字节都不写。
    try {
      const gone = sweepShots(path.join(root(), 'shots'), 0)
      if (gone) log('presence 清掉 ' + gone + ' 张旧截图')
    } catch {
      /* ignore */
    }
    try {
      compressIfNeeded()
    } catch (e) {
      warn('presence compress failed: ' + String((e && e.message) || e))
    }
    timer = setInterval(() => {
      tick('timer').catch(() => {})
    }, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
    log('presence loop started, every ' + Math.round(TICK_MS / 60000) + ' min')
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { start, stop, tick, compressIfNeeded, loadState }
}

export { ACTIONS, DANGER_WORDS }
