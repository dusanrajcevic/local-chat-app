const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-pairing-test-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;
process.env.PORT = '0';
delete process.env.LOCAL_CHAT_AUTH_TOKEN;
delete process.env.LOCAL_CHAT_EXTENSION_IDS;

const { startServer } = require('../server');
const { EXTENSION_AUTH_FILE } = require('../src/server/config');
const { resetPairingStateForTests } = require('../src/server/services/extension-auth-service');

const extensionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const extensionOrigin = `chrome-extension://${extensionId}`;
let server;
let baseUrl;

function extensionHeaders(token) {
  return {
    Origin: extensionOrigin,
    'X-Local-Chat-Extension-Id': extensionId,
    ...(token ? { 'X-Local-Chat-Token': token } : {})
  };
}

async function json(pathname, options = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

test.before(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1' });
  baseUrl = server.localChatUrl;
});

test.after(async () => {
  resetPairingStateForTests();
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

test('extension API access requires pairing and binds the token to the extension ID', async () => {
  const unpaired = await json('/api/health', { headers: extensionHeaders() });
  assert.equal(unpaired.res.status, 401);
  assert.match(unpaired.data.error, /pair/i);

  const pairingCode = await json('/api/extension/pairing-code', {
    method: 'POST',
    body: '{}'
  });
  assert.equal(pairingCode.res.status, 200);
  assert.match(pairingCode.data.code, /^[A-F0-9]{12}$/);
  assert.equal(pairingCode.res.headers.get('cache-control'), 'no-store');

  const mismatchedIdentity = await json('/api/extension/pair', {
    method: 'POST',
    headers: {
      Origin: extensionOrigin,
      'X-Local-Chat-Extension-Id': 'cccccccccccccccccccccccccccccccc'
    },
    body: JSON.stringify({ code: pairingCode.data.code })
  });
  assert.equal(mismatchedIdentity.res.status, 403);

  const paired = await json('/api/extension/pair', {
    method: 'POST',
    headers: extensionHeaders(),
    body: JSON.stringify({ code: pairingCode.data.code })
  });
  assert.equal(paired.res.status, 200, JSON.stringify(paired.data));
  assert.equal(paired.data.extensionId, extensionId);
  assert.equal(paired.res.headers.get('cache-control'), 'no-store');
  assert.ok(paired.data.token.length >= 40);

  const authenticated = await json('/api/health', {
    headers: extensionHeaders(paired.data.token)
  });
  assert.equal(authenticated.res.status, 200);
  assert.equal(authenticated.data.ok, true);

  const wrongToken = await json('/api/health', {
    headers: extensionHeaders('wrong-token')
  });
  assert.equal(wrongToken.res.status, 401);

  const authFile = JSON.parse(await fs.readFile(EXTENSION_AUTH_FILE, 'utf8'));
  assert.equal(authFile.pairings.length, 1);
  assert.equal(authFile.pairings[0].extensionId, extensionId);
  assert.match(authFile.pairings[0].tokenHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(authFile).includes(paired.data.token), false);
});

test('pairing codes can only be created from the local app and are single-use', async () => {
  const blocked = await json('/api/extension/pairing-code', {
    method: 'POST',
    headers: extensionHeaders('not-relevant'),
    body: '{}'
  });
  assert.equal(blocked.res.status, 401);

  const pairingCode = await json('/api/extension/pairing-code', { method: 'POST', body: '{}' });
  assert.equal(pairingCode.res.status, 200);

  const first = await json('/api/extension/pair', {
    method: 'POST',
    headers: extensionHeaders(),
    body: JSON.stringify({ code: pairingCode.data.code })
  });
  assert.equal(first.res.status, 200);

  const reuse = await json('/api/extension/pair', {
    method: 'POST',
    headers: extensionHeaders(),
    body: JSON.stringify({ code: pairingCode.data.code })
  });
  assert.equal(reuse.res.status, 410);
});
