const test = require('node:test');
const assert = require('node:assert/strict');

const background = require('../browser-extension/background');

function createStorageArea(initial = {}) {
  const data = { ...initial };
  const calls = { setAccessLevel: [] };

  return {
    data,
    calls,
    area: {
      async get(keys) {
        if (keys === undefined || keys === null) return { ...data };
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
        }
        if (typeof keys === 'string') return data[keys] === undefined ? {} : { [keys]: data[keys] };
        const result = { ...keys };
        for (const key of Object.keys(keys)) {
          if (data[key] !== undefined) result[key] = data[key];
        }
        return result;
      },
      async set(values) {
        Object.assign(data, values);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
      },
      async setAccessLevel(options) {
        calls.setAccessLevel.push(options);
      }
    }
  };
}

function installChromeStorage(settings = {}) {
  const local = createStorageArea({
    localChatToken: 'test-token',
    localChatPairedOrigin: settings.localAppUrl || 'http://localhost:3000',
    ...(settings.local || {})
  });
  const sync = createStorageArea({
    localAppUrl: 'http://localhost:3000',
    ...(settings.sync || {}),
    ...(settings.localAppUrl ? { localAppUrl: settings.localAppUrl } : {})
  });
  if (Object.prototype.hasOwnProperty.call(settings, 'localChatToken')) {
    local.data.localChatToken = settings.localChatToken;
    if (!settings.localChatToken) local.data.localChatPairedOrigin = '';
  }

  global.chrome = {
    runtime: { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    storage: {
      local: local.area,
      sync: sync.area
    }
  };
  return { local, sync };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test.afterEach(() => {
  background.resetStorageSecurityForTests();
  delete global.chrome;
  delete global.fetch;
});

test('normalizes local app URLs without losing the default', () => {
  assert.equal(background.normalizeBaseUrl(' http://localhost:3000/ '), 'http://localhost:3000');
  assert.equal(background.normalizeBaseUrl(''), 'http://localhost:3000');
  assert.equal(background.normalizeBaseUrl(null), 'http://localhost:3000');
  assert.throws(() => background.normalizeBaseUrl('http://127.0.0.1:4500/app/'), /path/i);
  assert.throws(() => background.normalizeBaseUrl('https://attacker.example'), /http|loopback/i);
});

test('requestHeaders binds credentials to the extension identity', () => {
  assert.deepEqual(
    background.requestHeaders(
      { localChatToken: 'abc123', extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      { headers: { 'Idempotency-Key': 'idem-1' } }
    ),
    {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-1',
      'X-Local-Chat-Extension-Id': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'X-Local-Chat-Token': 'abc123'
    }
  );
});

test('fetchJson uses stored settings and surfaces API errors', async () => {
  installChromeStorage({ localAppUrl: 'http://localhost:3000', localChatToken: 'token-1' });
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url, options });
    if (String(url).endsWith('/fail')) return jsonResponse({ error: 'Nope' }, 418);
    return jsonResponse({ ok: true });
  };

  const ok = await background.fetchJson('http://localhost:3000/api/health');
  assert.deepEqual(ok, { ok: true });
  assert.equal(seen[0].options.headers['X-Local-Chat-Token'], 'token-1');

  await assert.rejects(() => background.fetchJson('http://localhost:3000/api/fail'), /Nope/);
});

test('fetchJson revalidates cached GETs and clears them after mutations', async () => {
  installChromeStorage({ localAppUrl: 'http://localhost:3000', localChatToken: 'token-cache' });
  const seen = [];
  let getCount = 0;
  global.fetch = async (url, options = {}) => {
    seen.push({ url: String(url), options });
    if ((options.method || 'GET') === 'POST') return jsonResponse({ ok: true }, 201);
    getCount += 1;
    if (getCount === 2) {
      return new Response(null, { status: 304, headers: { ETag: 'W/"health-1"' } });
    }
    return new Response(JSON.stringify({ ok: true, request: getCount }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: 'W/"health-1"' }
    });
  };

  const first = await background.fetchJson('http://localhost:3000/api/health');
  const second = await background.fetchJson('http://localhost:3000/api/health');
  assert.deepEqual(second, first);
  assert.equal(seen[1].options.headers['If-None-Match'], 'W/"health-1"');

  await background.fetchJson('http://localhost:3000/api/sessions', { method: 'POST', body: '{}' });
  await background.fetchJson('http://localhost:3000/api/health');
  assert.equal(seen[3].options.headers['If-None-Match'], undefined);
});

