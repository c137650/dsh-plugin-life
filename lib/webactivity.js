/**
 * 真实网络活动。
 *
 * 为什么不是"派一个后台 agent 去做":
 *   实测发现后台 agent 拿不到网络工具。原因是工具挂在 **agent preset 的作用域**里,
 *   而 `ctx.agents.create()` 不指定 preset 时只继承根作用域的插件 ——
 *   活动 agent 能看到的只有:日程、生活记忆、文件读写。
 *   它自己也是这么报告的:「没有浏览器,没有网络请求,也没有可以抓取网页正文的通道」。
 *   DSH 的 headless 也是同样的写法(不传 preset),所以这不是笔误,是那条范式的局限。
 *
 * 所以改成:插件自己发请求。
 *   - 是真的发了 HTTP 请求、真的拿到了内容、真的落了盘
 *   - 不依赖 preset,不依赖 agent 有没有工具
 *   - 也不需要污染 GUI 的会话列表
 *
 * 检索走 `ctx.web.search`(tavily provider,唯一可用,实测正常):
 *   web.search({ query, maxResults }, signal)
 *     -> { content?, sources: [{ url, title?, snippet?, publishedAt? }], truncated }
 *
 * 但抓取**不走 web.fetch**,而是插件自己发 HTTP。原因:
 *   这个构建注册了两个 fetch provider(deepseek-fetch-api 与 http),
 *   而 web.fetch 内部要求"唯一可用 provider",于是直接抛:
 *     WEB_PROVIDER_AMBIGUOUS: multiple usable web providers are registered
 *       (deepseek-fetch-api, http); configure one explicitly
 *   实测连会话里的 web_fetch 工具都因此不可用。
 *   插件不该依赖一个需要全局配置才能工作的通道,也不该替舰长改全局设置,
 *   所以抓取换成 Node 自带的 fetch,自己控制 UA、超时与体积上限。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { localDateISO, localStamp } from './db.js'
import { tryAdapter, arxivSearch } from './adapters.js'
import { pdfFromUrl, renderWithPlaywright, videoSubtitles, detectPython } from './pysupport.js'

const DEFAULT_MAX_PAGES = 3
const FETCH_TIMEOUT_MS = 25_000
const FETCH_MAX_BYTES = 3_000_000
const EXCERPT_CHARS = 1500
/** 落盘保存的正文上限。以前只存 EXCERPT_CHARS,15421 字的页面丢掉九成,实质内容留不下来。 */
const SAVE_CHARS = 200_000

// 有些站点对默认 UA 直接 403,给一个普通的浏览器标识。
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36 dsh-plugin-life/0.1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 HTML 里粗暴抽正文:去脚本样式、去标签、压空白。 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 取 <title>。 */
export function titleOf(html) {
  const m = String(html ?? '').match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)
  return m ? htmlToText(m[1]).slice(0, 200) : ''
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function slugify(text, max = 48) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return slug || 'reading'
}

/**
 * 抓一个 URL。用 Node 自带的 fetch,不走 web.fetch(原因见文件头)。
 *
 * 非 2xx 是"结果"而不是异常 —— 拿到 404 也要记下来,那是真实发生的事。
 */
