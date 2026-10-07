const status = document.querySelector('#status');
const result = document.querySelector('#result');

document.querySelector('#bind').addEventListener('click', async () => {
  result.textContent = '';
  const response = await chrome.runtime.sendMessage({ kind: 'bindActiveTab' });
  result.textContent = response?.ok ? `Bound: ${response.title || response.url}` : `Error: ${response?.error || 'unknown error'}`;
  refresh();
});

async function refresh() {
  const s = await chrome.runtime.sendMessage({ kind: 'getStatus' });
  status.textContent = `Bridge: ${s?.socketOpen ? 'connected' : s?.state || 'disconnected'}\nTab: ${s?.boundUrl || 'not bound'}`;
}

refresh();
