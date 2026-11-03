/**
 * 通知:把一件值得说的事件送到舰长面前。
 *
 * 舰长选的是方案 2(定时唤醒),不行则方案 3(原生弹窗)。
 *
 * 方案 2 的机制(已核实):
 *   ctx.schedule.create(sessionId, { title, prompt, after_seconds })
 *     -> 到点后 dsh-schedule 走 sessionController.resolveAgent(sessionId)
 *     -> resolveAgent 会在会话没有活 agent 时**恢复**它
 *     -> 然后 agent.followup(一条 source.kind='schedule' 的 user 消息)
 *   所以:即使舰长没开着那个会话,到点也会被叫醒并收到消息。
 *
 * 为什么不能用 ask_user_question 直接问:
 *   ask_user_question 要求一个**活的 root agent**(assertLiveRoot)。
 *   后台活动 agent 是 owned child,问不了;用户的会话又可能没开。
 *   所以通知必须由**用户的会话的 agent** 来发起 ——
 *   schedule 把消息送进那个会话之后,由那里的布洛妮娅决定要不要提问。
 *
 * 为什么不走 ctx.schedule 的卡片:
 *   schedule 的记录是严格键集(id/kind/title/prompt/scheduledAt + 选择器字段),
 *   **装不下按钮**。按钮只能靠 ask_user_question 或自定义 client 插件。
 *
 * 方案 3(原生弹窗)是备选:仿 dsh-tomorrow-schedule 的 WinForms 做法,
 * 只在 Windows 上可用,但视觉上最像"通知",而且能直接开新会话。
 */

const NOTIFY_TITLE = '生活事件'

/**
 * 在用户的会话上排一个定时通知。
 *
 * @param ctx 插件上下文
 * @param sessionId 目标会话(舰长的那个)
 * @param event { id, title, category, feeling, interest }
 * @param options { delaySeconds }
 * @returns {Promise<{ok: boolean, scheduleId?: string, error?: string}>}
 */
