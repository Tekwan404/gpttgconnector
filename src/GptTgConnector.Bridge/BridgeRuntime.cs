using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace GptTgConnector.Bridge;

public sealed class BridgeRuntime(ILogger<BridgeRuntime> logger)
{
    private readonly Channel<BridgeJob> _jobs = Channel.CreateUnbounded<BridgeJob>(new UnboundedChannelOptions
    {
        SingleReader = true,
        SingleWriter = false
    });

    private readonly ConcurrentDictionary<string, TaskCompletionSource<EdgeEnvelope>> _pending = new();
    private readonly SemaphoreSlim _socketSendGate = new(1, 1);
    private readonly SemaphoreSlim _stateChanged = new(0, int.MaxValue);
    private readonly object _chatHistoryLock = new();
    private readonly List<RecentChat> _recentChats = LoadRecentChats();

    private static readonly string ChatHistoryPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "GptTgConnector",
        "chats.json");

    private WebSocket? _socket;
    private int _queued;
    private string? _activeJobId;

    public string? BoundUrl { get; private set; }
    public string? BoundTitle { get; private set; }
    public string LastState { get; private set; } = "disconnected";
    public string? LastDetail { get; private set; }

    public bool ExtensionConnected => _socket is { State: WebSocketState.Open };
    public int QueueLength => Math.Max(0, Volatile.Read(ref _queued));
    public bool HasActiveJob => !string.IsNullOrWhiteSpace(_activeJobId);
    public ChannelReader<BridgeJob> Jobs => _jobs.Reader;

    public IReadOnlyList<RecentChat> GetRecentChats()
    {
        lock (_chatHistoryLock)
        {
            return _recentChats
                .OrderByDescending(chat => chat.LastUsedAt)
                .Take(5)
                .ToArray();
        }
    }

    public async Task NavigateAsync(string url, CancellationToken ct)
    {
        if (!ExtensionConnected || string.IsNullOrWhiteSpace(BoundUrl))
            throw new InvalidOperationException("Edge is not ready or no ChatGPT tab is bound.");

        if (HasActiveJob ||
            QueueLength > 0 ||
            LastState is "submitting" or "waiting" or "generating" or "tool_running" or "finishing")
        {
            throw new InvalidOperationException(
                "Wait for the current ChatGPT activity to finish before switching chats.");
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var target) ||
            !string.Equals(target.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(target.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Only chatgpt.com navigation is allowed.");
        }

        await SendAsync(new BridgeCommand("navigate", Url: target.ToString()), ct);
    }

    public void Attach(WebSocket socket)
    {
        var old = Interlocked.Exchange(ref _socket, socket);
        try { old?.Abort(); } catch { }

        LastState = "connected";
        LastDetail = null;
        logger.LogInformation("Edge extension connected");
        SignalStateChange();
    }

    public void Detach(WebSocket socket)
    {
        if (!ReferenceEquals(_socket, socket)) return;

        _socket = null;
        LastState = "disconnected";
        LastDetail = null;
        logger.LogWarning("Edge extension disconnected");
        SignalStateChange();
    }

    public ValueTask QueueAsync(BridgeJob job, CancellationToken ct)
    {
        Interlocked.Increment(ref _queued);
        logger.LogInformation("Queued job {JobId}; queue length {QueueLength}", job.Id, QueueLength);
        return _jobs.Writer.WriteAsync(job, ct);
    }

    public void MarkDequeued() => Interlocked.Decrement(ref _queued);

    public async Task<EdgeEnvelope> ExecuteAsync(BridgeJob job, CancellationToken ct)
    {
        await WaitUntilReadyAsync(ct);

        var completion = new TaskCompletionSource<EdgeEnvelope>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        if (!_pending.TryAdd(job.Id, completion))
            throw new InvalidOperationException("Duplicate job id.");

        _activeJobId = job.Id;

        try
        {
            await SendAsync(new BridgeCommand("sendPrompt", job.Id, job.Text), ct);
            logger.LogInformation("Sent job {JobId} to {Url}", job.Id, BoundUrl);
            return await completion.Task.WaitAsync(ct);
        }
        finally
        {
            _pending.TryRemove(job.Id, out _);

            if (_activeJobId == job.Id)
                _activeJobId = null;
        }
    }

    public async Task HandleEdgeMessageAsync(
        EdgeEnvelope message,
        Func<EdgeEnvelope, Task> unsolicited,
        CancellationToken ct)
    {
        switch (message.Type)
        {
            case "bind":
                BoundUrl = message.Url;
                BoundTitle = message.Title;

                if (IsConversationUrl(BoundUrl))
                    RememberChat(BoundUrl!, BoundTitle);

                LastState = "idle";
                LastDetail = null;
                logger.LogInformation("Bound ChatGPT tab: {Title} {Url}", BoundTitle, BoundUrl);
                SignalStateChange();
                break;

            case "unbind":
                BoundUrl = null;
                BoundTitle = null;
                LastState = ExtensionConnected ? "connected" : "disconnected";
                LastDetail = null;
                logger.LogWarning("ChatGPT tab binding cleared");
                SignalStateChange();
                break;

            case "state":
                LastState = message.State ?? "working";
                LastDetail = message.Detail;
                logger.LogInformation(
                    "State {State} job={JobId} detail={Detail}",
                    LastState,
                    message.JobId,
                    LastDetail);
                SignalStateChange();
                break;

            case "result":
                LastState = "idle";
                LastDetail = null;

                if (!string.IsNullOrWhiteSpace(message.JobId) &&
                    _pending.TryGetValue(message.JobId, out var resultWaiter))
                {
                    resultWaiter.TrySetResult(message);
                }
                else
                {
                    await unsolicited(message);
                }

                SignalStateChange();
                break;

            case "error":
                LastDetail = message.Error;

                if (!string.IsNullOrWhiteSpace(message.JobId) &&
                    _pending.TryGetValue(message.JobId, out var errorWaiter))
                {
                    errorWaiter.TrySetResult(message);
                    LastState =
                        !string.IsNullOrWhiteSpace(BoundUrl) && ExtensionConnected
                            ? "idle"
                            : "error";
                }
                else
                {
                    LastState = "error";
                    await unsolicited(message);
                }

                SignalStateChange();
                break;

            case "observedResult":
                if (!string.IsNullOrWhiteSpace(_activeJobId) &&
                    _pending.TryGetValue(_activeJobId, out var activeWaiter))
                {
                    activeWaiter.TrySetResult(
                        message with { Type = "result", JobId = _activeJobId });

                    LastState = "idle";
                    LastDetail = null;
                    SignalStateChange();
                }
                else
                {
                    await unsolicited(message);
                }

                break;
        }
    }

    private async Task WaitUntilReadyAsync(CancellationToken ct)
    {
        while (true)
        {
            if (ExtensionConnected &&
                !string.IsNullOrWhiteSpace(BoundUrl) &&
                LastState is "idle" or "connected")
            {
                return;
            }

            if (LastState == "error" &&
                ExtensionConnected &&
                !string.IsNullOrWhiteSpace(BoundUrl))
            {
                logger.LogWarning("Recovering stale error state for bound ChatGPT tab");
                LastState = "idle";
                LastDetail = null;
                return;
            }

            logger.LogInformation(
                "Waiting for bound ChatGPT tab to become idle; state={State} detail={Detail}",
                LastState,
                LastDetail);

            await _stateChanged.WaitAsync(ct);
        }
    }

    private static bool IsConversationUrl(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed))
            return false;

        return string.Equals(parsed.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase) &&
               parsed.AbsolutePath.StartsWith("/c/", StringComparison.OrdinalIgnoreCase) &&
               parsed.AbsolutePath.Length > 3;
    }

    private void RememberChat(string url, string? title)
    {
        var cleanTitle = string.IsNullOrWhiteSpace(title)
            ? "ChatGPT"
            : title.Trim();

        lock (_chatHistoryLock)
        {
            _recentChats.RemoveAll(chat =>
                string.Equals(chat.Url, url, StringComparison.OrdinalIgnoreCase));

            _recentChats.Insert(0, new RecentChat(
                url,
                cleanTitle,
                DateTimeOffset.UtcNow));

            if (_recentChats.Count > 5)
                _recentChats.RemoveRange(5, _recentChats.Count - 5);

            SaveRecentChatsUnsafe();
        }
    }

    private static List<RecentChat> LoadRecentChats()
    {
        try
        {
            if (!File.Exists(ChatHistoryPath))
                return [];

            var json = File.ReadAllText(ChatHistoryPath);
            return JsonSerializer.Deserialize<List<RecentChat>>(json, Protocol.Json)?
                .Where(chat => IsConversationUrl(chat.Url))
                .OrderByDescending(chat => chat.LastUsedAt)
                .Take(5)
                .ToList() ?? [];
        }
        catch
        {
            return [];
        }
    }

    private void SaveRecentChatsUnsafe()
    {
        try
        {
            var directory = Path.GetDirectoryName(ChatHistoryPath);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);

            File.WriteAllText(
                ChatHistoryPath,
                JsonSerializer.Serialize(_recentChats, Protocol.Json));
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not persist recent ChatGPT chats");
        }
    }

    private void SignalStateChange()
    {
        try
        {
            _stateChanged.Release();
        }
        catch (SemaphoreFullException)
        {
        }
    }

    private async Task SendAsync(BridgeCommand command, CancellationToken ct)
    {
        var socket = _socket;

        if (socket is null || socket.State != WebSocketState.Open)
            throw new InvalidOperationException("Edge extension is not connected.");

        var bytes = Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(command, Protocol.Json));

        await _socketSendGate.WaitAsync(ct);

        try
        {
            await socket.SendAsync(
                new ArraySegment<byte>(bytes),
                WebSocketMessageType.Text,
                true,
                ct);
        }
        finally
        {
            _socketSendGate.Release();
        }
    }
}


public sealed record RecentChat(
    string Url,
    string Title,
    DateTimeOffset LastUsedAt);
