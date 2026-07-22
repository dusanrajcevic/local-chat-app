const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('node:http');

const tempDataDir = path.join(os.tmpdir(), `local-chat-app-api-test-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;
process.env.PORT = '0';
delete process.env.LOCAL_CHAT_AUTH_TOKEN;

const { startServer, DATA_DIR, buildChatExportText } = require('../server');

let server;
let baseUrl;

test.before(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1' });
  baseUrl = server.localChatUrl;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

async function json(pathname, options = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function rawJson(pathname, headers = {}) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: pathname,
        method: 'GET',
        headers
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try {
            data = JSON.parse(text);
          } catch {
            // Keep the empty object for responses without JSON bodies.
          }
          resolve({ res: response, data });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

async function createSession(overrides = {}) {
  const body = {
    title: overrides.title || `Session ${Date.now()} ${Math.random()}`,
    aiName: overrides.aiName || 'ChatGPT',
    ...(Object.prototype.hasOwnProperty.call(overrides, 'pinnedFolderId')
      ? { pinnedFolderId: overrides.pinnedFolderId }
      : {})
  };
  const result = await json('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(result.res.status, 201, JSON.stringify(result.data));
  return result.data;
}

async function createFolder(name = `Folder ${Date.now()} ${Math.random()}`) {
  const result = await json('/api/folders', { method: 'POST', body: JSON.stringify({ name }) });
  assert.equal(result.res.status, 201, JSON.stringify(result.data));
  return result.data;
}

async function postLocalMessage(sessionId, body) {
  const result = await json(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  assert.ok([200, 201].includes(result.res.status), JSON.stringify(result.data));
  return result.data;
}

async function findActiveSessionPath(sessionId) {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const candidate = path.join(DATA_DIR, entry.name, `${sessionId}.json`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue looking through date directories.
    }
  }
  throw new Error(`Could not locate session file for ${sessionId}`);
}


test('body-bearing routes require a JSON object with a supported content type', async () => {
  const routes = [
    ['POST', '/api/folders'],
    ['PATCH', '/api/folders/folder_1700000000000_deadbeef'],
    ['PUT', '/api/active-session'],
    ['POST', '/api/sessions'],
    ['PATCH', '/api/sessions/chat_1700000000000_deadbeef'],
    ['PATCH', '/api/sessions/chat_1700000000000_deadbeef/bot-name'],
    ['POST', '/api/sessions/chat_1700000000000_deadbeef/messages'],
    ['PATCH', '/api/sessions/chat_1700000000000_deadbeef/messages/msg_1700000000000_deadbeef'],
    ['PATCH', '/api/sessions/chat_1700000000000_deadbeef/pin']
  ];

  for (const [method, pathname] of routes) {
    const unsupported = await json(pathname, {
      method,
      headers: { 'Content-Type': 'text/plain' },
      body: '{}'
    });
    assert.equal(unsupported.res.status, 415, `${method} ${pathname}`);
    assert.match(unsupported.data.error, /content-type/i);

    const bodyless = await json(pathname, { method });
    assert.equal(bodyless.res.status, 400, `${method} ${pathname}`);
    assert.match(bodyless.data.error, /json object/i);
  }
});

test('malformed and non-object JSON bodies return stable 400 responses', async () => {
  const malformed = await json('/api/sessions', { method: 'POST', body: '{"title":' });
  assert.equal(malformed.res.status, 400);
  assert.equal(malformed.data.error, 'Request body contains invalid JSON.');

  const arrayBody = await json('/api/sessions', { method: 'POST', body: '[]' });
  assert.equal(arrayBody.res.status, 400);
  assert.match(arrayBody.data.error, /json object/i);
});

test('request fields reject arrays, objects, and booleans instead of stringifying them', async () => {
  const folder = await json('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name: { unexpected: true } })
  });
  assert.equal(folder.res.status, 400);
  assert.match(folder.data.error, /folder name must be a string/i);

  const session = await json('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: true })
  });
  assert.equal(session.res.status, 400);
  assert.match(session.data.error, /session title must be a string/i);

  const validSession = await createSession({ title: 'Typed request fields' });
  const message = await json(`/api/sessions/${validSession.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: ['not', 'text'], sender: false })
  });
  assert.equal(message.res.status, 400);
  assert.match(message.data.error, /message text must be a string/i);

  const sender = await json(`/api/sessions/${validSession.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Valid text', sender: false })
  });
  assert.equal(sender.res.status, 400);
  assert.match(sender.data.error, /message sender/i);

  const active = await json('/api/active-session', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: { unexpected: true } })
  });
  assert.equal(active.res.status, 400);
  assert.match(active.data.error, /session id/i);
});

test('health endpoint reports the app is reachable and omits Express fingerprinting', async () => {
  const { res, data } = await json('/api/health');
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.authRequired, false);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('rejects untrusted browser origins before CORS can expose responses', async () => {
  const { res, data } = await json('/api/health', {
    headers: { Origin: 'https://evil.example' }
  });
  assert.equal(res.status, 403);
  assert.match(data.error, /origin/i);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('rejects DNS-rebinding requests with attacker-controlled Host and Origin headers', async () => {
  const { res, data } = await rawJson('/api/health', {
    Host: 'attacker.example',
    Origin: 'http://attacker.example'
  });
  assert.equal(res.statusCode, 403);
  assert.match(data.error, /host/i);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('rejects local-looking Host headers that do not match the listening port', async () => {
  const { res, data } = await rawJson('/api/health', {
    Host: '127.0.0.1:65535',
    Origin: 'http://127.0.0.1:65535'
  });
  assert.equal(res.statusCode, 403);
  assert.match(data.error, /host/i);
});

test('allows a localhost Host alias on the actual loopback listening port', async () => {
  const { port } = new URL(baseUrl);
  const origin = `http://localhost:${port}`;
  const { res, data } = await rawJson('/api/health', {
    Host: `localhost:${port}`,
    Origin: origin
  });
  assert.equal(res.statusCode, 200, JSON.stringify(data));
  assert.equal(res.headers['access-control-allow-origin'], origin);
});

