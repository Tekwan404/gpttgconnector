# GPT TG Connector

Локальный мост **Telegram ↔ уже открытая вкладка ChatGPT в Microsoft Edge**.

Он не запускает отдельный браузер, не использует OpenAI API и не создаёт отдельную ChatGPT-сессию. Сообщение из Telegram попадает в конкретный привязанный ChatGPT-чат, а завершившийся ответ возвращается в Telegram.

> Это неофициальная DOM-автоматизация веб-интерфейса ChatGPT. DOM может меняться. Перед постоянной эксплуатацией автоматической пересылки output самостоятельно проверь актуальные условия использования OpenAI.

## Что уже умеет MVP

- работает с **существующей авторизованной вкладкой Edge**;
- привязывает именно конкретный conversation URL; если вкладка уйдёт на другой чат, binding снимается;
- Telegram long polling — внешний сервер и webhook не нужны;
- очередь: только один Telegram-запрос выполняется одновременно;
- если ChatGPT уже занят ручным запросом с ПК, Telegram job ждёт состояния idle;
- DOM отслеживается через `MutationObserver`, а не постоянный polling;
- состояния: `submitting`, `waiting`, `generating`, `tool_running`, `finishing`, `idle`, `error`;
- нет короткого timeout: длительная работа может продолжаться 20+ минут;
- если после действий появился UI-error, в Telegram уходит доступный текст результата + ошибка;
- ответ на prompt, отправленный вручную на ПК, тоже может быть продублирован в Telegram;
- длинные Telegram-ответы режутся на части;
- `/status` показывает Edge, привязанную вкладку, state и очередь;
- локальные логи;
- доступ ограничивается `AllowedChatId` и `AllowedUserId`.

## Архитектура

```text
Telegram
   │
   ▼
.NET 10 local bridge
   │  ws://127.0.0.1:8765/ws
   ▼
Edge extension service worker
   │
   ▼
content script
   │
   ▼
уже открытый https://chatgpt.com/c/...
```

WebSocket держит background service worker расширения. Content script занимается только DOM. Keepalive идёт раз в 20 секунд, поэтому соединение не должно засыпать при долгих генерациях.

---

## Самый простой запуск на Windows

После `git pull` больше не нужно каждый раз заново вводить `$env:Bridge__...`.

Один раз выполни:

```powershell
.\setup.ps1
```

Скрипт спросит:

- Telegram bot token;
- `chat_id`;
- `user_id`.

Он сохранит их локально в:

```text
src\GptTgConnector.Bridge\appsettings.Local.json
```

Этот файл уже добавлен в `.gitignore` и в Git не попадёт.

После этого обычный запуск:

```powershell
.\start.ps1
```

Либо двойным кликом:

```text
start.cmd
```

Если ID ещё не знаешь, можно временно запускать bridge только с token старым способом, написать боту `/id`, затем выполнить `setup.ps1`.


# Установка

## 1. Что нужно

На Windows:

- Microsoft Edge;
- .NET 10 SDK;
- Git;
- ChatGPT уже авторизован в Edge;
- Telegram bot token от `@BotFather`.

Проверь .NET:

```powershell
dotnet --version
```

Нужно `10.x`.

## 2. Скачать

```powershell
git clone https://github.com/Tekwan404/gpttgconnector.git
cd gpttgconnector
```

## 3. Создать Telegram-бота

1. Открой `@BotFather`.
2. Выполни `/newbot`.
3. Сохрани token вида `123456:ABC...`.
4. **Не пиши token в Git и не присылай его в публичные места.**

## 4. Первый запуск — узнать Telegram ID

Из корня репозитория:

```powershell
$env:Bridge__TelegramBotToken="ВАШ_BOT_TOKEN"
dotnet run --project .\src\GptTgConnector.Bridge\GptTgConnector.Bridge.csproj
```

Теперь напиши своему боту:

```text
/id
```

Ответ:

```text
chat_id: 123456789
user_id: 123456789
```

После этого останови bridge через `Ctrl+C`.

## 5. Нормальный защищённый запуск

Подставь свои значения:

```powershell
$env:Bridge__TelegramBotToken="ВАШ_BOT_TOKEN"
$env:Bridge__AllowedChatId="123456789"
$env:Bridge__AllowedUserId="123456789"

dotnet run --project .\src\GptTgConnector.Bridge\GptTgConnector.Bridge.csproj
```

Окно PowerShell должно оставаться запущенным.

Проверка:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

До подключения расширения `extensionConnected` будет `false`.

## 6. Установить Edge extension

1. Открой `edge://extensions`.
2. Включи **Developer mode / Режим разработчика**.
3. Нажми **Load unpacked / Загрузить распакованное**.
4. Выбери папку:

```text
gpttgconnector\extension
```

5. Закрепи `GPT TG Connector` на панели Edge.

Extension автоматически подключается к:

```text
ws://127.0.0.1:8765/ws
```

Если bridge был выключен, расширение переподключается примерно каждые 2 секунды.

## 7. Привязать чат

