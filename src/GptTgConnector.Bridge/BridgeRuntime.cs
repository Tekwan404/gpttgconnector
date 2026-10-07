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
    private WebSocket? _socket;
    private int _queued;
    private string? _activeJobId;

    public string? BoundUrl { get; private set; }
    public string? BoundTitle { get; private set; }
    public string LastState { get; private set; } = "disconnected";\n    public string? LastDetail { get; private set; }
    public bool ExtensionConnected => _socket is { State: WebSocketState.Open };
    public int QueueLength => Math.Max(0, Volatile.Read(ref _queued));
    public ChannelReader<BridgeJob> Jobs => _jobs.Reader;

    public void Attach(WebSocket socket)
    {
        var old = Interlocked.Exchange(ref _socket, socket);
        try { old?.Abort(); } catch { }

        LastState = "connected";
        logger.LogInformation("Edge extension connected");
        SignalStateChange();
    }

    public void Detach(WebSocket socket)
    {
        if (!ReferenceEquals(_socket, socket)) return;

        _socket = null;
        LastState = "disconnected";
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

        var completion = new TaskCompletionSource<EdgeEnvelope>(TaskCreationOptions.RunContinuationsAsynchronously);
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
            if (_activeJobId == job.Id) _activeJobId = null;
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
                LastState = "idle";
                logger.LogInformation("Bound ChatGPT tab: {Title} {Url}", BoundTitle, BoundUrl);
                SignalStateChange();
                break;

            case "unbind":
                BoundUrl = null;
                BoundTitle = null;
                LastState = ExtensionConnected ? "connected" : "disconnected";
                logger.LogWarning("ChatGPT tab binding cleared");
                SignalStateChange();
                break;

            case "state":
                LastState = message.State ?? "working";
                logger.LogInformation("State {State} job={JobId} detail={Detail}", LastState, message.JobId, message.Detail);
                SignalStateChange();
                break;

            case "result":
                LastState = "idle";
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
                if (!string.IsNullOrWhiteSpace(message.JobId) &&
                    _pending.TryGetValue(message.JobId, out var errorWaiter))
                {
                    errorWaiter.TrySetResult(message);
                    LastState = !string.IsNullOrWhiteSpace(BoundUrl) && ExtensionConnected ? "idle" : "error";
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
                    activeWaiter.TrySetResult(message with { Type = "result", JobId = _activeJobId });
                    LastState = "idle";
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
                (LastState is "idle" or "connected"))
            {
                return;
            }

            if (LastState == "error" && ExtensionConnected && !string.IsNullOrWhiteSpace(BoundUrl))
            {
                logger.LogWarning("Recovering stale error state for bound ChatGPT tab");
                LastState = "idle";
                return;
            }

            logger.LogInformation("Waiting for bound ChatGPT tab to become idle; state={State}", LastState);
            await _stateChanged.WaitAsync(ct);
        }
    }

    private void SignalStateChange()
    {
        try { _stateChanged.Release(); }
        catch (SemaphoreFullException) { }
    }

    private async Task SendAsync(BridgeCommand command, CancellationToken ct)
    {
        var socket = _socket;
        if (socket is null || socket.State != WebSocketState.Open)
            throw new InvalidOperationException("Edge extension is not connected.");

        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(command, Protocol.Json));

        await _socketSendGate.WaitAsync(ct);
        try
        {
            await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct);
        }
        finally
        {
            _socketSendGate.Release();
        }
    }
}
