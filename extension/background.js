const BRIDGE_URL = 'ws://127.0.0.1:8765/ws';
const CONTENT_SCRIPT_VERSION = '0.1.3';

let socket = null;
let reconnectTimer = null;
let boundTabId = null;
let boundUrl = null;
let state = 'disconnected';
let keepAliveTimer = null;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  state = 'connecting';
  socket = new WebSocket(BRIDGE_URL);

  socket.addEventListener('open', async () => {
    state = 'connected';
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => send({ type: 'ping' }), 20000);

    const saved = await chrome.storage.local.get(['boundTabId', 'boundUrl']);
    boundTabId = saved.boundTabId ?? boundTabId;
    boundUrl = saved.boundUrl ?? boundUrl;

    if (!boundTabId) return;

    try {
      const tab = await chrome.tabs.get(boundTabId);

      if (tab?.url === boundUrl && tab.url.startsWith('https://chatgpt.com/')) {
        await ensureContentScript(boundTabId);
        const refreshed = await chrome.tabs.get(boundTabId);
        send({
          type: 'bind',
          url: refreshed.url,
          title: refreshed.title || 'ChatGPT'
        });
      } else {
        await clearBinding();
        send({ type: 'unbind' });
      }
    } catch (error) {
      await clearBinding();
      send({ type: 'unbind' });
      state = 'error';
    }
  });

  socket.addEventListener('message', async event => {
    let command;
    try {
      command = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!boundTabId) {
      send({
        type: 'error',
        jobId: command?.jobId,
        error: 'No ChatGPT tab is bound.'
      });
      return;
    }

    try {
      await ensureContentScript(boundTabId);
      const response = await chrome.tabs.sendMessage(boundTabId, {
        kind: 'bridgeCommand',
        command
      });

      if (response?.ok === false) {
        throw new Error(response.error || 'ChatGPT content script rejected the command.');
      }
    } catch (error) {
      send({
        type: 'error',
        jobId: command?.jobId,
        error: `Bound ChatGPT tab is unavailable: ${error?.message || error}`
      });
    }
  });

  socket.addEventListener('close', scheduleReconnect);
  socket.addEventListener('error', () => {
    state = 'error';
  });
}

function scheduleReconnect() {
  state = 'disconnected';
  socket = null;
  clearInterval(keepAliveTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

async function clearBinding() {
  boundTabId = null;
  boundUrl = null;
  await chrome.storage.local.remove(['boundTabId', 'boundUrl']);
}

async function pingContent(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { kind: 'connectorPing' });
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForExpectedContent(tabId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ping = await pingContent(tabId);
    if (ping?.ok && ping.version === CONTENT_SCRIPT_VERSION) {
      return ping;
    }
    await delay(200);
  }

  throw new Error(
    `ChatGPT content script version ${CONTENT_SCRIPT_VERSION} did not initialize.`
  );
}

async function reloadTabAndWait(tabId, timeoutMs = 15000) {
  await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
    };

    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    const timer = setTimeout(
      () => finish(new Error('Timed out while refreshing the bound ChatGPT tab.')),
      timeoutMs
    );

    chrome.tabs.reload(tabId).catch(finish);
  });
}

async function ensureContentScript(tabId) {
  const current = await pingContent(tabId);

  if (current?.ok && current.version === CONTENT_SCRIPT_VERSION) {
    return current;
  }

  // An extension reload does not replace a content script that is already
  // running in an open ChatGPT page. Refresh the page to guarantee a clean,
  // current script instead of stacking duplicate observers/listeners.
  await reloadTabAndWait(tabId);

  try {
    return await waitForExpectedContent(tabId, 8000);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });

    return await waitForExpectedContent(tabId, 5000);
  }
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
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });

      if (!tab?.id || !tab.url?.startsWith('https://chatgpt.com/')) {
        sendResponse({
          ok: false,
          error: 'Open the ChatGPT conversation you want to bind first.'
        });
        return;
      }

      try {
        boundTabId = tab.id;
        boundUrl = tab.url;

        await chrome.storage.local.set({ boundTabId, boundUrl });
        const ping = await ensureContentScript(tab.id);
        const refreshed = await chrome.tabs.get(tab.id);

        boundUrl = refreshed.url;
        await chrome.storage.local.set({ boundTabId, boundUrl });

        send({
          type: 'bind',
          url: refreshed.url,
          title: refreshed.title || 'ChatGPT'
        });

        sendResponse({
          ok: true,
          title: refreshed.title,
          url: refreshed.url,
          contentVersion: ping.version,
          diagnostics: ping.diagnostics
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      }
    })();

    return true;
  }

  if (message?.kind === 'getStatus') {
    (async () => {
      const ping = boundTabId ? await pingContent(boundTabId) : null;
      sendResponse({
        state,
        boundTabId,
        boundUrl,
        socketOpen: socket?.readyState === WebSocket.OPEN,
        contentVersion: ping?.version || null,
        diagnostics: ping?.diagnostics || null
      });
    })();

    return true;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (tabId !== boundTabId || !changeInfo.url || changeInfo.url === boundUrl) {
    return;
  }

  await clearBinding();
  send({ type: 'unbind' });
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (tabId !== boundTabId) return;

  await clearBinding();
  send({ type: 'unbind' });
});

connect();
