using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace GptTgConnector.Bridge;

public sealed class TelegramPollingWorker(
    TelegramApi telegram,
    BridgeRuntime runtime,
    BridgeOptions options,
    ILogger<TelegramPollingWorker> logger) : BackgroundService
{
    private long _offset;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!telegram.IsConfigured)
        {
            logger.LogWarning(
                "Telegram bot token is missing. Set Bridge__TelegramBotToken and restart.");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var updates = await telegram.GetUpdatesAsync(_offset, stoppingToken);

                foreach (var update in updates)
                {
                    _offset = Math.Max(_offset, update.UpdateId + 1);
                    await HandleAsync(update, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Telegram polling failed");
                await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken);
            }
        }
    }

    private async Task HandleAsync(TelegramUpdate update, CancellationToken ct)
    {
        var message = update.Message;
        var text = message?.Text?.Trim();
        var chatId = message?.Chat?.Id ?? 0;
        var userId = message?.From?.Id ?? 0;

        if (chatId == 0 || string.IsNullOrWhiteSpace(text))
            return;

        if (text.Equals("/id", StringComparison.OrdinalIgnoreCase) ||
            text.Equals("/whoami", StringComparison.OrdinalIgnoreCase))
        {
            await telegram.SendMessageAsync(
                chatId,
                $"chat_id: {chatId}\nuser_id: {userId}",
                ct);
            return;
        }

        if (!IsAllowed(chatId, userId))
        {
            logger.LogWarning(
                "Rejected Telegram message chat={ChatId} user={UserId}",
                chatId,
                userId);
            return;
        }

        if (text.Equals("/status", StringComparison.OrdinalIgnoreCase))
        {
            await telegram.SendMessageAsync(
                chatId,
                $"Edge: {(runtime.ExtensionConnected ? "connected" : "disconnected")}\n" +
                $"Tab: {runtime.BoundTitle ?? "not bound"}\n" +
                $"State: {runtime.LastState}\n" +
                $"Active: {(runtime.HasActiveJob ? "yes" : "no")}\n" +
                $"Queue: {runtime.QueueLength}\n" +
                $"Detail: {runtime.LastDetail ?? "-"}\n" +
                $"URL: {runtime.BoundUrl ?? "-"}",
                ct);
            return;
        }


        if (text.Equals("/current", StringComparison.OrdinalIgnoreCase))
        {
            await telegram.SendMessageAsync(
                chatId,
                string.IsNullOrWhiteSpace(runtime.BoundUrl)
                    ? "No ChatGPT chat is currently bound."
                    : $"{runtime.BoundTitle ?? "ChatGPT"}\n{runtime.BoundUrl}",
                ct);
            return;
        }

        if (text.Equals("/chats", StringComparison.OrdinalIgnoreCase))
        {
            var chats = runtime.GetRecentChats();

            if (chats.Count == 0)
            {
                await telegram.SendMessageAsync(
                    chatId,
                    "No recent ChatGPT chats have been recorded yet.",
                    ct);
                return;
            }

            var lines = chats
                .Select((chat, index) =>
                {
                    var current = string.Equals(
                        chat.Url,
                        runtime.BoundUrl,
                        StringComparison.OrdinalIgnoreCase)
                        ? " ★"
                        : string.Empty;

                    return $"{index + 1}. {chat.Title}{current}";
                });

            await telegram.SendMessageAsync(
                chatId,
                "Recent chats:\n" +
                string.Join("\n", lines) +
                "\n\nUse /chat N to switch.",
                ct);
            return;
        }

        if (text.Equals("/new", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                await runtime.NavigateAsync("https://chatgpt.com/", ct);
                await telegram.SendMessageAsync(chatId, "Opening a new ChatGPT chat.", ct);
            }
            catch (Exception ex)
            {
                await telegram.SendMessageAsync(chatId, $"Cannot open a new chat: {ex.Message}", ct);
            }

            return;
        }

        if (text.StartsWith("/chat", StringComparison.OrdinalIgnoreCase))
        {
            var parts = text.Split(
                ' ',
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

            if (parts.Length != 2 || !int.TryParse(parts[1], out var number))
            {
                await telegram.SendMessageAsync(
                    chatId,
                    "Usage: /chat 1 (choose 1-5 from /chats).",
                    ct);
                return;
            }

            var chats = runtime.GetRecentChats();

            if (number < 1 || number > chats.Count)
            {
                await telegram.SendMessageAsync(
                    chatId,
                    $"Chat #{number} is not in the recent list. Use /chats.",
                    ct);
                return;
            }

            var selected = chats[number - 1];

            try
            {
                await runtime.NavigateAsync(selected.Url, ct);
                await telegram.SendMessageAsync(
                    chatId,
                    $"Switching to: {selected.Title}",
                    ct);
            }
            catch (Exception ex)
            {
                await telegram.SendMessageAsync(chatId, $"Cannot switch chat: {ex.Message}", ct);
            }

            return;
        }

        if (text.StartsWith('/'))
        {
            await telegram.SendMessageAsync(
                chatId,
                "Commands: /id, /status, /current, /new, /chats, /chat N. Any normal text is sent to the bound ChatGPT tab.",
                ct);
            return;
        }

        if (!runtime.ExtensionConnected || string.IsNullOrWhiteSpace(runtime.BoundUrl))
        {
            await telegram.SendMessageAsync(
                chatId,
                "Edge is not ready. Start the bridge, load the extension and press ‘Bind this ChatGPT tab’.",
                ct);
            return;
        }

        var job = new BridgeJob(
            Guid.NewGuid().ToString("N"),
            chatId,
            text,
            DateTimeOffset.UtcNow);

        await runtime.QueueAsync(job, ct);
        await telegram.SendMessageAsync(
            chatId,
            $"Queued ({runtime.QueueLength}).",
            ct);
    }

    private bool IsAllowed(long chatId, long userId) =>
        options.AllowedChatId != 0 &&
        options.AllowedUserId != 0 &&
        chatId == options.AllowedChatId &&
        userId == options.AllowedUserId;
}

