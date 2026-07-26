const assert = require('node:assert/strict');
const { test } = require('node:test');

async function loadSupport() {
  return import('../e2e/playwright-support.mjs');
}

function missingBrowserError() {
  return new Error(
    "Executable doesn't exist. Please run the following command to download new browsers: playwright install"
  );
}

test('required Chromium launch fails when the Playwright browser is missing', async () => {
  const { launchChromium } = await loadSupport();
  const originalError = missingBrowserError();
  const chromium = {
    launch: async () => {
      throw originalError;
    }
  };

  await assert.rejects(
    launchChromium({ chromium, t: { skip: assert.fail } }),
    (err) => err.message.includes('Playwright Chromium is required') && err.cause === originalError
  );
});

test('optional Chromium launch skips only when the bundled browser is missing', async () => {
  const { launchChromium } = await loadSupport();
  const skipReasons = [];
  const chromium = {
    launch: async () => {
      throw missingBrowserError();
    }
  };

  const browser = await launchChromium({
    chromium,
    t: { skip: (reason) => skipReasons.push(reason) },
    optional: true
  });

  assert.equal(browser, null);
  assert.equal(skipReasons.length, 1);
  assert.match(skipReasons[0], /Playwright Chromium is not installed/);
});

test('configured Chromium launch errors are never converted into skips', async () => {
  const { launchChromium } = await loadSupport();
  const originalError = missingBrowserError();
  let skipped = false;
  const chromium = {
    launch: async () => {
      throw originalError;
    }
  };

  await assert.rejects(
    launchChromium({
      chromium,
      t: { skip: () => (skipped = true) },
      optional: true,
      executablePath: '/missing/chromium'
    }),
    originalError
  );
  assert.equal(skipped, false);
});

test('browser launch receives the configured executable path', async () => {
  const { launchChromium } = await loadSupport();
  const expectedBrowser = {};
  let launchOptions;
  const chromium = {
    launch: async (options) => {
      launchOptions = options;
      return expectedBrowser;
    }
  };

  const browser = await launchChromium({
    chromium,
    t: { skip: assert.fail },
    executablePath: '/usr/bin/chromium'
  });

  assert.equal(browser, expectedBrowser);
  assert.deepEqual(launchOptions, {
    headless: true,
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox']
  });
});

test('browser monitoring records runtime, console, and network failures', async () => {
  const { monitorBrowserFailures } = await loadSupport();
  const listeners = new Map();
  const page = {
    on(event, listener) {
      listeners.set(event, listener);
    }
  };

  const failures = monitorBrowserFailures(page);
  listeners.get('console')({ type: () => 'info', text: () => 'expected info' });
  listeners.get('console')({ type: () => 'error', text: () => 'broken UI' });
  listeners.get('pageerror')(new Error('unhandled rejection'));
  listeners.get('requestfailed')({
    method: () => 'GET',
    url: () => 'http://127.0.0.1:3000/app.mjs',
    failure: () => ({ errorText: 'net::ERR_FAILED' })
  });

  assert.equal(failures.length, 3);
  assert.match(failures[0], /^console\.error: broken UI$/);
  assert.match(failures[1], /^pageerror: Error: unhandled rejection/);
  assert.equal(failures[2], 'requestfailed: GET http://127.0.0.1:3000/app.mjs (net::ERR_FAILED)');
});
