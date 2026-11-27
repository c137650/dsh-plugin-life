/**
 * 感知:八分钟一次地看一眼舰长在干什么。
 *
 * 只有三样东西,全部走 PowerShell/.NET,不装任何依赖:
 *   前台进程名、窗口标题、离最后一次键鼠操作过了多少秒,
 *   再加一张缩小的屏幕截图。
 *
 * 截图不按原尺寸存:1920 宽压到 1280,PNG 大约 200-400 KB。
 * 判断要看的是"在视频网站还是在编辑器",这个尺寸够用。
 */

import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const SAMPLE_PS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static string Sample() {
    var h = GetForegroundWindow();
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    uint pid; GetWindowThreadProcessId(h, out pid);
    string proc = "";
    try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
    var li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(li);
    uint idle = 0;
    if (GetLastInputInfo(ref li)) idle = ((uint)Environment.TickCount - li.dwTime) / 1000;
    return proc + "\\u0001" + sb.ToString() + "\\u0001" + idle;
  }
}
'@
[Fg]::Sample()
`

const SHOT_PS = `
param([string]$out, [int]$w = 1280)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$ratio = $w / $bmp.Width
$nw = [int]($bmp.Width * $ratio); $nh = [int]($bmp.Height * $ratio)
$small = New-Object System.Drawing.Bitmap $nw, $nh
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $nw, $nh)
$small.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $small.Dispose()
Write-Output ($nw.ToString() + "x" + $nh.ToString())
`

function runPs(script, args = []) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, ...args],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: String(stdout || '').trim(), err: String(stderr || (error && error.message) || '').trim() })
      },
    )
  })
}

let shotSeq = 0

/** 采一次样。截图失败不影响前台信息。 */
export async function sample(shotDir) {
  const at = Date.now()
  const base = { at, proc: '', title: '', idleSec: 0, shot: null, shotBytes: 0 }
  const r = await runPs(SAMPLE_PS)
  if (r.ok && r.out) {
    const parts = r.out.split('\u0001')
    base.proc = (parts[0] || '').trim()
    base.title = (parts[1] || '').trim().slice(0, 160)
    base.idleSec = Number(parts[2] || 0) || 0
  }
  if (shotDir) {
    try {
      mkdirSync(shotDir, { recursive: true })
      shotSeq = (shotSeq + 1) % 1000
      const file = path.join(shotDir, 'shot-' + String(at) + '-' + shotSeq + '.png')
      const s = await runPs(SHOT_PS, ['-out', file])
      if (s.ok) {
        base.shot = file
        try {
          const { statSync } = await import('node:fs')
          base.shotBytes = statSync(file).size
        } catch {
          base.shotBytes = 0
        }
      }
    } catch {
      /* 截图失败就算了 */
    }
  }
  return base
}
