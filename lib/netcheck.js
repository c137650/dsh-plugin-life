/**
 * 网络可用性探测。
 *
 * 为什么需要:
 *   没有网的时候,原来的流程会先花一次 LLM 调用去生成检索目标,
 *   然后抓取全部失败,白白烧掉 tokens,而且重试间隔是写死的 12 分钟,
 *   既不区分"没网"和"站点拦我",也不知道该退多远。
 *
 * 这里做的事很简单:用几个轻量端点判断"现在到底有没有网"。
 * 只要有一个回了状态码(哪怕是 404/403),就算有网 —— 那说明链路是通的,
 * 失败是站点层面的问题,不是断网。
 *
 * 结果缓存一小段时间,避免每次心跳都去探。
 */

const DEFAULT_ENDPOINTS = [
  'https://www.bing.com/',
  'https://api.github.com/',
  'https://www.baidu.com/',
]

const PROBE_TIMEOUT_MS = 6_000

/** 缓存:避免每分钟都探测。 */
let cache = { at: 0, online: null, endpoint: null, ms: null }

/**
 * @param opts { fetchImpl, endpoints, timeoutMs, force }
 * @returns {Promise<{online: boolean, endpoint: string|null, ms: number|null, cachedAt: number|null, tried: number}>}
 */
export async function probeNetwork(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const endpoints = opts.endpoints ?? DEFAULT_ENDPOINTS
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  const ttlMs = opts.ttlMs ?? 60_000
  const now = Date.now()

  if (!opts.force && cache.online !== null && now - cache.at < ttlMs) {
    return { ...cache.result, cachedAt: cache.at }
  }

  let tried = 0
  for (const endpoint of endpoints) {
    tried++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    try {
      // 只要能拿到状态码就说明链路通 —— 哪怕站点返回 403。
      const res = await fetchImpl(endpoint, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 dsh-plugin-life/0.1' },
      })
      const result = { online: true, endpoint, ms: Date.now() - started, status: res?.status ?? 0, tried }
      cache = { at: now, online: true, result }
      return { ...result, cachedAt: null }
    } catch {
      /* 这个端点不通,试下一个 */
    } finally {
      clearTimeout(timer)
    }
  }

  const result = { online: false, endpoint: null, ms: null, status: 0, tried }
  cache = { at: now, online: false, result }
  return { ...result, cachedAt: null }
}

/** 清掉缓存(测试用)。 */
export function resetNetworkCache() {
  cache = { at: 0, online: null, result: null }
}