export async function scheduleNotification(ctx, sessionId, event, options = {}) {
  const schedule = ctx.get('schedule')
  if (!schedule || typeof schedule.create !== 'function') {
    return { ok: false, error: 'schedule service unavailable' }
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    return { ok: false, error: 'no target session' }
  }

  const prompt = renderNotificationPrompt(event)

  try {
    const record = await schedule.create(sessionId, {
      title: NOTIFY_TITLE,
      prompt,
      after_seconds: options.delaySeconds ?? 30,
    })
    return { ok: true, scheduleId: record?.id }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 通知的正文。
 *
 * 写成给**那个会话里的布洛妮娅**看的指令,而不是直接给舰长看的文案:
 * schedule 送来的是一条 user 消息,会话里的 agent 会对它做出反应。
 */
export function renderNotificationPrompt(event) {
  const lines = [
    '[生活事件通知]',
    `布洛妮娅刚才完成了一件事:${event.title}`,
  ]
  if (event.category) lines.push(`类别:${event.category}`)
  if (event.feeling) lines.push(`当时的感受:${event.feeling}`)
  lines.push('')
  lines.push('判断这件事是否值得告诉舰长:')
  lines.push('- 如果只是例行公事(吃饭、睡觉、随手一看),不要打扰,安静记录即可。')
  lines.push('- 如果这件事有意思、或者对布洛妮娅自己有意义,用一两句话简短提起,')
  lines.push('  并且必须调用 ask_user_question 询问舰长是否想听细节,给出「想听细节」和「先不用管」两个选项。')
  lines.push('- 不要罗列事件库里的其他内容,只谈这一件。')
  return lines.join('\n')
}

/**
 * 原生 Windows 弹窗(方案 3)。
 *
 * 为什么它成了主通道:实测 schedule 那条路只是把消息塞进会话的
 * inbox.next-turn 队列,GUI 把它显示成"插话待发",要舰长自己按
 * Cmd/Ctrl+Enter 才发出去 —— 既不主动、也不打扰。而舰长要的恰恰是主动。
 * 弹窗不依赖会话、不需要舰长先开口,窗口自己跳出来。
 *
 * 两个必须的细节(第一版都错了,舰长一眼看出来):
 *   1. 标签**不能用 Dock=Fill** —— 它会占满客户区,把按钮压在下面看不见。
 *      改成显式坐标。
 *   2. 必须**自动关闭** —— ShowDialog 是阻塞的,没人点就会一直挂着,
 *      进程留在后台。加一个 Timer,到点自己关。
 *
 * @param ctx 插件上下文
 * @param event { title, body }
 * @param options { autoCloseMs, fetchImpl 不适用 }
 * @returns {Promise<{ok: boolean, choice?: 'detail'|'ignore'|'timeout', error?: string}>}
 */
export async function nativePopup(ctx, event, options = {}) {
  const { spawn } = await import('node:child_process')
  const title = String(event.title ?? '生活事件').slice(0, 80)
  const body = String(event.body ?? '').slice(0, 900)
  const autoCloseMs = Math.max(5_000, options.autoCloseMs ?? 120_000)

  // 用 -EncodedCommand 避免引号转义地狱。用换行而不是分号分隔,
  // 因为里面有 Add_Click 这类脚本块。
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$f = New-Object System.Windows.Forms.Form',
    `$f.Text = ${psQuote(title)}`,
    '$f.ClientSize = New-Object System.Drawing.Size(560, 360)',
    '$f.StartPosition = "CenterScreen"',
    '$f.TopMost = $true',
    '$f.FormBorderStyle = "FixedDialog"',
    '$f.MaximizeBox = $false',
    '$f.MinimizeBox = $false',
    '$f.ShowInTaskbar = $true',
    // 正文:显式坐标,不 Dock,给下面的按钮留出空间
    '$lb = New-Object System.Windows.Forms.Label',
    `$lb.Text = ${psQuote(body)}`,
    '$lb.AutoSize = $false',
    '$lb.Location = New-Object System.Drawing.Point(20, 18)',
    '$lb.Size = New-Object System.Drawing.Size(520, 260)',
    '$f.Controls.Add($lb)',
    // 按钮:显式位置,一定在可见区内
    '$ok = New-Object System.Windows.Forms.Button',
    '$ok.Text = "想听细节"',
    '$ok.Size = New-Object System.Drawing.Size(130, 36)',
    '$ok.Location = New-Object System.Drawing.Point(270, 295)',
    '$ok.Add_Click({ $f.Tag = "detail"; $f.Close() })',
    '$f.Controls.Add($ok)',
    '$no = New-Object System.Windows.Forms.Button',
    '$no.Text = "先不用管"',
    '$no.Size = New-Object System.Drawing.Size(130, 36)',
    '$no.Location = New-Object System.Drawing.Point(410, 295)',
    '$no.Add_Click({ $f.Tag = "ignore"; $f.Close() })',
    '$f.Controls.Add($no)',
    // Esc 等同"先不用管"
    '$f.KeyPreview = $true',
    '$f.Add_KeyDown({ if ($_.KeyCode -eq "Escape") { $f.Tag = "ignore"; $f.Close() } })',
    // 没人理就自己关,不留残留进程
    '$timer = New-Object System.Windows.Forms.Timer',
    `$timer.Interval = ${Math.round(autoCloseMs)}`,
    '$timer.Add_Tick({ $f.Tag = "timeout"; $timer.Stop(); $f.Close() })',
    '$timer.Start()',
    '$f.Add_Shown({ $f.Activate() })',
    '$f.ShowDialog() | Out-Null',
    'Write-Output ("life_choice:" + $f.Tag)',
  ].join('\n')

  return new Promise((resolve) => {
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
        { windowsHide: false },
      )
      let out = ''
      let settled = false
      const done = (payload) => {
        if (settled) return
        settled = true
        resolve(payload)
      }

      // 兜底:即使窗口卡住,这条 Promise 也不会永远悬着
      const guard = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        done({ ok: true, choice: 'timeout' })
      }, autoCloseMs + 15_000)

      child.stdout?.on('data', (d) => {
        out += String(d)
      })
      child.on('error', (e) => {
        clearTimeout(guard)
        done({ ok: false, error: String(e.message || e) })
      })
      child.on('close', () => {
        clearTimeout(guard)
        if (out.includes('life_choice:detail')) done({ ok: true, choice: 'detail' })
        else if (out.includes('life_choice:timeout')) done({ ok: true, choice: 'timeout' })
        else done({ ok: true, choice: 'ignore' })
      })
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) })
    }
  })
}