test('allows same-origin and Chrome-extension origins through CORS', async () => {
  const sameOrigin = await json('/api/health', { headers: { Origin: baseUrl } });
  assert.equal(sameOrigin.res.status, 200);
  assert.equal(sameOrigin.res.headers.get('access-control-allow-origin'), baseUrl);

  const extensionOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const extension = await json('/api/health', { headers: { Origin: extensionOrigin } });
  assert.equal(extension.res.status, 200);
  assert.equal(extension.res.headers.get('access-control-allow-origin'), extensionOrigin);
});

test('creates, trims, lists, and updates session metadata', async () => {
  const session = await createSession({ title: '  Architecture review   ', aiName: '  Claude   ' });
  assert.match(session.id, /^chat_\d+_[a-f0-9]{8}$/);
  assert.equal(session.title, 'Architecture review');
  assert.equal(session.aiName, 'Claude');
  assert.equal(session.messageCount, 0);

  const update = await json(`/api/sessions/${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Renamed review', aiName: 'Gemini' })
  });
  assert.equal(update.res.status, 200);
  assert.equal(update.data.title, 'Renamed review');
  assert.equal(update.data.aiName, 'Gemini');

  const read = await json(`/api/sessions/${session.id}`);
  assert.equal(read.res.status, 200);
  assert.equal(read.data.title, 'Renamed review');
  assert.equal(read.data.aiName, 'Gemini');

  const sessions = await json('/api/sessions');
  assert.equal(sessions.res.status, 200);
  assert.ok(sessions.data.some((item) => item.id === session.id));
});

test('rejects empty titles and no-op metadata updates', async () => {
  const create = await json('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '   ' }) });
  assert.equal(create.res.status, 400);
  assert.match(create.data.error, /title/i);

  const session = await createSession();
  const update = await json(`/api/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({}) });
  assert.equal(update.res.status, 400);
  assert.match(update.data.error, /nothing/i);
});

