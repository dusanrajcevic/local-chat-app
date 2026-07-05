const DEFAULT_LOCAL_APP_URL = 'http://localhost:3000';

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_LOCAL_APP_URL)
    .trim()
    .replace(/\/+$/, '');
  return raw || DEFAULT_LOCAL_APP_URL;
}

async function getSettings() {
  const data = await chrome.storage.local.get({
    localAppUrl: DEFAULT_LOCAL_APP_URL,
    localChatToken: ''
  });

  return {
    localAppUrl: normalizeBaseUrl(data.localAppUrl),
    localChatToken: String(data.localChatToken || '').trim()
  };
}

function requestHeaders(settings, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (settings?.localChatToken) headers['X-Local-Chat-Token'] = settings.localChatToken;
  return headers;
}

async function fetchJson(url, options = {}) {
  const settings = await getSettings();
  const res = await fetch(url, {
    ...options,
    headers: requestHeaders(settings, options)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

async function checkLocalChatApp() {
  const { localAppUrl } = await getSettings();
  const health = await fetchJson(`${localAppUrl}/api/health`);

  return {
    ok: true,
    localAppUrl,
    health
  };
}

async function getActiveSession(baseUrl) {
  const active = await fetchJson(`${baseUrl}/api/active-session`);
  if (!active?.sessionId) {
    throw new Error('No active local chat session. Open a session in your local app first.');
  }
  return active;
}

async function saveMessage(payload) {
  const text = String(payload.text || '').trim();
  if (!text) throw new Error('No message text was found to save.');

  const sender = payload.sender === 'me' ? 'me' : 'bot';

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  const explicitSessionId = String(payload.sessionId || '').trim();
  const active = explicitSessionId ? null : await getActiveSession(localAppUrl);
  const sessionId = explicitSessionId || active.sessionId;
  const idempotencyKey = String(payload.idempotencyKey || '').trim();

  const message = await fetchJson(`${localAppUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    body: JSON.stringify({
      sender,
      text,
      source: payload.source || '',
      providerKey: payload.providerKey || '',
      idempotencyKey
    })
  });

  const sessionTitle =
    active?.session?.title || payload.sessionTitle || (explicitSessionId ? 'selected session' : 'active session');

  return {
    ok: true,
    sessionId,
    sessionTitle,
    message
  };
}

async function createLocalChatSession(payload) {
  const title = String(payload.title || '').trim();
  if (!title) throw new Error('Session name is required.');

  const provider = String(payload.provider || 'AI Bot').trim() || 'AI Bot';
  const pinnedFolderId = String(payload.pinnedFolderId || '').trim() || null;
  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  const session = await fetchJson(`${localAppUrl}/api/sessions`, {
    method: 'POST',
    body: JSON.stringify({ title, aiName: provider, pinnedFolderId })
  });

  const active = await fetchJson(`${localAppUrl}/api/active-session`, {
    method: 'PUT',
    body: JSON.stringify({ sessionId: session.id })
  });

  return {
    ok: true,
    sessionId: session.id,
    sessionTitle: session.title,
    active
  };
}

async function createLocalChatFolder(payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Folder name is required.');

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  const folder = await fetchJson(`${localAppUrl}/api/folders`, {
    method: 'POST',
    body: JSON.stringify({ name })
  });

  return { ok: true, folder };
}

async function updateLocalChatSessionFolder(payload = {}) {
  const sessionId = String(payload.sessionId || '').trim();
  if (!sessionId) throw new Error('Session ID is required.');

  const pinnedFolderId = String(payload.pinnedFolderId || '').trim() || null;
  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  const session = await fetchJson(`${localAppUrl}/api/sessions/${encodeURIComponent(sessionId)}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ pinnedFolderId })
  });

  return { ok: true, sessionId: session.id || sessionId, session };
}

async function updateLocalChatSessionTitle(payload = {}) {
  const sessionId = String(payload.sessionId || '').trim();
  if (!sessionId) throw new Error('Session ID is required.');

  const title = String(payload.title || '').trim();
  if (!title) throw new Error('Chat title is required.');

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  const session = await fetchJson(`${localAppUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title })
  });

  return { ok: true, sessionId: session.id || sessionId, session };
}

async function deleteLocalChatSession(payload = {}) {
  const sessionId = String(payload.sessionId || '').trim();
  if (!sessionId) throw new Error('Session ID is required.');

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  await fetchJson(`${localAppUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE'
  });

  return { ok: true, sessionId };
}

