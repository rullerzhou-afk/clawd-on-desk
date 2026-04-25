param(
  [int]$DurationSeconds = 600,
  [double]$IntervalSeconds = 2,
  [string]$Pattern = 'Clawd on Desk|clawd-on-desk|src[\\/]+main\.js',
  [int[]]$RootPid,
  [string]$OutputPath,
  [switch]$Once,
  [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($IntervalSeconds -le 0) {
  throw "IntervalSeconds must be greater than zero."
}

if ($DurationSeconds -le 0 -and -not $Once) {
  throw "DurationSeconds must be greater than zero."
}

if (-not $OutputPath) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputPath = Join-Path "logs" "clawd-power-$timestamp.csv"
}

$outputDir = Split-Path -Parent $OutputPath
if ($outputDir) {
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

function Get-AllProcessRows {
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
}

function Get-CandidateProcessRows {
  $rows = Get-AllProcessRows |
    Where-Object {
      $_.Name -eq "Clawd on Desk.exe" -or
      (
        ($_.Name -eq "electron.exe" -or $_.Name -eq "node.exe") -and
        $_.CommandLine -and
        $_.CommandLine -match $Pattern
      )
    }

  return @($rows)
}

function Get-DescendantPids {
  param([int[]]$RootPids)

  if (-not $RootPids -or $RootPids.Count -eq 0) {
    return @()
  }

  $rows = Get-AllProcessRows
  $childrenByParent = @{}
  foreach ($row in $rows) {
    $parent = [int]$row.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parent)) {
      $childrenByParent[$parent] = New-Object System.Collections.Generic.List[int]
    }
    $childrenByParent[$parent].Add([int]$row.ProcessId)
  }

  $seen = @{}
  $queue = New-Object System.Collections.Generic.Queue[int]
  foreach ($root in $RootPids) {
    $queue.Enqueue([int]$root)
  }

  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if ($seen.ContainsKey($current)) {
      continue
    }
    $seen[$current] = $true
    if ($childrenByParent.ContainsKey($current)) {
      foreach ($child in $childrenByParent[$current]) {
        $queue.Enqueue($child)
      }
    }
  }

  return @($seen.Keys | ForEach-Object { [int]$_ })
}

