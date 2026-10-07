(() => {
  const CONTENT_SCRIPT_VERSION = '0.1.3';
  if (window.__gptTgConnectorLoaded === CONTENT_SCRIPT_VERSION) return;
  window.__gptTgConnectorLoaded = CONTENT_SCRIPT_VERSION;

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

  const PRIMARY_BLOCK_SELECTOR =
    '.markdown, [data-message-content], .prose, [class*="markdown"], [class*="prose"]';
  const LEAF_BLOCK_SELECTOR =
    'p, pre, blockquote, h1, h2, h3, h4, h5, h6, li';

  let activeJobId = null;
  let activePromptText = '';
  let lastState = null;
  let lastDetail = null;
  let wasBusy = false;
  let settleTimer = null;
  let submissionTimer = null;
  let promptAccepted = false;
  let generationBaseline = null;
  let lastForwardedFingerprint = null;

  const first = selectors =>
    selectors.map(selector => document.querySelector(selector)).find(Boolean) || null;

  const emit = payload =>
    chrome.runtime.sendMessage({ kind: 'edgeEvent', payload }).catch(() => {});

  const root = () =>
    document.querySelector('main') || document.body || document.documentElement;

  function normalizeText(value) {
    return (value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function readText(node) {
    return normalizeText(node?.innerText || node?.textContent || '');
  }

  function isVisible(node) {
    if (!node || !node.isConnected) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return node.getClientRects().length > 0;
  }

  function composerElement() {
    return first(SELECTORS.composer);
  }

  function isComposerContent(node) {
    const composer = composerElement();
    return Boolean(composer && (composer === node || composer.contains(node) || node.contains(composer)));
  }

  function dedupeContainers(nodes) {
    const unique = [...new Set(nodes)].filter(node => {
      if (!isVisible(node) || isComposerContent(node)) return false;
      return readText(node).length > 0;
    });

    return unique.filter(node => {
      const text = readText(node);
      return !unique.some(other =>
        other !== node &&
        other.contains(node) &&
        readText(other) === text
      );
    });
  }

  function primaryBlocks() {
    return dedupeContainers([...root().querySelectorAll(PRIMARY_BLOCK_SELECTOR)]);
  }

  function leafBlocks() {
    return dedupeContainers([...root().querySelectorAll(LEAF_BLOCK_SELECTOR)]);
  }

  function snapshotBlocks() {
    return {
      primary: new Map(primaryBlocks().map(node => [node, readText(node)])),
      leaves: new Map(leafBlocks().map(node => [node, readText(node)]))
    };
  }

  function isPromptEcho(text) {
    if (!activePromptText) return false;
    const prompt = normalizeText(activePromptText);
    if (!prompt) return false;
    if (text === prompt) return true;
    return text.includes(prompt) && text.length <= prompt.length + 120;
  }

  function changedNodes(nodes, baselineMap) {
    return nodes
      .map(node => ({ node, text: readText(node) }))
      .filter(item => item.text && !isPromptEcho(item.text))
      .filter(item => {
        const before = baselineMap?.get(item.node);
        return before === undefined || before !== item.text;
      });
  }

  function responseDelta(snapshot = generationBaseline) {
    if (!snapshot) return null;

    const primaryChanged = changedNodes(primaryBlocks(), snapshot.primary);
    if (primaryChanged.length > 0) {
      const item = primaryChanged.at(-1);
      return {
        text: item.text,
        fingerprint: `primary|${primaryChanged.length}|${item.text.length}|${item.text.slice(-180)}`
      };
    }

    const leafChanged = changedNodes(leafBlocks(), snapshot.leaves);
    if (leafChanged.length === 0) return null;

    const pieces = [];
    const seen = new Set();

    for (const item of leafChanged) {
      if (seen.has(item.text)) continue;
      seen.add(item.text);
      pieces.push(item.text);
    }

    const text = normalizeText(pieces.join('\n\n'));
    if (!text) return null;

    return {
      text,
      fingerprint: `leaves|${pieces.length}|${text.length}|${text.slice(-180)}`
    };
  }

  function roleDiagnostics() {
    const container = root();
    return {
      roleNodes: container.querySelectorAll('[data-message-author-role]').length,
      turnShells: container.querySelectorAll(
        '[data-turn], [data-testid*="conversation-turn"]'
      ).length
    };
  }

  function domDiagnostics() {
    const roles = roleDiagnostics();
    return [
      `primary=${primaryBlocks().length}`,
      `leaves=${leafBlocks().length}`,
      `roleNodes=${roles.roleNodes}`,
      `turnShells=${roles.turnShells}`
    ].join(' ');
  }

  function findUiError() {
    for (const selector of [
      '[role="alert"]',
      '[data-testid*="error"]',
      '[class*="error"]'
    ]) {
      for (const element of document.querySelectorAll(selector)) {
        const text = readText(element);
        if (text && text.length < 1000 && isVisible(element)) return text;
      }
    }

    return '';
  }

  function hasToolActivity() {
    return Boolean(
      root().querySelector(
        '[data-testid*="tool"], [data-tool], [data-testid*="action"]'
      )
    );
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
    activePromptText = '';
    promptAccepted = false;
    wasBusy = false;
    generationBaseline = snapshotBlocks();
  }

  function failActiveJob(message) {
    if (!activeJobId) return;

    const jobId = activeJobId;
    clearJob();
    emit({ type: 'error', jobId, error: message });
    setState('idle', domDiagnostics());
  }

  function composerText() {
    const composer = composerElement();
    if (!composer) return '';

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return normalizeText(composer.value);
    }

    return readText(composer);
  }

  function scheduleCompletion() {
    clearTimeout(settleTimer);

    settleTimer = setTimeout(() => {
      if (first(SELECTORS.stop)) {
        evaluate();
        return;
      }

      const delta = responseDelta();

      if (activeJobId) {
        if (!delta) {
          setState('waiting', `assistant_not_ready ${domDiagnostics()}`);
          return;
        }

        const jobId = activeJobId;
        const error = findUiError();
        lastForwardedFingerprint = delta.fingerprint;
        clearJob();

        emit({
          type: 'result',
          jobId,
          text: delta.text,
          error: error || null
        });

        setState('idle', domDiagnostics());
        return;
      }

      if (!delta || delta.fingerprint === lastForwardedFingerprint) {
        wasBusy = false;
        generationBaseline = snapshotBlocks();
        setState('idle', domDiagnostics());
        return;
      }

      const error = findUiError();
      lastForwardedFingerprint = delta.fingerprint;
      wasBusy = false;

      emit({
        type: 'observedResult',
        eventId: crypto.randomUUID(),
        text: delta.text,
        error: error || null
      });

      generationBaseline = snapshotBlocks();
      setState('idle', domDiagnostics());
    }, 1600);
  }

  function evaluate() {
    const busy = Boolean(first(SELECTORS.stop));

    if (activeJobId && !promptAccepted) {
      const accepted =
        busy ||
        composerText().length === 0 ||
        Boolean(responseDelta());

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
      if (!wasBusy && !activeJobId) {
        generationBaseline = snapshotBlocks();
      }

      wasBusy = true;
      clearTimeout(settleTimer);
      setState(
        hasToolActivity() ? 'tool_running' : 'generating',
        domDiagnostics()
      );
      return;
    }

    if (activeJobId) {
      const delta = responseDelta();

      if (delta) {
        setState('finishing', domDiagnostics());
        scheduleCompletion();
        return;
      }

      setState('waiting', `waiting_for_assistant ${domDiagnostics()}`);
      return;
    }

    if (wasBusy) {
      setState('finishing', domDiagnostics());
      scheduleCompletion();
      return;
    }

    setState('idle', domDiagnostics());
  }

  function setComposerText(composer, text) {
    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
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

      const timer = setTimeout(
        () => finish(first(SELECTORS.send)),
        timeoutMs
      );
    });
  }

  async function sendPrompt(command) {
    if (activeJobId) {
      throw new Error('Another bridge job is already active.');
    }

    if (first(SELECTORS.stop)) {
      throw new Error('ChatGPT is still busy with the previous generation.');
    }

    const composer = composerElement();
    if (!composer) {
      throw new Error('ChatGPT composer was not found.');
    }

    activeJobId = command.jobId;
    activePromptText = command.text || '';
    promptAccepted = false;
    wasBusy = false;
    generationBaseline = snapshotBlocks();

    setState('submitting', domDiagnostics());
    setComposerText(composer, activePromptText);

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

    setState(
      'waiting',
      `waiting_for_prompt_accept ${domDiagnostics()}`
    );

    submissionTimer = setTimeout(() => {
      if (!activeJobId || promptAccepted) return;

      const uiError = findUiError();

      failActiveJob(
        uiError
          ? `ChatGPT did not accept the prompt: ${uiError}`
          : `ChatGPT did not accept the prompt within 12 seconds. ${domDiagnostics()}`
      );
    }, 12000);

    setTimeout(evaluate, 100);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind === 'connectorPing') {
      sendResponse({
        ok: true,
        version: CONTENT_SCRIPT_VERSION,
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

        if (activeJobId === jobId) {
          clearJob();
        }

        emit({
          type: 'error',
          jobId,
          error: error?.message || String(error)
        });

        setState('idle', domDiagnostics());
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
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
    attributeFilter: [
      'disabled',
      'aria-disabled',
      'class',
      'data-testid'
    ]
  });

  generationBaseline = snapshotBlocks();
  evaluate();
})();
