param(
  [ValidateRange(5, 3600)]
  [int]$DurationSeconds = 60,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "This evidence observer requires an elevated PowerShell session. No observer was registered."
}

$sourceId = "ClawdIssue694ProcessStart-$PID-$([Guid]::NewGuid().ToString('N'))"
$records = New-Object System.Collections.Generic.List[object]

function Write-EvidenceRecord {
  param([object]$Record)
  $json = $Record | ConvertTo-Json -Compress
  Write-Output $json
  if ($OutputPath) { Add-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8 }
}

try {
  Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier $sourceId | Out-Null

  # Positive control: a hidden PowerShell child whose parent is this observer.
  # It exits from inside its own session; no shared Windows Terminal process is
  # terminated or cleaned up by PID.
  Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList @("-NoProfile", "-Command", "exit 0") -WindowStyle Hidden -Wait

  $canaryDeadline = (Get-Date).AddSeconds(5)
  $canary = $null
  while (-not $canary -and (Get-Date) -lt $canaryDeadline) {
    $event = Wait-Event -SourceIdentifier $sourceId -Timeout 1
    if (-not $event) { continue }
    $payload = $event.SourceEventArgs.NewEvent
    Remove-Event -EventIdentifier $event.EventIdentifier
    $record = [ordered]@{
      at = (Get-Date).ToUniversalTime().ToString("o")
      processName = [string]$payload.ProcessName
      processId = [int]$payload.ProcessID
      parentProcessId = [int]$payload.ParentProcessID
      kind = if ([int]$payload.ParentProcessID -eq $PID -and [string]$payload.ProcessName -match "^(powershell|pwsh)\.exe$") { "canary" } else { "observed" }
    }
    $records.Add($record)
    if ($record.kind -eq "canary") { $canary = $record }
  }
  if (-not $canary) {
    throw "Observer registered, but the contemporaneous PowerShell canary was not captured. This evidence run is invalid."
  }

  Write-EvidenceRecord ([ordered]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    kind = "ready"
    elevated = $true
    observerPid = $PID
    canaryPid = $canary.processId
    durationSeconds = $DurationSeconds
  })

  $deadline = (Get-Date).AddSeconds($DurationSeconds)
  while ((Get-Date) -lt $deadline) {
    $event = Wait-Event -SourceIdentifier $sourceId -Timeout 1
    if (-not $event) { continue }
    $payload = $event.SourceEventArgs.NewEvent
    Remove-Event -EventIdentifier $event.EventIdentifier
    $processName = [string]$payload.ProcessName
    if ($processName -notmatch "^(powershell|pwsh)\.exe$") { continue }
    $parentPid = [int]$payload.ParentProcessID
    $parentName = $null
    try { $parentName = (Get-Process -Id $parentPid -ErrorAction Stop).ProcessName } catch {}
    Write-EvidenceRecord ([ordered]@{
      at = (Get-Date).ToUniversalTime().ToString("o")
      kind = if ($parentName -eq "node") { "node-powershell" } else { "powershell" }
      processName = $processName
      processId = [int]$payload.ProcessID
      parentProcessId = $parentPid
      parentName = $parentName
    })
  }
} finally {
  Unregister-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue
  Get-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
}
