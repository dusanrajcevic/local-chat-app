function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createApiClient({ fetchImpl, baseUrl = '', defaultHeaders = {} } = {}) {
  const transport = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!transport) throw new Error('A fetch implementation is required.');
  const responseCache = new Map();

  return async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const url = `${baseUrl}${path}`;
    const cached = method === 'GET' ? responseCache.get(url) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...defaultHeaders,
      ...(options.headers || {})
    };
    if (cached?.etag && !headers['If-None-Match']) headers['If-None-Match'] = cached.etag;

    const res = await transport(url, { ...options, headers });
    if (res.status === 304) {
      if (!cached) throw new Error('Received a cache response without a cached value.');
      return cloneJson(cached.data);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');

    if (method === 'GET') {
      const etag = res.headers?.get?.('etag') || '';
      if (etag) responseCache.set(url, { etag, data: cloneJson(data) });
      else responseCache.delete(url);
    } else {
      responseCache.clear();
    }

    return data;
  };
}

export { createApiClient };
