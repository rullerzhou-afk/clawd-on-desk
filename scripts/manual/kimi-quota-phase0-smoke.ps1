[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [switch]$QuietWindowConfirmed,

  [ValidateRange(1, 3)]
  [int]$Samples = 3,

  [ValidateRange(5, 600)]
  [int]$IntervalSeconds = 60,

  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $QuietWindowConfirmed) {
  throw "Close other Kimi activity, then pass -QuietWindowConfirmed."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required."
}

$scriptPath = Join-Path $PSScriptRoot "kimi-quota-phase0-smoke.js"
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  throw "Missing Node smoke helper: $scriptPath"
}

Write-Host "This sends $Samples manual GET request(s) to the fixed Kimi Code usage endpoint."
Write-Host "The API Key is hidden, passed on stdin, and never written to the report."
$secureKey = Read-Host "Dedicated Kimi Code API Key" -AsSecureString
$plainKey = [System.Net.NetworkCredential]::new("", $secureKey).Password

try {
  $arguments = @(
    $scriptPath,
    "--key-stdin",
    "--quiet-window-confirmed",
    "--samples", $Samples,
    "--interval-seconds", $IntervalSeconds
  )
  if ($OutputPath) {
    $arguments += @("--output", [IO.Path]::GetFullPath($OutputPath))
  }
  $plainKey | & node @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Kimi quota Phase 0 smoke exited with code $LASTEXITCODE."
  }
} finally {
  $plainKey = $null
  if ($secureKey -is [IDisposable]) {
    $secureKey.Dispose()
  }
}
