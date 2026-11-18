const { execFile } = require('child_process');

function getHwnd(browserWin) {
  const buf = browserWin.getNativeWindowHandle();
  if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
  return buf.readUInt32LE(0).toString();
}

function runPs(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 5000 },
      () => resolve()
    );
  });
}

const WIN32 = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeskPin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  // HWND_BOTTOM = 1; SWP_NOMOVE=0x2 SWP_NOSIZE=0x1 SWP_NOACTIVATE=0x10 SWP_SHOWWINDOW=0x40
  public static void ToBottom(IntPtr hwnd) {
    SetParent(hwnd, IntPtr.Zero);
    SetWindowPos(hwnd, new IntPtr(1), 0, 0, 0, 0, 0x0013);
  }

  public static void Move(IntPtr hwnd, int x, int y) {
    SetWindowPos(hwnd, new IntPtr(1), x, y, 0, 0, 0x0015); // NOSIZE|NOACTIVATE|HWND_BOTTOM
  }

  public static void Detach(IntPtr hwnd) {
    SetParent(hwnd, IntPtr.Zero);
  }
}
"@
`;

function moveToBottom(browserWin) {
  if (process.platform !== 'win32' || !browserWin || browserWin.isDestroyed()) {
    return Promise.resolve();
  }
  const hwnd = getHwnd(browserWin);
  return runPs(`${WIN32}; [DeskPin]::ToBottom([IntPtr]${hwnd})`);
}

function detachFromDesktop(browserWin) {
  if (process.platform !== 'win32' || !browserWin || browserWin.isDestroyed()) {
    return Promise.resolve();
  }
  const hwnd = getHwnd(browserWin);
  return runPs(`${WIN32}; [DeskPin]::Detach([IntPtr]${hwnd})`);
}

function nativeMove(browserWin, x, y) {
  if (process.platform !== 'win32' || !browserWin || browserWin.isDestroyed()) {
    return Promise.resolve();
  }
  const hwnd = getHwnd(browserWin);
  return runPs(`${WIN32}; [DeskPin]::Move([IntPtr]${hwnd}, ${x | 0}, ${y | 0})`);
}

// Kept for API compatibility — no longer parents to WorkerW (that blocked clicks/drag)
function attachToDesktop(browserWin) {
  return moveToBottom(browserWin);
}

module.exports = {
  attachToDesktop,
  detachFromDesktop,
  moveToBottom,
  nativeMove,
};
