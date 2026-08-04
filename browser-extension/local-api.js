(function exposeLocalChatApiConfig(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatApiConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatApiConfig() {
  'use strict';

  const DEFAULT_LOCAL_APP_URL = 'http://localhost:3000';
  const DEFAULT_FETCH_TIMEOUT_MS = 8000;

  function isLoopbackHostname(hostname) {
    const normalized = String(hostname || '').toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1';
  }

  function normalizeBaseUrl(value) {
    const raw = String(value || DEFAULT_LOCAL_APP_URL).trim() || DEFAULT_LOCAL_APP_URL;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('Local app URL must be a valid loopback HTTP URL.');
    }

    if (parsed.protocol !== 'http:') {
      throw new Error('Local app URL must use http://.');
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new Error('Local app URL must use localhost or 127.0.0.1.');
    }
    if (parsed.username || parsed.password) {
      throw new Error('Local app URL must not contain credentials.');
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('Local app URL must not contain a path, query, or fragment.');
    }

    return parsed.origin;
  }

  function normalizeApiUrl(url, baseUrl) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch {
      throw new Error('Local API URL is invalid.');
    }

    if (parsed.origin !== normalizedBaseUrl || !parsed.pathname.startsWith('/api/')) {
      throw new Error('Refusing to send Local Chat credentials outside the configured local API.');
    }
    if (parsed.username || parsed.password || parsed.hash) {
      throw new Error('Local API URL is invalid.');
    }

    return parsed.toString();
  }

  return {
    DEFAULT_LOCAL_APP_URL,
    DEFAULT_FETCH_TIMEOUT_MS,
    isLoopbackHostname,
    normalizeBaseUrl,
    normalizeApiUrl
  };
});
