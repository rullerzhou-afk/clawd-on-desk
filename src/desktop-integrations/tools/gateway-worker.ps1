param([ValidateSet('status','start','stop')][string]$Action = 'status', [Parameter(Mandatory=$true)][string]$GatewayExecutable, [ValidateRange(1,65535)][int]$HealthPort=7863)
$ErrorActionPreference = 'Stop'
$gatewayExe = [IO.Path]::GetFullPath($GatewayExecutable)
if (-not [IO.Path]::IsPathRooted($GatewayExecutable) -or [IO.Path]::GetFileName($gatewayExe) -ne 'wb2api.exe') { throw 'Configure an absolute wb2api.exe path' }
$gatewayRoot = [IO.Path]::GetDirectoryName($gatewayExe)
function Gateway-Processes {
  @(Get-Process -Name 'wb2api' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $gatewayExe })
}
function Gateway-State {
  $gatewayPort = $HealthPort
  $ownedProcesses = @(Gateway-Processes)
  $healthy = $false
  if ($ownedProcesses.Count -gt 0) {
    try { $healthResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$gatewayPort/healthz" -TimeoutSec 2 -UseBasicParsing -MaximumRedirection 0
      $healthBody = $healthResponse.Content | ConvertFrom-Json
      $healthy = $healthBody.service -eq 'workbuddy2api' -and $healthResponse.StatusCode -in @(200,503)
    } catch {}
  }
  @{ running = $ownedProcesses.Count -gt 0; healthy = [bool]$healthy; pids = @($ownedProcesses | ForEach-Object Id); port = $gatewayPort; panelUrl = "http://127.0.0.1:$gatewayPort/panel/" }
}
try {
  if ($Action -eq 'start' -and @(Gateway-Processes).Count -eq 0) {
    if (-not (Test-Path -LiteralPath $gatewayExe -PathType Leaf)) { throw '找不到喵云网关程序' }
    Start-Process -FilePath $gatewayExe -WorkingDirectory $gatewayRoot -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 12; $attempt++) { Start-Sleep -Milliseconds 300; $gatewayStatus = Gateway-State; if ($gatewayStatus.healthy) { break } }
  }
  if ($Action -eq 'stop') {
    foreach ($gatewayProcess in @(Gateway-Processes)) {
      $currentProcess = Get-Process -Id $gatewayProcess.Id -ErrorAction SilentlyContinue
      if ($currentProcess) {
        $null = $currentProcess.Handle
        if ($currentProcess.Path -and [IO.Path]::GetFullPath($currentProcess.Path) -eq $gatewayExe) { $currentProcess.Kill() }
        $currentProcess.Dispose()
      }
    }
    Start-Sleep -Milliseconds 300
  }
  @{ ok = $true; state = (Gateway-State) } | ConvertTo-Json -Compress -Depth 5
} catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }
