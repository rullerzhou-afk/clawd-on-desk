param([string]$OutputDirectory = (Join-Path $PSScriptRoot '.native'))
$ErrorActionPreference = 'Stop'
# Run with Windows PowerShell 5.1; use the framework's UIA assemblies, not a vendor DLL.
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path -LiteralPath $framework)) { $framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319' }
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is unavailable' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$references = @('System.Web.Extensions.dll', (Join-Path $framework 'WPF\UIAutomationClient.dll'), (Join-Path $framework 'WPF\UIAutomationTypes.dll'), (Join-Path $framework 'WPF\WindowsBase.dll'))
foreach ($name in @('library-native', 'desktop-lyrics')) {
  $arguments = @('/nologo','/target:exe','/platform:anycpu',('/out:' + (Join-Path $output ($name + '.exe'))))
  $arguments += $references | ForEach-Object { '/reference:' + $_ }
  $arguments += Join-Path $PSScriptRoot ($name + '.cs')
  & $compiler @arguments
  if ($LASTEXITCODE -ne 0) { throw "Native helper compilation failed: $name" }
}
Write-Output 'Built source-owned helpers; generated executables remain ignored.'
