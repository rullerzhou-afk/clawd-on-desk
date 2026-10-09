[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Codespace,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [ValidateRange(5, 1800)]
  [int]$DurationSeconds = 300,

  [ValidateRange(100, 5000)]
  [int]$IntervalMs = 200
)

$ErrorActionPreference = "Stop"
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $OutputPath
if (-not $parent) { throw "OutputPath must have a parent directory" }
New-Item -ItemType Directory -Path $parent -Force | Out-Null

function Get-Sha256Text {
  param([string]$Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $hash = [Security.Cryptography.SHA256]::HashData($bytes)
  return [Convert]::ToHexString($hash).ToLowerInvariant()
}

$startedAt = Get-Date
$deadline = $startedAt.AddSeconds($DurationSeconds)
$peakSsh = 0
$peakGh = 0
$peakCombined = 0
$previousSignature = $null
$transitions = @()
$processes = @{}

while ((Get-Date) -lt $deadline) {
  $now = Get-Date
  $matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.Name -ieq "ssh.exe" -or $_.Name -ieq "gh.exe") -and
      $_.CommandLine -and
      $_.CommandLine.Contains($Codespace)
    })
  $sshCount = @($matches | Where-Object { $_.Name -ieq "ssh.exe" }).Count
  $ghCount = @($matches | Where-Object { $_.Name -ieq "gh.exe" }).Count
  $peakSsh = [Math]::Max($peakSsh, $sshCount)
  $peakGh = [Math]::Max($peakGh, $ghCount)
  $peakCombined = [Math]::Max($peakCombined, $matches.Count)

  foreach ($process in $matches) {
    $pidKey = [string]$process.ProcessId
    $role = if ($process.Name -ieq "gh.exe" -and $process.CommandLine -match "--stdio(?:\s|$)") {
      "codespaces-stdio-proxy"
    } elseif ($process.Name -ieq "ssh.exe") {
      "openssh-client"
    } else {
      "test-transport"
    }
    if (-not $processes.ContainsKey($pidKey)) {
      $processes[$pidKey] = [ordered]@{
        pid = [int]$process.ProcessId
        parentPid = [int]$process.ParentProcessId
        image = $process.Name
        role = $role
        commandHash = Get-Sha256Text $process.CommandLine
        firstSeenAt = $now.ToString("o")
        lastSeenAt = $now.ToString("o")
      }
    } else {
      $processes[$pidKey].lastSeenAt = $now.ToString("o")
    }
  }

  $signature = "$sshCount/$ghCount/" + (($matches | Sort-Object Name, ProcessId | ForEach-Object {
    "$($_.Name):$($_.ProcessId)"
  }) -join ",")
  if ($signature -ne $previousSignature) {
    $transitions += [ordered]@{
      at = $now.ToString("o")
      sshCount = $sshCount
      ghCount = $ghCount
      combinedCount = $matches.Count
    }
    $previousSignature = $signature
  }
  Start-Sleep -Milliseconds $IntervalMs
}

$result = [ordered]@{
  version = 1
  startedAt = $startedAt.ToString("o")
  finishedAt = (Get-Date).ToString("o")
  durationSeconds = $DurationSeconds
  intervalMs = $IntervalMs
  peakSsh = $peakSsh
  peakGh = $peakGh
  peakCombined = $peakCombined
  transitions = $transitions
  processes = @($processes.Values | Sort-Object firstSeenAt, pid)
}
$result | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "Safe transport observation saved to $OutputPath"
