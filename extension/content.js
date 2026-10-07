(() => {
  if (window.__gptTgConnectorLoaded) return;
  window.__gptTgConnectorLoaded = true;

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
  let lastDetail = null;
  let wasBusy = false;
  let settleTimer = null;
  let submissionTimer = null;
  let lastForwardedFingerprint = null;
  let initialized = false;

  let baselineUserCount = 0;
  let baselineAssistantCount = 0;
  let baselineAssistantFingerprint = null;
  let promptAccepted = false;

  const first = selectors => selectors.map(s => document.querySelector(s)).find(Boolean) || null;
  const emit = payload => chrome.runtime.sendMessage({ kind: 'edgeEvent', payload }).catch(() => {});
  const root = () => document.querySelector('main') || document;

  function inferredRole(turn) {
    if (!turn) return null;

    const direct = turn.getAttribute?.('data-turn');
    if (direct === 'user' || direct === 'assistant') return direct;

    const roleNode = turn.matches?.('[data-message-author-role], [data-role], [data-message-author]')
      ? turn
      : turn.querySelector?.('[data-message-author-role], [data-role], [data-message-author]');

    const attr =
      roleNode?.getAttribute('data-message-author-role') ||
      roleNode?.getAttribute('data-role') ||
      roleNode?.getAttribute('data-message-author');

    if (attr === 'user' || attr === 'assistant') return attr;

    const heading = [...turn.querySelectorAll?.('h1,h2,h3,h4,h5,h6,[aria-label]') || []]
      .map(el => `${el.getAttribute?.('aria-label') || ''} ${el.textContent || ''}`.trim())
      .join(' ')
      .toLowerCase();

    if (/\b(you said|user said|вы сказали|пользователь)\b/.test(heading)) return 'user';
    if (/\b(chatgpt said|assistant said|chatgpt|assistant|ассистент)\b/.test(heading)) return 'assistant';

    return null;
  }

  function roleMessages(role) {
    const container = root();
    const result = [];
    const seen = new Set();

    const add = node => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      result.push(node);
    };

    for (const selector of [
      `[data-message-author-role="${role}"]`,
      `[data-message-author="${role}"]`,
      `[data-role="${role}"]`,
      `[data-turn="${role}"]`
    ]) {
      for (const node of container.querySelectorAll(selector)) add(node);
    }

    for (const turn of container.querySelectorAll(
      '[data-testid^="conversation-turn-"], [data-testid*="conversation-turn"]'
    )) {
      if (inferredRole(turn) !== role) continue;

      const roleNode = turn.querySelector(
        `[data-message-author-role="${role}"], [data-message-author="${role}"], [data-role="${role}"]`
      );
      add(roleNode || turn);
    }

    if (role === 'assistant') {
      for (const node of container.querySelectorAll('.agent-turn')) add(node);
    }

    result.sort((a, b) => {
      if (a === b) return 0;
      const relation = a.compareDocumentPosition(b);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return result;
  }

  function userMessages() {
    return roleMessages('user');
  }

  function assistantMessages() {
    return roleMessages('assistant');
  }

  function messageText(node) {
    if (!node) return '';

    const preferred = node.querySelector?.(
      '.markdown, [data-message-content], .prose, [class*="markdown"]'
    );

    const roleNode = node.matches?.(
      '[data-message-author-role], [data-message-author], [data-role]'
    )
      ? node
      : node.querySelector?.('[data-message-author-role], [data-message-author], [data-role]');

    return (preferred?.innerText || roleNode?.innerText || node.innerText || node.textContent || '').trim();
  }

  function messageIdentity(node) {
    if (!node) return '';

    const roleNode = node.matches?.(
      '[data-message-author-role], [data-message-author], [data-role]'
    )
      ? node
      : node.querySelector?.('[data-message-author-role], [data-message-author], [data-role]');

    const turn = node.matches?.('[data-turn-id], [data-testid*="conversation-turn"]')
      ? node
      : node.closest?.('[data-turn-id], [data-testid*="conversation-turn"]');

    return (
      roleNode?.getAttribute('data-message-id') ||
      roleNode?.getAttribute('data-message-uuid') ||
      turn?.getAttribute('data-turn-id') ||
      turn?.getAttribute('data-testid') ||
      node.id ||
      ''
    );
  }

  function fingerprint(node, text) {
    return `${messageIdentity(node)}|${text.length}|${text.slice(-160)}`;
  }

  function domDiagnostics() {
    const container = root();
    return [
      `users=${userMessages().length}`,
      `assistants=${assistantMessages().length}`,
      `roleNodes=${container.querySelectorAll('[data-message-author-role]').length}`,
      `turnShells=${container.querySelectorAll('[data-turn], [data-testid*="conversation-turn"]').length}`
    ].join(' ');
  }

  function findUiError() {
    for (const selector of ['[role="alert"]', '[data-testid*="error"]', '[class*="error"]']) {
      for (const el of document.querySelectorAll(selector)) {
        const text = (el.innerText || '').trim();
        if (text && text.length < 1000 && el.offsetParent !== null) return text;
      }
    }
    return '';
  }

  function hasToolActivity(node) {
    if (!node) return false;
    return Boolean(node.querySelector?.('[data-testid*="tool"], [data-tool], [data-testid*="action"]'));
  }

  function setState(state, detail = null) {
    if (state === lastState && detail === lastDetail) return;
    lastState = state;
    lastDetail = detail;
    emit({ type: 'state', jobId: activeJobId, state, detail });
  }

  function clearJob() {
    clearTimeout(submissionTimer);
    activeJobId = null;
    promptAccepted = false;
    wasBusy = false;
    baselineUserCount = 0;
    baselineAssistantCount = 0;
    baselineAssistantFingerprint = null;
  }

  function failActiveJob(message) {
    if (!activeJobId) return;
    const jobId = activeJobId;
    clearJob();
    emit({ type: 'error', jobId, error: message });
    setState('idle', domDiagnostics());
  }

  function evaluate() {
    const assistants = assistantMessages();
    const node = assistants.at(-1) || null;
    const text = messageText(node);
    const currentFingerprint = node && text ? fingerprint(node, text) : null;
    const busy = Boolean(first(SELECTORS.stop));

    if (!initialized) {
      initialized = true;
      if (currentFingerprint) lastForwardedFingerprint = currentFingerprint;
    }

    if (activeJobId) {
      if (!promptAccepted) {
        const accepted =
          userMessages().length > baselineUserCount ||
          assistants.length > baselineAssistantCount ||
          busy;

        if (!accepted) {
          setState('waiting', `waiting_for_prompt_accept ${domDiagnostics()}`);
          return;
        }

        promptAccepted = true;
        clearTimeout(submissionTimer);
        setState(
          busy ? 'generating' : 'waiting',
          `prompt_accepted ${domDiagnostics()}`
        );
      }

      if (busy) {
        wasBusy = true;
        clearTimeout(settleTimer);
        setState(
          hasToolActivity(node) ? 'tool_running' : 'generating',
          domDiagnostics()
        );
        return;
      }

      const hasNewAssistant =
        assistants.length > baselineAssistantCount ||
        (currentFingerprint &&
          currentFingerprint !== baselineAssistantFingerprint &&
          currentFingerprint !== lastForwardedFingerprint);

      if (hasNewAssistant && text) {
        setState('finishing', domDiagnostics());
        scheduleCompletion();
        return;
      }

      setState('waiting', `waiting_for_assistant ${domDiagnostics()}`);
      return;
    }

    if (busy) {
      wasBusy = true;
      clearTimeout(settleTimer);
      setState(
        hasToolActivity(node) ? 'tool_running' : 'generating',
        domDiagnostics()
      );
      return;
    }

    if (wasBusy) {
      setState('finishing', domDiagnostics());
      scheduleCompletion();
      return;
    }

    if (currentFingerprint && currentFingerprint !== lastForwardedFingerprint) {
      scheduleCompletion();
      return;
    }

    setState('idle', domDiagnostics());
  }

  function scheduleCompletion() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const assistants = assistantMessages();
      const node = assistants.at(-1) || null;
      const text = messageText(node);
      const currentFingerprint = node && text ? fingerprint(node, text) : null;

      if (first(SELECTORS.stop)) {
        evaluate();
        return;
      }

      if (activeJobId) {
        const hasNewAssistant =
          assistants.length > baselineAssistantCount ||
          (currentFingerprint &&
            currentFingerprint !== baselineAssistantFingerprint &&
            currentFingerprint !== lastForwardedFingerprint);

        if (!hasNewAssistant || !currentFingerprint) {
          setState('waiting', `assistant_not_ready ${domDiagnostics()}`);
          return;
        }

        const jobId = activeJobId;
        const error = findUiError();
        lastForwardedFingerprint = currentFingerprint;
        clearJob();
        emit({ type: 'result', jobId, text, error: error || null });
        setState('idle', domDiagnostics());
        return;
      }

      if (!currentFingerprint || currentFingerprint === lastForwardedFingerprint) {
        wasBusy = false;
        setState('idle', domDiagnostics());
        return;
      }

      const error = findUiError();
      lastForwardedFingerprint = currentFingerprint;
      wasBusy = false;
      emit({ type: 'observedResult', eventId: crypto.randomUUID(), text, error: error || null });
      setState('idle', domDiagnostics());
    }, 1800);
  }

  function setComposerText(composer, text) {
    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(composer, text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (composer.isContentEditable) {
      composer.replaceChildren();
      composer.focus();

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection?.removeAllRanges();
      selection?.addRange(range);

      const inserted = document.execCommand?.('insertText', false, text);
      if (!inserted) composer.textContent = text;

      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text
      }));
      return;
    }

    throw new Error('Unsupported ChatGPT composer element.');
  }

  function waitForEnabledSendButton(timeoutMs = 2500) {
    const immediate = first(SELECTORS.send);
    if (immediate && !immediate.disabled) return Promise.resolve(immediate);

    return new Promise(resolve => {
      let finished = false;

      const finish = value => {
        if (finished) return;
        finished = true;
        watcher.disconnect();
        clearTimeout(timer);
        resolve(value);
      };

      const watcher = new MutationObserver(() => {
        const button = first(SELECTORS.send);
        if (button && !button.disabled) finish(button);
      });

      watcher.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled']
      });

      const timer = setTimeout(() => finish(first(SELECTORS.send)), timeoutMs);
    });
  }

  async function sendPrompt(command) {
    if (activeJobId) throw new Error('Another bridge job is already active.');
    if (first(SELECTORS.stop)) throw new Error('ChatGPT is still busy with the previous generation.');

    const composer = first(SELECTORS.composer);
    if (!composer) throw new Error('ChatGPT composer was not found.');

    const assistants = assistantMessages();
    const lastAssistant = assistants.at(-1) || null;
    const lastAssistantText = messageText(lastAssistant);

    activeJobId = command.jobId;
    baselineUserCount = userMessages().length;
    baselineAssistantCount = assistants.length;
    baselineAssistantFingerprint =
      lastAssistant && lastAssistantText ? fingerprint(lastAssistant, lastAssistantText) : null;
    promptAccepted = false;
    wasBusy = false;

    setState('submitting', domDiagnostics());
    setComposerText(composer, command.text || '');

    const sendButton = await waitForEnabledSendButton();

    if (sendButton && !sendButton.disabled) {
      sendButton.click();
    } else {
      const form = composer.closest('form');
      if (form?.requestSubmit) {
        form.requestSubmit();
      } else {
        composer.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true
        }));
      }
    }

    setState('waiting', `waiting_for_prompt_accept ${domDiagnostics()}`);

    submissionTimer = setTimeout(() => {
      if (!activeJobId || promptAccepted) return;
      const uiError = findUiError();
      failActiveJob(
        uiError
          ? `ChatGPT did not accept the prompt: ${uiError}`
          : `ChatGPT did not accept the prompt within 12 seconds. ${domDiagnostics()}`
      );
    }, 12000);

    evaluate();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind === 'connectorPing') {
      sendResponse({
        ok: true,
        state: lastState || 'ready',
        activeJobId,
        diagnostics: domDiagnostics()
      });
      return;
    }

    if (message?.kind !== 'bridgeCommand') return;
    const command = message.command;
    if (command?.type !== 'sendPrompt') return;

    sendPrompt(command)
      .then(() => sendResponse({ ok: true }))
      .catch(error => {
        const jobId = command.jobId;
        if (activeJobId === jobId) clearJob();
        emit({ type: 'error', jobId, error: error?.message || String(error) });
        setState('idle', domDiagnostics());
        sendResponse({ ok: false, error: error?.message || String(error) });
      });

    return true;
  });

  const observer = new MutationObserver(() => {
    clearTimeout(window.__gptTgConnectorMutationTimer);
    window.__gptTgConnectorMutationTimer = setTimeout(evaluate, 100);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'data-turn', 'data-message-author-role']
  });

  evaluate();
})();
