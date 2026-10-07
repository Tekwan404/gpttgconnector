$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $repoRoot "src\GptTgConnector.Bridge\GptTgConnector.Bridge.csproj"
$config = Join-Path $repoRoot "src\GptTgConnector.Bridge\appsettings.Local.json"

if (-not (Test-Path $config)) {
    Write-Host "Local config not found." -ForegroundColor Yellow
    Write-Host "Run .\setup.ps1 first."
    exit 1
}

Set-Location $repoRoot
dotnet run --project $project
