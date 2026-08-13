[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Repository,

  [string]$Branch = "main",
  [string]$Machine = "basicLinux32gb",
  [string]$ExistingCodespace = "",
  [string]$EvidenceRoot = "",
  [switch]$KeepCodespace,
  [switch]$SkipApp
)

$ErrorActionPreference = "Stop"
$script:CreatedCodespace = $false
$script:CreatedDisplayName = ""
$script:CodespaceName = $ExistingCodespace.Trim()
$script:Evidence = [ordered]@{
  version = 1
  issue = 546
  startedAt = (Get-Date).ToString("o")
  repository = $Repository
  branch = $Branch
  codespace = $null
  steps = @()
  processSamples = @()
}

function Add-Step {
  param([string]$Id, [string]$Status, [string]$Detail = "")
  $script:Evidence.steps += [ordered]@{
    id = $Id
    status = $Status
    detail = $Detail
    at = (Get-Date).ToString("o")
  }
}

function Get-Sha256Text {
  param([string]$Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $hash = [Security.Cryptography.SHA256]::HashData($bytes)
  return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Get-TestTransportProcesses {
  param([string]$Codespace, [string]$Stage)
  $safe = @()
  if (-not $Codespace) { return $safe }
  $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.Name -ieq "ssh.exe" -or $_.Name -ieq "gh.exe") -and
      $_.CommandLine -and $_.CommandLine.Contains($Codespace)
    }
  foreach ($process in $processes) {
    $role = if ($process.Name -ieq "gh.exe" -and $process.CommandLine -match "--stdio(?:\s|$)") {
      "codespaces-stdio-proxy"
    } elseif ($process.Name -ieq "ssh.exe") {
      "openssh-client"
    } else {
      "test-transport"
    }
    $safe += [ordered]@{
      stage = $Stage
      at = (Get-Date).ToString("o")
      pid = [int]$process.ProcessId
      image = $process.Name
      role = $role
      commandHash = Get-Sha256Text $process.CommandLine
    }
  }
  return $safe
}

function Invoke-Gh {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & gh @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gh $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
  return $output
}

function Save-Evidence {
  param([string]$Path)
  $script:Evidence.finishedAt = (Get-Date).ToString("o")
  $script:Evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding utf8
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) is required"
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw "Windows OpenSSH (ssh) is required"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $EvidenceRoot) {
  $EvidenceRoot = Join-Path ([IO.Path]::GetTempPath()) "clawd-546-evidence-$stamp"
}
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null
$evidencePath = Join-Path $EvidenceRoot "evidence.json"
$harnessHome = Join-Path $EvidenceRoot "home"
$electronUserData = Join-Path $harnessHome "electron-user-data"
$sshDir = Join-Path $harnessHome ".ssh"
$sshConfig = Join-Path $sshDir "config"
$knownHosts = Join-Path $sshDir "known_hosts"
New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
New-Item -ItemType Directory -Path $electronUserData -Force | Out-Null

