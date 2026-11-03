/**
 * 站点适配器:对已知站点走它们的结构化接口,而不是硬扒 HTML。
 *
 * 为什么需要:抓 arXiv 的 /list/ 页面只能拿到一串论文编号 —— 那是**目录**,
 * 不是内容。真正的标题和摘要在 arXiv 的 Atom API 里,一次请求就能拿全。
 * B 站的页面同样只有一堆 JS 壳,标题/简介/字幕在它自己的 API 里。
 *
 * 每个适配器统一返回:
 *   { url, title, text, status, bytes, chars, kind, via }
 * 失败返回 null,交给调用方回退到普通 HTTP 抓取。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36 dsh-plugin-life/0.1'

const TIMEOUT_MS = 20_000

async function get(url, fetchImpl, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text, bytes: Buffer.byteLength(text, 'utf8'), url: res.url || url }
  } catch (e) {
    return { ok: false, status: 0, text: '', bytes: 0, url, error: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 粗暴的 XML 字段取值。 */
function xmlTag(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) : ''
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function makePage(fields) {
  const text = String(fields.text ?? '')
  return {
    url: fields.url,
    requestedUrl: fields.url,
    host: (() => {
      try {
        return new URL(fields.url).hostname
      } catch {
        return fields.url
      }
    })(),
    status: fields.status ?? 200,
    kind: fields.kind ?? 'api',
    bytes: Buffer.byteLength(text, 'utf8'),
    title: fields.title ?? '',
    excerpt: text.slice(0, 1500),
    fullText: text.slice(0, 200_000),
    chars: text.length,
    truncated: false,
    ms: fields.ms ?? 0,
    via: fields.via,
  }
}

// ---------- arXiv ----------

/** 从 abs/pdf 链接里取 arXiv id。 */
export function arxivIdOf(url) {
  const m = String(url).match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}|[a-z-]+\/[0-9]{7})(?:v\d+)?/i)
  return m ? m[1] : ''
}

/**
 * 用 arXiv 官方 Atom API 检索,返回**标题 + 摘要原文**。
 * 这比抓 /list/ 页面有用得多:后者只有编号。
 */
export async function arxivSearch(query, { fetchImpl = globalThis.fetch, max = 5 } = {}) {
  const started = Date.now()
  const cleaned = String(query)
    .replace(/arxiv(\.org)?/gi, ' ')
    .replace(/[^\p{L}\p{N}\s.-]+/gu, ' ')
    .trim()
  const url =
    'http://export.arxiv.org/api/query?search_query=' +
    encodeURIComponent('all:' + (cleaned || 'artificial life')) +
    '&sortBy=submittedDate&sortOrder=descending&max_results=' + Math.max(1, Math.min(10, max))

  const r = await get(url, fetchImpl)
  if (!r.ok || !r.text.includes('<entry')) return null

  const entries = [...r.text.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => m[1])
  if (!entries.length) return null

  const lines = [`arXiv 检索:${cleaned || 'artificial life'}`, '']
  for (const e of entries) {
    const title = xmlTag(e, 'title')
    const summary = xmlTag(e, 'summary')
    const id = xmlTag(e, 'id')
    const published = xmlTag(e, 'published').slice(0, 10)
    const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((m) => decodeEntities(m[1].trim()))
    lines.push(`## ${title}`, `<${id}>`, `${published} · ${authors.slice(0, 4).join(', ')}`, '', summary, '')
  }
  return makePage({
    url: 'https://arxiv.org/',
    title: `arXiv 检索结果:${cleaned}`,
    text: lines.join('\n'),
    kind: 'api:arxiv-search',
    via: 'arxiv-api',
    ms: Date.now() - started,
  })
}

