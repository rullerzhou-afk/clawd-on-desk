param([string]$CockpitExecutable='', [string]$CCSwitchExecutable='')
$ErrorActionPreference = 'Stop'
$definitions = @(
  @{ id = 'cockpit'; name = 'Cockpit Tools'; executable = $CockpitExecutable; processName = 'cockpit-tools' },
  @{ id = 'ccswitch'; name = 'CC Switch'; executable = $CCSwitchExecutable; processName = 'cc-switch' }
)
$tools = @()
foreach ($definition in $definitions) {
  if (-not $definition.executable) { $tools += @{id=$definition.id;name=$definition.name;installed=$false;running=$false}; continue }
  if (-not [IO.Path]::IsPathRooted($definition.executable)) { throw 'An absolute executable path is required' }
  $resolvedExe = [IO.Path]::GetFullPath($definition.executable)
  $installed = Test-Path -LiteralPath $resolvedExe -PathType Leaf
  $running = @(Get-Process -Name $definition.processName -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $resolvedExe
  }).Count -gt 0
  $tools += @{ id = $definition.id; name = $definition.name; installed = [bool]$installed; running = [bool]$running }
}
@{ ok = $true; tools = $tools } | ConvertTo-Json -Compress -Depth 4