async function fetchOne(url, fetchImpl = globalThis.fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const started = Date.now()
    let referer
    try {
      referer = new URL(url).origin + '/'
    } catch {
      referer = undefined
    }

    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        // 有些站点(知乎等)对没有 referer 的直连直接 403。
        // 加了也不保证能过,但成本为零。
        ...(referer ? { referer } : {}),
      },
    })

    const contentType = String(res.headers.get('content-type') ?? '').toLowerCase()
    const isHtml = contentType.includes('html') || contentType.includes('xml')
    const declared = Number(res.headers.get('content-length') ?? 0)

    let truncated = false
    let raw = ''
    if (declared > FETCH_MAX_BYTES) {
      truncated = true
    } else {
      raw = await res.text()
      if (raw.length > FETCH_MAX_BYTES) {
        raw = raw.slice(0, FETCH_MAX_BYTES)
        truncated = true
      }
    }

    const text = isHtml ? htmlToText(raw) : String(raw)
    return {
      url: res.url || url,
      requestedUrl: url,
      host: hostOf(res.url || url),
      status: res.status,
      kind: isHtml ? 'html' : contentType || 'unknown',
      bytes: Buffer.byteLength(String(raw), 'utf8'),
      title: isHtml ? titleOf(raw) : '',
      // excerpt 喂提示词(有预算),fullText 只用于落盘 —— 两回事,不要混。
      excerpt: text.slice(0, EXCERPT_CHARS),
      fullText: text.slice(0, SAVE_CHARS),
      chars: text.length,
      truncated,
      ms: Date.now() - started,
    }
  } catch (e) {
    return {
      url,
      requestedUrl: url,
      host: hostOf(url),
      status: 0,
      error: String((e && e.message) || e),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 执行一次真实网络活动。
 *
 * @param ctx 插件上下文
 * @param opts { plan, maxPages, saveDir, dateISO, fetchImpl }
 * @returns {Promise<{ok, reason?, search?, pages, allPages?, totalBytes, savedFile?}>}
 */
export async function runWebActivity(ctx, opts) {
  // 抓取用 Node 自带 fetch,所以只需要 web.search 存在。
  const web = ctx.get('web')
  const canSearch = Boolean(web && typeof web.search === 'function')

  const plan = opts.plan ?? {}
  const maxPages = Math.max(1, Math.min(6, opts.maxPages ?? DEFAULT_MAX_PAGES))

  const givenUrls = Array.isArray(plan.urls) ? plan.urls.filter((u) => typeof u === 'string' && u.trim()) : []
  if (!canSearch && !givenUrls.length) {
    return {
      ok: false,
      reason: 'web search unavailable and no explicit urls (web service: ' + (web ? 'no search()' : 'missing') + ')',
      pages: [],
      totalBytes: 0,
    }
  }

  let search
  const urls = []

  // 1) 候选 URL:要么是计划里直接给的,要么先搜一次。
  if (givenUrls.length) {
    urls.push(...givenUrls.slice(0, maxPages))
  } else if (plan.searchQuery) {
    try {
      const result = await web.search({ query: plan.searchQuery, maxResults: maxPages * 2 })
      search = {
        query: plan.searchQuery,
        content: typeof result?.content === 'string' ? result.content.slice(0, 800) : '',
        sources: (result?.sources ?? []).map((s) => ({
          url: s.url,
          title: s.title ?? '',
          snippet: s.snippet ?? '',
        })),
      }
      // 候选要收得比目标多,否则"抓不到就试下一个"形同虚设 ——
      // 实测第一批全是知乎的 403,候选只有 3 个时就没有备选了。
      const wantCandidates = maxPages + 2
      for (const s of search.sources) {
        if (urls.length >= wantCandidates) break
        if (s.url) urls.push(s.url)
      }
    } catch (e) {
      return {
        ok: false,
        reason: 'search failed: ' + String((e && e.message) || e),
        pages: [],
        totalBytes: 0,
      }
    }
  }

  if (!urls.length) {
    return { ok: false, reason: 'no url to fetch', search, pages: [], totalBytes: 0 }
  }

  // Python 能力:PDF 抽取、无头浏览器渲染、视频字幕。
  // 探不到就整块降级,不影响普通抓取。
  const py = await detectPython().catch(() => ({ ok: false, caps: {} }))

  /**
   * 按"能拿到最多内容"的顺序取一个网址。
   *
   *   1. PDF           -> 交给 python 下载并抽正文(论文原文在这里)
   *   2. 已知站点       -> 走结构化接口(arXiv / B站 / GitHub)
   *   3. 普通 HTTP     -> 任意网址的默认路径
   *   4. 内容太薄      -> 用无头浏览器再渲染一次(知乎这类 JS 站)
   */
  async function fetchCandidate(url) {
    // 1) PDF
    const looksPdf = /\.pdf($|[?#])/i.test(url) || /arxiv\.org\/pdf\//i.test(url)
    if (looksPdf && py.ok && py.caps?.pdf) {
      const started = Date.now()
      const pdf = await pdfFromUrl(url)
      if (pdf.ok && (pdf.text ?? '').length > 200) {
        return {
          url,
          requestedUrl: url,
          host: hostOf(url),
          status: 200,
          kind: 'pdf',
          bytes: pdf.downloadBytes ?? Buffer.byteLength(String(pdf.text), 'utf8'),
          title: (String(pdf.text).match(/^(.{5,120})/m) || [''])[0].trim(),
          excerpt: String(pdf.text).slice(0, EXCERPT_CHARS),
          fullText: String(pdf.text).slice(0, SAVE_CHARS),
          chars: String(pdf.text).length,
          truncated: false,
          ms: Date.now() - started,
          via: `pdf:${pdf.engine}`,
        }
      }
    }

    // 2) 站点适配器
    const viaAdapter = await tryAdapter(url, { fetchImpl: opts.fetchImpl })
    if (viaAdapter && (viaAdapter.chars ?? 0) > 120) return viaAdapter

    // 3) 普通 HTTP
    let page = viaAdapter ?? (await fetchOne(url, opts.fetchImpl))

    // 视频站点:yt-dlp 能拿字幕就拿,拿不到再退回页面本身。
    // (B 站已由适配器覆盖;这里是别的站点的补充路线。)
    const looksVideo = /(youtube\.com\/watch|youtu\.be\/|vimeo\.com\/)/i.test(url)
    if (looksVideo && py.ok && py.caps?.ytdlp) {
      const v = await videoSubtitles(url).catch(() => ({ ok: false }))
      if (v.ok) {
        const body = [
          `# ${v.title}`,
          '',
          v.uploader ? `作者:${v.uploader}` : '',
          v.duration ? `时长:${Math.round(v.duration / 60)} 分钟` : '',
          '',
          v.description ? '简介:' + v.description : '',
          '',
          v.subtitles ? '字幕:' + v.subtitles : '(没有字幕)',
        ]
          .filter(Boolean)
          .join('\n')
        if (body.length > 200) {
          return {
            url,
            requestedUrl: url,
            host: hostOf(url),
            status: 200,
            kind: 'video',
            bytes: Buffer.byteLength(body, 'utf8'),
            title: v.title || hostOf(url),
            excerpt: body.slice(0, EXCERPT_CHARS),
            fullText: body.slice(0, SAVE_CHARS),
            chars: body.length,
            truncated: false,
            ms: 0,
            via: 'yt-dlp',
          }
        }
      }
    }

    // 4) 内容太薄(空壳页 / 403 / 反爬):用无头浏览器再试一次
    const tooThin = (page.chars ?? 0) < 120 || page.status === 403
    if (tooThin && py.ok && py.caps?.playwright) {
      const started = Date.now()
      const rendered = await renderWithPlaywright(url).catch(() => ({ ok: false }))
      if (rendered.ok && String(rendered.text ?? '').length > 200) {
        const text = String(rendered.text)
        return {
          url,
          requestedUrl: url,
          host: hostOf(url),
          status: 200,
          kind: 'html',
          bytes: Buffer.byteLength(text, 'utf8'),
          title: rendered.title || hostOf(url),
          excerpt: text.slice(0, EXCERPT_CHARS),
          fullText: text.slice(0, SAVE_CHARS),
          chars: text.length,
          truncated: false,
          ms: Date.now() - started,
          via: 'playwright',
        }
      }
    }

    return page
  }

  // 2) 逐个真的抓。
  //
  // 候选比目标多:有些站点从这台机器连不上,或者在反爬。
  // (实测 news.ycombinator.com 连 curl 都 20 秒超时;zhihu.com 一律 403。)
  // 死守第一个会白白浪费一次活动,所以按顺序试,凑够 wantPages 就停手。
  const wantPages = Math.max(1, Math.min(3, maxPages))
  const maxAttempts = Math.min(urls.length, wantPages + 2)
  const pages = []
  const good = []

  // 检索结果里出现 arXiv 链接时,直接用官方 API 取摘要原文。
  // 抓 /list/ 页面只能得到一串论文编号 —— 那是目录,不是内容。
  if (search?.sources?.some((s) => /arxiv\.org/i.test(String(s.url)))) {
    const paper = await arxivSearch(plan.searchQuery, { fetchImpl: opts.fetchImpl, max: 5 })
    if (paper) {
      pages.push(paper)
      good.push(paper)
    }
  }

  for (const url of urls.slice(0, maxAttempts)) {
    const page = await fetchCandidate(url)
    pages.push(page)
    if (page.status >= 200 && page.status < 300 && (page.chars ?? 0) > 120) {
      good.push(page)
      if (good.length >= wantPages) break
    }
    await sleep(200)
  }

  const totalBytes = pages.reduce((a, p) => a + (p.bytes ?? 0), 0)

  if (!good.length) {
    return {
      ok: false,
      reason: 'no page yielded usable content',
      search,
      // 契约:pages 只装**成功抓到内容**的页面。失败的放到 allPages,
      // 免得调用方把 404/403 当成一次真的读到了东西。
      pages: [],
      allPages: pages,
      totalBytes,
    }
  }

  // 3) 落一份真实产物:把读到的东西存成笔记,不是只留一个摘要。
  let savedFile
  if (opts.saveDir) {
    try {
      mkdirSync(opts.saveDir, { recursive: true })
      const name =
        `${opts.dateISO ?? localDateISO()}-` +
        `${slugify(good[0].title || plan.searchQuery || good[0].host)}.md`
      savedFile = path.join(opts.saveDir, name)
      const lines = [
        `# ${good[0].title || plan.searchQuery || good[0].host}`,
        '',
        `- 抓取时间:${localStamp()}`,
        plan.searchQuery ? `- 搜索词:${plan.searchQuery}` : '',
        `- 抓取页面:${good.length} 个,共 ${totalBytes} 字节`,
        `- 渠道:${plan.searchQuery ? 'tavily 搜索 -> 直接 HTTP 抓取' : '直接打开给定网址 -> 直接 HTTP 抓取'}`,
        pages.length > good.length
          ? `- 另有 ${pages.length - good.length} 个候选抓取失败:${pages
              .filter((p) => !good.includes(p))
              .map((p) => `${p.host}(${p.status || p.error || '?'})`)
              .join(', ')}`
          : '',
        '',
      ].filter(Boolean)
      for (const p of good) {
        // 存**正文全文**(上限 SAVE_CHARS),不是那 1500 字的摘录。
        // 以前只写 excerpt,15421 字的页面等于扔掉九成,实质内容留不下来。
        const body = p.fullText || p.excerpt || ''
        lines.push(
          `## ${p.title || p.host}`,
          '',
          `<${p.url}>`,
          `HTTP ${p.status} · ${p.chars} 字 · ${p.bytes} 字节`,
          '',
          body,
          '',
          '---',
          '',
        )
      }
      writeFileSync(savedFile, lines.join('\n'), 'utf8')
    } catch (e) {
      savedFile = undefined
      ctx.logger?.warn?.('dsh-plugin-life: save reading failed: ' + String((e && e.message) || e))
    }
  }

  return { ok: true, search, pages: good, allPages: pages, totalBytes, savedFile }
}

/** 把真实抓取结果压成给写手看的事实材料。 */
export function renderEvidence(result) {
  const lines = []
  if (result.search) {
    lines.push(`搜索词:${result.search.query}`)
    if (result.search.content) lines.push(`搜索摘要:${result.search.content.slice(0, 300)}`)
    if (result.search.sources?.length) {
      lines.push('搜索结果:')
      for (const s of result.search.sources.slice(0, 8)) {
        lines.push(`  - ${s.title || s.url} <${s.url}>${s.snippet ? ' — ' + s.snippet.slice(0, 120) : ''}`)
      }
    }
  }
  lines.push('实际打开的页面:')
  for (const p of result.pages) {
    lines.push(`  - [HTTP ${p.status}] ${p.title || p.host} <${p.url}> (${p.chars} 字, ${p.bytes} 字节)`)
    lines.push(`    正文摘录:${p.excerpt.replace(/\s+/g, ' ').slice(0, 700)}`)
  }
  if (result.savedFile) lines.push(`已保存到:${result.savedFile}`)
  return lines.join('\n')
}
