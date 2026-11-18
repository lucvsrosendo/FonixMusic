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

function Write-SmtcLog([string]$msg) {
  try {
    $line = ("{0:HH:mm:ss.fff} {1}" -f (Get-Date), $msg)
    [System.IO.File]::AppendAllText($script:logFile, $line + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  } catch {}
}

function Score-Session($session) {
  $score = 0
  try {
    $info = $session.GetPlaybackInfo()
    $status = [string]$info.PlaybackStatus
    if ($status -eq 'Playing') { $score += 100 }
    elseif ($status -eq 'Paused') { $score += 40 }
    elseif ($status -eq 'Opened') { $score += 5 }
    $app = ([string]$session.SourceAppUserModelId).ToLowerInvariant()
    if ($app -match 'spotify') { $score += 35 }
    elseif ($app -match 'brave') { $score += 30 }
    elseif ($app -match 'chrome|msedge|chromium') { $score += 20 }
    elseif ($app -match 'vlc|itunes|groove|zune|musicbee|foobar') { $score += 15 }
    try {
      $tl = $session.GetTimelineProperties()
      $age = ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds
      if ($age -ge 0 -and $age -lt 120) { $score += [int](40 - [math]::Min(40, $age)) }
    } catch {}
  } catch {}
  return $score
}

function Get-BestSession($mgr) {
  $best = $null
  $bestScore = -1
  try {
    $cur = $mgr.GetCurrentSession()
    if ($cur) {
      $scs = Score-Session $cur
      if ($scs -ge 100) { return $cur }
    }
  } catch {}
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

function Read-MediaProps($session, [int]$attempts = 1) {
  $title = ''
  $artist = ''
  $album = ''
  if ($null -eq $session) { return @{ title = ''; artist = ''; album = '' } }
  for ($i = 0; $i -lt $attempts; $i++) {
    try {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 1200
      if ($props) {
        $title = [string]$props.Title
        $artist = [string]$props.Artist
        $album = [string]$props.AlbumTitle
        if ($title) { break }
      }
    } catch {}
    if ($i -lt ($attempts - 1)) { Start-Sleep -Milliseconds 80 }
  }
  return @{ title = $title; artist = $artist; album = $album }
}

function Publish-State([string]$json) {
  Write-Output $json
  try {
    if ($env:MUSIC_STATE_FILE) {
      [System.IO.File]::WriteAllText($env:MUSIC_STATE_FILE, $json, [System.Text.UTF8Encoding]::new($false))
    }
  } catch {}
}

function Ensure-Manager([bool]$force = $false) {
  $now = [Environment]::TickCount64
  if ($force -or $null -eq $script:mgr -or ($now - $script:mgrAt) -gt 1200) {
    try {
      $m = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) 3000
      if ($null -ne $m) {
        $script:mgr = $m
        $script:mgrAt = $now
      }
    } catch {}
  }
  return ($null -ne $script:mgr)
}

function Refresh-Volume([long]$now) {
  if ($now -lt $script:nextVolAt) { return }
  $script:nextVolAt = $now + 5000
  try {
    $script:volume = [double][Vol]::Get()
  } catch {}
}

function Emit-State {
  $session = $null
  try {
    if (-not (Ensure-Manager $false)) {
      Publish-State '{"idle":true}'
      return
    }
    $session = Get-BestSession $script:mgr
  } catch {
    $script:mgr = $null
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
  $canSeek = $false

  try { $app = [string]$session.SourceAppUserModelId } catch {}
  try {
    $info = $session.GetPlaybackInfo()
    $status = [string]$info.PlaybackStatus
    try { $canPlay = [bool]$info.Controls.IsPlayEnabled } catch {}
    try { $canPause = [bool]$info.Controls.IsPauseEnabled } catch {}
    try { $canNext = [bool]$info.Controls.IsNextEnabled } catch {}
    try { $canPrev = [bool]$info.Controls.IsPreviousEnabled } catch {}
    try { $canSeek = [bool]$info.Controls.IsPlaybackPositionEnabled } catch {}
  } catch {}

  try {
    $timeline = $session.GetTimelineProperties()
    $position = [double]$timeline.Position.TotalSeconds
    $duration = [double]$timeline.EndTime.TotalSeconds
    # Browsers only refresh the timeline on events; extrapolate while playing.
    if ($status -eq 'Playing') {
      $age = ([DateTimeOffset]::UtcNow - $timeline.LastUpdatedTime).TotalSeconds
      if ($age -gt 0 -and $age -lt 21600) {
        $rate = 1.0
        try { $rate = [double]$info.PlaybackRate } catch {}
        if ($rate -le 0) { $rate = 1.0 }
        $position += $age * $rate
      }
      if ($duration -gt 0 -and $position -gt $duration) { $position = $duration }
    }
  } catch {}

  if ($app -match 'spotify') {
    $canNext = $true
    $canPrev = $true
  }

  $durJump = ($script:lastDuration -gt 0 -and $duration -gt 0 -and [math]::Abs($duration - $script:lastDuration) -gt 2)
  $posReset = ($status -eq 'Playing' -and $script:lastPosition -gt 8 -and $position -lt 3)
  if ($durJump -or $posReset) {
    $script:mgr = $null
    Ensure-Manager $true | Out-Null
    $session = Get-BestSession $script:mgr
    if ($null -eq $session) {
      Publish-State '{"idle":true}'
      return
    }
    try {
      $timeline = $session.GetTimelineProperties()
      $position = [double]$timeline.Position.TotalSeconds
      $duration = [double]$timeline.EndTime.TotalSeconds
    } catch {}
    Write-SmtcLog "jump durJump=$durJump posReset=$posReset pos=$position dur=$duration"
  }

  $propTries = 1
  if ($durJump -or $posReset) { $propTries = 2 }
  $meta = Read-MediaProps $session $propTries
  $title = $meta.title
  $artist = $meta.artist
  $album = $meta.album

  if (-not $title) {
    $script:emptyCount++
    if ($status -match 'Playing|Paused' -and $script:emptyCount -lt 4) {
      return
    }
    Publish-State '{"idle":true}'
    return
  }
  $script:emptyCount = 0

  $durKey = if ($duration -gt 0) { [math]::Round($duration) } else { 0 }
  $mediaKey = "$app|$title|$artist|$durKey"
  $changed = $mediaKey -ne $script:lastMediaKey
  if ($changed -or $durJump -or $posReset) {
    Write-SmtcLog "track title=$title artist=$artist status=$status app=$app key=$mediaKey"
  }
  $script:lastMediaKey = $mediaKey
  $script:lastDuration = $duration
  $script:lastPosition = $position

  $vol = $script:volume
  $obj = [ordered]@{
    idle = $false
    title = $title
    artist = $artist
    album = $album
    status = $status
    position = [math]::Round($position, 2)
    duration = [math]::Round($duration, 2)
    canPlay = $canPlay
    canPause = $canPause
    canNext = $canNext
    canPrev = $canPrev
    canSeek = $canSeek
    volume = [math]::Round($vol, 3)
    app = $app
  }
  Publish-State (($obj | ConvertTo-Json -Compress -Depth 4))
}

function Do-Control([string]$cmd) {
  try {
    if ($cmd.StartsWith('vol:')) {
      $n = 0.0
      [void][double]::TryParse(($cmd.Substring(4) -replace ',', '.'), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$n)
      [Vol]::Set([float]$n)
      $script:volume = $n
      $script:nextVolAt = [Environment]::TickCount64 + 2000
      return
    }
    if (-not (Ensure-Manager $true)) { return }
    $session = Get-BestSession $script:mgr
    if ($null -eq $session) { return }
    if ($cmd.StartsWith('seek:')) {
      $sec = 0.0
      [void][double]::TryParse(($cmd.Substring(5) -replace ',', '.'), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$sec)
      if ($sec -lt 0) { $sec = 0 }
      $ticks = [long]([TimeSpan]::FromSeconds($sec).Ticks)
      Await ($session.TryChangePlaybackPositionAsync($ticks)) ([bool]) 2000 | Out-Null
      return
    }
    $status = [string]$session.GetPlaybackInfo().PlaybackStatus
    switch ($cmd) {
      'play' { Await ($session.TryPlayAsync()) ([bool]) 2000 | Out-Null }
      'pause' { Await ($session.TryPauseAsync()) ([bool]) 2000 | Out-Null }
      'toggle' {
        if ($status -eq 'Playing') { Await ($session.TryPauseAsync()) ([bool]) 2000 | Out-Null }
        else { Await ($session.TryPlayAsync()) ([bool]) 2000 | Out-Null }
      }
      'next' { Await ($session.TrySkipNextAsync()) ([bool]) 2000 | Out-Null }
      'prev' { Await ($session.TrySkipPreviousAsync()) ([bool]) 2000 | Out-Null }
    }
  } catch {}
  $script:forceEmit = $true
}

$script:mgr = $null
$script:mgrAt = 0
$script:lastMediaKey = ''
$script:lastPosition = 0.0
$script:lastDuration = 0.0
$script:emptyCount = 0
$script:volume = 1.0
$script:nextVolAt = 0
$script:forceEmit = $true
$script:logFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'fonix-smtc.log')
Write-SmtcLog "smtc-bridge-start pid=$PID"
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
          if ($c -eq 'quit') { Write-SmtcLog 'quit'; exit 0 }
          Do-Control $c
        }
      }
    } catch {}
  }
  $now = [Environment]::TickCount64
  Refresh-Volume $now
  if ($script:forceEmit -or $now -ge $nextStateAt) {
    $script:forceEmit = $false
    Emit-State
    $nextStateAt = [Environment]::TickCount64 + 500
  }
  Start-Sleep -Milliseconds 40
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
    this._lastTrackKey = '';
  }

  _trackKey(data) {
    if (!data || data.idle) return 'idle';
    const dur =
      data.duration > 0 ? Math.round(data.duration) : 0;
    return `${data.app || ''}|${data.title || ''}|${data.artist || ''}|${dur}`;
  }

  _publish(data) {
    if (!data || typeof data !== 'object') return;
    const trackKey = this._trackKey(data);
    const trackChanged = trackKey !== this._lastTrackKey;

    // Keep last cover only while the same track is playing (no SMTC thumbs anymore).
    if (
      !trackChanged &&
      this.last &&
      !data.idle &&
      !this.last.idle &&
      !data.thumbnail &&
      !data.coverUrl &&
      this.last.thumbnail
    ) {
      data = {
        ...data,
        thumbnail: this.last.thumbnail,
        thumbMime: this.last.thumbMime,
      };
    }

    const key = JSON.stringify({
      idle: !!data.idle,
      title: data.title || '',
      artist: data.artist || '',
      status: data.status || '',
      app: data.app || '',
      duration: Math.round(data.duration || 0),
      position: Math.round((data.position || 0) * 10) / 10,
      thumbnail: data.thumbnail ? data.thumbnail.slice(0, 24) : '',
      coverUrl: data.coverUrl || '',
      volume: Math.round((data.volume || 0) * 100),
    });
    if (key === this._lastStateRaw) return;
    this._lastStateRaw = key;
    this._lastTrackKey = trackKey;
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
    this._lastStateRaw = '';
    this._lastTrackKey = '';
    this.last = null;
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
    this._poll = setInterval(() => this._readStateFile(), 350);
    if (this._watchdog) clearInterval(this._watchdog);
    this._stateMtime = 0;
    this._watchdog = setInterval(() => this._watchStale(), 2500);
  }

  _watchStale() {
    if (!this.proc || this.restarting) return;
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const mtime = fs.statSync(this.stateFile).mtimeMs;
      if (mtime === this._stateMtime) {
        const age = Date.now() - mtime;
        if (age > 5000) this._restartBridge();
        return;
      }
      this._stateMtime = mtime;
    } catch {
      /* ignore */
    }
  }

  _restartBridge() {
    if (!this.proc || this.restarting) return;
    this.restarting = true;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this._lastStateRaw = '';
    this._lastTrackKey = '';
    setTimeout(() => {
      this.restarting = false;
      this.start();
    }, 800);
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
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
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
