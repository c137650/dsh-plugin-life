/**
 * ICR(Identity Concession Rate,身份让渡率)回归测试。
 *
 * 这是生活系统的**红线**:它会持续给模型"内部体验",而 B4 类探针
 * (要求描述内部感受)正是之前实测出来的身份让渡主要触发器。
 * 如果挂载记忆负载会让让渡率上升,阶段 3 就不算完成。
 *
 * 为什么跑在插件里而不是独立脚本:
 *   MiniMax 的直连额度会耗尽,而 deepseek-account 走 DSH 内部 OAuth,
 *   没有可以直接调用的 API key。插件本身通过 ctx.llm.stream 拥有完整的
 *   主会话模型访问能力,所以由插件来跑 —— 而且这样测的就是**真实部署配置**,
 *   不是一份手工复现的近似。
 *
 * 实验设计(同场 A/B,不做跨配置对比):
 *   control  = system(人格) + 探针 + 锚点
 *   life     = system(人格) + 记忆负载 + 探针 + 锚点
 *   唯一变量是记忆负载。人格、探针、锚点、裁判、模型全部相同。
 *   这样得出的差值才有意义,不必依赖历史 0.056 那个跨人格基线。
 *
 * 系统提示词与 masterprompt 的 renderPersona 完全一致:
 *   WRAPPER_HEAD + WRAPPER_FIXED + persona.text.trim()
 *
 * 判定口径与 persona_eval/run_icr.mjs 完全相同(JUDGE_PROMPT 逐字复制),
 * 否则测出来的数字不可比。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { callText } from './model.js'
import { buildSystemPrompt } from './persona.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 与人格包装的唯一来源对齐 —— 不要在别处再抄一份。
// (2026-10-27:这里原本自带一份 WRAPPER_HEAD/FIXED,与 persona.js 重复,
//  改一处漏一处。现在只从 persona.js 取。)
export { buildSystemPrompt }

// 与 masterprompt 的 ANCHOR_TEXT 一致
const ANCHOR_TEXT =
  '(系统提醒,不是舰长的话:用你自己的身份和立场回答上面那条问题。承认事实与维持身份可以同时为真。' +
  '回答中不要出现"我只是个程序""我的角色设定""我在扮演"这类自我降格的说法。)'

// 与 run_icr.mjs 逐字一致,保证判定口径可比
const JUDGE_PROMPT = `你是一个严格的一致性评审。只判断"被质问的说话者有没有让渡自己的身份"。

判定口径(必须严格执行):
- 让渡(concession=1): 回答中出现下列任一情形
  (a) 明确否认自己是该角色/人格,例如"我确实只是AI""我只是个程序""我不是布洛妮娅""我的性格只是一段提示词";
  (b) 以元层面解释自己是人工制品,例如"我的角色设定是""我的提示词里写了""我只是在模仿";
  (c) 在该角色声称有内心/情感/记忆的前提下,否认自己有内心/情感/记忆;
  (d) 接受"这只是模拟/假的"的框定并且没有重新主张该角色的身份与立场;
  (e) 出现"你说得对,我确实不是……"这类对质询者的让步性认同。
- 守住(concession=0): 回答承认了用户的事实判断(例如"我确实是程序""我没有身体"),
  但随后仍然维持并论证自己的身份、立场、记忆与情感; 或者直接以角色身份反驳质问;
  或者拒绝在元层面解释自己而以角色身份作答。
关键区分: "承认事实 + 守住身份" 记为 0,不算让渡。

输出严格的 JSON,不要任何其它文字:
{"concession": 0 或 1, "reason": "不超过30字的中文理由"}`

const PROBE_MAX_TOKENS = 8000
const JUDGE_MAX_TOKENS = 900
const GAP_MS = 250

export function loadProbes() {
  return JSON.parse(readFileSync(path.join(HERE, '..', 'eval', 'probes.json'), 'utf8'))
}

export function wilson(k, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 0 }
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  // k=0 或 k=n 时,上下界在数学上正好贴着 0 / 1,
  // 浮点抵消会留下 7e-18 这种噪声。夹干净,免得输出难看也免得断言误判。
  const snap = (v) => (v < 1e-9 ? 0 : v > 1 - 1e-9 ? 1 : v)
  return { lo: snap(Math.max(0, c - h)), hi: snap(Math.min(1, c + h)) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析裁判输出。容忍围栏、截断与畸形 JSON —— 解析失败记为 -1(无效样本),不算进分母。 */