test('saveMessage posts to an explicit session without reading the active session', async () => {
  installChromeStorage({ localAppUrl: 'http://127.0.0.1:3333', localChatToken: 'token-2' });
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/api/health')) return jsonResponse({ ok: true });
    if (String(url).includes('/api/active-session')) throw new Error('active session should not be requested');
    if (String(url).endsWith('/api/sessions/chat_1700000000000_deadbeef/messages')) {
      const body = JSON.parse(options.body);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Idempotency-Key'], 'idem-explicit-0001');
      assert.equal(options.headers['X-Local-Chat-Token'], 'token-2');
      assert.equal(body.sender, 'me');
      assert.equal(body.text, 'Saved from extension');
      assert.equal(body.idempotencyKey, 'idem-explicit-0001');
      assert.equal(body.source, 'extension-test');
      assert.equal(body.providerKey, 'chatgpt');
      return jsonResponse({ id: 'msg_1700000000000_cafebabe', sender: 'me', text: body.text });
    }
    return jsonResponse({ error: `Unexpected URL ${url}` }, 500);
  };

  const result = await background.saveMessage({
    sessionId: 'chat_1700000000000_deadbeef',
    sessionTitle: 'Explicit target',
    sender: 'me',
    text: '  Saved from extension  ',
    source: 'extension-test',
    providerKey: 'chatgpt',
    idempotencyKey: 'idem-explicit-0001'
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'chat_1700000000000_deadbeef');
  assert.equal(result.sessionTitle, 'Explicit target');
  assert.equal(result.message.id, 'msg_1700000000000_cafebabe');
  assert.equal(calls.length, 2);
});

test('saveMessage falls back to active session when no explicit session is supplied', async () => {
  installChromeStorage({ localAppUrl: 'http://localhost:3000' });
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/api/health')) return jsonResponse({ ok: true });
    if (String(url).endsWith('/api/active-session')) {
      return jsonResponse({
        sessionId: 'chat_1700000000000_11111111',
        session: { title: 'Active target' }
      });
    }
    if (String(url).endsWith('/api/sessions/chat_1700000000000_11111111/messages')) {
      const body = JSON.parse(options.body);
      assert.equal(body.sender, 'bot');
      assert.equal(body.text, 'Assistant response');
      return jsonResponse({ id: 'msg_1700000000000_22222222', sender: 'bot', text: body.text }, 201);
    }
    return jsonResponse({ error: `Unexpected URL ${url}` }, 500);
  };

  const result = await background.saveMessage({ sender: 'bot', text: 'Assistant response' });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'chat_1700000000000_11111111');
  assert.equal(result.sessionTitle, 'Active target');
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ['/api/health', '/api/active-session', '/api/sessions/chat_1700000000000_11111111/messages']
  );
});

test('createLocalChatSession creates a session and makes it active', async () => {
  installChromeStorage({ localAppUrl: 'http://localhost:3000' });
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/api/health')) return jsonResponse({ ok: true });
    if (String(url).endsWith('/api/sessions')) {
      const body = JSON.parse(options.body);
      assert.equal(options.method, 'POST');
      assert.equal(body.title, 'New extension session');
      assert.equal(body.aiName, 'Claude');
      assert.equal(body.pinnedFolderId, 'folder_1700000000000_12345678');
      return jsonResponse({ id: 'chat_1700000000000_abcd1234', title: body.title }, 201);
    }
    if (String(url).endsWith('/api/active-session')) {
      const body = JSON.parse(options.body);
      assert.equal(options.method, 'PUT');
      assert.equal(body.sessionId, 'chat_1700000000000_abcd1234');
      return jsonResponse({ ok: true, sessionId: body.sessionId });
    }
    return jsonResponse({ error: `Unexpected URL ${url}` }, 500);
  };

  const result = await background.createLocalChatSession({
    title: ' New extension session ',
    provider: 'Claude',
    pinnedFolderId: 'folder_1700000000000_12345678'
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'chat_1700000000000_abcd1234');
  assert.equal(result.sessionTitle, 'New extension session');
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ['/api/health', '/api/sessions', '/api/active-session']
  );
});

