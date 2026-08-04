const { DEFAULT_LOCAL_APP_URL, normalizeBaseUrl } = globalThis.LocalChatApiConfig;

const urlInput = document.querySelector('#localAppUrl');
const pairingCodeInput = document.querySelector('#pairingCode');
const statusEl = document.querySelector('#status');
const saveBtn = document.querySelector('#save');
const pairBtn = document.querySelector('#pair');
const testBtn = document.querySelector('#test');

function preferenceStorage() {
  return chrome.storage.sync || chrome.storage.local;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b91c1c' : '#52525b';
}

async function sendRuntimeMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Extension request failed.');
  return response;
}

async function load() {
  const data = await preferenceStorage().get({ localAppUrl: DEFAULT_LOCAL_APP_URL });
  urlInput.value = normalizeBaseUrl(data.localAppUrl);
}

async function save() {
  const localAppUrl = normalizeBaseUrl(urlInput.value);
  await preferenceStorage().set({ localAppUrl });
  urlInput.value = localAppUrl;
  setStatus('Local app URL saved.');
  return localAppUrl;
}

async function pair() {
  try {
    const localAppUrl = await save();
    const code = String(pairingCodeInput.value || '').trim().toUpperCase();
    const response = await sendRuntimeMessage({
      type: 'PAIR_LOCAL_CHAT_APP',
      payload: { localAppUrl, code }
    });
    pairingCodeInput.value = '';
    setStatus(`Paired with Local Chat App (${response.extensionId}).`);
  } catch (error) {
    setStatus(`Could not pair: ${error.message}`, true);
  }
}

async function test() {
  try {
    await save();
    const result = await sendRuntimeMessage({ type: 'CHECK_LOCAL_CHAT_APP' });
    const active = result.active?.sessionId;
    if (!active) {
      setStatus('Connected and paired. No active chat is selected.');
      return;
    }
    setStatus(`Connected. Active chat: ${active}`);
  } catch (error) {
    setStatus(`Could not connect: ${error.message}`, true);
  }
}

saveBtn.addEventListener('click', () => save().catch((error) => setStatus(error.message, true)));
pairBtn.addEventListener('click', pair);
testBtn.addEventListener('click', test);

load().catch((error) => setStatus(error.message, true));
