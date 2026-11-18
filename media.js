const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PS_BODY = `
$ErrorActionPreference = 'SilentlyContinue'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
Function Await($WinRtTask, $ResultType, $ms = -1) {
  if ($null -eq $WinRtTask) { return $null }
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  if ($ms -ge 0) {
    if (-not $netTask.Wait($ms)) { return $null }
  } else {
    $netTask.Wait(-1) | Out-Null
  }
  $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.Buffer,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null

function Get-ThumbB64($ref) {
  if ($null -eq $ref) { return $null }
  try {
    $stream = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType]) 2500
    if ($null -eq $stream) { return $null }
    $bytes = [ThumbIo]::Read($stream)
    if ($null -eq $bytes -or $bytes.Length -lt 32) { return $null }
    $mime = 'image/jpeg'
    if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $mime = 'image/png' }
    elseif ($bytes[0] -eq 0x47 -and $bytes[1] -eq 0x49) { $mime = 'image/gif' }
    elseif ($bytes.Length -gt 12 -and $bytes[0] -eq 0x52 -and $bytes[8] -eq 0x57) { $mime = 'image/webp' }
    return @{ b64 = [Convert]::ToBase64String($bytes); mime = $mime }
  } catch { return $null }
}

function Score-Session($session) {
  $score = 0
  try {
    $info = $session.GetPlaybackInfo()
    $status = [string]$info.PlaybackStatus
    if ($status -eq 'Playing') { $score += 100 }
    elseif ($status -eq 'Paused') { $score += 40 }
    $app = ([string]$session.SourceAppUserModelId).ToLowerInvariant()
    if ($app -match 'brave') { $score += 30 }
    elseif ($app -match 'chrome|msedge|chromium') { $score += 20 }
    elseif ($app -match 'spotify|vlc|itunes|groove|zune') { $score += 10 }
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 2000
    if ($props -and [string]$props.Title) { $score += 5 }
  } catch {}
  return $score
}

function Get-BestSession($mgr) {
  $best = $null
  $bestScore = -1
  try {
    $sessions = $mgr.GetSessions()
    foreach ($s in $sessions) {
      $sc = Score-Session $s
      if ($sc -gt $bestScore) {
        $bestScore = $sc
        $best = $s
      }
    }
  } catch {}
  if ($null -eq $best) {
    try { $best = $mgr.GetCurrentSession() } catch { $best = $null }
  }
  return $best
}

function Publish-State([string]$json) {
  Write-Output $json
  try {
    if ($env:MUSIC_STATE_FILE) {
      [System.IO.File]::WriteAllText($env:MUSIC_STATE_FILE, $json, [System.Text.UTF8Encoding]::new($false))
    }
  } catch {}
}

function Emit-State {
  $session = $null
  try {
    $script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) 4000
    if ($null -eq $script:mgr) {
      Publish-State '{"idle":true}'
      return
    }
    $session = Get-BestSession $script:mgr
  } catch {
    Publish-State '{"idle":true}'
    return
  }
  if ($null -eq $session) {
    Publish-State '{"idle":true}'
    return
  }

  $title = ''
  $artist = ''
  $album = ''
  $status = 'Opened'
  $app = ''
  $position = 0.0
  $duration = 0.0
  $canPlay = $true
  $canPause = $true
  $canNext = $false
  $canPrev = $false
  $volume = 1.0
  $props = $null

  try { $app = [string]$session.SourceAppUserModelId } catch {}
  try {
    $info = $session.GetPlaybackInfo()
    $status = [string]$info.PlaybackStatus
    try { $canPlay = [bool]$info.Controls.IsPlayEnabled } catch {}
    try { $canPause = [bool]$info.Controls.IsPauseEnabled } catch {}
    try { $canNext = [bool]$info.Controls.IsNextEnabled } catch {}
    try { $canPrev = [bool]$info.Controls.IsPreviousEnabled } catch {}
  } catch {}
  try {
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 3000
    if ($props) {
      $title = [string]$props.Title
      $artist = [string]$props.Artist
      $album = [string]$props.AlbumTitle
    }
  } catch {}
  try {
    $timeline = $session.GetTimelineProperties()
    $position = [double]$timeline.Position.TotalSeconds
    $duration = [double]$timeline.EndTime.TotalSeconds
  } catch {}
  try { $volume = [double](Get-MasterVolume) } catch { $volume = 1.0 }
  if ($app -match 'spotify') {
    $canNext = $true
    $canPrev = $true
  }

  $mediaKey = "$app|$title|$artist|$album"
  $changed = $mediaKey -ne $script:lastMediaKey
  $obj = [ordered]@{
    idle = $false
    title = $title
    artist = $artist
    album = $album
    status = $status
    position = $position
    duration = $duration
    canPlay = $canPlay
    canPause = $canPause
    canNext = $canNext
    canPrev = $canPrev
    volume = $volume
    app = $app
    thumbnail = $script:lastThumb
    thumbMime = $script:lastMime
  }
  Publish-State (($obj | ConvertTo-Json -Compress -Depth 4))

  if ($changed) {
    $script:lastMediaKey = $mediaKey
    try {
      if ($props -and $props.Thumbnail) {
        $thumb = Get-ThumbB64 $props.Thumbnail
        if ($thumb) {
          $script:lastThumb = $thumb.b64
          $script:lastMime = $thumb.mime
          $obj.thumbnail = $script:lastThumb
          $obj.thumbMime = $script:lastMime
          Publish-State (($obj | ConvertTo-Json -Compress -Depth 4))
        } else {
          $script:lastThumb = $null
          $script:lastMime = $null
        }
      } else {
        $script:lastThumb = $null
        $script:lastMime = $null
      }
    } catch {
      $script:lastThumb = $null
      $script:lastMime = $null
    }
  }
}

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class ThumbIo {
  [DllImport("shcore.dll", PreserveSig = true)]
  static extern int CreateStreamOverRandomAccessStream(IntPtr randomAccessStream, ref Guid riid, out IStream ppv);
  public static byte[] Read(object obj) {
    IntPtr unk = Marshal.GetIUnknownForObject(obj);
    try {
      Guid iid = typeof(IStream).GUID;
      IStream com;
      int hr = CreateStreamOverRandomAccessStream(unk, ref iid, out com);
      if (hr != 0 || com == null) return null;
      var ms = new MemoryStream();
      var buf = new byte[65536];
      IntPtr pcb = Marshal.AllocCoTaskMem(4);
      try {
        while (ms.Length < 2000000) {
          com.Read(buf, buf.Length, pcb);
          int n = Marshal.ReadInt32(pcb);
          if (n <= 0) break;
          ms.Write(buf, 0, n);
        }
      } finally { Marshal.FreeCoTaskMem(pcb); }
      return ms.ToArray();
    } finally { Marshal.Release(unk); }
  }
}
"@ -ErrorAction SilentlyContinue

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int a(); int b(); int c();
  int SetMasterVolumeLevel(float level, Guid ctx);
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int x();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
public class Vol {
  static IAudioEndpointVolume Endpoint() {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
    dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    return (IAudioEndpointVolume)o;
  }
  public static void Set(float level) {
    if (level < 0) level = 0; if (level > 1) level = 1;
    Endpoint().SetMasterVolumeLevelScalar(level, Guid.Empty);
  }
  public static float Get() { float v; Endpoint().GetMasterVolumeLevelScalar(out v); return v; }
}
"@ -ErrorAction SilentlyContinue

function Get-MasterVolume {
  try { return [double][Vol]::Get() } catch { return 1 }
}

function Do-Control([string]$cmd) {
  try {
    if ($cmd.StartsWith('vol:')) {
      $n = 0.0
      [void][double]::TryParse(($cmd.Substring(4) -replace ',', '.'), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$n)
      [Vol]::Set([float]$n)
      return
    }
    if ($null -eq $script:mgr) {
      $script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) 4000
    }
    $session = Get-BestSession $script:mgr
    if ($null -eq $session) { return }
    $status = [string]$session.GetPlaybackInfo().PlaybackStatus
    switch ($cmd) {
      'play' { Await ($session.TryPlayAsync()) ([bool]) | Out-Null }
      'pause' { Await ($session.TryPauseAsync()) ([bool]) | Out-Null }
      'toggle' {
        if ($status -eq 'Playing') { Await ($session.TryPauseAsync()) ([bool]) | Out-Null }
        else { Await ($session.TryPlayAsync()) ([bool]) | Out-Null }
      }
      'next' { Await ($session.TrySkipNextAsync()) ([bool]) | Out-Null }
      'prev' { Await ($session.TrySkipPreviousAsync()) ([bool]) | Out-Null }
    }
  } catch {}
}

$script:mgr = $null
$script:lastMediaKey = ''
$script:lastThumb = $null
$script:lastMime = $null
$cmdFile = $env:MUSIC_CMD_FILE
$nextStateAt = [Environment]::TickCount64
while ($true) {
  if ($cmdFile -and (Test-Path $cmdFile)) {
    try {
      $raw = Get-Content -LiteralPath $cmdFile -Raw -ErrorAction SilentlyContinue
      if ($raw) {
        Clear-Content -LiteralPath $cmdFile -ErrorAction SilentlyContinue
        foreach ($line in ($raw -split "[\\r\\n]+")) {
          $c = $line.Trim()
          if (-not $c) { continue }
          if ($c -eq 'quit') { exit 0 }
          Do-Control $c
        }
      }
    } catch {}
  }
  $now = [Environment]::TickCount64
  if ($now -ge $nextStateAt) {
    Emit-State
    $nextStateAt = $now + 900
  }
  Start-Sleep -Milliseconds 60
}
`;

