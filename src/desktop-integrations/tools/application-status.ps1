$ErrorActionPreference = 'Stop'
$value = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (-not [IO.Path]::IsPathRooted($value.executable)) { throw 'Absolute application path required' }
$target = [IO.Path]::GetFullPath($value.executable)
$running = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($target)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $target }).Count -gt 0
@{ installed = [bool](Test-Path -LiteralPath $target -PathType Leaf); running = [bool]$running } | ConvertTo-Json -Compress