test('active session can be set, read, cleared, and auto-cleared after delete', async () => {
  const session = await createSession({ title: 'Active lifecycle' });

  const activate = await json('/api/active-session', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: session.id })
  });
  assert.equal(activate.res.status, 200);
  assert.equal(activate.data.sessionId, session.id);
  assert.equal(activate.data.session.title, 'Active lifecycle');

  const active = await json('/api/active-session');
  assert.equal(active.res.status, 200);
  assert.equal(active.data.sessionId, session.id);

  const clear = await json('/api/active-session', { method: 'DELETE' });
  assert.equal(clear.res.status, 200);
  assert.equal(clear.data.sessionId, null);

  await json('/api/active-session', { method: 'PUT', body: JSON.stringify({ sessionId: session.id }) });
  const deleted = await json(`/api/sessions/${session.id}`, { method: 'DELETE' });
  assert.equal(deleted.res.status, 200);
  const afterDelete = await json('/api/active-session');
  assert.equal(afterDelete.data.sessionId, null);
});

test('messages support explicit sender, auto sender, edit, delete, metadata, and validation', async () => {
  const session = await createSession({ title: 'Message lifecycle' });

  const first = await postLocalMessage(session.id, {
    text: 'First prompt',
    sender: 'me',
    source: 'unit-test',
    providerKey: 'chatgpt'
  });
  assert.match(first.id, /^msg_\d+_[a-f0-9]{8}$/);
  assert.equal(first.sender, 'me');
  assert.equal(first.source, 'unit-test');
  assert.equal(first.providerKey, 'chatgpt');

  const second = await postLocalMessage(session.id, { text: 'Implicit bot response' });
  assert.equal(second.sender, 'bot');

  const edit = await json(`/api/sessions/${session.id}/messages/${first.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ text: 'Edited prompt', sender: 'bot' })
  });
  assert.equal(edit.res.status, 200);
  assert.equal(edit.data.text, 'Edited prompt');
  assert.equal(edit.data.sender, 'bot');
  assert.ok(edit.data.updatedAt);

  const remove = await json(`/api/sessions/${session.id}/messages/${second.id}`, { method: 'DELETE' });
  assert.equal(remove.res.status, 200);

  const read = await json(`/api/sessions/${session.id}`);
  assert.equal(read.data.messages.length, 1);
  assert.equal(read.data.messages[0].text, 'Edited prompt');

  const empty = await json(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: '  ' })
  });
  assert.equal(empty.res.status, 400);
  assert.match(empty.data.error, /message text/i);
});

test('automatic sender alternates from the last explicit sender override', async () => {
  const session = await createSession({ title: 'Sender override' });

  await postLocalMessage(session.id, { text: 'First message', sender: 'me' });
  await postLocalMessage(session.id, { text: 'Manual same-sender message', sender: 'me' });
  const next = await postLocalMessage(session.id, { text: 'Automatic reply' });

  assert.equal(next.sender, 'bot');
});

test('message idempotency works for sequential and concurrent duplicate saves', async () => {
  const session = await createSession({ title: 'Idempotency' });
  const body = { sender: 'me', text: 'Save this exactly once.', idempotencyKey: 'test-key-0001' };

  const first = await json(`/api/sessions/${session.id}/messages`, { method: 'POST', body: JSON.stringify(body) });
  const second = await json(`/api/sessions/${session.id}/messages`, { method: 'POST', body: JSON.stringify(body) });

  assert.equal(first.res.status, 201);
  assert.equal(second.res.status, 200);
  assert.equal(second.data.id, first.data.id);

  const concurrentKey = 'test-key-concurrent-0001';
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () =>
      json(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ sender: 'bot', text: 'Concurrent duplicate', idempotencyKey: concurrentKey })
      })
    )
  );
  assert.equal(concurrent.filter((item) => item.res.status === 201).length, 1);
  assert.equal(new Set(concurrent.map((item) => item.data.id)).size, 1);

  const invalid = await json(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ sender: 'me', text: 'Bad key', idempotencyKey: '../escape' })
  });
  assert.equal(invalid.res.status, 400);
  assert.match(invalid.data.error, /idempotency/i);

  const read = await json(`/api/sessions/${session.id}`);
  assert.equal(read.data.messages.length, 2);
});

test('per-session write locking preserves all concurrent distinct messages', async () => {
  const session = await createSession({ title: 'Concurrent distinct saves' });
  const count = 30;

  const results = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      json(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          sender: index % 2 ? 'bot' : 'me',
          text: `Concurrent message ${index}`,
          idempotencyKey: `distinct-${index}-0001`
        })
      })
    )
  );

  assert.equal(
    results.every((item) => item.res.status === 201),
    true
  );
  const read = await json(`/api/sessions/${session.id}`);
  assert.equal(read.data.messages.length, count);
  assert.deepEqual(new Set(read.data.messages.map((message) => message.text)).size, count);
});

test('folders can be created, renamed, pinned, unpinned, and deleted with session cleanup', async () => {
  const folder = await createFolder('  Research  ');
  assert.match(folder.id, /^folder_\d+_[a-f0-9]{8}$/);
  assert.equal(folder.name, 'Research');

  const renamed = await json(`/api/folders/${folder.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Portfolio' })
  });
  assert.equal(renamed.res.status, 200);
  assert.equal(renamed.data.name, 'Portfolio');

  const session = await createSession({ title: 'Pinned chat', pinnedFolderId: folder.id });
  assert.equal(session.pinnedFolderId, folder.id);

  const unpin = await json(`/api/sessions/${session.id}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ pinnedFolderId: null })
  });
  assert.equal(unpin.res.status, 200);
  assert.equal(unpin.data.pinnedFolderId, null);

  await json(`/api/sessions/${session.id}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ pinnedFolderId: folder.id })
  });
  const deleted = await json(`/api/folders/${folder.id}`, { method: 'DELETE' });
  assert.equal(deleted.res.status, 200);

  const read = await json(`/api/sessions/${session.id}`);
  assert.equal(read.data.pinnedFolderId, null);
});