/** 单篇论文:用 abs 页面的元信息 + 摘要。 */
async function arxivPaper(url, fetchImpl) {
  const id = arxivIdOf(url)
  if (!id) return null
  const started = Date.now()
  const api =
    'http://export.arxiv.org/api/query?id_list=' + encodeURIComponent(id)
  const r = await get(api, fetchImpl)
  if (!r.ok || !r.text.includes('<entry')) return null
  const entry = (r.text.match(/<entry>([\s\S]*?)<\/entry>/i) || [])[1] ?? ''
  const title = xmlTag(entry, 'title')
  const summary = xmlTag(entry, 'summary')
  if (!title && !summary) return null
  const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((m) => decodeEntities(m[1].trim()))
  return makePage({
    url: 'https://arxiv.org/abs/' + id,
    title,
    text: [`# ${title}`, '', `arXiv:${id}`, authors.slice(0, 6).join(', '), '', summary].join('\n'),
    kind: 'api:arxiv-paper',
    via: 'arxiv-api',
    ms: Date.now() - started,
  })
}

// ---------- Bilibili ----------

function bvidOf(url) {
  const m = String(url).match(/(BV[0-9A-Za-z]{10})/)
  return m ? m[1] : ''
}

/**
 * B 站视频:官方 API 拿标题/简介/分P/字幕列表。
 * 页面 HTML 只是个空壳,不这么做什么也拿不到。
 */
async function bilibiliVideo(url, fetchImpl) {
  const bvid = bvidOf(url)
  if (!bvid) return null
  const started = Date.now()
  const headers = { referer: 'https://www.bilibili.com/', 'accept-language': 'zh-CN,zh;q=0.9' }
  const view = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, fetchImpl, headers)
  if (!view.ok) return null
  let json
  try {
    json = JSON.parse(view.text)
  } catch {
    return null
  }
  if (!json || json.code !== 0 || !json.data) return null
  const d = json.data
  const lines = [
    `# ${d.title}`,
    '',
    `UP 主:${d.owner?.name ?? '未知'}`,
    `时长:${Math.round((d.duration ?? 0) / 60)} 分钟 · 播放 ${d.stat?.view ?? 0} · 弹幕 ${d.stat?.danmaku ?? 0}`,
    `发布:${d.pubdate ? new Date(d.pubdate * 1000).toLocaleString('zh-CN', { hour12: false }) : '未知'}`,
    '',
    '简介:',
    String(d.desc ?? '(无)'),
  ]

  // 字幕:有就取,没有就说明没有
  try {
    const cid = d.pages?.[0]?.cid
    if (cid) {
      const sub = await get(
        `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`,
        fetchImpl,
        headers,
      )
      const sj = JSON.parse(sub.text)
      const subtitles = sj?.data?.subtitle?.subtitles ?? []
      if (subtitles.length) {
        lines.push('', '字幕:')
        const first = subtitles[0]
        const subUrl = first.subtitle_url?.startsWith('//') ? 'https:' + first.subtitle_url : first.subtitle_url
        const body = await get(subUrl, fetchImpl, headers)
        const sjson = JSON.parse(body.text)
        const items = sjson?.body ?? []
        const merged = items.map((x) => String(x.content ?? '')).join(' ')
        lines.push(`(${first.lan_doc ?? first.lan ?? 'unknown'},${items.length} 条)`, '', merged.slice(0, 120_000))
      } else {
        lines.push('', '字幕:该视频没有可用字幕。')
      }
    }
  } catch {
    lines.push('', '字幕:获取失败。')
  }

  return makePage({
    url: `https://www.bilibili.com/video/${bvid}`,
    title: d.title,
    text: lines.join('\n'),
    kind: 'api:bilibili',
    via: 'bilibili-api',
    ms: Date.now() - started,
  })
}

// ---------- Wikipedia ----------

