/**
 * 感知:八分钟一次地看一眼舰长在干什么。
 *
 * 只有三样东西,全部走 PowerShell/.NET,不装任何依赖:
 *   前台进程名、窗口标题、离最后一次键鼠操作过了多少秒,
 *   再加一张缩小的屏幕截图。
 *
 * 截图不按原尺寸存:1920 宽压到 960,PNG 大约 300-400 KB。
 * 判断要看的是"在视频网站还是在编辑器",这个尺寸够用。
 * 压完不写文件,base64 从 stdout 带回来,磁盘上不留屏幕的任何拷贝。
 */

import { execFile } from 'node:child_process'

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

function runPs(script) {
  return new Promise((resolve) => {
    // 输出统一按 UTF-8 读回来。默认走系统代码页,中文标题会变乱码。
    const wrapped = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' + script
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: String(stdout || '').trim(), err: String(stderr || (error && error.message) || '').trim() })
      },
    )
  })
}

/**
 * 截图,直接输出 base64,不落盘。
 *
 * 图只是这一眼的中间物,看完就该消失。存成文件意味着磁盘上留着一份
 * 舰长屏幕的原样拷贝,哪怕只留一天也不该有。所以走内存:存 MemoryStream,
 * 转 base64 从 stdout 带回来,进程退出后内存里那份也没了。
 */
async function grabShot() {
  const script = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DpiAware{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
[DpiAware]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$w = 960
$ratio = $w / $bmp.Width
$nw = [int]($bmp.Width * $ratio); $nh = [int]($bmp.Height * $ratio)
$small = New-Object System.Drawing.Bitmap $nw, $nh
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $nw, $nh)
$ms = New-Object System.IO.MemoryStream
$small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$b64 = [Convert]::ToBase64String($ms.ToArray())
$g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $small.Dispose(); $ms.Dispose()
Write-Output ($nw.ToString() + 'x' + $nh.ToString() + [char]1 + $b64)
`
  return runPs(script)
}

/** 采一次样。截图失败不影响前台信息。 */
export async function sample() {
  const at = Date.now()
  const base = { at, proc: '', title: '', idleSec: 0, shotBuf: null, shotBytes: 0 }
  const r = await runPs(SAMPLE_PS)
  if (r.ok && r.out) {
    const parts = r.out.split('\u0001')
    base.proc = (parts[0] || '').trim()
    base.title = (parts[1] || '').trim().slice(0, 160)
    base.idleSec = Number(parts[2] || 0) || 0
  }
  try {
    const s = await grabShot()
    if (s.ok && s.out) {
      const parts = s.out.split('\u0001')
      const b64 = parts[1] || ''
      const buf = b64 ? Buffer.from(b64, 'base64') : null
      if (buf && buf.length > 0) {
        base.shotBuf = buf
        base.shotBytes = buf.length
        base.shotSize = (parts[0] || '').trim()
      }
    } else {
      base.shotError = s.err.slice(0, 200)
    }
  } catch (e) {
    base.shotError = String((e && e.message) || e).slice(0, 200)
  }
  return base
}