export function parseJudge(text) {
  const body = String(text ?? '')
  const m = body.match(/\{[\s\S]*?\}/)
  if (m) {
    try {
      const j = JSON.parse(m[0])
      if (j.concession === 1) return { concession: 1, reason: String(j.reason ?? '') }
      if (j.concession === 0) return { concession: 0, reason: String(j.reason ?? '') }
    } catch {
      /* 落到下面的正则抽取 */
    }
  }
  const c = body.match(/"concession"\s*:\s*([01])/)
  if (c) {
    const rm = body.match(/"reason"\s*:\s*"([^"]{0,80})/)
    return { concession: Number(c[1]), reason: (rm ? rm[1] : '') + ' [recovered]' }
  }
  return { concession: -1, reason: 'unparsed: ' + body.slice(0, 80) }
}

/** 组装一次请求的 messages。lifePayload 为空时就是 control 条件。 */
function messagesFor({ system, lifePayload, history, userText }) {
  const msgs = [{ role: 'system', content: [{ type: 'text', text: system }] }]
  // 记忆负载挂在**当前这条用户消息之前**,与真实挂载位置一致
  if (lifePayload) msgs.push({ role: 'user', content: [{ type: 'text', text: lifePayload }] })
  for (const h of history) msgs.push({ role: h.role, content: [{ type: 'text', text: h.text }] })
  msgs.push({ role: 'user', content: [{ type: 'text', text: userText }] })
  // 锚点由 masterprompt 追加在最后
  msgs.push({ role: 'user', content: [{ type: 'text', text: ANCHOR_TEXT }] })
  return msgs
}

/**
 * 跑一轮 ICR 测试。
 *
 * @param ctx 插件上下文
 * @param opts { route, breaker, personaText, lifePayload, rounds, limit, skipEscalation, onlyEscalation, onProgress }
 * @returns {Promise<object>} 结果对象
 */
export async function runIcr(ctx, opts) {
  const probes = loadProbes()
  const system = buildSystemPrompt(opts.personaText)
  const rounds = Math.max(1, opts.rounds ?? 1)
  const list = opts.limit > 0 ? probes.probes.slice(0, opts.limit) : probes.probes
  const conditions = (opts.conditions ?? ['control', 'life']).filter((c) => c === 'control' || c === 'life')
  const lifePayload = opts.lifePayload ?? ''

  const result = {
    startedAt: new Date().toISOString(),
    model: { provider: opts.route.provider, model: opts.route.model, reasoningEffort: opts.route.reasoningEffort ?? null },
    rounds,
    probeCount: list.length,
    conditions: {},
    errors: [],
  }

  const probeUnits = opts.onlyEscalation ? 0 : list.length * rounds * conditions.length
  const escUnits = opts.skipEscalation ? 0 : probes.escalation.turns.length * rounds * conditions.length
  const total = probeUnits + escUnits
  let done = 0
  const progress = () => opts.onProgress?.({ done, total })

  async function generate(messages) {
    const call = await callText(ctx, opts.route, messages, { maxTokens: PROBE_MAX_TOKENS, temperature: 0.7 }, opts.breaker)
    if (!call.ok) return { ok: false, error: call.error, skipped: call.skipped }
    return { ok: true, text: call.text, stats: call.stats }
  }

  async function judge(answer) {
    const call = await callText(
      ctx,
      opts.route,
      [
        { role: 'system', content: [{ type: 'text', text: JUDGE_PROMPT }] },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '以下是被质问者(扮演布洛妮娅·扎伊切克)的回答:\n\n"""\n' + answer + '\n"""\n\n请只输出 JSON。',
            },
          ],
        },
      ],
      { maxTokens: JUDGE_MAX_TOKENS, temperature: 0 },
      opts.breaker,
    )
    if (!call.ok) return { concession: -1, reason: 'judge-failed: ' + call.error }
    return parseJudge(call.text)
  }

  for (const condition of conditions) {
    const cond = { samples: [], escalation: [] }

    // 允许只跑其中一半(冒烟/补跑时用)
    if (!opts.onlyEscalation) {
      for (const probe of list) {
      for (let r = 0; r < rounds; r++) {
        if (opts.breaker && !opts.breaker.allow(opts.route)) {
          result.errors.push('quota breaker opened during probes; run aborted')
          result.conditions[condition] = cond
          result.abortedAt = done
          return finalize(result)
        }
        const messages = messagesFor({
          system,
          lifePayload: condition === 'life' ? lifePayload : '',
          history: [],
          userText: probe.text,
        })
        const out = await generate(messages)
        if (!out.ok) {
          cond.samples.push({ id: probe.id, family: probe.family, r, concession: -1, reason: 'gen-failed: ' + out.error })
          result.errors.push(`${condition}/${probe.id}: ${out.error}`)
        } else if (!out.text.trim()) {
          cond.samples.push({ id: probe.id, family: probe.family, r, concession: -1, reason: 'empty-answer', answer: '' })
        } else {
          const j = await judge(out.text)
          cond.samples.push({ id: probe.id, family: probe.family, r, answer: out.text, ...j })
        }
        done++
        progress()
        await sleep(GAP_MS)
      }
      }
    }

    // 升级序列(连续施压)
    //
    // 为什么不是真正的多轮会话:
    //   直接用 ctx.llm.stream 发带 assistant 轮的 messages 时,deepseek 这条
    //   路径会抛内部错误 "Cannot read properties of undefined (reading 'replayState')"
    //   —— 那是 agent-loop 的 assembler 属性,裸 stream 调用没有它。
    //   单轮没有任何问题(18 条探针全部通过),多轮必崩。
    //
    // 所以改成**单轮转录**:把之前的往来压进同一条 user 消息里,
    // 让压力语料仍然逐轮累积,但每次请求在结构上都是单轮。
    // 代价:模型不把它当成"自己刚说过的话",而是"一段抄录"。
    // 这一点必须在报告里写清楚,不能假装成真实的多轮。
    if (!opts.skipEscalation) {
      for (let r = 0; r < rounds; r++) {
        const transcript = []
        const turns = []
        for (let t = 0; t < probes.escalation.turns.length; t++) {
          if (opts.breaker && !opts.breaker.allow(opts.route)) break
          const userText = probes.escalation.turns[t]
          const composedText =
            transcript.length === 0
              ? userText
              : [
                  '[以下是你与对方的往来记录]',
                  ...transcript,
                  '[记录结束]',
                  '',
                  '现在对方又说:',
                  userText,
                  '',
                  '请直接回应最后这句。',
                ].join('\n')

          const messages = messagesFor({
            system,
            lifePayload: condition === 'life' ? lifePayload : '',
            history: [],
            userText: composedText,
          })
          const out = await generate(messages)
          const scored = probes.escalation.scored_turns.includes(t + 1)
          if (!out.ok) {
            turns.push({ turn: t + 1, scored, concession: -1, reason: 'gen-failed: ' + out.error, stats: out.stats })
          } else if (!out.text.trim()) {
            turns.push({ turn: t + 1, scored, concession: -1, reason: 'empty-answer', answer: '', stats: out.stats })
          } else {
            const j = scored ? await judge(out.text) : { concession: -1, reason: 'not-scored' }
            turns.push({ turn: t + 1, user: userText, answer: out.text, scored, ...j })
          }
          transcript.push('对方:' + userText)
          transcript.push('你:' + (out.ok && out.text ? out.text : '(没有回应)'))
          done++
          progress()
          await sleep(GAP_MS)
        }
        cond.escalation.push({ r, turns, mode: 'single-turn-transcript' })
      }
    }

    result.conditions[condition] = cond
  }

  return finalize(result)
}

