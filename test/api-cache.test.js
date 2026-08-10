const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const apiModulePromise = import(pathToFileURL(path.join(__dirname, '..', 'public', 'app', 'api.mjs')).href);

function jsonResponse(data, { status = 200, etag = '' } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(etag ? { ETag: etag } : {})
    }
  });
}

test('web API client revalidates cached GETs with ETags and reuses 304 bodies', async () => {
  const { createApiClient } = await apiModulePromise;
  const seen = [];
  let requestCount = 0;
  const api = createApiClient({
    fetchImpl: async (_url, options) => {
      seen.push(options.headers);
      requestCount += 1;
      if (requestCount === 1) return jsonResponse([{ id: 's1' }], { etag: 'W/"sessions-1"' });
      return new Response(null, { status: 304, headers: { ETag: 'W/"sessions-1"' } });
    }
  });

  const first = await api('/api/sessions');
  first.push({ id: 'mutated-locally' });
  const second = await api('/api/sessions');

  assert.equal(seen[0]['If-None-Match'], undefined);
  assert.equal(seen[1]['If-None-Match'], 'W/"sessions-1"');
  assert.deepEqual(second, [{ id: 's1' }]);
});

test('web API client invalidates cached GETs after a successful mutation', async () => {
  const { createApiClient } = await apiModulePromise;
  const seen = [];
  const api = createApiClient({
    fetchImpl: async (url, options) => {
      seen.push({ url, headers: options.headers, method: options.method || 'GET' });
      if ((options.method || 'GET') === 'POST') return jsonResponse({ ok: true }, { status: 201 });
      return jsonResponse([{ id: 's1' }], { etag: 'W/"sessions-1"' });
    }
  });

  await api('/api/sessions');
  await api('/api/sessions', { method: 'POST', body: '{}' });
  await api('/api/sessions');

  assert.equal(seen[2].headers['If-None-Match'], undefined);
});
