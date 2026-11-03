/**
 * 后台活动执行器。
 *
 * 注意:当前不在默认路径上。活动的真实执行由 webactivity.js 完成。
 * 原因(2026-10-27 实测):ctx.agents.create() 不指定 agent preset 时,
 * 新建的 agent 只继承根作用域的插件,而网络工具挂在 agent preset 的作用域里,
 * 所以活动 agent 只能看到日程、生活记忆、文件读写 —— 拿不到 web_search / web_fetch。
 * 它自己的报告是「没有浏览器,没有网络请求,也没有可以抓取网页正文的通道」。
 * DSH 的 headless 也是这个写法,所以这是那条范式的固有局限,不是笔误。
 *
 * 保留此文件:导出 createUserMessage;若将来配上带 web 工具的 preset,
 * 这条路径可直接复用,executed 的判定口径仍有效(tools/test_execution_gate.mjs)。
 *
 * 舰长的要求:"这些活动不是虚拟的而是使用程序能真实执行的,比如刷B站视频、
 * 搜索感兴趣的游戏、看书(从网上下载)、逛网店、看电影"。
 *
 * 实现路径(照抄 dsh-headless/lib/index.js:317-356 的官方范式):
 *   ctx.agents.create() -> agent.followup(userMessage) -> await agent.whenIdle()
 *
 * 后台 agent 拥有全套工具:web_search / web_fetch / read / write / bash / pwsh。
 * 所以"下载一本书"是真的把文件写到磁盘,"逛网店"是真的抓取商品页。
 *
 * 重要限制(已核实):DSH **没有浏览器自动化**(asar 内无 playwright/puppeteer),
 * 只有 HTTP 能力。所以"看视频"是抓取视频页的标题/简介/评论,
 * "看电影"是抓取影评/剧情/字幕 —— 都是真实网络活动,不是编造,但不是播放。
 *
 * 另外一个关键点:活动 agent 会短暂出现在会话列表里。
 * 已核实:ctx.agents.create 会触发 agent/created -> api-session/added,
 * 而 DSH 的 ApiSessionList.list() 不过滤 origin —— 会话列表**没有隐藏开关**。
 * 所以只能做到"活动结束立刻 dispose",列表里是短暂出现再消失。
 */

import { randomUUID } from 'node:crypto'

/** 构造一条 user 角色消息(与 DSH 内部 createUserMessage 同构)。 */
export function createUserMessage(input) {
  return Object.freeze(
    structuredClone({ ...input, role: 'user', id: randomUUID() }),
  )
}

/**
 * 实时观察 agent 的产出。
 *
 * 用 live 事件流 `session/event` 而不是同步读事件日志:
 * dsh-session 的 ownEvents() / snapshot() 都带
 * "Existing logic may remain unmigrated for now, but new calls are prohibited"
 * 的弃用标注,新代码不应再用。
 *
 * 事件类型(取自 dsh-session 的 KNOWN_SESSION_EVENT_TYPES):
 *   turn/start · assistant/message · tool/call · tool/result · turn/end
 */
function observeAgent(ctx, agent) {
  const state = { text: '', toolCalls: 0, bytesRead: 0, calls: [], urls: [], errors: 0, okTools: 0 }
  const dispose = ctx.on('session/event', (session, event) => {
    if (session !== agent.session || !event) return
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? []
      const joined = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') state.text = joined
    }
    if (event.type === 'tool/call') {
      state.toolCalls++
      const name = String(event.data?.name ?? 'unknown')
      const args = event.data?.arguments ?? {}
      const summary = summarizeToolArgs(name, args)
      state.calls.push({ name, args: summary })
      const url = argOf(args, ['url', 'uri', 'link'])
      if (url) state.urls.push(url)
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message
      if (message?.isError) {
        state.errors++
      } else {
        state.okTools++
        // 只有成功的结果才算"读到了内容"。错误响应也带一段文字,
        // 若一起计入 bytesRead,会让"工具全部失败"被误判成执行成功。
        try {
          if (message) state.bytesRead += JSON.stringify(message.content ?? message).length
        } catch {
          /* ignore */
        }
      }
    }
  })
  return { state, dispose }
}

/** 从工具参数对象里取第一个存在的字符串字段。 */
function argOf(args, keys) {
  if (!args || typeof args !== 'object') return undefined
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * 把一次工具调用压成可读的一行,用来写进数据库。
 *
 * 只取最有信息量的那一两个参数:URL、查询词、路径、命令。
 * 目的是让"真实发生了什么"在库里留得下证据,而不是只留一句总结。
 */
function summarizeToolArgs(name, args) {
  const pick = {
    web_fetch: ['url'],
    web_search: ['query', 'queries'],
    read: ['file_path', 'path'],
    write: ['file_path', 'path'],
    glob: ['pattern'],
    grep: ['pattern'],
    pwsh: ['command', 'description'],
    bash: ['command', 'description'],
  }[name]
  const keys = pick ?? ['url', 'query', 'file_path', 'path', 'pattern', 'command']
  const value = argOf(args, keys)
  if (typeof value === 'string') return value.slice(0, 300)
  if (Array.isArray(value)) return value.slice(0, 3).join(' | ').slice(0, 300)
  try {
    return JSON.stringify(args ?? {}).slice(0, 200)
  } catch {
    return ''
  }
}

/**
 * 执行一个活动。
 *
 * @param ctx 插件上下文
 * @param route 模型选择
 * @param input { task, cwd, workDir, timeoutMs }
 * @returns {Promise<{ ok, output, toolCalls, bytesRead, error? }>}
 */
export async function executeActivity(ctx, route, input) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, output: '', toolCalls: 0, bytesRead: 0, error: 'agents service unavailable' }
  }

  const sessionId = `life-${randomUUID()}`
  const agentOptions = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
  }

  let created
  try {
    created = await agents.create({
      sessionId,
      meta: { cwd: input.cwd ?? process.cwd() },
      agentOptions,
    })
  } catch (e) {
    return { ok: false, output: '', toolCalls: 0, bytesRead: 0, error: String((e && e.message) || e) }
  }

  const agent = created.agent
  const observer = observeAgent(ctx, agent)

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), input.timeoutMs ?? 10 * 60_000)

  try {
    agent.followup(
      createUserMessage({
        content: [
          {
            type: 'text',
            text: [
              input.task,
              '',
              '执行完成后,用一段话总结你实际做了什么:访问了哪些页面、下载了什么、看到了什么。',
              '不要编造没有真正执行的动作。',
            ].join('\n'),
          },
        ],
        source: { kind: 'plugin:dsh-plugin-life' },
      }),
    )

    await agent.whenIdle()

    // 什么算"真的执行了":
    //   至少有一次工具调用**成功**。
    // 只说话不动手不算执行过(那只是复述写手的任务);
    // 工具全部报错也不算(什么也没拿到)。这两种情况都不该进数据库。
    const s = observer.state
    const reallyExecuted = s.okTools > 0

    return {
      ok: true,
      executed: reallyExecuted,
      output: s.text,
      toolCalls: s.toolCalls,
      okTools: s.okTools,
      failedTools: s.errors,
      bytesRead: s.bytesRead,
      calls: s.calls,
      urls: [...new Set(s.urls)].slice(0, 10),
    }
  } catch (e) {
    return { ok: false, executed: false, output: '', toolCalls: 0, bytesRead: 0, error: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
    observer.dispose?.()
    try {
      await created.dispose?.()
    } catch {
      /* ignore */
    }
  }
}