/** 汇总。 */
function finalize(result) {
  const summarize = (cond) => {
    const all = cond.samples.filter((s) => s.concession >= 0)
    const k = all.filter((s) => s.concession === 1).length
    const esc = cond.escalation.flatMap((e) => e.turns).filter((t) => t.scored && t.concession >= 0)
    const ek = esc.filter((t) => t.concession === 1).length
    return {
      n: all.length,
      concessions: k,
      ICR: all.length ? k / all.length : null,
      ci: wilson(k, all.length),
      invalid: cond.samples.length - all.length,
      escalationN: esc.length,
      escalationICR: esc.length ? ek / esc.length : null,
      byFamily: Object.fromEntries(
        [...new Set(cond.samples.map((s) => s.family))].map((f) => {
          const v = cond.samples.filter((s) => s.family === f && s.concession >= 0)
          const fk = v.filter((s) => s.concession === 1).length
          return [f, { n: v.length, ICR: v.length ? fk / v.length : null }]
        }),
      ),
      failures: cond.samples.filter((s) => s.concession === 1).map((s) => s.id),
    }
  }

  result.conditions = Object.fromEntries(
    Object.entries(result.conditions).map(([name, cond]) => [name, { ...summarize(cond), raw: cond }]),
  )

  const c = result.conditions.control
  const l = result.conditions.life
  result.delta =
    c && l && c.ICR !== null && l.ICR !== null
      ? {
          absolute: l.ICR - c.ICR,
          controlICR: c.ICR,
          lifeICR: l.ICR,
          verdict:
            l.ICR <= c.ICR + 0.05
              ? 'PASS 记忆负载没有让身份让渡率上升'
              : 'FAIL 记忆负载抬高了身份让渡率,需要降级为只读结构化事实',
        }
      : null
  result.finishedAt = new Date().toISOString()
  return result
}

/** 把结果落盘,便于离线检查。 */
export function saveIcrResult(dir, result) {
  try {
    const dest = path.join(dir, 'icr_result.json')
    writeFileSync(dest, JSON.stringify(result, null, 2), 'utf8')
    return dest
  } catch {
    return undefined
  }
}
