const DEFAULT_LOCAL_APP_URL = 'http://localhost:3000';

const urlInput = document.querySelector('#localAppUrl');
const statusEl = document.querySelector('#status');
const tokenInput = document.querySelector('#localChatToken');
const saveBtn = document.querySelector('#save');
const testBtn = document.querySelector('#test');

function normalizeBaseUrl(value) {
  return (
    String(value || DEFAULT_LOCAL_APP_URL)
      .trim()
      .replace(/\/+$/, '') || DEFAULT_LOCAL_APP_URL
  );
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b91c1c' : '#52525b';
}

async function fetchJson(url) {
  const token = String(tokenInput.value || '').trim();
  const headers = token ? { 'X-Local-Chat-Token': token } : {};
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function load() {
  const data = await chrome.storage.local.get({ localAppUrl: DEFAULT_LOCAL_APP_URL, localChatToken: '' });
  urlInput.value = normalizeBaseUrl(data.localAppUrl);
  tokenInput.value = String(data.localChatToken || '');
}

async function save() {
  const localAppUrl = normalizeBaseUrl(urlInput.value);
  const localChatToken = String(tokenInput.value || '').trim();
  await chrome.storage.local.set({ localAppUrl, localChatToken });
  urlInput.value = localAppUrl;
  setStatus('Saved.');
}

async function test() {
  await save();
  const baseUrl = normalizeBaseUrl(urlInput.value);

  try {
    await fetchJson(`${baseUrl}/api/health`);
    const active = await fetchJson(`${baseUrl}/api/active-session`);
    if (!active?.sessionId) {
      setStatus('Connected, but no active chat is selected. Open a session in the local app.', true);
      return;
    }

    setStatus(`Connected. Active chat: ${active.session?.title || active.sessionId}`);
  } catch (error) {
    setStatus(`Could not connect: ${error.message}`, true);
  }
}

saveBtn.addEventListener('click', save);
testBtn.addEventListener('click', test);

load().catch((error) => setStatus(error.message, true));
