$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $repoRoot "src\GptTgConnector.Bridge\GptTgConnector.Bridge.csproj"
$config = Join-Path $repoRoot "src\GptTgConnector.Bridge\appsettings.Local.json"

Set-Location $repoRoot

function Test-GitAvailable {
    try {
        & git --version *> $null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

function Invoke-AutoUpdate {
    if (-not (Test-GitAvailable)) {
        Write-Host "Git not found. Starting current local version." -ForegroundColor Yellow
        return
    }

    & git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Not running from a Git checkout. Starting current local version." -ForegroundColor Yellow
        return
    }

    $branch = (& git branch --show-current 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) {
        Write-Host "Could not determine current Git branch. Starting current local version." -ForegroundColor Yellow
        return
    }

    if ($branch -ne "main") {
        Write-Host "Auto-update skipped: current branch is '$branch' (expected 'main')." -ForegroundColor Yellow
        return
    }

    $changes = @(& git status --porcelain --untracked-files=normal 2>$null)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not inspect working tree. Starting current local version." -ForegroundColor Yellow
        return
    }

    if ($changes.Count -gt 0) {
        Write-Host "Auto-update skipped: local repository has uncommitted changes." -ForegroundColor Yellow
        Write-Host "Your files were not modified."
        return
    }

    $before = (& git rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not read current commit. Starting current local version." -ForegroundColor Yellow
        return
    }

    Write-Host "Checking for updates..." -ForegroundColor Cyan
    & git fetch origin main --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Update check failed (offline or GitHub unavailable). Starting current local version." -ForegroundColor Yellow
        return
    }

    $remote = (& git rev-parse origin/main 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remote)) {
        Write-Host "Could not read origin/main. Starting current local version." -ForegroundColor Yellow
        return
    }

    if ($before -eq $remote) {
        Write-Host "Already up to date." -ForegroundColor DarkGray
        return
    }

    & git merge-base --is-ancestor $before $remote *> $null
    if ($LASTEXITCODE -ne 0) {
        & git merge-base --is-ancestor $remote $before *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Local main is ahead of origin/main. Auto-update skipped." -ForegroundColor Yellow
        }
        else {
            Write-Host "Local main diverged from origin/main. Auto-update skipped for safety." -ForegroundColor Yellow
        }
        return
    }

    Write-Host "Update found. Installing..." -ForegroundColor Green
    & git merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Automatic update failed. Starting previous local version." -ForegroundColor Yellow
        return
    }

    $after = (& git rev-parse HEAD 2>$null).Trim()
    Write-Host "Updated: $($before.Substring(0, 7)) -> $($after.Substring(0, 7))" -ForegroundColor Green

    $extensionChanges = @(& git diff --name-only "$before..$after" -- extension/ 2>$null)
    if ($LASTEXITCODE -eq 0 -and $extensionChanges.Count -gt 0) {
        Write-Host ""
        Write-Host "Edge extension was updated." -ForegroundColor Yellow
        Write-Host "Reload 'GPT TG Connector' once in edge://extensions before using it." -ForegroundColor Yellow
        Write-Host ""
    }
}

Invoke-AutoUpdate

if (-not (Test-Path $config)) {
    Write-Host "Local config not found." -ForegroundColor Yellow
    Write-Host "Run .\setup.ps1 first."
    exit 1
}

dotnet run --project $project
