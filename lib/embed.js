/**
 * 嵌入服务的桥。
 *
 * 一个常驻子进程(tts0 环境里的 python),模型只加载一次。
 * JS 这边只负责:发一行 JSON、收一行 JSON、把 base64 解成 Float32Array。
 *
 * **两个地方共用它**:
 *   - captain/  跨会话记忆:判重、检测"你又提到这件事了"
 *   - index.js  活动去重:判断"这次想做的事是不是刚刚做过"
 * 所以它住在 lib/ 而不是 captain/ 里 —— 它不是记忆的子模块。
 *
 * 三条设计约束:
 *
 * 1. **永远不阻塞主流程**。加载要 4 秒,第一次嵌入要等它好。
 *    所以 warm() 只在后台踢一脚,embed() 在没就绪时直接返回 null ——
 *    调用方必须能接受"这次没有向量"并退化。
 *
 * 2. **崩了不重试到死**。子进程挂掉就把状态标记为 dead,
 *    之后一段时间不再拉起;过一段时间允许再试一次。
 *    否则每轮都会拉一次 python、失败一次,把机器拖垮。
 *
 * 3. **显式超时**。请求 3 秒没回就当这次失败,
 *    不能因为一个卡住的子进程把整台机器拖慢。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 默认的 tts0 环境。里面有 torch + transformers。 */
const DEFAULT_PYTHON = 'E:\\anaconda\\envs\\tts0\\python.exe'
/** 失败后多久允许再试一次。 */
const REVIVE_MS = 10 * 60 * 1000
/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 3000

/**
 * 找一个能用的模型目录。
 *
 * 顺序:显式配置 -> 数据目录下的副本 -> modelscope 缓存。
 * 全都找不到就返回空串,服务会报告 model-dir-missing,
 * 调用方退化成"没有向量"—— 功能打折,但不会失效。
 */
export function pickModelDir(explicit, dataDir) {
  const candidates = [
    explicit,
    dataDir ? path.join(dataDir, 'models', 'bge-small-zh-v1.5') : undefined,
    'C:\\Users\\34230\\.cache\\modelscope\\AI-ModelScope\\bge-small-zh-v1___5',
  ]
  for (const c of candidates) {
    if (!c) continue
    try {
      if (existsSync(c) && existsSync(path.join(c, 'config.json'))) return c
    } catch {
      /* ignore */
    }
  }
  return ''
}

/**
 * 余弦相似度。
 *
 * 两个向量都已经 L2 归一化过,所以内积就是余弦 —— 不用再除模长。
 * 维度对不上就返回 -1(当作"完全不像"),不要悄悄返回 0 ——
 * 0 在相似度里是个有意义的中间值,用错会让人查错方向。
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

export function createEmbedBridge(options = {}) {  const log = options.log ?? (() => {})
  const scriptPath = options.scriptPath || path.join(HERE, 'embed_server.py')
  const modelDir = options.modelDir ?? pickModelDir(undefined, options.dataDir)
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
      // 服务端出错了 —— 必须喊出来。
      //
      // 以前这里是静默 reject,调用方只看到"没有向量",于是判重悄悄失效,
      // 相似的事件全都入库,而日志里什么都没有。
      // 嵌入失败是这个系统最重要的故障,不能没有声音。
      log('captain/embed: 请求失败 ' + msg.error)
      w.reject(new Error(msg.error))
      return
    }
    try {
      w.resolve((msg.vectors ?? []).map((b64) => b64ToFloat32(b64)))
    } catch (e) {
      log('captain/embed: 向量解码失败 ' + String(e?.message ?? e))
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
        // 钉死 UTF-8。
        //
        // Windows 上 python 的 stdin/stdout 默认走系统 ANSI 代码页(这台机器是 gbk),
        // 而这边发的是 UTF-8 字节 —— 中文被读坏,某些字节组合还会产生孤立代理字符,
        // Rust 分词器直接拒绝,每次都回 error。
        // 服务端里也有同样的处理(reconfigure),这里是双保险。
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
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

    child.on('exit', (code, signal) => {
      // 退出码是 0 也要记一笔。
      //
      // 之前只在 code !== 0 时记,结果"子进程安静地退了"这一种最难查的情况
      // 完全不留痕迹 —— 表现为向量永远是空的,判重从不生效。
      log(
        'captain/embed: 子进程退出 code=' + code + ' signal=' + signal +
          (stderrTail ? ' / ' + stderrTail.trim().slice(-300) : ''),
      )
      if (code !== 0 && code !== null) {
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
