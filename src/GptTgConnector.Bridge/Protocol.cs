using System.Text.Json;
using System.Text.Json.Serialization;

namespace GptTgConnector.Bridge;

public static class Protocol
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}

public sealed record EdgeEnvelope(
    string Type,
    string? JobId = null,
    string? Url = null,
    string? Title = null,
    string? State = null,
    string? Detail = null,
    string? Text = null,
    string? Error = null,
    string? EventId = null);

public sealed record BridgeCommand(string Type, string? JobId = null, string? Text = null);

public sealed record BridgeJob(string Id, long ChatId, string Text, DateTimeOffset CreatedAt);
