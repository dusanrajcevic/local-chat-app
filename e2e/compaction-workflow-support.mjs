import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { playwrightBrowserIsMissingError } from './playwright-support.mjs';

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (!port) reject(new Error('Could not allocate a local test port.'));
        else resolve(port);
      });
    });
  });
}

export async function waitForHealth(baseUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError || new Error('Timed out waiting for local server health check.');
}

export async function apiJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}

export async function pollUntil(read, predicate, { timeoutMs = 12_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await read();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

export async function launchExtensionContext({ chromium, userDataDir, extensionPath }) {
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        '--no-sandbox',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });
  } catch (error) {
    if (playwrightBrowserIsMissingError(error)) {
      throw new Error(
        'Playwright Chromium is required for the extension compaction E2E test. ' +
          'Run `npx playwright install chromium` before retrying.',
        { cause: error }
      );
    }
    throw error;
  }
}

export async function extensionServiceWorker(context, timeoutMs = 10_000) {
  const existing = context.serviceWorkers()[0];
  return existing || context.waitForEvent('serviceworker', { timeout: timeoutMs });
}

export function readProviderFixture(rootDir) {
  return fs.readFileSync(path.join(rootDir, 'e2e', 'fixtures', 'chatgpt-compaction.html'), 'utf8');
}

export function responseHasProtocolText(session, markers) {
  return (session?.messages || []).some((message) =>
    markers.some((marker) => String(message?.text || '').includes(marker))
  );
}
