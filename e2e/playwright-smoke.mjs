import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

async function getFreePort() {
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

async function waitForHealth(baseUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError || new Error('Timed out waiting for local server health check.');
}

function playwrightBrowserIsMissingError(err) {
  const message = String(err?.message || err);
  return /Executable doesn't exist|Please run the following command to download new browsers|playwright install/i.test(
    message
  );
}

async function launchChromiumOrSkip(t) {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  try {
    return await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox']
    });
  } catch (err) {
    if (!executablePath && playwrightBrowserIsMissingError(err)) {
      t.skip('Playwright Chromium is not installed; run `npx playwright install chromium` to enable this smoke test.');
      return null;
    }
    throw err;
  }
}

test('web UI smoke flow works against a live local server', { timeout: 30_000 }, async (t) => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-chat-playwright-'));
  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOCAL_CHAT_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stderr = [];
  serverProcess.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  let browser;
  try {
    await waitForHealth(baseUrl);

    browser = await launchChromiumOrSkip(t);
    if (!browser) return;

    const page = await browser.newPage();
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Start a new local chat' }).waitFor();

    await page.getByRole('button', { name: '+ Create folder' }).click();
    await page.locator('#appPromptInput').fill('Smoke Folder');
    await page.getByRole('button', { name: 'Create folder' }).click();
    await page.locator('#folderList').getByText('Smoke Folder').waitFor();

    await page.locator('#folderList').getByText('Smoke Folder').click();
    await page.getByRole('button', { name: '+ New session' }).click();
    await page.locator('#appPromptInput').fill('Smoke Session');
    await page.getByRole('button', { name: 'Create session' }).click();
    await page.getByRole('heading', { name: 'Smoke Session' }).waitFor();

    await page.locator('#messageInput').fill('Hello from Playwright smoke');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.message-text').getByText('Hello from Playwright smoke').waitFor();

    await page.getByRole('button', { name: 'Rename session' }).click();
    await page.locator('#appPromptInput').fill('Smoke Session Renamed');
    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByRole('heading', { name: 'Smoke Session Renamed' }).waitFor();

    await page.locator('[data-trash-session]').first().click();
    await page.getByRole('heading', { name: 'No session selected' }).waitFor();

    await page.getByRole('button', { name: 'Trash' }).click();
    await page.locator('#trashList').getByText('Smoke Session Renamed').waitFor();
    await page.locator('[data-restore-session]').first().click();
    await page.locator('#sessionList').getByText('Smoke Session Renamed').waitFor();

    const response = await fetch(`${baseUrl}/api/sessions`);
    const sessions = await response.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, 'Smoke Session Renamed');
    assert.equal(sessions[0].messageCount, 1);
  } finally {
    await browser?.close();
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => serverProcess.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  assert.equal(stderr.join('').trim(), '');
});
