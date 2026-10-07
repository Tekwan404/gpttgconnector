using GptTgConnector.Bridge;

var builder = WebApplication.CreateBuilder(args);

builder.Configuration
    .AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: false)
    .AddEnvironmentVariables();

var bridgeOptions = new BridgeOptions();
builder.Configuration
    .GetSection(BridgeOptions.SectionName)
    .Bind(bridgeOptions);

builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddProvider(
    new FileLoggerProvider(Path.Combine(AppContext.BaseDirectory, "logs")));

builder.Services.AddSingleton(bridgeOptions);
builder.Services.AddSingleton<BridgeRuntime>();

builder.Services.AddHttpClient<TelegramApi>(client =>
    client.Timeout = TimeSpan.FromSeconds(
        Math.Max(45, bridgeOptions.TelegramPollTimeoutSeconds + 15)));

builder.Services.AddHostedService<TelegramPollingWorker>();
builder.Services.AddHostedService<JobWorker>();

builder.WebHost.UseUrls($"http://127.0.0.1:{bridgeOptions.Port}");

var app = builder.Build();

app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(20)
});

app.MapGet("/health", (BridgeRuntime runtime) => Results.Ok(new
{
    ok = true,
    extensionConnected = runtime.ExtensionConnected,
    boundUrl = runtime.BoundUrl,
    state = runtime.LastState,
    detail = runtime.LastDetail,
    active = runtime.HasActiveJob,
    queue = runtime.QueueLength,
    telegramConfigured = bridgeOptions.TelegramBotToken.Length > 0,
    accessConfigured =
        bridgeOptions.AllowedChatId != 0 &&
        bridgeOptions.AllowedUserId != 0
}));

app.Map("/ws", async context =>
{
    var runtime = context.RequestServices.GetRequiredService<BridgeRuntime>();
    var telegram = context.RequestServices.GetRequiredService<TelegramApi>();
    var options = context.RequestServices.GetRequiredService<BridgeOptions>();
    var logger = context.RequestServices
        .GetRequiredService<ILoggerFactory>()
        .CreateLogger("WebSocket");

    await WebSocketEndpoint.RunAsync(
        context,
        runtime,
        telegram,
        options,
        logger);
});

app.Run();
