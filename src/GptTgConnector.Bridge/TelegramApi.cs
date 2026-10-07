using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GptTgConnector.Bridge;

public sealed class TelegramApi(
    HttpClient http,
    BridgeOptions options,
    ILogger<TelegramApi> logger)
{
    private readonly string _baseUrl = string.IsNullOrWhiteSpace(options.TelegramBotToken)
        ? string.Empty
        : $"https://api.telegram.org/bot{options.TelegramBotToken}/";

    public bool IsConfigured => !string.IsNullOrWhiteSpace(_baseUrl);

    public async Task<IReadOnlyList<TelegramUpdate>> GetUpdatesAsync(
        long offset,
        CancellationToken ct)
    {
        if (!IsConfigured) return [];

        using var response = await http.GetAsync(
            $"{_baseUrl}getUpdates?offset={offset}&timeout={options.TelegramPollTimeoutSeconds}&allowed_updates=%5B%22message%22%5D",
            ct);

        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);

        var payload = await JsonSerializer.DeserializeAsync<TelegramResponse<List<TelegramUpdate>>>(
            stream,
            Protocol.Json,
            ct);

        return payload?.Ok == true && payload.Result is not null
            ? payload.Result
            : [];
    }

    public async Task SendMessageAsync(
        long chatId,
        string text,
        CancellationToken ct)
    {
        if (!IsConfigured || string.IsNullOrWhiteSpace(text)) return;

        var max = Math.Clamp(options.TelegramMessageChunkSize, 1000, 4000);

        foreach (var chunk in Split(text, max))
        {
            await SendRawAsync(chatId, chunk, parseMode: null, ct);
        }
    }

    public async Task SendFormattedMessageAsync(
        long chatId,
        string html,
        string fallbackText,
        CancellationToken ct)
    {
        if (!IsConfigured) return;

        var max = Math.Clamp(options.TelegramMessageChunkSize, 1000, 3800);
        var formatted = html?.Trim() ?? string.Empty;

        if (formatted.Length == 0 || formatted.Length > max)
        {
            await SendMessageAsync(chatId, fallbackText, ct);
            return;
        }

        var sent = await SendRawAsync(chatId, formatted, "HTML", ct);

        if (!sent)
        {
            logger.LogWarning(
                "Falling back to plain Telegram text after formatted send failed.");
            await SendMessageAsync(chatId, fallbackText, ct);
        }
    }

    private async Task<bool> SendRawAsync(
        long chatId,
        string text,
        string? parseMode,
        CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync(
            $"{_baseUrl}sendMessage",
            new
            {
                chat_id = chatId,
                text,
                parse_mode = parseMode,
                disable_web_page_preview = true
            },
            Protocol.Json,
            ct);

        if (response.IsSuccessStatusCode)
            return true;

        var body = await response.Content.ReadAsStringAsync(ct);

        logger.LogWarning(
            "Telegram sendMessage failed: {Status} {Body}",
            response.StatusCode,
            body);

        return false;
    }

    private static IEnumerable<string> Split(string text, int max)
    {
        var remaining = text;

        while (remaining.Length > max)
        {
            var cut = remaining.LastIndexOf('\n', max - 1, max);

            if (cut < max / 2)
                cut = max;

            yield return remaining[..cut].TrimEnd();
            remaining = remaining[cut..].TrimStart('\r', '\n');
        }

        if (remaining.Length > 0)
            yield return remaining;
    }
}

public sealed record TelegramResponse<T>(bool Ok, T? Result);

public sealed class TelegramUpdate
{
    [JsonPropertyName("update_id")]
    public long UpdateId { get; set; }

    public TelegramMessage? Message { get; set; }
}

public sealed class TelegramMessage
{
    [JsonPropertyName("message_id")]
    public long MessageId { get; set; }

    public TelegramChat? Chat { get; set; }
    public TelegramUser? From { get; set; }
    public string? Text { get; set; }
}

public sealed class TelegramChat
{
    public long Id { get; set; }
}

public sealed class TelegramUser
{
    public long Id { get; set; }
}
