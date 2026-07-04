function createApiClient({ fetchImpl, baseUrl = '', defaultHeaders = {} } = {}) {
  const transport = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!transport) throw new Error('A fetch implementation is required.');

  return async function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...defaultHeaders,
      ...(options.headers || {})
    };
    const res = await transport(`${baseUrl}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  };
}

export { createApiClient };
