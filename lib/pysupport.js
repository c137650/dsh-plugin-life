/**
 * Python 桥:让插件借用本机已有的 Python 生态补齐三件事。
 *
 *   PDF    —— pdfplumber / PyMuPDF(fitz) 抽正文(论文原文在这里)
 *   渲染   —— Playwright 过需要 JavaScript 的页面(知乎这类直接 403 的)
 *   视频   —— yt-dlp 取公开视频的标题/简介/字幕
 *
 * 为什么不自己实现:DSH 只给了 HTTP,没有 PDF 解析、没有 JS 引擎、没有视频协议栈。
 * 本机已经装了全套(requests/bs4/playwright/pdfplumber/fitz/yt_dlp),ffmpeg 也在 PATH,
 * 直接借比重新实现现实。
 *
 * 风险与对策:
 *   - DSH 若是从图形界面启动,进程的 PATH 里可能没有 python。
 *     所以启动时做一次自检,把结果写进 status.json;探不到就整块降级,
 *     普通 HTTP 抓取照常,不会因此崩。
 *   - 每次调用都是独立进程 + 超时;脚本写到临时文件再跑,避免引号转义地狱。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 60_000

/** 探测结果缓存。 */
let env = null

/** 跑一段 Python,返回 stdout/stderr。 */
function runPython(exe, scriptPath, args = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, ['-X', 'utf8', scriptPath, ...args], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: '', error: String((e && e.message) || e) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, stdout, stderr, error: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)

    child.stdout?.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (e) => finish({ ok: false, stdout, stderr, error: String(e.message || e) }))
    child.on('close', (code) => finish({ ok: code === 0, stdout, stderr, code }))
  })
}

/** 把脚本写到临时文件执行,执行完删掉。 */
async function runScript(exe, body, args, timeoutMs) {
  let dir
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'dsh-life-py-'))
    const file = path.join(dir, 'run.py')
    writeFileSync(file, body, 'utf8')
    return await runPython(exe, file, args, timeoutMs)
  } catch (e) {
    return { ok: false, stdout: '', stderr: '', error: String((e && e.message) || e) }
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

/** 从输出里找最后一行 JSON。 */
function lastJson(stdout) {
  const lines = String(stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      /* 继续往前找 */
    }
  }
  return undefined
}

/**
 * 探测本机 Python 与所需库。只跑一次,结果缓存。
 * @returns {Promise<{ok, exe, version, caps, error?}>}
 */
export async function detectPython(options = {}) {
  if (env && !options.force) return env

  const probe = `
import json, sys
caps = {}
def has(m):
    try:
        __import__(m); return True
    except Exception:
        return False
caps["pdf"] = has("fitz") or has("pdfplumber")
caps["pdf_engine"] = "fitz" if has("fitz") else ("pdfplumber" if has("pdfplumber") else "")
caps["playwright"] = has("playwright")
caps["ytdlp"] = has("yt_dlp")
print(json.dumps({"ok": True, "version": sys.version.split()[0], "caps": caps}))
`
  const candidates = options.candidates ?? ['python', 'python3', 'py']
  for (const exe of candidates) {
    const r = await runScript(exe, probe, [], 20_000)
    const j = lastJson(r.stdout)
    if (j && j.ok) {
      env = { ok: true, exe, version: j.version, caps: j.caps }
      return env
    }
  }
  env = { ok: false, exe: null, version: null, caps: { pdf: false, playwright: false, ytdlp: false }, error: 'no usable python found' }
  return env
}

/** 清缓存(测试用)。 */
export function resetPythonEnv() {
  env = null
}

const PDF_SCRIPT = `
import json, sys, os, tempfile
target = sys.argv[1]
is_url = target.lower().startswith("http")
path = target
tmp = None
out = {"ok": False}
try:
    if is_url:
        import requests
        r = requests.get(target, timeout=60, headers={
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
            "accept": "application/pdf,*/*",
        })
        if r.status_code >= 400:
            print(json.dumps({"ok": False, "error": "download http %d" % r.status_code}))
            sys.exit(0)
        fd, tmp = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        with open(tmp, "wb") as fh:
            fh.write(r.content)
        path = tmp
        out["downloadBytes"] = len(r.content)

    text = None
    try:
        import fitz
        doc = fitz.open(path)
        parts = []
        for i, page in enumerate(doc):
            if i >= 80:
                break
            parts.append(page.get_text())
        text = "\\n".join(parts)
        out.update({"ok": True, "engine": "pymupdf", "pages": min(len(doc), 80)})
    except Exception as e:
        try:
            import pdfplumber
            parts = []
            with pdfplumber.open(path) as pdf:
                for i, page in enumerate(pdf.pages):
                    if i >= 80:
                        break
                    parts.append(page.extract_text() or "")
            text = "\\n".join(parts)
            out.update({"ok": True, "engine": "pdfplumber", "pages": len(parts)})
        except Exception as e2:
            out = {"ok": False, "error": "fitz: %s; pdfplumber: %s" % (e, e2)}

    if out.get("ok") and text is not None:
        out["text"] = text
except Exception as e:
    out = {"ok": False, "error": str(e)[:400]}
finally:
    if tmp:
        try:
            os.remove(tmp)
        except Exception:
            pass
print(json.dumps(out))
`

