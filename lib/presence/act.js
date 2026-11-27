/**
 * 动手:三条通道各一个函数。
 *
 *   notify   发一条系统通知
 *   focus    把 DSH 弹到前台
 *   input    发键鼠事件(媒体键 / 点击 / 按键)
 *
 * 键鼠那块用 user32 的 SendInput 走 PowerShell。每次调用起一个 PowerShell 进程,
 * 三百毫秒上下,拿来做单个动作够用;要连续动作再换成常驻。
 * 所有动作都要先过硬闸:白名单、配额、危险目标拦截,闸在 index.js 里。
 */

import { execFile } from 'node:child_process'

function runPs(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: String(stdout || '').trim(), err: String(stderr || (error && error.message) || '').trim() })
      },
    )
  })
}

const INPUT_PS_HEAD = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Inp {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; public KEYBDINPUT ki; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    var a = new INPUT[2];
    a[0].type = 0; a[0].mi.dwFlags = 0x0002;
    a[1].type = 0; a[1].mi.dwFlags = 0x0004;
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Key(ushort vk) {
    var a = new INPUT[2];
    a[0].type = 1; a[0].ki.wVk = vk;
    a[1].type = 1; a[1].ki.wVk = vk; a[1].ki.dwFlags = 0x0002;
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
}
'@
`

/** 媒体键:暂停 / 继续。对浏览器视频和多数播放器都有效。 */
export async function mediaPlayPause() {
  return runPs(INPUT_PS_HEAD + '\n[Inp]::Key(0xB3); "ok"')
}

/** 点一下屏幕坐标。 */
export async function click(x, y) {
  const px = Math.round(Number(x))
  const py = Math.round(Number(y))
  if (!Number.isFinite(px) || !Number.isFinite(py)) return { ok: false, err: 'bad coords' }
  return runPs(INPUT_PS_HEAD + '\n[Inp]::Click(' + px + ',' + py + '); "ok"')
}

/** 按一个键。给的是虚拟键码,见白名单。 */
export async function key(vk) {
  const code = Number(vk)
  if (!Number.isFinite(code) || code <= 0 || code > 255) return { ok: false, err: 'bad vk' }
  return runPs(INPUT_PS_HEAD + '\n[Inp]::Key(' + Math.round(code) + '); "ok"')
}

/** 只把鼠标挪过去,不点。用来配合截图确认落点。 */
export async function move(x, y) {
  const px = Math.round(Number(x))
  const py = Math.round(Number(y))
  if (!Number.isFinite(px) || !Number.isFinite(py)) return { ok: false, err: 'bad coords' }
  return runPs(INPUT_PS_HEAD + '\n[Inp]::Move(' + px + ',' + py + '); "ok"')
}

/** 允许的动作名。模型只能从这里挑,挑不到的一律拒。 */
export const ACTIONS = {
  media_play_pause: { run: () => mediaPlayPause(), danger: 0 },
  click: { run: (p) => click(p && p.x, p && p.y), danger: 1 },
  key: { run: (p) => key(p && p.vk), danger: 1 },
  move: { run: (p) => move(p && p.x, p && p.y), danger: 0 },
}

/** 点下去之前要躲开的字。落点附近的文本命中这些就不许点。 */
export const DANGER_WORDS = [
  '删除', '清空', '格式化', '支付', '付款', '购买', '确认购买', '发送', '转账',
  'delete', 'remove', 'format', 'pay', 'purchase', 'send', 'confirm',
]