async function wikipediaPage(url, fetchImpl) {
  const m = String(url).match(/^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/i)
  if (!m) return null
  const lang = m[1]
  const title = decodeURIComponent(m[2].split('#')[0])
  const started = Date.now()
  const api =
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=` +
    encodeURIComponent(title)
  const r = await get(api, fetchImpl)
  if (!r.ok) return null
  try {
    const j = JSON.parse(r.text)
    const pages = j?.query?.pages ?? {}
    const first = Object.values(pages)[0]
    const extract = first?.extract
    if (!extract) return null
    return makePage({
      url,
      title: first.title || title,
      text: extract,
      kind: 'api:wikipedia',
      via: 'wikipedia-api',
      ms: Date.now() - started,
    })
  } catch {
    return null
  }
}

// ---------- GitHub ----------

async function githubRepo(url, fetchImpl) {
  const m = String(url).match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i)
  if (!m) return null
  const [, owner, repo] = m
  const started = Date.now()
  const headers = { accept: 'application/vnd.github+json' }
  const meta = await get(`https://api.github.com/repos/${owner}/${repo}`, fetchImpl, headers)
  if (!meta.ok) return null
  let j
  try {
    j = JSON.parse(meta.text)
  } catch {
    return null
  }
  const readme = await get(`https://api.github.com/repos/${owner}/${repo}/readme`, fetchImpl, {
    ...headers,
    accept: 'application/vnd.github.raw',
  })
  const body = readme.ok ? readme.text.slice(0, 120_000) : ''
  const lines = [
    `# ${j.full_name}`,
    '',
    String(j.description ?? ''),
    '',
    `stars ${j.stargazers_count ?? 0} · forks ${j.forks_count ?? 0} · 语言 ${j.language ?? '未知'}`,
    j.license?.name ? `许可:${j.license.name}` : '',
    '',
    body ? 'README:' : '(没有 README)',
    '',
    body,
  ].filter(Boolean)
  return makePage({
    url: `https://github.com/${owner}/${repo}`,
    title: j.full_name,
    text: lines.join('\n'),
    kind: 'api:github',
    via: 'github-api',
    ms: Date.now() - started,
  })
}

// ---------- 调度 ----------

/**
 * 尝试用适配器取一个 URL。
 * @returns {Promise<object|null>} 取不到返回 null,调用方回退普通抓取
 */
export async function tryAdapter(url, { fetchImpl = globalThis.fetch } = {}) {
  const u = String(url)
  try {
    // 写手有时会自己拼出 arXiv 的 API 查询地址。识别出来就走官方解析,
    // 否则会把一段 Atom XML 当成网页正文,标题变成 "arXiv Query: search_query=…"。
    const apiQuery = u.match(/export\.arxiv\.org\/api\/query\?[^#]*search_query=([^&]+)/i)
    if (apiQuery) {
      const q = decodeURIComponent(apiQuery[1])
        .replace(/^\s*all:/i, '')
        .replace(/\+/g, ' ')
        .replace(/"/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return await arxivSearch(q, { fetchImpl, max: 6 })
    }
    if (/arxiv\.org\/(abs|pdf)\//i.test(u)) return await arxivPaper(u, fetchImpl)
    if (/bilibili\.com\/video\//i.test(u) || bvidOf(u)) return await bilibiliVideo(u, fetchImpl)
    if (/^https?:\/\/[a-z-]+\.wikipedia\.org\/wiki\//i.test(u)) return await wikipediaPage(u, fetchImpl)
    if (/^https?:\/\/github\.com\/[^/]+\/[^/#?]+/i.test(u)) return await githubRepo(u, fetchImpl)
  } catch {
    return null
  }
  return null
}

/** 有没有适配器能处理这个网址(给写手/日志用)。 */
export function adapterNameFor(url) {
  const u = String(url)
  if (/export\.arxiv\.org\/api\/query/i.test(u)) return 'arxiv-api-query'
  if (/arxiv\.org\/(abs|pdf)\//i.test(u)) return 'arxiv'
  if (/bilibili\.com\/video\//i.test(u) || bvidOf(u)) return 'bilibili'
  if (/^https?:\/\/[a-z-]+\.wikipedia\.org\/wiki\//i.test(u)) return 'wikipedia'
  if (/^https?:\/\/github\.com\/[^/]+\/[^/#?]+/i.test(u)) return 'github'
  return ''
}
