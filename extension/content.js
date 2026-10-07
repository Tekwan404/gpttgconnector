(() => {
  const SELECTORS = {
    composer: [
      '#prompt-textarea',
      '[data-testid="composer-text-input"]',
      'textarea[data-id="root"]',
      'form textarea',
      'form [contenteditable="true"]'
    ],
    send: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Отправ"]'
    ],
    stop: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label*="Останов"]'
    ]
  };

  let activeJobId = null;
  let lastState = null;
  let wasBusy = false;
  let settleTimer = null;
  let lastForwardedFingerprint = null;
  let initialized = false;

  const first = selectors => selectors.map(s => document.querySelector(s)).find(Boolean) || null;
  const emit = payload => chrome.runtime.sendMessage({ kind: 'edgeEvent', payload }).catch(() => {});

  function assistantMessages() {
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  }

  function latestAssistant() {
    const items = assistantMessages();
    return items.at(-1) || null;
  }

  function assistantText(node) {
    if (!node) return '';
    const markdown = node.querySelector('.markdown, [data-message-content], [class*="markdown"]');
    return (markdown?.innerText || node.innerText || '').trim();
  }

  function fingerprint(node, text) {
    const id = node?.getAttribute('data-message-id') || node?.id || '';
    return `${id}|${text.length}|${text.slice(-160)}`;
  }

  function findUiError() {
    const candidates = [
      '[role="alert"]',
      '[data-testid*="error"]',
      '[class*="error"]'
    ];
    for (const selector of candidates) {
      for (const el of document.querySelectorAll(selector)) {
        const text = (el.innerText || '').trim();
        if (text && text.length < 1000 && el.offsetParent !== null) return text;
      }
    }
    return '';
  }

  function hasToolActivity(node) {
    if (!node) return false;
    return Boolean(node.querySelector('[data-testid*="tool"], [data-tool], [data-testid*="action"]'));
  }

  function setState(state, detail = null) {
    if (state === lastState && !detail) return;
    lastState = state;
    emit({ type: 'state', jobId: activeJobId, state, detail });
  }

  function evaluate() {
    const node = latestAssistant();
    const text = assistantText(node);
    const busy = Boolean(first(SELECTORS.stop));

    if (!initialized) {
      initialized = true;
      if (node && text) lastForwardedFingerprint = fingerprint(node, text);
    }

    if (busy) {
      wasBusy = true;
      clearTimeout(settleTimer);
      setState(hasToolActivity(node) ? 'tool_running' : 'generating');
      return;
    }

    if (wasBusy) {
      setState('finishing');
      scheduleCompletion();
      return;
    }

    if (node && text && fingerprint(node, text) !== lastForwardedFingerprint) {
      scheduleCompletion();
    }
  }

  function scheduleCompletion() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const node = latestAssistant();
      const text = assistantText(node);
      const currentFingerprint = node && text ? fingerprint(node, text) : null;
      const stillBusy = Boolean(first(SELECTORS.stop));
      if (stillBusy) return evaluate();
      if (!currentFingerprint || currentFingerprint === lastForwardedFingerprint) {
        wasBusy = false;
        setState('idle');
        return;
      }

      const error = findUiError();
      lastForwardedFingerprint = currentFingerprint;
      const payload = activeJobId
        ? { type: 'result', jobId: activeJobId, text, error: error || null }
        : { type: 'observedResult', eventId: crypto.randomUUID(), text, error: error || null };
      emit(payload);
      activeJobId = null;
      wasBusy = false;
      setState('idle');
    }, 1800);
  }

  function setComposerText(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(composer, text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (composer.isContentEditable) {
      composer.replaceChildren();
      composer.focus();
      const inserted = document.execCommand?.('insertText', false, text);
      if (!inserted) composer.textContent = text;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return;
    }

    throw new Error('Unsupported ChatGPT composer element.');
  }

  async function sendPrompt(command) {
    if (first(SELECTORS.stop)) throw new Error('ChatGPT is still busy with the previous generation.');
    const composer = first(SELECTORS.composer);
    if (!composer) throw new Error('ChatGPT composer was not found. Refresh ChatGPT and try again.');

    activeJobId = command.jobId;
    setState('submitting');
    setComposerText(composer, command.text || '');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const sendButton = first(SELECTORS.send);
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
    } else {
      const form = composer.closest('form');
      if (form?.requestSubmit) form.requestSubmit();
      else composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    }

    setState('waiting');
    setTimeout(evaluate, 250);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind !== 'bridgeCommand') return;
    const command = message.command;
    if (command?.type !== 'sendPrompt') return;

    sendPrompt(command)
      .then(() => sendResponse({ ok: true }))
      .catch(error => {
        emit({ type: 'error', jobId: command.jobId, error: error?.message || String(error) });
        activeJobId = null;
        setState('idle');
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  });

  const observer = new MutationObserver(() => {
    clearTimeout(window.__gptTgConnectorMutationTimer);
    window.__gptTgConnectorMutationTimer = setTimeout(evaluate, 120);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  evaluate();
})();
