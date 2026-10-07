$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Join-Path $repoRoot "src\GptTgConnector.Bridge"
$configPath = Join-Path $projectDir "appsettings.Local.json"

Write-Host ""
Write-Host "GPT TG Connector setup" -ForegroundColor Cyan
Write-Host "This file stays local and is ignored by Git." -ForegroundColor DarkGray
Write-Host ""

$token = Read-Host "Telegram bot token"
if ([string]::IsNullOrWhiteSpace($token)) {
    throw "Bot token cannot be empty."
}

$chatIdText = Read-Host "Allowed Telegram chat_id"
$userIdText = Read-Host "Allowed Telegram user_id"

$chatId = 0L
$userId = 0L

if (-not [long]::TryParse($chatIdText, [ref]$chatId)) {
    throw "chat_id must be a number. Send /id to the bot to see it."
}
if (-not [long]::TryParse($userIdText, [ref]$userId)) {
    throw "user_id must be a number. Send /id to the bot to see it."
}

$config = @{
    Bridge = @{
        Port = 8765
        TelegramBotToken = $token
        AllowedChatId = $chatId
        AllowedUserId = $userId
        TelegramPollTimeoutSeconds = 30
        TelegramMessageChunkSize = 3500
    }
}

$config | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8

Write-Host ""
Write-Host "Saved:" -ForegroundColor Green
Write-Host $configPath
Write-Host ""
Write-Host "Now run:" -ForegroundColor Cyan
Write-Host ".\start.ps1"
