$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -Path (Join-Path $PSScriptRoot 'audio-session.cs')
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$propertyType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-Result($Operation, [Type]$ResultType) {
  $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (-not $task.Wait(5000)) { throw 'QQ 音乐响应超时，请稍后重试' }
  return $task.Result
}
$manager = Await-Result ($managerType::RequestAsync()) $managerType
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    if ($line.Length -gt 1024) { throw 'Request too large' }
    $request = $line | ConvertFrom-Json
    $action = [string]$request.action
    if ($action -notin @('status','toggle','next','previous','play','pause','seek','set-volume','volume-up','volume-down','mute')) { throw 'Unknown media action' }
    $session = @($manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -eq 'QQMusic.exe' }) | Select-Object -First 1
    if ($action -in @('toggle','next','previous','play','pause','seek')) {
      if (-not $session) { throw '请先打开 QQ 音乐并播放一首歌' }
      $controls = $session.GetPlaybackInfo().Controls
      $operation = switch ($action) {
        'toggle' { $session.TryTogglePlayPauseAsync() }
        'next' { if (-not $controls.IsNextEnabled) { throw 'QQ 音乐当前不允许切到下一首' }; $session.TrySkipNextAsync() }
        'previous' { if (-not $controls.IsPreviousEnabled) { throw 'QQ 音乐当前不允许切到上一首' }; $session.TrySkipPreviousAsync() }
        'play' { $session.TryPlayAsync() }
        'pause' { $session.TryPauseAsync() }
        'seek' {
          if (-not $controls.IsPlaybackPositionEnabled) { throw 'QQ 音乐当前不支持跳转播放进度' }
          if ($null -eq $request.value -or $request.value -is [string]) { throw '无效的播放进度' }
          $target=[double]$request.value
          $timeline=$session.GetTimelineProperties()
          $length=($timeline.EndTime-$timeline.StartTime).TotalSeconds
          if ([double]::IsNaN($target) -or [double]::IsInfinity($target) -or $target -lt 0 -or $target -gt $length) { throw '播放进度超出当前歌曲范围' }
          $session.TryChangePlaybackPositionAsync([long]($timeline.StartTime.Ticks+[Math]::Round($target*10000000)))
        }
      }
      if (-not (Await-Result $operation ([bool]))) { throw 'QQ 音乐未接受本次操作' }
    }
    $audioAction = if ($action -in @('set-volume','volume-up','volume-down','mute')) { $action } else { 'status' }
    if ($action -eq 'set-volume' -and ($null -eq $request.value -or $request.value -is [string])) { throw 'Invalid volume' }
    $audio = [ClawdQQMusic.SessionVolume]::Run($audioAction, [double]$request.value)
    if ($audioAction -ne 'status' -and $audio.Sessions -eq 0) { throw '未找到 QQ 音乐的音量会话，请先播放一首歌' }
    $title = ''; $artist = ''; $playback = 'Unavailable'; $next = $false; $previous = $false
    if ($session) {
      $info = $session.GetPlaybackInfo(); $playback = [string]$info.PlaybackStatus
      $next = $info.Controls.IsNextEnabled; $previous = $info.Controls.IsPreviousEnabled
      try { $properties = Await-Result ($session.TryGetMediaPropertiesAsync()) $propertyType; $title = $properties.Title; $artist = $properties.Artist } catch { }
    }
    $shuffle=$null; $repeat=$null; $canShuffle=$false; $canRepeat=$false
    if($session){$playInfo=$session.GetPlaybackInfo();$shuffle=$playInfo.IsShuffleActive;$repeat=[string]$playInfo.AutoRepeatMode;$canShuffle=$playInfo.Controls.IsShuffleEnabled;$canRepeat=$playInfo.Controls.IsRepeatEnabled}
    $position=0; $duration=0; $canSeek=$false
    if($session){
      $timeline=$session.GetTimelineProperties();$duration=[Math]::Max(0,($timeline.EndTime-$timeline.StartTime).TotalSeconds);$position=($timeline.Position-$timeline.StartTime).TotalSeconds
      if($playback -eq 'Playing'){$age=([DateTimeOffset]::UtcNow-$timeline.LastUpdatedTime).TotalSeconds;if($age -ge 0 -and $age -lt 3600){$rate=$session.GetPlaybackInfo().PlaybackRate;if($null -eq $rate){$rate=1};$position+=$age*[double]$rate}}
      $position=[Math]::Max(0,[Math]::Min($duration,$position));$canSeek=($duration -gt 0 -and $session.GetPlaybackInfo().Controls.IsPlaybackPositionEnabled)
    }
    $state = @{ connected = [bool]$session; title = $title; artist = $artist; playback = $playback; canNext = $next; canPrevious = $previous; volume = $audio.Volume; muted = $audio.Muted; volumeAvailable = ($audio.Sessions -gt 0); shuffle=$shuffle; repeat=$repeat; canShuffle=$canShuffle; canRepeat=$canRepeat; position=$position; duration=$duration; canSeek=$canSeek }
    @{ id = $request.id; ok = $true; state = $state } | ConvertTo-Json -Depth 5 -Compress | ForEach-Object { [Console]::WriteLine($_) }
  } catch {
    @{ id = $request.id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
  }
}
