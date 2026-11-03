/**
 * 模型解析:与主会话保持一致,推理等级一律 medium(若该模型支持)。
 *
 * 舰长的要求:"和主会话使用的模型一致就好了,推理等级一律选用 medium(如果可选)"。
 *
 * 实现要点(全部已核实):
 *  - provider / model 取自 ctx.agentDefaultModel.currentSelection(),
 *    它反映的是主会话当前的选择。
 *  - 推理等级通过 ctx.llm.resolveCallConfig() 做能力探测:
 *    该模型不支持 medium 时会抛 UNSUPPORTED_REASONING_EFFORT,
 *    此时退回该模型自己的默认等级,而不是让整条链路失败。
 *  - 覆盖 agentOptions.reasoningEffort 之所以有效,是因为
 *    dsh-agent-loop/lib/index.js:1184 是
 *      this.options.reasoningEffort ?? persistedReasoningEffort
 *    ——显式传入的值优先于会话里持久化的配置。
 *
 * 舰长补充的两条要求(2026-10-27):
 *   1. "如果主会话切换,后台也要切换,避免一个模型额度用尽而导致崩盘"
 *      -> 每次调用前都重新读 currentSelection(),**不缓存**。
 *         缓存的只是"选择"这个读操作的成本(2 秒),不是选择本身。
 *   2. "如果调用发现额度用尽就直接跳过所有使用 llm 的环节"
 *      -> 见下面的额度熔断器:一旦识别到额度类错误,关掉所有 LLM 入口,
 *         只保留不需要 LLM 的部分(作息 FSM、追赶、压缩、挂载)。
 *         冷却后自动重试;主会话一换模型立刻重新尝试。
 */

const DESIRED_EFFORT = 'medium'

/** 选择缓存的存活时间 —— 足够便宜,又足够灵敏。 */
const SELECTION_TTL_MS = 2_000

/** 额度熔断的冷却时间。到点后放行一次试探。 */
const QUOTA_COOLDOWN_MS = 10 * 60_000

/** 额度/限流类错误的识别模式。 */
const QUOTA_PATTERNS = [
  /quota/i,
  /insufficient/i,
  /balance/i,
  /credit/i,
  /rate.?limit/i,
  /\b429\b/,
  /too many requests/i,
  /exceeded.*(budget|limit|allowance)/i,
  /payment required/i,
  /\b402\b/,
  /额度/,
  /配额/,
  /余额/,
  /欠费/,
]

/**
 * 判断一个错误是不是"额度用尽/被限流"这一类。
 *
 * 这一类错误的特点是:**重试没有意义,但换模型有意义**。
 * 所以触发熔断后,主会话换模型就会立刻重新放行。
 */
export function isQuotaError(error) {
  if (!error) return false
  const parts = [
    typeof error === 'string' ? error : '',
    error.message,
    error.code,
    error.type,
    error.status,
    error.statusCode,
    error.cause?.message,
    error.detail,
  ]
  const text = parts.filter((p) => p !== undefined && p !== null).map(String).join(' ')
  if (!text) return false
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * 额度熔断器。
 *
 * 状态机:
 *   closed(正常) --识别到额度错误--> open(全关),记录当时的 route 签名
 *   open --冷却到期--> half-open:放行一次
 *   open --主会话换了模型--> 立刻 half-open(换模型等于换了额度池)
 *   half-open 成功 --> closed
 *   half-open 失败 --> 重新 open
 */
export function createQuotaBreaker() {
  let state = 'closed'
  let openedAt = 0
  let blockedSignature = ''

  const signatureOf = (route) => `${route?.provider ?? ''}/${route?.model ?? ''}`

  /** 现在能不能调用 LLM? */
  function allow(route) {
    if (state === 'closed') return true

    // 主会话换了模型 —— 额度池换了,立刻重试。
    if (blockedSignature && signatureOf(route) !== blockedSignature) {
      state = 'half-open'
      return true
    }
    if (Date.now() - openedAt >= QUOTA_COOLDOWN_MS) {
      state = 'half-open'
      return true
    }
    return false
  }

  /** 报告一次成功。 */
  function noteSuccess() {
    if (state === 'half-open') state = 'closed'
  }

  /** 报告一次失败。返回 true 表示这次失败触发了熔断。 */
  function noteError(error, route) {
    if (!isQuotaError(error)) return false
    const wasOpen = state === 'open'
    state = 'open'
    openedAt = Date.now()
    blockedSignature = signatureOf(route)
    return !wasOpen || blockedSignature !== signatureOf(route)
  }

  function status() {
    return { state, openedAt, blockedSignature }
  }

  return { allow, noteSuccess, noteError, status }
}

/** 上一次解析结果的缓存(只缓存读操作,不缓存选择本身的意义)。 */
let cache = { at: 0, route: undefined }

/**
 * 解析主会话的模型选择,并尽量把推理等级调整到 medium。
 *
 * **每次调用都重新读** currentSelection(),所以主会话切换模型后,
 * 后台最多 2 秒就会跟上。
 *
 * @param ctx 插件上下文
 * @param options { force } 跳过缓存
 * @returns {Promise<{provider, model, reasoningEffort?, source}>}
 */
export async function resolveModel(ctx, options = {}) {
  if (!options.force && cache.route && Date.now() - cache.at < SELECTION_TTL_MS) {
    return cache.route
  }

  const fallback = { provider: '', model: '', source: 'none' }

  let selection
  try {
    selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  } catch {
    selection = undefined
  }
  if (!selection || !selection.provider || !selection.model) {
    // 主会话没有可用选择时,退回到已注册的第一个 provider 的第一个模型。
    const providers = ctx.get('llm')?.listProviders?.() ?? []
    for (const provider of providers) {
      const models = provider.models ?? []
      if (models.length) {
        selection = { provider: provider.id ?? provider, model: models[0].id }
        break
      }
    }
  }
  if (!selection || !selection.provider || !selection.model) return fallback

  const route = { provider: selection.provider, model: selection.model }
  const effort = await resolveEffort(ctx, route)
  const resolved = { ...route, ...(effort ? { reasoningEffort: effort } : {}), source: 'agentDefaultModel' }
  cache = { at: Date.now(), route: resolved }
  return resolved
}

/** 清掉缓存(主会话切模型时用)。 */
export function invalidateModelCache() {
  cache = { at: 0, route: undefined }
}

/**
 * 探测该模型支持哪些推理等级,并选出 medium(若支持)。
 *
 * @returns {Promise<string|undefined>} 推理等级 id;模型完全不支持时返回 undefined
 */
export async function resolveEffort(ctx, route) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.resolveCallConfig !== 'function') return undefined

  // 先探测 medium 是否被支持。
  try {
    const resolved = await llm.resolveCallConfig({ ...route, reasoningEffort: DESIRED_EFFORT })
    return resolved?.reasoningEffort ?? DESIRED_EFFORT
  } catch {
    // 不支持 medium:退回该模型自己的默认等级。
    try {
      const resolved = await llm.resolveCallConfig({ ...route })
      return resolved?.reasoningEffort
    } catch {
      return undefined
    }
  }
}