1. В Edge открой **конкретный** ChatGPT-разговор.
2. Нажми иконку `GPT TG Connector`.
3. Нажми **Bind this ChatGPT tab**.
4. В Telegram отправь:

```text
/status
```

Ожидаемый результат:

```text
Edge: connected
Tab: ChatGPT
State: idle
Queue: 0
URL: https://chatgpt.com/c/...
```

Если в этой вкладке перейти на другой ChatGPT-разговор, binding специально сбрасывается. Это защита от случайной отправки не в тот чат.

---

# Использование

После binding любое обычное сообщение Telegram-боту становится prompt:

```text
Telegram
  "проверь последний PR и исправь тесты"
        ↓
локальная очередь
        ↓
уже открытая вкладка ChatGPT
        ↓
ChatGPT выполняет работу
        ↓
готовый ответ
        ↓
Telegram
```

Если отправить несколько сообщений во время одной генерации, они выполняются последовательно.

Если ты отправил prompt руками на ПК, ушёл от компьютера, а ChatGPT закончил позже — extension увидит новый завершённый assistant response и продублирует его в разрешённый Telegram chat.

## Telegram-команды

```text
/id       показать chat_id и user_id
/status   состояние bridge, Edge, вкладки и очереди
```

Любой другой текст — prompt.

---

# Логи

Логи идут в консоль и в файл:

```text
src\GptTgConnector.Bridge\bin\Debug\net10.0\logs\bridge-YYYYMMDD.log
```

Для Release:

```text
src\GptTgConnector.Bridge\bin\Release\net10.0\logs\bridge-YYYYMMDD.log
```

Логируются подключения, binding, job id, очередь, состояния и ошибки. Bot token намеренно не логируется.

---

# Запуск одним кликом

После первого теста можешь локально сделать `start-bridge.ps1` (с реальным token его не коммитить):

```powershell
$env:Bridge__TelegramBotToken="ВАШ_BOT_TOKEN"
$env:Bridge__AllowedChatId="123456789"
$env:Bridge__AllowedUserId="123456789"

Set-Location "C:\path\to\gpttgconnector"
dotnet run --project .\src\GptTgConnector.Bridge\GptTgConnector.Bridge.csproj
```

---

# Если что-то не работает

### `/status`: Edge disconnected

Проверь, что .NET bridge запущен. Затем в `edge://extensions` открой расширение и при необходимости нажми Reload.

### Edge connected, Tab not bound

Открой нужный ChatGPT-чат → иконка расширения → **Bind this ChatGPT tab**.

### `ChatGPT composer was not found`

Сначала обнови ChatGPT. Если ошибка остаётся, OpenAI поменял DOM — обновлять нужно selectors в:

```text
extension/content.js
```

Основные группы:

```text
SELECTORS.composer
SELECTORS.send
SELECTORS.stop
```

### Ответ пришёл частично

MVP определяет завершение по DOM-событиям, исчезновению Stop и стабилизации финального текста. Если UI ChatGPT поменяет индикатор generation, в первую очередь нужно обновить `SELECTORS.stop`.

### Бот отвечает на /id, но молчит на обычный текст

Это ожидаемо, пока не установлены обе переменные:

```text
Bridge__AllowedChatId
Bridge__AllowedUserId
```

---

# Безопасность

- bridge слушает только `127.0.0.1`, а не `0.0.0.0`;
- порт 8765 не нужно открывать в роутере или firewall наружу;
- cookie/session ChatGPT никуда не копируются;
- extension запускается только на `https://chatgpt.com/*`;
- bot token хранится через environment variable;
- обычные команды принимаются только от разрешённого Telegram chat + user;
- не коммить файлы с реальными секретами.

## CI

В репозитории есть GitHub Actions workflow:

```text
.github/workflows/build.yml
```

Он собирает bridge на .NET 10 Release и проверяет manifest расширения.

## Ограничения MVP

ChatGPT DOM не является стабильным публичным API. После изменения интерфейса selectors могут потребовать обновления. Определение `tool_running` эвристическое: если структура tool blocks изменится, state может показываться как `generating`, но сама очередь и ожидание финального ответа продолжат работать.

Следующие логичные улучшения: recovery активного job после полного перезапуска bridge, Windows autostart и tray UI.


## После обновления расширения

Если extension уже был установлен как **Load unpacked**, после `git pull` открой `edge://extensions` и нажми **Reload** на карточке GPT TG Connector. Затем открой нужный ChatGPT-чат и снова нажми **Bind this ChatGPT tab**.

Начиная с версии 0.1.1 Bind сам проверяет, есть ли content script в уже открытой вкладке, и при необходимости внедряет его через `chrome.scripting.executeScript`. Поэтому вкладку ChatGPT обычно уже не нужно вручную перезагружать.

Если `/status` когда-либо показывает `State: error`, после обновления 0.1.1 такой терминальный UI/extension error больше не должен навсегда блокировать очередь: следующий job может восстановить `idle`, а ошибка конкретного job возвращается в Telegram.
