/**
 * 嵌入服务的桥。
 *
 * 一个常驻子进程(tts0 环境里的 python),模型只加载一次。
 * JS 这边只负责:发一行 JSON、收一行 JSON、把 base64 解成 Float32Array。
 *
 * 三条设计约束:
 *
 * 1. **永远不阻塞对话**。加载要 4 秒,第一次嵌入要等它好。
 *    所以 warm() 只在后台踢一脚,embed() 在没就绪时直接放弃 ——
 *    调用方(判定)必须能接受"这一轮没有向量"并退化成只靠规则。
 *
 * 2. **崩了不重试到死**。子进程挂掉就把状态标记为 dead,
 *    之后一段时间不再拉起;过一段时间允许再试一次。
 *    否则每轮都会拉一次 python、失败一次,把机器拖垮。
 *
 * 3. **显式超时**。请求 3 秒没回就当这一轮失败,
 *    不能因为一个卡住的子进程把整轮对话拖死。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 默认的 tts0 环境。舰长指定的就是它 —— 里面有 torch + transformers。 */
const DEFAULT_PYTHON = 'E:\\anaconda\\envs\\tts0\\python.exe'
/** 失败后多久允许再试一次。 */
const REVIVE_MS = 10 * 60 * 1000
/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 3000

export function createEmbedBridge(options = {}) {
  const log = options.log ?? (() => {})
  const scriptPath = options.scriptPath
  const modelDir = options.modelDir
  const pythonPath = options.pythonPath || process.env.CAPTAIN_PYTHON || DEFAULT_PYTHON

  let child = null
  let ready = false
  let deadUntil = 0
  let starting = false
  let seq = 0
  const waiting = new Map() // id -> {resolve, reject, timer, expectVectors}
  let buffered = ''
  let stderrTail = ''

  function failAll(reason) {
    for (const [, w] of waiting) {
      clearTimeout(w.timer)
      w.reject(new Error(reason))
    }
    waiting.clear()
  }

  function shutdown(reason) {
    ready = false
    starting = false
    if (child) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      child = null
    }
    failAll(reason)
  }

  function onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id === 0) {
      if (msg.ready) {
        ready = true
        log('captain/embed: 就绪,维度 ' + msg.dim)
      } else if (msg.error) {
        log('captain/embed: 启动失败 ' + msg.error)
        deadUntil = Date.now() + REVIVE_MS
        shutdown('start-failed')
      }
      return
    }
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    clearTimeout(w.timer)
    if (msg.error) {
      w.reject(new Error(msg.error))
      return
    }
    try {
      w.resolve((msg.vectors ?? []).map((b64) => b64ToFloat32(b64)))
    } catch (e) {
      w.reject(e)
    }
  }

  function b64ToFloat32(b64) {
    const buf = Buffer.from(b64, 'base64')
    const out = new Float32Array(buf.byteLength / 4)
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
    return out
  }

  function start() {
    if (child || starting || Date.now() < deadUntil) return
    if (!existsSync(scriptPath) || !existsSync(pythonPath)) {
      log('captain/embed: 缺脚本或 python,放弃')
      deadUntil = Date.now() + REVIVE_MS
      return
    }
    starting = true
    try {
      child = spawn(pythonPath, ['-u', scriptPath, modelDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      starting = false
      deadUntil = Date.now() + REVIVE_MS
      log('captain/embed: spawn 失败 ' + String(e?.message ?? e))
      return
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      let idx
      while ((idx = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, idx).trim()
        buffered = buffered.slice(idx + 1)
        if (line) onLine(line)
      }
    })

    // 不要因为子进程还活着就把宿主卡住。
    //
    // 用 unref 之后:DSH 正常退出时不会等这个 python;
    // 宿主一退,stdin 管道断开,python 那边的 `for line in sys.stdin` 结束,
    // 它自己就退出了 —— 不需要谁去 kill 它。
    // (没有这一句,杀掉 node 之后 python 会变成孤儿进程。)
    child.unref()
    child.stdout.unref?.()
    child.stdin.unref?.()

    // stderr 只留最后几行:python 那边加载模型时会刷一堆无关的 warning,
    // 但真出错的时候这几行是唯一的线索。
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-800)
    })
    child.stderr.unref?.()

    child.on('error', (e) => {
      log('captain/embed: 子进程错误 ' + String(e?.message ?? e))
      deadUntil = Date.now() + REVIVE_MS
      shutdown('spawn-error')
    })

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        log('captain/embed: 子进程退出 ' + code + (stderrTail ? ' / ' + stderrTail.trim().slice(-300) : ''))
        deadUntil = Date.now() + REVIVE_MS
      }
      shutdown('exited')
    })

    starting = false
  }

  /** 后台预热,不等结果。 */
  function warm() {
    start()
  }

  /** 有没有可能用 —— 只是提示,不保证 embed() 一定成功。 */
  function isUsable() {
    return ready || (!child && Date.now() >= deadUntil)
  }

  /**
   * 求一批句子的向量。
   *
   * 没就绪、失败、超时都返回 null —— 调用方必须能接受 null。
   * 这里不抛异常,因为判定那一步宁可退化也不该打断对话。
   */
  function embed(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return Promise.resolve([])
    if (!ready) {
      warm()
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      const id = ++seq
      const timer = setTimeout(() => {
        waiting.delete(id)
        resolve(null)
      }, REQUEST_TIMEOUT_MS)
      waiting.set(id, {
        resolve,
        reject: () => resolve(null),
        timer,
      })
      try {
        child.stdin.write(JSON.stringify({ id, texts }) + '\n')
      } catch {
        clearTimeout(timer)
        waiting.delete(id)
        resolve(null)
      }
    })
  }

  function dispose() {
    shutdown('dispose')
  }

  return { warm, embed, isUsable, dispose, isReady: () => ready }
}