/**
 * 从 PDF 抽正文。target 可以是本地路径,也可以是 http(s) 网址。
 *
 * 网址这一路交给 Python 的 requests 下载,不用 Node 的 fetch ——
 * 实测 Node fetch 到 arxiv.org/pdf 会超时,而同一时刻 curl 一秒就下来了。
 * 让下载和解析待在同一个进程里,少一跳、少一处失败点。
 *
 * @returns {Promise<{ok, engine?, pages?, text?, downloadBytes?, error?}>}
 */
export async function extractPdfText(target, options = {}) {
  const e = await detectPython()
  if (!e.ok || !e.caps.pdf) return { ok: false, error: 'pdf capability unavailable' }
  const r = await runScript(e.exe, PDF_SCRIPT, [target], options.timeoutMs ?? 120_000)
  const j = lastJson(r.stdout)
  if (!j) return { ok: false, error: 'pdf extraction produced no output: ' + String(r.stderr).slice(0, 200) }
  if (j.ok && typeof j.text === 'string') j.text = j.text.slice(0, 400_000)
  return j
}

/** 从网址抓 PDF 并抽正文。 */
export async function pdfFromUrl(url, options = {}) {
  return extractPdfText(url, options)
}

const RENDER_SCRIPT = `
import json, sys
url = sys.argv[1]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
out = {"ok": False}
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        pg = b.new_page(user_agent=UA, locale="zh-CN")
        pg.goto(url, wait_until="domcontentloaded", timeout=30000)
        pg.wait_for_timeout(2500)
        title = pg.title()
        text = pg.inner_text("body")
        b.close()
    out = {"ok": True, "title": title, "text": text}
except Exception as e:
    out = {"ok": False, "error": str(e)[:400]}
print(json.dumps(out))
`

/**
 * 用无头浏览器渲染一个页面,拿渲染后的正文。
 * 用于需要 JavaScript 的站点(直连 HTML 只有空壳)。
 */
export async function renderWithPlaywright(url, options = {}) {
  const e = await detectPython()
  if (!e.ok || !e.caps.playwright) return { ok: false, error: 'playwright unavailable' }
  const r = await runScript(e.exe, RENDER_SCRIPT, [url], options.timeoutMs ?? 75_000)
  const j = lastJson(r.stdout)
  if (!j) return { ok: false, error: 'render produced no output: ' + String(r.stderr).slice(0, 200) }
  if (j.ok && typeof j.text === 'string') j.text = j.text.slice(0, 400_000)
  return j
}

const VIDEO_SCRIPT = `
import json, sys, os, glob
url = sys.argv[1]
workdir = sys.argv[2]
out = {"ok": False}
try:
    import yt_dlp
    opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["zh-Hans", "zh-CN", "zh", "en"],
        "subtitlesformat": "vtt",
        "outtmpl": os.path.join(workdir, "%(id)s.%(ext)s"),
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)

    subs = []
    for f in glob.glob(os.path.join(workdir, "*.vtt")):
        with open(f, "r", encoding="utf-8", errors="replace") as fh:
            subs.append(fh.read())

    def vtt_to_text(vtt):
        lines = []
        for line in vtt.splitlines():
            s = line.strip()
            if not s or s == "WEBVTT" or "-->" in s or s.isdigit():
                continue
            if s.startswith("NOTE") or s.startswith("Kind:") or s.startswith("Language:"):
                continue
            lines.append(s)
        seen, dedup = None, []
        for s in lines:
            if s != seen:
                dedup.append(s)
                seen = s
        return " ".join(dedup)

    text = "\\n\\n".join(vtt_to_text(v)[:200000] for v in subs)
    out = {
        "ok": True,
        "title": info.get("title") or "",
        "uploader": info.get("uploader") or "",
        "duration": info.get("duration") or 0,
        "description": (info.get("description") or "")[:4000],
        "subtitles": text[:200000],
        "subtitleFiles": len(subs),
    }
except Exception as e:
    out = {"ok": False, "error": str(e)[:400]}
print(json.dumps(out))
`

/**
 * 取公开视频的元信息与字幕。
 * 需要 yt-dlp;没有字幕时 ok 仍为 true,但 subtitles 为空。
 */
export async function videoSubtitles(url, options = {}) {
  const e = await detectPython()
  if (!e.ok || !e.caps.ytdlp) return { ok: false, error: 'yt-dlp unavailable' }
  let dir
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'dsh-life-video-'))
    const r = await runScript(e.exe, VIDEO_SCRIPT, [url, dir], options.timeoutMs ?? 120_000)
    const j = lastJson(r.stdout)
    if (!j) return { ok: false, error: 'video probe produced no output: ' + String(r.stderr).slice(0, 200) }
    return j
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

/** 环境是否支持某一档能力。 */
export async function capability(name) {
  const e = await detectPython()
  if (!e.ok) return false
  return Boolean(e.caps?.[name])
}