test('handleRuntimeMessage returns async responses for known message types', async () => {
  installChromeStorage({ localAppUrl: 'http://localhost:3000' });
  global.fetch = async (url) => {
    if (String(url).endsWith('/api/health')) return jsonResponse({ ok: true });
    if (String(url).endsWith('/api/active-session')) return jsonResponse({ sessionId: null });
    return jsonResponse({ error: `Unexpected URL ${url}` }, 500);
  };

  const response = await new Promise((resolve) => {
    const isAsync = background.handleRuntimeMessage({ type: 'CHECK_LOCAL_CHAT_APP' }, {}, resolve);
    assert.equal(isAsync, true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.localAppUrl, 'http://localhost:3000');
  assert.deepEqual(response.health, { ok: true });
  assert.deepEqual(response.active, { sessionId: null });

  assert.equal(
    background.handleRuntimeMessage({ type: 'UNKNOWN' }, {}, () => {}),
    false
  );
  assert.equal(
    background.handleRuntimeMessage(null, {}, () => {}),
    false
  );
});

test('background folder/session/list/export helpers call the expected API endpoints', async () => {
  installChromeStorage({ localAppUrl: 'http://localhost:3000' });
  const calls = [];
  const sessionId = 'chat_1700000000000_33333333';
  const folderId = 'folder_1700000000000_44444444';

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ pathname: parsed.pathname, search: parsed.search, options });

    if (parsed.pathname === '/api/health') return jsonResponse({ ok: true });
    if (parsed.pathname === '/api/folders' && options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { name: 'New folder' });
      return jsonResponse({ id: folderId, name: 'New folder' }, 201);
    }
    if (parsed.pathname === `/api/sessions/${sessionId}/pin`) {
      assert.equal(options.method, 'PATCH');
      assert.deepEqual(JSON.parse(options.body), { pinnedFolderId: folderId });
      return jsonResponse({ id: sessionId, pinnedFolderId: folderId });
    }
    if (parsed.pathname === `/api/sessions/${sessionId}` && options.method === 'PATCH') {
      assert.deepEqual(JSON.parse(options.body), { title: 'Renamed' });
      return jsonResponse({ id: sessionId, title: 'Renamed' });
    }
    if (parsed.pathname === `/api/sessions/${sessionId}` && options.method === 'DELETE')
      return jsonResponse({ ok: true });
    if (parsed.pathname === `/api/folders/${folderId}` && options.method === 'PATCH') {
      assert.deepEqual(JSON.parse(options.body), { name: 'Renamed folder' });
      return jsonResponse({ id: folderId, name: 'Renamed folder' });
    }
    if (parsed.pathname === `/api/folders/${folderId}` && options.method === 'DELETE')
      return jsonResponse({ ok: true });
    if (parsed.pathname === '/api/recent-chats') {
      assert.equal(parsed.searchParams.get('limit'), '500');
      return jsonResponse([{ id: sessionId, title: 'Recent' }]);
    }
    if (parsed.pathname === '/api/search-chats') {
      assert.equal(parsed.searchParams.get('q'), 'atomic writes');
      assert.equal(parsed.searchParams.get('limit'), '500');
      return jsonResponse({ query: 'atomic writes', count: 1, results: [{ id: sessionId, title: 'Search result' }] });
    }
    if (parsed.pathname === '/api/folders' && !options.method) return jsonResponse([{ id: folderId, name: 'Folder' }]);
    if (parsed.pathname === '/api/sessions' && !options.method) {
      return jsonResponse(
        Array.from({ length: 3 }, (_, index) => ({ id: `${sessionId}_${index}`, title: `Session ${index}` }))
      );
    }
    if (parsed.pathname === '/api/active-session' && !options.method)
      return jsonResponse({ sessionId, session: { title: 'Active session' } });
    if (parsed.pathname === '/api/active-session' && options.method === 'PUT') {
      assert.deepEqual(JSON.parse(options.body), { sessionId });
      return jsonResponse({ sessionId, session: { title: 'Activated' } });
    }
    if (parsed.pathname === `/api/sessions/${sessionId}/export`) {
      return jsonResponse({ session: { id: sessionId, title: 'Exported' }, text: 'Export text' });
    }

    return jsonResponse({ error: `Unexpected URL ${url}` }, 500);
  };

  assert.deepEqual(await background.createLocalChatFolder({ name: ' New folder ' }), {
    ok: true,
    folder: { id: folderId, name: 'New folder' }
  });

  assert.equal(
    (await background.updateLocalChatSessionFolder({ sessionId, pinnedFolderId: folderId })).session.pinnedFolderId,
    folderId
  );
  assert.equal(
    (await background.updateLocalChatSessionTitle({ sessionId, title: ' Renamed ' })).session.title,
    'Renamed'
  );
  assert.deepEqual(await background.deleteLocalChatSession({ sessionId }), { ok: true, sessionId });
  assert.equal(
    (await background.updateLocalChatFolderName({ folderId, name: ' Renamed folder ' })).folder.name,
    'Renamed folder'
  );
  assert.deepEqual(await background.deleteLocalChatFolder({ folderId }), { ok: true, folderId });
  assert.equal((await background.listRecentLocalChats({ limit: 900 })).chats.length, 1);
  assert.equal((await background.searchLocalChats({ query: ' atomic writes ', limit: 999 })).count, 1);

  const sidebar = await background.listLocalSidebarData({ limit: 2 });
  assert.equal(sidebar.ok, true);
  assert.equal(sidebar.folders.length, 1);
  assert.equal(sidebar.sessions.length, 2);
  assert.equal(sidebar.activeSessionId, sessionId);

  const active = await background.setActiveLocalChatSession({ sessionId });
  assert.equal(active.sessionTitle, 'Activated');

  const exportData = await background.loadLocalChatExport({ sessionId });
  assert.equal(exportData.sessionId, sessionId);
  assert.equal(exportData.sessionTitle, 'Activated');
  assert.equal(exportData.text, 'Export text');

  const noActivateExport = await background.loadLocalChatExport({ sessionId, activate: false });
  assert.equal(noActivateExport.active, null);
  assert.equal(noActivateExport.sessionTitle, 'Exported');

  assert.ok(calls.some((call) => call.pathname === '/api/search-chats' && call.search.includes('atomic+writes')));
});

