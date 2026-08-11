const { DEFAULT_LOCAL_APP_URL, normalizeBaseUrl } = globalThis.LocalChatApiConfig;

const urlInput = document.querySelector('#localAppUrl');
const pairingCodeInput = document.querySelector('#pairingCode');
const statusEl = document.querySelector('#status');
const saveBtn = document.querySelector('#save');
const pairBtn = document.querySelector('#pair');
const testBtn = document.querySelector('#test');
const diagnoseBtn = document.querySelector('#diagnose');
const diagnosticsEl = document.querySelector('#diagnostics');
const diagnosticsBody = document.querySelector('#diagnosticsBody');

function preferenceStorage() {
  return chrome.storage.sync || chrome.storage.local;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b91c1c' : '#52525b';
  statusEl.setAttribute('role', isError ? 'alert' : 'status');
  statusEl.setAttribute('aria-live', isError ? 'assertive' : 'polite');
}

async function sendRuntimeMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Extension request failed.');
  return response;
}

function appendTextElement(parent, tagName, text, className = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function diagnosticStatusLabel(status) {
  if (status === 'pass') return 'Healthy';
  if (status === 'warning') return 'Needs attention';
  if (status === 'fail') return 'Not working';
  return 'Unsupported page';
}

function selectorHitSummary(groups = {}) {
  return Object.entries(groups).flatMap(([group, entries]) =>
    (entries || []).filter((entry) => entry.count > 0).map((entry) => `${group}: ${entry.selector} (${entry.count})`)
  );
}

function renderDiagnostics(report) {
  diagnosticsBody.replaceChildren();
  diagnosticsEl.hidden = false;

  const providerName = report.provider?.name || 'Unknown provider';
  const status = diagnosticStatusLabel(report.status);
  appendTextElement(diagnosticsBody, 'p', `${providerName} on ${report.hostname || 'unknown host'} — ${status}.`);

  const summary = report.summary || {};
  appendTextElement(
    diagnosticsBody,
    'p',
    `Messages: ${summary.extractableMessages || 0}/${summary.messageContainers || 0} extractable; ` +
      `${summary.userMessages || 0} user, ${summary.assistantMessages || 0} assistant; ` +
      `${summary.messageLevelCopyControls || 0} message copy controls.`
  );

  const selectorHits = selectorHitSummary(report.selectors);
  if (selectorHits.length) {
    appendTextElement(diagnosticsBody, 'p', 'Matched selectors:');
    const list = document.createElement('ul');
    for (const hit of selectorHits) appendTextElement(list, 'li', hit);
    diagnosticsBody.appendChild(list);
  }

  if (report.warnings?.length) {
    appendTextElement(diagnosticsBody, 'p', 'Warnings:');
    const list = document.createElement('ul');
    for (const warning of report.warnings) appendTextElement(list, 'li', warning);
    diagnosticsBody.appendChild(list);
  }
}

async function diagnosePage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active browser tab is available.');

    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PROVIDER_DIAGNOSTICS' });
    if (!response?.ok) throw new Error(response?.error || 'Provider diagnostics failed.');

    renderDiagnostics(response.diagnostics || {});
    setStatus('Provider diagnostics completed.');
  } catch (error) {
    diagnosticsEl.hidden = true;
    const message = /receiving end does not exist|could not establish connection/i.test(String(error?.message || ''))
      ? 'Open a supported ChatGPT, Claude, DeepSeek, or Gemini chat, then try diagnostics again.'
      : error.message;
    setStatus(`Could not diagnose page: ${message}`, true);
  }
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
    const code = String(pairingCodeInput.value || '')
      .trim()
      .toUpperCase();
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
diagnoseBtn.addEventListener('click', diagnosePage);

load().catch((error) => setStatus(error.message, true));
