using Microsoft.Extensions.Logging;

namespace GptTgConnector.Bridge;

public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly string _directory;
    private readonly object _gate = new();

    public FileLoggerProvider(string directory)
    {
        _directory = Path.GetFullPath(directory);
        Directory.CreateDirectory(_directory);
    }

    public ILogger CreateLogger(string categoryName) => new FileLogger(categoryName, _directory, _gate);
    public void Dispose() { }

    private sealed class FileLogger(string category, string directory, object gate) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;

            var line = $"{DateTimeOffset.Now:O} [{logLevel}] {category}: {formatter(state, exception)}";
            if (exception is not null) line += Environment.NewLine + exception;

            var path = Path.Combine(directory, $"bridge-{DateTime.Now:yyyyMMdd}.log");
            lock (gate)
            {
                File.AppendAllText(path, line + Environment.NewLine);
            }
        }
    }
}
