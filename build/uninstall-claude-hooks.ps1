param(
  [string]$InstallDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
$ClawdPermissionPorts = @(23333, 23334, 23335, 23336, 23337)
$ClawdCommandMarkers = @("clawd-hook.js", "auto-start.js", "auto-start.sh")

function Normalize-PathForCompare {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $null }
  try {
    $fullPath = [System.IO.Path]::GetFullPath($PathValue.Trim().Trim('"'))
    $fullPath = $fullPath.Replace("/", "\")
    return ($fullPath -replace "\\+$", "").ToLowerInvariant()
  } catch {
    return $null
  }
}

function Resolve-PlausibleUserHome {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $null }

  $candidate = $PathValue.Trim().Trim('"')
  if (-not [System.IO.Path]::IsPathRooted($candidate)) { return $null }
  if (-not [System.IO.Directory]::Exists($candidate)) { return $null }

  $normalized = Normalize-PathForCompare $candidate
  if ([string]::IsNullOrWhiteSpace($normalized)) { return $null }

  $blockedRoots = @($env:SystemRoot, $env:windir)
  foreach ($blockedRoot in $blockedRoots) {
    $blocked = Normalize-PathForCompare $blockedRoot
    if ([string]::IsNullOrWhiteSpace($blocked)) { continue }
    if ($normalized -eq $blocked -or $normalized.StartsWith($blocked + "\")) { return $null }
  }

  if ($normalized -match "\\(systemprofile|localservice|networkservice)$") { return $null }
  if ($normalized -match "\\serviceprofiles\\(localservice|networkservice)$") { return $null }

  return [System.IO.Path]::GetFullPath($candidate)
}

function Test-ProcessElevated {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Read-TrimmedTextCandidates {
  param([string]$PathValue)
  $values = New-Object System.Collections.ArrayList
  $encodings = @($Utf8NoBom, [System.Text.Encoding]::Unicode, [System.Text.Encoding]::Default)

  foreach ($encoding in $encodings) {
    try {
      $value = [System.IO.File]::ReadAllText($PathValue, $encoding)
      if ([string]::IsNullOrWhiteSpace($value)) { continue }
      [void]$values.Add($value.TrimStart([char]0xFEFF).Trim())
    } catch {
    }
  }

  return [object[]]$values.ToArray()
}

function Resolve-TargetUserHome {
  $markerPath = Join-Path $InstallDir ".clawd-install-user-home"
  if ([System.IO.File]::Exists($markerPath)) {
    foreach ($candidateText in (Read-TrimmedTextCandidates $markerPath)) {
      $resolved = Resolve-PlausibleUserHome $candidateText
      if (-not [string]::IsNullOrWhiteSpace($resolved)) { return $resolved }
    }
  }

  if (-not (Test-ProcessElevated)) {
    return Resolve-PlausibleUserHome $env:USERPROFILE
  }

  return $null
}

function Get-JsonProperty {
  param(
    [object]$ObjectValue,
    [string]$Name
  )

  if ($null -eq $ObjectValue -or $null -eq $ObjectValue.PSObject) { return $null }
  $matches = $ObjectValue.PSObject.Properties.Match($Name)
  if ($matches.Count -eq 0) { return $null }
  return $matches[0]
}

function Get-StringPropertyValue {
  param(
    [object]$ObjectValue,
    [string]$Name
  )

  $property = Get-JsonProperty $ObjectValue $Name
  if ($null -eq $property -or -not ($property.Value -is [string])) { return $null }
  return $property.Value
}

function Test-ClawdCommand {
  param([string]$Command)
  if ([string]::IsNullOrWhiteSpace($Command)) { return $false }

  foreach ($marker in $ClawdCommandMarkers) {
    if ($Command.IndexOf($marker, [System.StringComparison]::Ordinal) -ge 0) {
      return $true
    }
  }

  return $false
}

function Test-ClawdPermissionUrl {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return $false }

  try {
    $uri = [System.Uri]$Url
    return $uri.IsAbsoluteUri `
      -and $uri.Scheme -eq "http" `
      -and $uri.Host -eq "127.0.0.1" `
      -and $uri.AbsolutePath -eq "/permission" `
      -and [string]::IsNullOrEmpty($uri.Query) `
      -and [string]::IsNullOrEmpty($uri.Fragment) `
      -and [string]::IsNullOrEmpty($uri.UserInfo) `
      -and ($ClawdPermissionPorts -contains $uri.Port)
  } catch {
    return $false
  }
}

function Test-ClawdHttpHook {
  param([object]$Hook)

  $type = Get-StringPropertyValue $Hook "type"
  if ($type -ne "http") { return $false }

  $url = Get-StringPropertyValue $Hook "url"
  return Test-ClawdPermissionUrl $url
}

function Remove-ClawdHooksFromEntries {
  param([object[]]$Entries)

  $nextEntries = New-Object System.Collections.ArrayList
  $removed = 0
  $changed = $false

  foreach ($entry in $Entries) {
    if ($null -eq $entry -or $null -eq $entry.PSObject) {
      [void]$nextEntries.Add($entry)
      continue
    }

    $entryCommand = Get-StringPropertyValue $entry "command"
    if (Test-ClawdCommand $entryCommand) {
      $removed++
      $changed = $true
      continue
    }

    if (Test-ClawdHttpHook $entry) {
      $removed++
      $changed = $true
      continue
    }

    $hooksProperty = Get-JsonProperty $entry "hooks"
    if ($null -eq $hooksProperty -or -not ($hooksProperty.Value -is [System.Array])) {
      [void]$nextEntries.Add($entry)
      continue
    }

    $nextHooks = New-Object System.Collections.ArrayList
    $entryHooksChanged = $false

    foreach ($hook in ([object[]]$hooksProperty.Value)) {
      $removeHook = $false
      if ($null -ne $hook -and $null -ne $hook.PSObject) {
        $hookCommand = Get-StringPropertyValue $hook "command"
        if (Test-ClawdCommand $hookCommand) {
          $removeHook = $true
        } elseif (Test-ClawdHttpHook $hook) {
          $removeHook = $true
        }
      }

      if ($removeHook) {
        $removed++
        $changed = $true
        $entryHooksChanged = $true
      } else {
        [void]$nextHooks.Add($hook)
      }
    }

    if ($entryHooksChanged) {
      $nextHookArray = [object[]]$nextHooks.ToArray()
      $entryType = Get-StringPropertyValue $entry "type"
      if ($nextHookArray.Count -eq 0 -and [string]::IsNullOrEmpty($entryCommand) -and $entryType -ne "http") {
        continue
      }
      $hooksProperty.Value = [object[]]$nextHookArray
    }

    [void]$nextEntries.Add($entry)
  }

  return [pscustomobject]@{
    Entries = [object[]]$nextEntries.ToArray()
    Removed = $removed
    Changed = $changed
  }
}

function Remove-ClawdHooksFromSettings {
  param([object]$Settings)

  $hooksProperty = Get-JsonProperty $Settings "hooks"
  if ($null -eq $hooksProperty -or $null -eq $hooksProperty.Value -or $null -eq $hooksProperty.Value.PSObject) {
    return $false
  }

  $changed = $false
  $eventProperties = @($hooksProperty.Value.PSObject.Properties)

  foreach ($eventProperty in $eventProperties) {
    if (-not ($eventProperty.Value -is [System.Array])) { continue }

    $result = Remove-ClawdHooksFromEntries -Entries ([object[]]$eventProperty.Value)
    if (-not $result.Changed) { continue }

    $changed = $true
    $nextEntries = [object[]]$result.Entries
    if ($nextEntries.Count -gt 0) {
      $eventProperty.Value = [object[]]$nextEntries
    } else {
      $hooksProperty.Value.PSObject.Properties.Remove($eventProperty.Name)
    }
  }

  return $changed
}

try {
  $userHome = Resolve-TargetUserHome
  if ([string]::IsNullOrWhiteSpace($userHome)) { exit 0 }

  $settingsPath = Join-Path (Join-Path $userHome ".claude") "settings.json"
  if (-not [System.IO.File]::Exists($settingsPath)) { exit 0 }

  $rawSettings = [System.IO.File]::ReadAllText($settingsPath, $Utf8NoBom)
  $rawSettings = $rawSettings.TrimStart([char]0xFEFF)
  try {
    $settings = ConvertFrom-Json -InputObject $rawSettings
  } catch {
    exit 0
  }

  if ($null -eq $settings) { exit 0 }
  if (-not (Remove-ClawdHooksFromSettings $settings)) { exit 0 }

  $backupName = "settings.json.clawd-uninstall-{0}.bak" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff")
  $backupPath = Join-Path (Split-Path -Parent $settingsPath) $backupName
  [System.IO.File]::Copy($settingsPath, $backupPath, $false)

  $json = ConvertTo-Json -InputObject $settings -Depth 100
  [System.IO.File]::WriteAllText($settingsPath, $json + [Environment]::NewLine, $Utf8NoBom)
  exit 0
} catch {
  exit 0
}