try {
  $auth = Invoke-Gh auth status 2>&1
  if (($auth -join "`n") -notmatch "codespace") {
    throw "gh auth status does not show the codespace scope"
  }
  Add-Step "prerequisites" "pass" "gh auth and local tools are available"

  if (-not $script:CodespaceName) {
    $displayName = "clawd-546-$stamp"
    Invoke-Gh codespace create --repo $Repository --branch $Branch --machine $Machine --retention-period 24h --display-name $displayName | Out-Null
    # Record ownership immediately after a successful create. If any later
    # discovery step fails, finally can recover the exact resource by this
    # unique display name without touching unrelated Codespaces.
    $script:CreatedCodespace = $true
    $script:CreatedDisplayName = $displayName
    $listed = Invoke-Gh codespace list --repo $Repository --json "name,displayName,state" | ConvertFrom-Json
    $created = $listed |
      Where-Object { $_.displayName -eq $displayName } |
      Select-Object -First 1
    if (-not $created -or -not $created.name) {
      throw "Could not resolve the exact temporary Codespace name"
    }
    $script:CodespaceName = $created.name
    Add-Step "codespace-create" "pass" $displayName
  } else {
    Add-Step "codespace-create" "skip" "using caller-supplied Codespace"
  }
  $script:Evidence.codespace = $script:CodespaceName

  $configLines = Invoke-Gh codespace ssh --codespace $script:CodespaceName --config
  $configLines | Set-Content -LiteralPath $sshConfig -Encoding utf8
  $hostLine = $configLines | Where-Object { $_ -match '^\s*Host\s+([^*\s]+)\s*$' } | Select-Object -First 1
  if (-not $hostLine) { throw "Generated SSH config has no concrete Host alias" }
  $alias = ([regex]::Match($hostLine, '^\s*Host\s+(\S+)\s*$')).Groups[1].Value
  Add-Content -LiteralPath $sshConfig -Encoding utf8 -Value @(
    "",
    "Host $alias",
    "  UserKnownHostsFile $($knownHosts.Replace('\', '/'))",
    "  StrictHostKeyChecking accept-new"
  )
  Add-Step "temporary-ssh-config" "pass" "generated under evidence directory"

  $nodeVersion = & ssh -F $sshConfig -o BatchMode=yes -o ConnectTimeout=30 $alias node -v
  if ($LASTEXITCODE -ne 0 -or ($nodeVersion -join "`n") -notmatch '^v\d+') {
    throw "V1 sequential node control failed"
  }
  Add-Step "V1" "pass" (($nodeVersion -join "`n").Trim())

  $previousInspectionConfig = $env:CLAWD_REMOTE_SSH_CONFIG_FILE
  try {
    $env:CLAWD_REMOTE_SSH_CONFIG_FILE = $sshConfig
    $classificationJson = & node -e "const {inspectEffectiveTransport}=require('./src/remote-ssh-transport'); inspectEffectiveTransport({host:process.argv[1]}).then(r=>process.stdout.write(JSON.stringify({mode:r.mode,kind:r.kind,key:r.key})),e=>{console.error(e&&e.message||e);process.exit(1)})" $alias
    if ($LASTEXITCODE -ne 0) { throw "production effective-transport inspection failed" }
    $classification = $classificationJson | ConvertFrom-Json
  } finally {
    if ($null -eq $previousInspectionConfig) {
      Remove-Item Env:CLAWD_REMOTE_SSH_CONFIG_FILE -ErrorAction SilentlyContinue
    } else {
      $env:CLAWD_REMOTE_SSH_CONFIG_FILE = $previousInspectionConfig
    }
  }
  if ($classification.mode -ne "serialized" -or $classification.kind -ne "codespaces-stdio") {
    throw "V2 production classifier did not identify the Codespaces stdio transport"
  }
  Add-Step "V2" "pass" "production classifier identified Codespaces stdio without recording raw config"

  $script:Evidence.processSamples += Get-TestTransportProcesses $script:CodespaceName "before-app"
  if (-not $SkipApp) {
    Write-Host ""
    Write-Host "Temporary Codespace: $($script:CodespaceName)"
    Write-Host "Temporary SSH alias: $alias"
    Write-Host "Evidence directory: $EvidenceRoot"
    Write-Host ""
    Write-Host "Clawd will start with a temporary USERPROFILE and Electron userData directory."
    Write-Host "In Settings > Remote SSH, create a profile whose Host is '$alias', then run V3-V14 from README.md."
    Write-Host "Exit Clawd normally when the checklist is complete; do not kill Terminal, ssh.exe, gh.exe, cmd.exe, OpenConsole, or conhost."
    $previousUserProfile = $env:USERPROFILE
    $previousSshConfigFile = $env:CLAWD_REMOTE_SSH_CONFIG_FILE
    try {
      $env:USERPROFILE = $harnessHome
      $env:CLAWD_REMOTE_SSH_CONFIG_FILE = $sshConfig
      & npm start -- "--user-data-dir=$electronUserData"
      if ($LASTEXITCODE -ne 0) { throw "npm start exited with code $LASTEXITCODE" }
    } finally {
      $env:USERPROFILE = $previousUserProfile
      if ($null -eq $previousSshConfigFile) {
        Remove-Item Env:CLAWD_REMOTE_SSH_CONFIG_FILE -ErrorAction SilentlyContinue
      } else {
        $env:CLAWD_REMOTE_SSH_CONFIG_FILE = $previousSshConfigFile
      }
    }
    Add-Step "V3-V14" "manual-unverified" "app exited; record each checklist result separately before marking complete"
  } else {
    Add-Step "V3-V14" "skip" "-SkipApp was specified"
  }

  Start-Sleep -Seconds 3
  $after = Get-TestTransportProcesses $script:CodespaceName "after-app"
  $script:Evidence.processSamples += $after
  if ($after.Count -eq 0) {
    Add-Step "V14-residue" "pass" "no exact Codespace transport process remains"
  } else {
    Add-Step "V14-residue" "fail" "$($after.Count) exact test transport process(es) remain; preserved for manual inspection"
    throw "Exact test-owned transport residue remains. It was not terminated; inspect the evidence and close it manually."
  }

  Save-Evidence $evidencePath
  Write-Host "Evidence saved to $evidencePath"
} finally {
  if ($script:CreatedCodespace -and -not $KeepCodespace) {
    $deleteName = $script:CodespaceName
    if (-not $deleteName -and $script:CreatedDisplayName) {
      try {
        $matches = @(Invoke-Gh codespace list --repo $Repository --json "name,displayName,state" |
          ConvertFrom-Json |
          Where-Object { $_.displayName -eq $script:CreatedDisplayName })
        if ($matches.Count -eq 1) {
          $deleteName = $matches[0].name
        } else {
          throw "Expected one exact display-name match, found $($matches.Count)"
        }
      } catch {
        Add-Step "codespace-delete-discovery" "fail" $_.Exception.Message
      }
    }
    if ($deleteName) {
      try {
        Invoke-Gh codespace delete --codespace $deleteName --force | Out-Null
        Add-Step "codespace-delete" "pass" $deleteName
      } catch {
        Add-Step "codespace-delete" "fail" $_.Exception.Message
        Write-Warning "Could not delete the exact temporary Codespace: $deleteName"
      }
    } else {
      Add-Step "codespace-delete" "fail" "exact created Codespace could not be resolved"
      Write-Warning "Could not resolve the exact temporary Codespace for deletion; no broad cleanup was attempted."
    }
  }
  try { Save-Evidence $evidencePath } catch {}
}
