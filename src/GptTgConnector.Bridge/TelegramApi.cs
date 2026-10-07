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
            $"{_baseUrl}getUpdates?offset={offset}&timeout={options.TelegramPollTimeoutSeconds}&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D",
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
        await SendMessageTrackedAsync(chatId, text, ct);
    }

    public async Task<IReadOnlyList<long>> SendMessageTrackedAsync(
        long chatId,
        string text,
        CancellationToken ct,
        TelegramInlineKeyboardMarkup? replyMarkup = null,
        long? replyToMessageId = null)
    {
        if (!IsConfigured || string.IsNullOrWhiteSpace(text)) return [];

        var max = Math.Clamp(options.TelegramMessageChunkSize, 1000, 4000);
        var ids = new List<long>();
        var chunks = Split(text, max).ToArray();

        for (var index = 0; index < chunks.Length; index++)
        {
            var message = await SendRawAsync(
                chatId,
                chunks[index],
                parseMode: null,
                ct,
                replyMarkup: index == chunks.Length - 1 ? replyMarkup : null,
                replyToMessageId: index == 0 ? replyToMessageId : null);

            if (message is not null)
                ids.Add(message.MessageId);
        }

        return ids;
    }

    public async Task SendFormattedMessageAsync(
        long chatId,
        string html,
        string fallbackText,
        CancellationToken ct)
    {
        await SendFormattedMessageTrackedAsync(
            chatId,
            html,
            fallbackText,
            ct);
    }

    public async Task<IReadOnlyList<long>> SendFormattedMessageTrackedAsync(
        long chatId,
        string html,
        string fallbackText,
        CancellationToken ct,
        TelegramInlineKeyboardMarkup? replyMarkup = null,
        long? replyToMessageId = null)
    {
        if (!IsConfigured) return [];

        var max = Math.Clamp(options.TelegramMessageChunkSize, 1000, 3800);
        var formatted = html?.Trim() ?? string.Empty;

        if (formatted.Length == 0 || formatted.Length > max)
        {
            return await SendMessageTrackedAsync(
                chatId,
                fallbackText,
                ct,
                replyMarkup,
                replyToMessageId);
        }

        var sent = await SendRawAsync(
            chatId,
            formatted,
            "HTML",
            ct,
            replyMarkup,
            replyToMessageId);

        if (sent is not null)
            return [sent.MessageId];

        logger.LogWarning(
            "Falling back to plain Telegram text after formatted send failed.");

        return await SendMessageTrackedAsync(
            chatId,
            fallbackText,
            ct,
            replyMarkup,
            replyToMessageId);
    }

    public async Task<IReadOnlyList<long>> SendMessageWithKeyboardAsync(
        long chatId,
        string text,
        TelegramInlineKeyboardMarkup keyboard,
        CancellationToken ct)
    {
        return await SendMessageTrackedAsync(
            chatId,
            text,
            ct,
            keyboard);
    }

    public async Task AnswerCallbackQueryAsync(
        string callbackQueryId,
        string? text,
        CancellationToken ct)
    {
        if (!IsConfigured || string.IsNullOrWhiteSpace(callbackQueryId)) return;

        using var response = await http.PostAsJsonAsync(
            $"{_baseUrl}answerCallbackQuery",
            new
            {
                callback_query_id = callbackQueryId,
                text = string.IsNullOrWhiteSpace(text) ? null : text
            },
            Protocol.Json,
            ct);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            logger.LogWarning(
                "Telegram answerCallbackQuery failed: {Status} {Body}",
                response.StatusCode,
                body);
        }
    }

    private async Task<TelegramMessage?> SendRawAsync(
        long chatId,
        string text,
        string? parseMode,
        CancellationToken ct,
        TelegramInlineKeyboardMarkup? replyMarkup = null,
        long? replyToMessageId = null)
    {
        using var response = await http.PostAsJsonAsync(
            $"{_baseUrl}sendMessage",
            new
            {
                chat_id = chatId,
                text,
                parse_mode = parseMode,
                disable_web_page_preview = true,
                reply_markup = replyMarkup,
                reply_parameters = replyToMessageId is long messageId
                    ? new
                    {
                        message_id = messageId,
                        allow_sending_without_reply = true
                    }
                    : null
            },
            Protocol.Json,
            ct);

        if (response.IsSuccessStatusCode)
        {
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var payload = await JsonSerializer.DeserializeAsync<TelegramResponse<TelegramMessage>>(
                stream,
                Protocol.Json,
                ct);

            return payload?.Ok == true ? payload.Result : null;
        }

        var body = await response.Content.ReadAsStringAsync(ct);

        logger.LogWarning(
            "Telegram sendMessage failed: {Status} {Body}",
            response.StatusCode,
            body);

        return null;
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

    [JsonPropertyName("callback_query")]
    public TelegramCallbackQuery? CallbackQuery { get; set; }
}

public sealed class TelegramMessage
{
    [JsonPropertyName("message_id")]
    public long MessageId { get; set; }

    public TelegramChat? Chat { get; set; }
    public TelegramUser? From { get; set; }
    public string? Text { get; set; }

    [JsonPropertyName("reply_to_message")]
    public TelegramMessage? ReplyToMessage { get; set; }
}

public sealed class TelegramChat
{
    public long Id { get; set; }
}

public sealed class TelegramUser
{
    public long Id { get; set; }
}


public sealed class TelegramCallbackQuery
{
    public string Id { get; set; } = string.Empty;
    public TelegramUser? From { get; set; }
    public TelegramMessage? Message { get; set; }
    public string? Data { get; set; }
}

public sealed class TelegramInlineKeyboardMarkup
{
    [JsonPropertyName("inline_keyboard")]
    public IReadOnlyList<IReadOnlyList<TelegramInlineButton>> InlineKeyboard { get; init; } = [];
}

public sealed class TelegramInlineButton
{
    public string Text { get; init; } = string.Empty;

    [JsonPropertyName("callback_data")]
    public string? CallbackData { get; init; }

    public string? Url { get; init; }
}
