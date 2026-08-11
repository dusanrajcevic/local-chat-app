const test = require('node:test');
const assert = require('node:assert/strict');

const { isLocalAppNavigationUrl, externalUrlToOpen, installNavigationGuards } = require('../electron/security');
const { closeHttpServer } = require('../electron/server-lifecycle');
const {
  CONTENT_SECURITY_POLICY,
  PERMISSIONS_POLICY,
  setSecurityHeaders
} = require('../src/server/middleware/security-headers');

const LOCAL_URL = 'http://127.0.0.1:3000';

test('Electron navigation only accepts the local app document', () => {
  assert.equal(isLocalAppNavigationUrl(`${LOCAL_URL}/`, LOCAL_URL), true);
  assert.equal(isLocalAppNavigationUrl(`${LOCAL_URL}/#session`, LOCAL_URL), true);
  assert.equal(isLocalAppNavigationUrl(`${LOCAL_URL}/index.html`, LOCAL_URL), true);
  assert.equal(isLocalAppNavigationUrl(`${LOCAL_URL}/api/sessions`, LOCAL_URL), false);
  assert.equal(isLocalAppNavigationUrl(`${LOCAL_URL}/?next=https://evil.example`, LOCAL_URL), false);
  assert.equal(isLocalAppNavigationUrl('http://127.0.0.1:3001/', LOCAL_URL), false);
  assert.equal(isLocalAppNavigationUrl('https://example.com/', LOCAL_URL), false);
  assert.equal(isLocalAppNavigationUrl('not a url', LOCAL_URL), false);
});

test('Electron external opening uses an explicit protocol allowlist', () => {
  assert.equal(externalUrlToOpen('https://example.com/docs'), 'https://example.com/docs');
  assert.equal(externalUrlToOpen('http://example.com/docs'), 'http://example.com/docs');
  assert.equal(externalUrlToOpen('mailto:user@example.com'), 'mailto:user@example.com');

  assert.equal(externalUrlToOpen('https://user:secret@example.com/'), null);
  assert.equal(externalUrlToOpen('file:///tmp/private.txt'), null);
  assert.equal(externalUrlToOpen('javascript:alert(1)'), null);
  assert.equal(externalUrlToOpen('data:text/html,hello'), null);
  assert.equal(externalUrlToOpen('custom-protocol://example'), null);
  assert.equal(externalUrlToOpen('https://example.com/\nfile:///tmp/test'), null);
});

test('Electron window and navigation guards deny child windows and unsafe navigation', async () => {
  const listeners = new Map();
  let windowHandler;
  const opened = [];
  const deferred = [];
  const webContents = {
    setWindowOpenHandler(handler) {
      windowHandler = handler;
    },
    on(event, handler) {
      listeners.set(event, handler);
    }
  };

  installNavigationGuards(webContents, {
    localChatUrl: LOCAL_URL,
    openExternal: async (url) => opened.push(url),
    defer: (callback) => deferred.push(callback),
    logError: assert.fail
  });

  assert.deepEqual(windowHandler({ url: `${LOCAL_URL}/` }), { action: 'deny' });
  assert.deepEqual(windowHandler({ url: 'file:///tmp/private.txt' }), { action: 'deny' });
  assert.deepEqual(windowHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.equal(deferred.length, 1);
  deferred.shift()();
  await Promise.resolve();
  assert.deepEqual(opened, ['https://example.com/']);

  let prevented = false;
  listeners.get('will-navigate')({ preventDefault: () => (prevented = true) }, `${LOCAL_URL}/#session`);
  assert.equal(prevented, false);

  prevented = false;
  listeners.get('will-navigate')({ preventDefault: () => (prevented = true) }, `${LOCAL_URL}/api/sessions`);
  assert.equal(prevented, true);
  assert.equal(deferred.length, 0);

  prevented = false;
  listeners.get('will-redirect')({ preventDefault: () => (prevented = true) }, 'mailto:user@example.com');
  assert.equal(prevented, true);
  assert.equal(deferred.length, 1);
  deferred.shift()();
  await Promise.resolve();
  assert.deepEqual(opened, ['https://example.com/', 'mailto:user@example.com']);
});

test('Electron external opening contains synchronous shell failures', () => {
  let windowHandler;
  const errors = [];
  const webContents = {
    setWindowOpenHandler(handler) {
      windowHandler = handler;
    },
    on() {}
  };

  installNavigationGuards(webContents, {
    localChatUrl: LOCAL_URL,
    openExternal() {
      throw new Error('shell failed');
    },
    defer: (callback) => callback(),
    logError: (...args) => errors.push(args)
  });

  assert.deepEqual(windowHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.equal(errors.length, 1);
  assert.match(errors[0][1].message, /shell failed/);
});

test('Electron server shutdown closes idle connections and resolves after close', async () => {
  const calls = [];
  const server = {
    listening: true,
    close(callback) {
      calls.push('close');
      queueMicrotask(callback);
    },
    closeIdleConnections() {
      calls.push('idle');
    },
    closeAllConnections() {
      calls.push('all');
    }
  };

  await closeHttpServer(server);
  assert.deepEqual(calls, ['close', 'idle']);
});

test('Electron server shutdown force-closes remaining connections after the grace period', async () => {
  const calls = [];
  let closeCallback;
  let forceCallback;
  const timer = { unref() {} };
  const server = {
    listening: true,
    close(callback) {
      calls.push('close');
      closeCallback = callback;
    },
    closeIdleConnections() {
      calls.push('idle');
    },
    closeAllConnections() {
      calls.push('all');
      closeCallback();
    }
  };

  const closing = closeHttpServer(server, {
    forceAfterMs: 10,
    setTimeout(callback) {
      forceCallback = callback;
      return timer;
    },
    clearTimeout() {
      calls.push('clear-timer');
    }
  });

  assert.deepEqual(calls, ['close', 'idle']);
  forceCallback();
  await closing;
  assert.deepEqual(calls, ['close', 'idle', 'all', 'clear-timer']);
});

test('security headers enforce a restrictive local-app browser policy', () => {
  const headers = new Map();
  let nextCalled = false;
  setSecurityHeaders(
    {},
    { setHeader: (name, value) => headers.set(name.toLowerCase(), value) },
    () => (nextCalled = true)
  );

  assert.equal(nextCalled, true);
  assert.equal(headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.equal(headers.get('permissions-policy'), PERMISSIONS_POLICY);
  assert.match(PERMISSIONS_POLICY, /camera=\(\)/);
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
});