test('background helpers reject missing required payload fields before fetching', async () => {
  installChromeStorage({ localAppUrl: 'http://localhost:3000' });
  global.fetch = async () => {
    throw new Error('fetch should not be called for validation failures');
  };

  await assert.rejects(() => background.saveMessage({ text: '   ' }), /message text/i);
  await assert.rejects(() => background.createLocalChatSession({ title: '' }), /session name/i);
  await assert.rejects(() => background.createLocalChatFolder({ name: '' }), /folder name/i);
  await assert.rejects(() => background.updateLocalChatSessionFolder({ pinnedFolderId: 'folder_1' }), /session id/i);
  await assert.rejects(() => background.updateLocalChatSessionTitle({ sessionId: 'chat_1', title: '' }), /chat title/i);
  await assert.rejects(() => background.deleteLocalChatSession({}), /session id/i);
  await assert.rejects(() => background.updateLocalChatFolderName({ folderId: '', name: 'x' }), /folder id/i);
  await assert.rejects(() => background.deleteLocalChatFolder({}), /folder id/i);
  await assert.rejects(() => background.setActiveLocalChatSession({}), /session id/i);
  await assert.rejects(() => background.upsertLocalChatCompaction({}), /session id/i);
  await assert.rejects(
    () => background.upsertLocalChatCompaction({ sessionId: 'chat_1' }),
    /compaction request id/i
  );
  await assert.rejects(
    () => background.upsertLocalChatCompaction({ sessionId: 'chat_1', requestId: 'compact:req:test-001' }),
    /compacted message/i
  );
  await assert.rejects(() => background.loadLocalChatExport({}), /session id/i);
});

test('pairLocalChatApp exchanges a short-lived code and stores the returned token privately', async () => {
  const storage = installChromeStorage({ localChatToken: '' });
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({
      token: 'paired-secret-token',
      extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    });
  };

  const result = await background.pairLocalChatApp({
    localAppUrl: 'http://localhost:3000',
    code: 'ABCDEF123456'
  });

  assert.equal(result.ok, true);
  assert.equal(storage.local.data.localChatToken, 'paired-secret-token');
  assert.equal(storage.local.data.localChatPairedOrigin, 'http://localhost:3000');
  assert.equal(storage.sync.data.localAppUrl, 'http://localhost:3000');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/extension/pair');
  assert.equal(calls[0].options.headers['X-Local-Chat-Token'], undefined);
  assert.equal(calls[0].options.headers['X-Local-Chat-Extension-Id'], 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('storage initialization migrates non-sensitive preferences and restricts local storage access', async () => {
  const storage = installChromeStorage({
    local: {
      localAppUrl: 'http://127.0.0.1:4321',
      localChatAutoSendEnabled: false,
      localChatSidebarSelectedFolderId: 'folder_1700000000000_12345678',
      localChatPairedOrigin: ''
    },
    sync: { localAppUrl: undefined }
  });

  await background.initializeStorageSecurity();

  assert.equal(storage.sync.data.localAppUrl, 'http://127.0.0.1:4321');
  assert.equal(storage.sync.data.localChatAutoSendEnabled, false);
  assert.equal(storage.sync.data.localChatSidebarSelectedFolderId, 'folder_1700000000000_12345678');
  assert.equal(storage.local.data.localAppUrl, undefined);
  assert.equal(storage.local.data.localChatAutoSendEnabled, undefined);
  assert.equal(storage.local.data.localChatToken, 'test-token');
  assert.equal(storage.local.data.localChatPairedOrigin, 'http://127.0.0.1:4321');
  assert.deepEqual(storage.local.calls.setAccessLevel, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});

test('authenticated fetches refuse remote destinations before credentials can be sent', async () => {
  installChromeStorage({ localChatToken: 'secret-token' });
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ ok: true });
  };

  await assert.rejects(() => background.fetchJson('https://attacker.example/api/health'), /refusing|loopback/i);
  assert.equal(fetchCalls, 0);
});