/**
 * 构造 ctx.llm.stream 需要的 options。
 *
 * 注意:这条路径绕过了系统提示词装配、工具调度和审批策略,
 * 只用于"写手"这种一次性结构化生成。
 * 真正需要工具的活动走 executor.js 的后台 agent。
 */
export function llmOptions(route, messages, extra = {}) {
  return {
    provider: route.provider,
    model: route.model,
    messages,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    ...extra,
  }
}

/**
 * 消费一次 llm.stream,返回拼接后的文本。
 *
 * chunk 协议(已核实 dsh-llm/lib/index.js:1273):
 *   { type: 'text-delta', index, text }
 */
export async function collectText(stream) {
  let text = ''
  for await (const chunk of stream) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    }
  }
  return text
}

/**
 * 走熔断器的一次文本生成。
 *
 * 所有需要 LLM 的地方都从这里过 —— 这样"额度用尽就跳过所有 LLM 环节"
 * 只需要在一个地方保证,而不是每个调用点各写一遍。
 *
 * @returns {Promise<{ok: true, text: string, stats} | {ok: false, skipped?: boolean, error?: string, quota?: boolean}>}
 */
export async function callText(ctx, route, messages, extra = {}, breaker) {
  if (breaker && !breaker.allow(route)) {
    return { ok: false, skipped: true, error: 'quota breaker open' }
  }

  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: 'llm service unavailable' }
  }

  try {
    const stream = llm.stream(llmOptions(route, messages, extra))
    const { text, stats } = await collectTextDetailed(stream)
    // 流以 error 收尾时不能当成"空回答":
    // 那会把平台错误伪装成"模型没说话",排查方向会被带偏整整一轮。
    if (stats?.finish?.kind === 'error') {
      const failure = stats.finish.failure
      return {
        ok: false,
        error: 'stream failed: ' + String((failure && (failure.message || failure.code)) || 'unknown'),
        stats,
      }
    }
    breaker?.noteSuccess()
    return { ok: true, text, stats }
  } catch (e) {
    const quota = breaker ? breaker.noteError(e, route) : isQuotaError(e)
    return {
      ok: false,
      quota: isQuotaError(e),
      error: String((e && e.message) || e),
    }
  }
}

/**
 * 比 collectText 多收集诊断信息。
 *
 * 为什么需要:升级序列出现"有 reasoning 但没有正文"的空回答,
 * 而只看 text 无法区分是 token 被推理吃光、是流被中断、还是模型就是没说话。
 * 把这些记下来,下一次就不用再猜。
 */
export async function collectTextDetailed(stream) {
  let text = ''
  let reasoning = ''
  let finish
  const chunkTypes = {}

  for await (const chunk of stream) {
    if (!chunk || typeof chunk.type !== 'string') continue
    chunkTypes[chunk.type] = (chunkTypes[chunk.type] ?? 0) + 1
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason ?? chunk.finishReason ?? chunk
    else if (chunk.type === 'usage') chunkTypes.__usage = chunk
  }

  return {
    text,
    stats: {
      reasoningChars: reasoning.length,
      finish: finish === undefined ? null : finish,
      chunkTypes,
      blocks: chunkTypes['block-start'] ?? 0,
    },
  }
}
