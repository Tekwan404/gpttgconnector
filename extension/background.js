const BRIDGE_URL = 'ws://127.0.0.1:8765/ws';
const CONTENT_SCRIPT_VERSION = '0.1.9';

let socket = null;
let reconnectTimer = null;
let boundTabId = null;
let boundUrl = null;
let state = 'disconnected';
let keepAliveTimer = null;
const reloadingConversationTabs = new Set();
const directNavigationTabs = new Set();

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  state = 'connecting';
  const ws = new WebSocket(BRIDGE_URL);
  socket = ws;

  ws.addEventListener('open', async () => {
    if (socket !== ws) return;
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

  ws.addEventListener('message', async event => {
    if (socket !== ws) return;
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
      if (command?.type === 'navigate') {
        const target = command.url;

        if (!target || !target.startsWith('https://chatgpt.com/')) {
          throw new Error('Navigation target must be a chatgpt.com URL.');
        }

        directNavigationTabs.add(boundTabId);
        await chrome.tabs.update(boundTabId, { url: target });
        return;
      }

      if (reloadingConversationTabs.has(boundTabId)) {
        await waitForTabReady(boundTabId);
        reloadingConversationTabs.delete(boundTabId);
      }

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

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    if (socket !== ws) return;
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

function conversationId(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://chatgpt.com') return null;

    const match = parsed.pathname.match(/\/c\/([^/]+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

async function waitForTabReady(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === 'complete') return tab;
    } catch {
      throw new Error('Bound ChatGPT tab is unavailable.');
    }

    await delay(100);
  }

  throw new Error('Timed out waiting for the ChatGPT tab to finish reloading.');
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

async function ensureContentScript(tabId) {
  const current = await pingContent(tabId);

  if (current?.ok && current.version === CONTENT_SCRIPT_VERSION) {
    return current;
  }

  // Never reload the ChatGPT page just to refresh the connector.
  // After an unpacked-extension Reload, the previous content-script context
  // is invalidated, so reinject the current file directly into the open tab.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (error) {
    throw new Error(
      `Could not inject ChatGPT content script: ${error?.message || error}`
    );
  }

  return await waitForExpectedContent(tabId, 5000);
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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId !== boundTabId) return;

  if (changeInfo.url) {
    if (!changeInfo.url.startsWith('https://chatgpt.com/')) {
      reloadingConversationTabs.delete(tabId);
      directNavigationTabs.delete(tabId);
      await clearBinding();
      send({ type: 'unbind' });
      return;
    }

    const previousConversationId = conversationId(boundUrl);
    const nextConversationId = conversationId(changeInfo.url);

    boundUrl = changeInfo.url;
    await chrome.storage.local.set({ boundTabId, boundUrl });

    send({
      type: 'bind',
      url: boundUrl,
      title: tab?.title || 'ChatGPT'
    });

    // ChatGPT SPA navigation can leave the ProseMirror composer visually
    // present but disconnected from its Send-button state. Do one real page
    // reload only when moving from one existing /c/<id> conversation to
    // another. Do not reload the transition from "new chat" to its first
    // generated /c/<id>, because that can happen while a response is running.
    if (
      !directNavigationTabs.has(tabId) &&
      previousConversationId &&
      nextConversationId &&
      previousConversationId !== nextConversationId
    ) {
      reloadingConversationTabs.add(tabId);

      try {
        await chrome.tabs.reload(tabId);
      } catch (error) {
        reloadingConversationTabs.delete(tabId);
        send({
          type: 'error',
          error: `Could not refresh the newly selected ChatGPT conversation: ${error?.message || error}`
        });
      }
    }

    return;
  }

  if (
    changeInfo.status === 'complete' &&
    directNavigationTabs.has(tabId)
  ) {
    directNavigationTabs.delete(tabId);

    try {
      const ping = await ensureContentScript(tabId);
      const refreshed = await chrome.tabs.get(tabId);

      boundUrl = refreshed.url;
      await chrome.storage.local.set({ boundTabId, boundUrl });

      send({
        type: 'bind',
        url: boundUrl,
        title: refreshed.title || tab?.title || 'ChatGPT',
        detail: `direct_navigation content=${ping.version}`
      });
    } catch (error) {
      send({
        type: 'error',
        error: `ChatGPT navigation failed: ${error?.message || error}`
      });
    }

    return;
  }

  if (
    changeInfo.status === 'complete' &&
    reloadingConversationTabs.has(tabId)
  ) {
    reloadingConversationTabs.delete(tabId);

    try {
      const ping = await ensureContentScript(tabId);
      const refreshed = await chrome.tabs.get(tabId);

      boundUrl = refreshed.url;
      await chrome.storage.local.set({ boundTabId, boundUrl });

      send({
        type: 'bind',
        url: boundUrl,
        title: refreshed.title || tab?.title || 'ChatGPT',
        detail: `conversation_refreshed content=${ping.version}`
      });
    } catch (error) {
      send({
        type: 'error',
        error: `ChatGPT conversation refresh failed: ${error?.message || error}`
      });
    }
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (tabId !== boundTabId) return;

  await clearBinding();
  send({ type: 'unbind' });
});

connect();