async function updateLocalChatFolderName(payload = {}) {
  const folderId = String(payload.folderId || '').trim();
  if (!folderId) throw new Error('Folder ID is required.');

  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Folder name is required.');

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  const folder = await fetchJson(`${localAppUrl}/api/folders/${encodeURIComponent(folderId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name })
  });

  return { ok: true, folderId: folder.id || folderId, folder };
}

async function deleteLocalChatFolder(payload = {}) {
  const folderId = String(payload.folderId || '').trim();
  if (!folderId) throw new Error('Folder ID is required.');

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  await fetchJson(`${localAppUrl}/api/folders/${encodeURIComponent(folderId)}`, {
    method: 'DELETE'
  });

  return { ok: true, folderId };
}

async function listRecentLocalChats(payload = {}) {
  const rawLimit = Number(payload.limit || 100);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);
  const chats = await fetchJson(`${localAppUrl}/api/recent-chats?limit=${encodeURIComponent(limit)}`);

  return { ok: true, chats };
}

async function searchLocalChats(payload = {}) {
  const query = String(payload.query || payload.q || '').trim();
  const rawLimit = Number(payload.limit || 100);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  const params = new URLSearchParams();
  params.set('q', query);
  params.set('limit', String(limit));
  const data = await fetchJson(`${localAppUrl}/api/search-chats?${params.toString()}`);

  return {
    ok: true,
    chats: Array.isArray(data.results) ? data.results : [],
    query: data.query || query,
    count: data.count || 0
  };
}

async function listLocalSidebarData(payload = {}) {
  const rawLimit = Number(payload.limit || 500);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 1000) : 500;

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  const [folders, sessions, active] = await Promise.all([
    fetchJson(`${localAppUrl}/api/folders`),
    fetchJson(`${localAppUrl}/api/sessions`),
    fetchJson(`${localAppUrl}/api/active-session`)
  ]);

  return {
    ok: true,
    folders: Array.isArray(folders) ? folders : [],
    sessions: Array.isArray(sessions) ? sessions.slice(0, limit) : [],
    active,
    activeSessionId: active?.sessionId || null
  };
}

async function setActiveLocalChatSession(payload = {}) {
  const sessionId = String(payload.sessionId || '').trim();
  if (!sessionId) throw new Error('Session ID is required.');

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  const active = await fetchJson(`${localAppUrl}/api/active-session`, {
    method: 'PUT',
    body: JSON.stringify({ sessionId })
  });

  return {
    ok: true,
    sessionId: active.sessionId || sessionId,
    sessionTitle: active.session?.title || 'active session',
    active
  };
}

async function loadLocalChatExport(payload = {}) {
  const sessionId = String(payload.sessionId || '').trim();
  if (!sessionId) throw new Error('Session ID is required.');

  const { localAppUrl } = await getSettings();
  await fetchJson(`${localAppUrl}/api/health`);

  let active = null;
  if (payload.activate !== false) {
    active = await fetchJson(`${localAppUrl}/api/active-session`, {
      method: 'PUT',
      body: JSON.stringify({ sessionId })
    });
  }

  const exportData = await fetchJson(`${localAppUrl}/api/sessions/${encodeURIComponent(sessionId)}/export`);

  return {
    ok: true,
    ...exportData,
    active,
    sessionId: active?.sessionId || sessionId,
    sessionTitle: active?.session?.title || exportData.session?.title || 'active session'
  };
}

function handleRuntimeMessage(message, sender, sendResponse) {
  if (!message) return false;

  if (message.type === 'CHECK_LOCAL_CHAT_APP') {
    checkLocalChatApp()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || 'Local chat app is not running.' }));
    return true;
  }

  if (message.type === 'SAVE_LOCAL_CHAT_MESSAGE') {
    saveMessage(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'CREATE_LOCAL_CHAT_SESSION') {
    createLocalChatSession(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'CREATE_LOCAL_CHAT_FOLDER') {
    createLocalChatFolder(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'UPDATE_LOCAL_CHAT_SESSION_FOLDER') {
    updateLocalChatSessionFolder(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'UPDATE_LOCAL_CHAT_SESSION_TITLE') {
    updateLocalChatSessionTitle(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'DELETE_LOCAL_CHAT_SESSION') {
    deleteLocalChatSession(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'UPDATE_LOCAL_CHAT_FOLDER_NAME') {
    updateLocalChatFolderName(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'DELETE_LOCAL_CHAT_FOLDER') {
    deleteLocalChatFolder(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'LIST_RECENT_LOCAL_CHATS') {
    listRecentLocalChats(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'SEARCH_LOCAL_CHATS') {
    searchLocalChats(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'LIST_LOCAL_SIDEBAR') {
    listLocalSidebarData(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'SET_ACTIVE_LOCAL_CHAT_SESSION') {
    setActiveLocalChatSession(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'LOAD_LOCAL_CHAT_EXPORT') {
    loadLocalChatExport(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_LOCAL_APP_URL,
    normalizeBaseUrl,
    getSettings,
    requestHeaders,
    fetchJson,
    checkLocalChatApp,
    getActiveSession,
    saveMessage,
    createLocalChatSession,
    createLocalChatFolder,
    updateLocalChatSessionFolder,
    updateLocalChatSessionTitle,
    deleteLocalChatSession,
    updateLocalChatFolderName,
    deleteLocalChatFolder,
    listRecentLocalChats,
    searchLocalChats,
    listLocalSidebarData,
    setActiveLocalChatSession,
    loadLocalChatExport,
    handleRuntimeMessage
  };
}
