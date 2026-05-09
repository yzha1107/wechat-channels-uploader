param(
  [string]$RepoUrl = "https://github.com/yzha1107/wechat-channels-uploader.git",
  [string]$Branch = "master",
  [switch]$Prompt,
  [switch]$Strict
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$VersionFile = Join-Path $Root ".update-version"
$ArchiveUrl = $RepoUrl -replace "\.git$", ""
$ArchiveUrl = "$ArchiveUrl/archive/refs/heads/$Branch.zip"
$RepoApi = ($RepoUrl -replace "\.git$", "") -replace "^https://github\.com/", "https://api.github.com/repos/"

function Write-Step($Message) {
  Write-Host "[INFO] $Message"
}

function Write-Warn($Message) {
  Write-Host "[WARN] $Message"
}

function Finish-Warn($Message) {
  Write-Warn $Message
  if ($Strict) { exit 1 }
  exit 0
}

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Confirm-Update($Message) {
  if (-not $Prompt) { return $true }
  Write-Host $Message
  $answer = Read-Host "Update now? [Y/n]"
  return ($answer -eq "" -or $answer -match "^(y|yes)$")
}

function Get-RemoteHeadSha {
  try {
    $commit = Invoke-RestMethod -Uri "$RepoApi/commits/$Branch" -UseBasicParsing
    return [string]$commit.sha
  } catch {
    Finish-Warn "Could not check latest version: $($_.Exception.Message)"
  }
}

function Invoke-GitUpdate {
  if (-not (Test-Command "git")) {
    Finish-Warn "Git not found; trying zip update instead is not possible from a Git checkout."
  }

  Push-Location $Root
  try {
    git remote get-url origin *> $null
    if ($LASTEXITCODE -ne 0) {
      Finish-Warn "Git remote origin is not configured."
    }

    git diff --quiet -- .
    if ($LASTEXITCODE -ne 0) {
      Finish-Warn "Local code has changes; skipped update to avoid conflicts."
    }

    Write-Step "Fetching latest code from GitHub..."
    git fetch --prune origin
    if ($LASTEXITCODE -ne 0) {
      Finish-Warn "Could not reach GitHub."
    }

    $currentBranch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
    if (-not $currentBranch) { $currentBranch = $Branch }

    git rev-parse --verify "origin/$currentBranch" *> $null
    if ($LASTEXITCODE -ne 0) {
      Finish-Warn "Remote branch origin/$currentBranch was not found."
    }

    $localCommit = (git rev-parse HEAD).Trim()
    $remoteCommit = (git rev-parse "origin/$currentBranch").Trim()
    if ($localCommit -eq $remoteCommit) {
      Write-Host "[ OK ] Already up to date"
      return
    }

    $localShort = $localCommit.Substring(0, 7)
    $remoteShort = $remoteCommit.Substring(0, 7)
    if (-not (Confirm-Update "New version found: $localShort -> $remoteShort")) {
      Write-Host "[INFO] Update skipped by user."
      return
    }

    Write-Step "Pulling updates..."
    git pull --ff-only origin $currentBranch
    if ($LASTEXITCODE -ne 0) {
      Finish-Warn "Git pull failed."
    }

    Write-Host "[ OK ] Updated from Git"
  } finally {
    Pop-Location
  }
}

function Invoke-ZipUpdate {
  $remoteCommit = Get-RemoteHeadSha
  $localCommit = ""
  if (Test-Path -LiteralPath $VersionFile) {
    $localCommit = (Get-Content -LiteralPath $VersionFile -Raw -ErrorAction SilentlyContinue).Trim()
  }

  if ($localCommit -and $localCommit -eq $remoteCommit) {
    Write-Host "[ OK ] Already up to date"
    return
  }

  if ($localCommit) {
    $localShort = $localCommit.Substring(0, [Math]::Min(7, $localCommit.Length))
    $remoteShort = $remoteCommit.Substring(0, [Math]::Min(7, $remoteCommit.Length))
    if (-not (Confirm-Update "New version found: $localShort -> $remoteShort")) {
      Write-Host "[INFO] Update skipped by user."
      return
    }
  } else {
    if (-not (Confirm-Update "Current package version is unknown. Check and apply the latest GitHub version?")) {
      Write-Host "[INFO] Update skipped by user."
      return
    }
  }

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("wechat-uploader-update-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempRoot "source.zip"
  $extractPath = Join-Path $tempRoot "source"

  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  try {
    Write-Step "Downloading latest code zip from GitHub..."
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $zipPath -UseBasicParsing

    Write-Step "Extracting update package..."
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
    $source = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
    if (-not $source) {
      Finish-Warn "Downloaded zip did not contain source files."
    }

    Write-Step "Applying update while preserving local data..."
    $excludeDirs = @(
      ".git", "node_modules", "browser-profile", "browser-profile-*",
      "uploads", "screenshots", "runtime", "installers", ".claude"
    )
    $excludeFiles = @(
      "accounts.json", "results.csv", "upload.log", "batch-config.csv",
      "test-batch.csv", ".update-version", "*.log", "*.xlsx"
    )

    $args = @(
      $source.FullName, $Root, "/MIR", "/R:2", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
      "/XD"
    ) + $excludeDirs + @("/XF") + $excludeFiles

    & robocopy @args | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
      Finish-Warn "File copy failed with robocopy code $code."
    }

    Set-Content -LiteralPath $VersionFile -Value $remoteCommit -Encoding ASCII
    Write-Host "[ OK ] Updated from GitHub zip"
  } catch {
    Finish-Warn $_.Exception.Message
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  if (Test-Path -LiteralPath (Join-Path $Root ".git")) {
    Invoke-GitUpdate
  } else {
    Invoke-ZipUpdate
  }
} catch {
  Finish-Warn $_.Exception.Message
}