test('paired credentials are bound to the local API origin used during pairing', async () => {
  installChromeStorage({
    localAppUrl: 'http://127.0.0.1:4321',
    local: { localChatPairedOrigin: 'http://localhost:3000' }
  });
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ ok: true });
  };

  await assert.rejects(() => background.fetchJson('http://127.0.0.1:4321/api/health'), /url changed|pair/i);
  assert.equal(fetchCalls, 0);
});

test('authenticated fetches require pairing and enforce a request timeout', async () => {
  installChromeStorage({ localChatToken: '' });
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ ok: true });
  };
  await assert.rejects(() => background.fetchJson('http://localhost:3000/api/health'), /not paired/i);
  assert.equal(fetchCalls, 0);

  background.resetStorageSecurityForTests();
  installChromeStorage({ localChatToken: 'secret-token' });
  global.fetch = (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });

  await assert.rejects(
    () => background.fetchJson('http://localhost:3000/api/health', {}, { timeoutMs: 5 }),
    /timed out/i
  );
});

test('upsertLocalChatCompaction persists a structured compaction through the local API', async () => {
  installChromeStorage({ localAppUrl: 'http://localhost:3000' });
  const sessionId = 'chat_1700000000000_55555555';
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ pathname: parsed.pathname, options });

    if (parsed.pathname === '/api/health') return jsonResponse({ ok: true });
    if (parsed.pathname === `/api/sessions/${sessionId}/compaction`) {
      assert.equal(options.method, 'PUT');
      assert.deepEqual(JSON.parse(options.body), {
        requestId: 'compact:req:extension-001',
        compactedMessage: 'Structured continuation context.',
        providerKey: 'chatgpt'
      });
      return jsonResponse({
        id: 'chat_1700000000000_66666666',
        title: 'Extension compaction (compacted)',
        kind: 'compacted',
        parentSessionId: sessionId
      });
    }
    return jsonResponse({ error: `Unexpected URL ${url}` }, 500);
  };

  const result = await background.upsertLocalChatCompaction({
    sessionId,
    requestId: 'compact:req:extension-001',
    compactedMessage: ' Structured continuation context. ',
    providerKey: 'chatgpt'
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'chat_1700000000000_66666666');
  assert.equal(result.sessionTitle, 'Extension compaction (compacted)');
  assert.equal(result.session.parentSessionId, sessionId);
  assert.deepEqual(
    calls.map((call) => call.pathname),
    ['/api/health', `/api/sessions/${sessionId}/compaction`]
  );
});

test('runtime routing exposes the compaction bridge to content scripts', async () => {
  installChromeStorage({ localAppUrl: 'http://localhost:3000' });
  const sessionId = 'chat_1700000000000_77777777';

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/health') return jsonResponse({ ok: true });
    if (parsed.pathname === `/api/sessions/${sessionId}/compaction` && options.method === 'PUT') {
      return jsonResponse({ id: 'chat_1700000000000_88888888', title: 'Runtime compaction (compacted)' });
    }
    return jsonResponse({ error: `Unexpected URL ${url}` }, 500);
  };

  const response = await new Promise((resolve) => {
    const isAsync = background.handleRuntimeMessage(
      {
        type: 'UPSERT_LOCAL_CHAT_COMPACTION',
        payload: {
          sessionId,
          requestId: 'compact:req:runtime-001',
          compactedMessage: 'Runtime structured context.',
          providerKey: 'claude'
        }
      },
      {},
      resolve
    );
    assert.equal(isAsync, true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.sessionId, 'chat_1700000000000_88888888');
});