public sealed class JobWorker(
    BridgeRuntime runtime,
    TelegramApi telegram,
    ILogger<JobWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in runtime.Jobs.ReadAllAsync(stoppingToken))
        {
            runtime.MarkDequeued();

            try
            {
                var result = await runtime.ExecuteAsync(job, stoppingToken);
                await SendResultAsync(job.ChatId, result, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Job {JobId} failed", job.Id);
                await telegram.SendMessageAsync(
                    job.ChatId,
                    $"Bridge error: {ex.Message}",
                    stoppingToken);
            }
        }
    }

    private async Task SendResultAsync(
        long chatId,
        EdgeEnvelope result,
        CancellationToken ct)
    {
        var fallbackText = !string.IsNullOrWhiteSpace(result.Text)
            ? result.Text.Trim()
            : "ChatGPT finished, but no readable final text was found.";

        if (!string.IsNullOrWhiteSpace(result.Html))
        {
            await telegram.SendFormattedMessageAsync(
                chatId,
                result.Html.Trim(),
                fallbackText,
                ct);
        }
        else
        {
            await telegram.SendMessageAsync(
                chatId,
                fallbackText,
                ct);
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            await telegram.SendMessageAsync(
                chatId,
                $"⚠ ChatGPT/UI error: {result.Error.Trim()}",
                ct);
        }
    }
}

public static class WebSocketEndpoint
{
    public static async Task RunAsync(
        HttpContext context,
        BridgeRuntime runtime,
        TelegramApi telegram,
        BridgeOptions options,
        ILogger logger)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        runtime.Attach(socket);

        var buffer = new byte[64 * 1024];

        try
        {
            while (socket.State == WebSocketState.Open &&
                   !context.RequestAborted.IsCancellationRequested)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult result;

                do
                {
                    result = await socket.ReceiveAsync(
                        new ArraySegment<byte>(buffer),
                        context.RequestAborted);

                    if (result.MessageType == WebSocketMessageType.Close)
                        return;

                    ms.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                if (result.MessageType != WebSocketMessageType.Text)
                    continue;

                var message = JsonSerializer.Deserialize<EdgeEnvelope>(
                    Encoding.UTF8.GetString(ms.ToArray()),
                    Protocol.Json);

                if (message is null)
                    continue;

                await runtime.HandleEdgeMessageAsync(
                    message,
                    async unsolicited =>
                    {
                        if (options.AllowedChatId == 0)
                            return;

                        var text = unsolicited.Text?.Trim();
                        var html = unsolicited.Html?.Trim();
                        var error = unsolicited.Error?.Trim();

                        if (!string.IsNullOrWhiteSpace(html))
                        {
                            await telegram.SendFormattedMessageAsync(
                                options.AllowedChatId,
                                html,
                                text ?? "ChatGPT finished, but no readable final text was found.",
                                context.RequestAborted);
                        }
                        else if (!string.IsNullOrWhiteSpace(text))
                        {
                            await telegram.SendMessageAsync(
                                options.AllowedChatId,
                                text,
                                context.RequestAborted);
                        }

                        if (!string.IsNullOrWhiteSpace(error))
                        {
                            await telegram.SendMessageAsync(
                                options.AllowedChatId,
                                $"⚠ ChatGPT/UI error: {error}",
                                context.RequestAborted);
                        }
                    },
                    context.RequestAborted);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (WebSocketException ex)
        {
            logger.LogWarning(ex, "Edge WebSocket closed");
        }
        finally
        {
            runtime.Detach(socket);
        }
    }
}
