const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const tempRoot = path.join(os.tmpdir(), `local-chat-routes-pagination-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = path.join(tempRoot, 'data');

const { ensureBaseFiles } = require('../src/server/storage/file-store');
const { createSession, addMessage } = require('../src/server/services/session-service');
const { registerSessionRoutes } = require('../src/server/routes/sessions');

function collectGetRoutes() {
  const routes = new Map();
  const app = {
    get(route, handler) {
      routes.set(route, handler);
    },
    post() {},
    put() {},
    patch() {},
    delete() {}
  };
  registerSessionRoutes(app);
  return routes;
}

function fakeRequest(originalUrl, headers = {}) {
  const parsed = new URL(originalUrl, 'http://localhost');
  const query = Object.fromEntries(parsed.searchParams.entries());
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    query,
    originalUrl: `${parsed.pathname}${parsed.search}`,
    get(name) {
      return normalizedHeaders.get(String(name).toLowerCase());
    }
  };
}

function fakeResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    headers,
    body: undefined,
    ended: false,
    set(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
}

async function invoke(handler, req) {
  const res = fakeResponse();
  let routedError = null;
  await handler(req, res, (error) => {
    routedError = error;
  });
  if (routedError) throw routedError;
  return res;
}

test.before(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  await ensureBaseFiles();
  for (let index = 0; index < 5; index += 1) {
    const session = await createSession({ title: `Route page ${index}`, aiName: 'AI Bot' });
    await addMessage(session.id, { sender: 'me', text: `shared pagination phrase ${index}` });
  }
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('session list route keeps array responses while exposing page headers and ETags', async () => {
  const handler = collectGetRoutes().get('/api/sessions');
  const first = await invoke(handler, fakeRequest('/api/sessions?offset=1&limit=2'));

  assert.equal(first.statusCode, 200);
  assert.equal(first.body.length, 2);
  assert.equal(first.headers.get('x-total-count'), '5');
  assert.equal(first.headers.get('x-page-offset'), '1');
  assert.equal(first.headers.get('x-page-limit'), '2');
  assert.equal(first.headers.get('x-has-more'), 'true');
  assert.match(first.headers.get('link'), /rel="prev"/);
  assert.match(first.headers.get('link'), /rel="next"/);
  assert.ok(first.headers.get('etag'));

  const unchanged = await invoke(
    handler,
    fakeRequest('/api/sessions?offset=1&limit=2', { 'If-None-Match': first.headers.get('etag') })
  );
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.body, undefined);
});

test('legacy session listing remains unpaginated when page parameters are omitted', async () => {
  const handler = collectGetRoutes().get('/api/sessions');
  const response = await invoke(handler, fakeRequest('/api/sessions'));

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.length, 5);
  assert.equal(response.headers.get('x-total-count'), '5');
  assert.equal(response.headers.get('x-has-more'), 'false');
});

test('search route returns offset pagination metadata and look-ahead state', async () => {
  const handler = collectGetRoutes().get('/api/search-chats');
  const response = await invoke(
    handler,
    fakeRequest('/api/search-chats?q=shared%20pagination%20phrase&offset=1&limit=2')
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.count, 2);
  assert.equal(response.body.offset, 1);
  assert.equal(response.body.limit, 2);
  assert.equal(response.body.hasMore, true);
  assert.equal(response.body.nextOffset, 3);
  assert.equal(response.headers.get('x-page-offset'), '1');
  assert.equal(response.headers.get('x-has-more'), 'true');
});