function Get-TargetPids {
  if ($RootPid -and $RootPid.Count -gt 0) {
    return @(Get-DescendantPids -RootPids $RootPid)
  }

  $rows = Get-CandidateProcessRows | Where-Object {
    $_.Name -eq "Clawd on Desk.exe" -or
    ($_.CommandLine -and $_.CommandLine -match $Pattern)
  }

  return @($rows | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
}

function Get-BatterySnapshot {
  $battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
  $status = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue |
    Select-Object -First 1

  $powerOnline = $null
  $discharging = $null
  $rate = $null
  $remainingCapacity = $null
  $estimatedPercent = $null

  if ($status) {
    if ($status.PSObject.Properties["PowerOnline"]) {
      $powerOnline = [bool]$status.PowerOnline
    }
    if ($status.PSObject.Properties["Discharging"]) {
      $discharging = [bool]$status.Discharging
    }
    if ($status.PSObject.Properties["RemainingCapacity"]) {
      $remainingCapacity = $status.RemainingCapacity
    }
    if ($status.PSObject.Properties["Rate"]) {
      $rate = $status.Rate
    }
  }

  if ($battery) {
    if ($battery.PSObject.Properties["EstimatedChargeRemaining"]) {
      $estimatedPercent = $battery.EstimatedChargeRemaining
    }
  }

  return [pscustomobject]@{
    PowerOnline = $powerOnline
    Discharging = $discharging
    RateMilliwatts = $rate
    RemainingCapacity = $remainingCapacity
    EstimatedChargePercent = $estimatedPercent
  }
}

function Get-SampleSnapshot {
  $targetPids = @(Get-TargetPids)
  $processes = @()
  if ($targetPids.Count -gt 0) {
    $processes = @(Get-Process -Id $targetPids -ErrorAction SilentlyContinue)
  }

  $cpuByPid = @{}
  foreach ($proc in $processes) {
    $cpuValue = 0.0
    if ($null -ne $proc.CPU) {
      $cpuValue = [double]$proc.CPU
    }
    $cpuByPid[[int]$proc.Id] = $cpuValue
  }

  return [pscustomobject]@{
    At = Get-Date
    Pids = $targetPids
    Processes = $processes
    CpuByPid = $cpuByPid
  }
}

function New-OutputRow {
  param(
    [object]$Previous,
    [object]$Current
  )

  $elapsed = ($Current.At - $Previous.At).TotalSeconds
  if ($elapsed -le 0) {
    $elapsed = $IntervalSeconds
  }

  $cpuDelta = 0.0
  foreach ($proc in $Current.Processes) {
    $pidValue = [int]$proc.Id
    if ($Previous.CpuByPid.ContainsKey($pidValue)) {
      $cpuValue = 0.0
      if ($null -ne $proc.CPU) {
        $cpuValue = [double]$proc.CPU
      }
      $processCpuDelta = $cpuValue - [double]$Previous.CpuByPid[$pidValue]
      if ($processCpuDelta -gt 0) {
        $cpuDelta += $processCpuDelta
      }
    }
  }

  $cpuOneCore = 100.0 * $cpuDelta / $elapsed
  $cpuSystem = $cpuOneCore / [Environment]::ProcessorCount
  $battery = Get-BatterySnapshot

  $workingSetMeasure = $Current.Processes | Measure-Object WorkingSet64 -Sum
  $privateMeasure = $Current.Processes | Measure-Object PrivateMemorySize64 -Sum
  $workingSetBytes = 0
  $privateBytes = 0
  if ($workingSetMeasure -and $workingSetMeasure.PSObject.Properties["Sum"] -and $null -ne $workingSetMeasure.Sum) {
    $workingSetBytes = $workingSetMeasure.Sum
  }
  if ($privateMeasure -and $privateMeasure.PSObject.Properties["Sum"] -and $null -ne $privateMeasure.Sum) {
    $privateBytes = $privateMeasure.Sum
  }
  $details = ($Current.Processes |
    Sort-Object Id |
    ForEach-Object {
      $cpuValue = 0.0
      if ($null -ne $_.CPU) {
        $cpuValue = [double]$_.CPU
      }
      $pidValue = [int]$_.Id
      $pidCpuDelta = 0.0
      if ($Previous.CpuByPid.ContainsKey($pidValue)) {
        $pidCpuDelta = [math]::Max(0.0, $cpuValue - [double]$Previous.CpuByPid[$pidValue])
      }
      $pidCpuOneCore = 100.0 * $pidCpuDelta / $elapsed
      "pid=$($_.Id) deltaCpuSeconds=$([math]::Round($pidCpuDelta, 4)) cpuOneCorePercent=$([math]::Round($pidCpuOneCore, 2)) cpuSeconds=$([math]::Round($cpuValue, 2)) wsMB=$([math]::Round($_.WorkingSet64 / 1MB, 1)) privateMB=$([math]::Round($_.PrivateMemorySize64 / 1MB, 1)) name=$($_.ProcessName)"
    }) -join " ; "

  return [pscustomobject]@{
    timestamp = $Current.At.ToString("yyyy-MM-dd HH:mm:ss")
    epoch = [int64](($Current.At.ToUniversalTime() - [datetime]"1970-01-01T00:00:00Z").TotalSeconds)
    elapsed_seconds = [math]::Round($elapsed, 3)
    power_online = $battery.PowerOnline
    discharging = $battery.Discharging
    battery_rate_mw = $battery.RateMilliwatts
    battery_remaining_capacity = $battery.RemainingCapacity
    battery_estimated_percent = $battery.EstimatedChargePercent
    pid_count = $Current.Processes.Count
    pids = ($Current.Pids -join "|")
    cpu_seconds_delta = [math]::Round($cpuDelta, 4)
    cpu_percent_one_core = [math]::Round($cpuOneCore, 2)
    cpu_percent_system = [math]::Round($cpuSystem, 2)
    working_set_mb = [math]::Round($workingSetBytes / 1MB, 1)
    private_mb = [math]::Round($privateBytes / 1MB, 1)
    logical_processors = [Environment]::ProcessorCount
    details = $details
  }
}

if (-not $Quiet) {
  Write-Host "Monitoring Clawd power/resource proxy metrics."
  Write-Host "Output: $OutputPath"
  Write-Host "Pattern: $Pattern"
  if ($RootPid) {
    Write-Host "Root PID(s): $($RootPid -join ', ')"
  }
}

$started = Get-Date
$previous = Get-SampleSnapshot
$wroteHeader = $false

while ($true) {
  Start-Sleep -Milliseconds ([int]($IntervalSeconds * 1000))
  $current = Get-SampleSnapshot
  $row = New-OutputRow -Previous $previous -Current $current

  if ($wroteHeader) {
    $row | Export-Csv -Path $OutputPath -NoTypeInformation -Append
  } else {
    $row | Export-Csv -Path $OutputPath -NoTypeInformation
    $wroteHeader = $true
  }

  if (-not $Quiet) {
    Write-Host ("[{0}] pids={1} cpu={2}% system/{3}% one-core mem={4}MB powerOnline={5} rateMw={6}" -f
      $row.timestamp,
      $row.pid_count,
      $row.cpu_percent_system,
      $row.cpu_percent_one_core,
      $row.working_set_mb,
      $row.power_online,
      $row.battery_rate_mw)
  }

  $previous = $current

  if ($Once) {
    break
  }

  if (((Get-Date) - $started).TotalSeconds -ge $DurationSeconds) {
    break
  }
}

if (-not $Quiet) {
  Write-Host "Monitoring stopped. CSV saved at: $OutputPath"
}