test('folder references must point to existing folders', async () => {
  const missing = 'folder_1700000000000_deadbeef';
  const create = await json('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'Bad folder ref', pinnedFolderId: missing })
  });
  assert.equal(create.res.status, 404);
  assert.match(create.data.error, /folder/i);

  const session = await createSession();
  const pin = await json(`/api/sessions/${session.id}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ pinnedFolderId: missing })
  });
  assert.equal(pin.res.status, 404);
  assert.match(pin.data.error, /folder/i);
});

test('search, recent, and export endpoints expose useful summaries without trash results', async () => {
  const session = await createSession({ title: 'Searchable Architecture Notes', aiName: 'DeepSeek' });
  const keep = await postLocalMessage(session.id, {
    sender: 'me',
    text: 'Discuss local-first storage and browser extension boundaries.'
  });
  await postLocalMessage(session.id, { sender: 'bot', text: 'Use atomic writes and origin checks.' });

  const search = await json('/api/search-chats?q=atomic&limit=10');
  assert.equal(search.res.status, 200);
  assert.equal(search.data.query, 'atomic');
  assert.ok(search.data.results.some((item) => item.id === session.id));
  const found = search.data.results.find((item) => item.id === session.id);
  assert.equal(found.match.messageCount, 1);
  assert.match(found.match.preview, /atomic writes/i);

  const recent = await json('/api/recent-chats?limit=1');
  assert.equal(recent.res.status, 200);
  assert.equal(recent.data.length, 1);

  const exported = await json(`/api/sessions/${session.id}/export`);
  assert.equal(exported.res.status, 200);
  assert.equal(exported.data.format, 'copy-entire-chat');
  assert.match(exported.data.text, /Below is the context from a previous conversation/);
  assert.match(exported.data.text, /Searchable Architecture Notes/);
  assert.match(exported.data.text, /DeepSeek/);
  assert.match(exported.data.text, /local-first storage/);

  const renderedByHelper = buildChatExportText({
    title: 'Helper export',
    aiName: 'Bot',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [{ id: keep.id, sender: 'me', text: 'Helper message', createdAt: new Date().toISOString() }]
  });
  assert.match(renderedByHelper, /Helper export/);
  assert.match(renderedByHelper, /Helper message/);
});

test('trash lifecycle moves sessions out of active lists, supports restore, and permanent delete', async () => {
  const session = await createSession({ title: 'Trash me' });
  await postLocalMessage(session.id, { text: 'Temporary message', sender: 'me' });

  const removed = await json(`/api/sessions/${session.id}`, { method: 'DELETE' });
  assert.equal(removed.res.status, 200);

  const sessions = await json('/api/sessions');
  assert.equal(
    sessions.data.some((item) => item.id === session.id),
    false
  );

  const trash = await json('/api/trash');
  assert.equal(trash.res.status, 200);
  assert.ok(trash.data.some((item) => item.id === session.id && item.trashed));

  const readTrashed = await json(`/api/sessions/${session.id}`);
  assert.equal(readTrashed.res.status, 200);
  assert.equal(readTrashed.data.trashed, true);

  const restored = await json(`/api/trash/${session.id}/restore`, { method: 'POST' });
  assert.equal(restored.res.status, 200);
  assert.equal(restored.data.trashed, false);

  const readRestored = await json(`/api/sessions/${session.id}`);
  assert.equal(readRestored.res.status, 200);
  assert.equal(readRestored.data.trashed, false);

  await json(`/api/sessions/${session.id}`, { method: 'DELETE' });
  const purged = await json(`/api/trash/${session.id}`, { method: 'DELETE' });
  assert.equal(purged.res.status, 200);
  const missing = await json(`/api/sessions/${session.id}`);
  assert.equal(missing.res.status, 404);
});

test('corrupted persisted session IDs cannot overwrite metadata files', async () => {
  await createFolder('Protected folder metadata');
  const session = await createSession({ title: 'Corruption regression' });
  const sessionPath = await findActiveSessionPath(session.id);
  const foldersPath = path.join(DATA_DIR, 'folders.json');
  const originalSessionText = await fs.readFile(sessionPath, 'utf8');
  const originalFoldersText = await fs.readFile(foldersPath, 'utf8');
  const corruptedSession = JSON.parse(originalSessionText);
  corruptedSession.id = '../folders';
  await fs.writeFile(sessionPath, `${JSON.stringify(corruptedSession, null, 2)}\n`);

  try {
    const removed = await json(`/api/sessions/${session.id}`, { method: 'DELETE' });
    assert.equal(removed.res.status, 500);
    assert.match(removed.data.error, /stored session data is invalid/i);
    assert.equal(await fs.readFile(foldersPath, 'utf8'), originalFoldersText);
    await fs.access(sessionPath);
    await assert.rejects(fs.access(path.join(DATA_DIR, 'trash', `${session.id}.json`)), { code: 'ENOENT' });
  } finally {
    await fs.writeFile(sessionPath, originalSessionText);
  }
});

test('valid-looking record IDs must still match the session filename', async () => {
  const session = await createSession({ title: 'Filename mismatch regression' });
  const sessionPath = await findActiveSessionPath(session.id);
  const originalSessionText = await fs.readFile(sessionPath, 'utf8');
  const corruptedSession = JSON.parse(originalSessionText);
  corruptedSession.id = 'chat_1700000000000_deadbeef';
  await fs.writeFile(sessionPath, `${JSON.stringify(corruptedSession, null, 2)}\n`);

  try {
    const read = await json(`/api/sessions/${session.id}`);
    assert.equal(read.res.status, 500);
    assert.match(read.data.error, /does not match filename id/i);
  } finally {
    await fs.writeFile(sessionPath, originalSessionText);
  }
});

test('invalid IDs are rejected instead of being used in file paths', async () => {
  const invalidSession = await json('/api/sessions/not-a-valid-id');
  assert.equal(invalidSession.res.status, 400);
  assert.match(invalidSession.data.error, /session id/i);

  const session = await createSession();
  const invalidMessage = await json(`/api/sessions/${session.id}/messages/not-a-message`, {
    method: 'PATCH',
    body: JSON.stringify({ text: 'Nope' })
  });
  assert.equal(invalidMessage.res.status, 400);
  assert.match(invalidMessage.data.error, /message id/i);
});

test('base files are created in the configured data directory only', async () => {
  const entries = await fs.readdir(DATA_DIR);
  assert.ok(entries.includes('folders.json'));
  assert.ok(entries.includes('app-state.json'));
  assert.ok(entries.includes('trash'));
  assert.equal(path.resolve(DATA_DIR), path.resolve(tempDataDir));
});