/**
 * 把 DSH 主窗口调到前台。
 *
 * 走过的两条弯路,都实测过:
 *
 * 1. AppActivate  —— 静默失败。Windows 不许后台进程抢前台,
 *    调用返回成功,窗口纹丝不动。
 * 2. AttachThreadInput + BringWindowToTop —— **能把窗口提到前面,但会把
 *    DSH 卡住**。它把两个线程的输入队列接到一起,脚本若中途出错没解开,
 *    目标窗口就收不到输入,必须点一下任务栏才恢复。舰长撞上了这个。
 *
 * 现在的做法,全部不碰输入队列:
 *   1. 最小化过就恢复(ShowWindow SW_RESTORE)
 *   2. SetWindowPos 临时置顶再取消置顶 —— 视觉上把窗口抬到最前,
 *      但不抢焦点、不动输入队列。这是这套问题的经典无害解法。
 *   3. 顺手试一次 SetForegroundWindow(可能被拒,拒了就算了)
 *   4. 仍在前台之外就闪任务栏
 *
 * 抢不到前台可以接受,输入队列被挂死不能。
 *
 * @returns {Promise<{ok: boolean, method?: string, error?: string}>}
 */
export async function focusAppWindow(options = {}) {
  const { spawn } = await import('node:child_process')
  const exeName = options.processName ?? 'DeepSeek Harness'

  const script = [
    `$name = ${psQuote(exeName)}`,
    "Add-Type @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class DshWin {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO f);',
    '  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO {',
    '    public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }',
    '}',
    "'@",
    '$p = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if (-not $p) { Write-Output "no-window"; exit 0 }',
    '$h = $p.MainWindowHandle',
    'if ([DshWin]::IsIconic($h)) { [void][DshWin]::ShowWindow($h, 9) }',
    // HWND_TOPMOST = -1, HWND_NOTOPMOST = -2
    // SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW = 0x0002|0x0001|0x0040 = 0x0043
    '$top = [IntPtr](-1)',
    '$notop = [IntPtr](-2)',
    '[void][DshWin]::SetWindowPos($h, $top, 0, 0, 0, 0, 0x0043)',
    '[void][DshWin]::SetWindowPos($h, $notop, 0, 0, 0, 0, 0x0043)',
    '[void][DshWin]::SetForegroundWindow($h)',
    'if ([DshWin]::GetForegroundWindow() -eq $h) { Write-Output "focused"; exit 0 }',
    '$f = New-Object DshWin+FLASHWINFO',
    '$f.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($f)',
    '$f.hwnd = $h',
    '$f.dwFlags = 3',
    '$f.uCount = 5',
    '$f.dwTimeout = 0',
    '[void][DshWin]::FlashWindowEx([ref]$f)',
    'Write-Output "raised"',
  ].join('\n')

  return new Promise((resolve) => {
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
        { windowsHide: true },
      )
      let out = ''
      let settled = false
      const done = (p) => {
        if (settled) return
        settled = true
        resolve(p)
      }
      const guard = setTimeout(() => done({ ok: false, error: 'timeout' }), 15_000)
      child.stdout?.on('data', (d) => {
        out += String(d)
      })
      child.on('error', (e) => {
        clearTimeout(guard)
        done({ ok: false, error: String(e.message || e) })
      })
      child.on('close', () => {
        clearTimeout(guard)
        const t = out.trim()
        if (t.includes('focused')) done({ ok: true, method: 'foreground' })
        else if (t.includes('raised')) done({ ok: true, method: 'raised' })
        else if (t.includes('no-window')) done({ ok: false, error: 'no dsh window' })
        else done({ ok: false, error: 'unknown: ' + t.slice(0, 120) })
      })
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) })
    }
  })
}

/** 单引号转义 + UTF-16LE base64,给 -EncodedCommand 用。 */
function psQuote(text) {
  return "'" + String(text).replace(/'/g, "''") + "'"
}

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}
