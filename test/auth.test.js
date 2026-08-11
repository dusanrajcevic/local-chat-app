const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-app-auth-test-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;
process.env.PORT = '0';
process.env.LOCAL_CHAT_AUTH_TOKEN = 'secret-token-for-tests';

const { startServer } = require('../server');

let server;
let baseUrl;

const extensionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const extensionOrigin = `chrome-extension://${extensionId}`;

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

test('configured extension token is reported by health endpoint', async () => {
  const { res, data } = await json('/api/health');
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.authRequired, true);
  assert.equal(data.manualTokenConfigured, true);
});

test('Chrome-extension API requests require a valid pairing or configured local token', async () => {
  const missing = await json('/api/health', {
    headers: { Origin: extensionOrigin, 'X-Local-Chat-Extension-Id': extensionId }
  });
  assert.equal(missing.res.status, 401);
  assert.match(missing.data.error, /pair/i);

  const wrong = await json('/api/health', {
    headers: {
      Origin: extensionOrigin,
      'X-Local-Chat-Extension-Id': extensionId,
      'X-Local-Chat-Token': 'wrong-token'
    }
  });
  assert.equal(wrong.res.status, 401);

  const ok = await json('/api/health', {
    headers: {
      Origin: extensionOrigin,
      'X-Local-Chat-Extension-Id': extensionId,
      'X-Local-Chat-Token': 'secret-token-for-tests'
    }
  });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.data.ok, true);
  assert.equal(ok.res.headers.get('access-control-allow-origin'), extensionOrigin);
});

test('same-origin app requests do not require the extension token', async () => {
  const { res, data } = await json('/api/health', { headers: { Origin: baseUrl } });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
});

test('extension preflight succeeds only for trusted origins', async () => {
  const allowed = await fetch(`${baseUrl}/api/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: extensionOrigin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'X-Local-Chat-Token'
    }
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), extensionOrigin);

  const blocked = await fetch(`${baseUrl}/api/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'GET'
    }
  });
  assert.equal(blocked.status, 403);
});