class MediaService extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.last = null;
    this.cmdFile = path.join(os.tmpdir(), `music-cmd-${process.pid}.txt`);
    this.stateFile = path.join(os.tmpdir(), `music-state-${process.pid}.json`);
    this.restarting = false;
    this._scriptFile = path.join(os.tmpdir(), `music-smtc-${process.pid}.ps1`);
    this._poll = null;
    this._lastStateRaw = '';
  }

  _publish(data) {
    const key = JSON.stringify({
      idle: !!data.idle,
      title: data.title || '',
      artist: data.artist || '',
      status: data.status || '',
      app: data.app || '',
      position: Math.round((data.position || 0) * 10) / 10,
      thumbnail: data.thumbnail ? data.thumbnail.slice(0, 24) : '',
      volume: Math.round((data.volume || 0) * 100),
    });
    if (key === this._lastStateRaw) return;
    this._lastStateRaw = key;
    this.last = data;
    this.emit('update', data);
  }

  _readStateFile() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw = fs.readFileSync(this.stateFile, 'utf8').trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      this._publish(data);
    } catch {
      /* ignore */
    }
  }

  start() {
    if (this.proc) return;
    try {
      fs.writeFileSync(this._scriptFile, PS_BODY, 'utf8');
      fs.writeFileSync(this.cmdFile, '', 'utf8');
      fs.writeFileSync(this.stateFile, '{"idle":true}', 'utf8');
    } catch {
      /* ignore */
    }
    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this._scriptFile],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          MUSIC_CMD_FILE: this.cmdFile,
          MUSIC_STATE_FILE: this.stateFile,
        },
      }
    );
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          this._publish(JSON.parse(line));
        } catch {
          /* ignore broken line; state file is the fallback */
        }
      }
    });
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => {
      this.proc = null;
      if (!this.restarting) {
        this.restarting = true;
        setTimeout(() => {
          this.restarting = false;
          this.start();
        }, 1500);
      }
    });
    if (this._poll) clearInterval(this._poll);
    this._poll = setInterval(() => this._readStateFile(), 700);
  }

  control(cmd) {
    try {
      fs.appendFileSync(this.cmdFile, cmd + '\n', 'utf8');
    } catch {
      /* ignore */
    }
  }

  stop() {
    this.restarting = true;
    if (this._poll) {
      clearInterval(this._poll);
      this._poll = null;
    }
    try {
      fs.appendFileSync(this.cmdFile, 'quit\n', 'utf8');
    } catch {
      /* ignore */
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    for (const file of [this.cmdFile, this._scriptFile, this.stateFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { MediaService };
