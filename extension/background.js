const BRIDGE_URL = 'ws://127.0.0.1:8765/ws';
let socket = null;
let reconnectTimer = null;
let boundTabId = null;
let boundUrl = null;
let state = 'disconnected';
let keepAliveTimer = null;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  state = 'connecting';
  socket = new WebSocket(BRIDGE_URL);

  socket.addEventListener('open', async () => {
    state = 'connected';
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => send({ type: 'ping' }), 20000);
    const saved = await chrome.storage.local.get(['boundTabId', 'boundUrl']);
    boundTabId = saved.boundTabId ?? boundTabId;
    boundUrl = saved.boundUrl ?? boundUrl;
    if (boundTabId) {
      try {
        const tab = await chrome.tabs.get(boundTabId);
        if (tab?.url === boundUrl && tab.url.startsWith('https://chatgpt.com/')) {
          send({ type: 'bind', url: tab.url, title: tab.title || 'ChatGPT' });
        } else {
          await clearBinding();
          send({ type: 'unbind' });
        }
      } catch {
        await clearBinding();
      }
    }
  });

  socket.addEventListener('message', async event => {
    let command;
    try { command = JSON.parse(event.data); } catch { return; }
    if (!boundTabId) return;
    try {
      await chrome.tabs.sendMessage(boundTabId, { kind: 'bridgeCommand', command });
    } catch (error) {
      send({ type: 'error', jobId: command.jobId, error: `Bound ChatGPT tab is unavailable: ${error?.message || error}` });
    }
  });

  socket.addEventListener('close', scheduleReconnect);
  socket.addEventListener('error', () => { state = 'error'; });
}

function scheduleReconnect() {
  state = 'disconnected';
  socket = null;
  clearInterval(keepAliveTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

async function clearBinding() {
  boundTabId = null;
  boundUrl = null;
  await chrome.storage.local.remove(['boundTabId', 'boundUrl']);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === 'edgeEvent') {
    const payload = { ...message.payload };
    if (sender.tab?.url) payload.url ??= sender.tab.url;
    send(payload);
    return;
  }

  if (message?.kind === 'bindActiveTab') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url?.startsWith('https://chatgpt.com/')) {
        sendResponse({ ok: false, error: 'Open the ChatGPT conversation you want to bind first.' });
        return;
      }
      boundTabId = tab.id;
      boundUrl = tab.url;
      await chrome.storage.local.set({ boundTabId, boundUrl });
      send({ type: 'bind', url: tab.url, title: tab.title || 'ChatGPT' });
      sendResponse({ ok: true, title: tab.title, url: tab.url });
    })();
    return true;
  }

  if (message?.kind === 'getStatus') {
    sendResponse({ state, boundTabId, boundUrl, socketOpen: socket?.readyState === WebSocket.OPEN });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (tabId !== boundTabId || !changeInfo.url || changeInfo.url === boundUrl) return;
  await clearBinding();
  send({ type: 'unbind' });
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (tabId !== boundTabId) return;
  await clearBinding();
  send({ type: 'unbind' });
});

connect();
