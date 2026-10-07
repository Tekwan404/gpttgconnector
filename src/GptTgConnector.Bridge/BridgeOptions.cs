namespace GptTgConnector.Bridge;

public sealed class BridgeOptions
{
    public const string SectionName = "Bridge";

    public int Port { get; set; } = 8765;
    public string TelegramBotToken { get; set; } = string.Empty;
    public long AllowedChatId { get; set; }
    public long AllowedUserId { get; set; }
    public int TelegramPollTimeoutSeconds { get; set; } = 30;
    public int TelegramMessageChunkSize { get; set; } = 3500;
}
