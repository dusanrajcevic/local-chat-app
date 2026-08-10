import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '@playwright/test';

import { collectAccessibilityIssues } from './accessibility-support.mjs';
import { launchChromium, monitorBrowserFailures } from './playwright-support.mjs';

const OPTIONAL_SMOKE_TEST = process.argv.includes('--optional');

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

test('web UI smoke flow works against a live local server', { timeout: 60_000 }, async (t) => {
  const browser = await launchChromium({
    chromium,
    t,
    optional: OPTIONAL_SMOKE_TEST,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  });
  if (!browser) return;

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

  try {
    await waitForHealth(baseUrl);

    const page = await browser.newPage();
    const browserFailures = monitorBrowserFailures(page);
    page.setDefaultTimeout(10_000);
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Start a new local chat' }).waitFor();
    assert.deepEqual(await collectAccessibilityIssues(page), [], 'Initial UI accessibility audit failed.');

    await page.locator('#newFolderBtn').click();
    await page.locator('#appPromptInput').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'appPromptInput');
    assert.equal(await page.locator('#appShell').getAttribute('inert'), '');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'saveAppPromptBtn');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'appPromptInput');
    await page.locator('#appPromptInput').fill('Smoke Folder');
    await page.locator('#saveAppPromptBtn').click();
    await page.locator('#folderList').getByText('Smoke Folder').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'newFolderBtn');
    assert.equal(await page.locator('#appShell').getAttribute('inert'), null);

    await page.locator('#folderList').getByText('Smoke Folder').click();
    await page.locator('#newChatBtn').click();
    await page.locator('#appPromptInput').fill('Smoke Session');
    await page.locator('#saveAppPromptBtn').click();
    await page.getByRole('heading', { name: 'Smoke Session' }).waitFor();
    assert.equal(await page.locator('[data-open-session][aria-current="true"]').count(), 1);
    assert.equal(await page.locator('[data-folder="all"][aria-current="true"]').count(), 0);
    assert.equal(await page.getByLabel('Message').count(), 1);
    assert.equal(await page.getByLabel('Pin current session to folder').count(), 1);

    const sidebarItemLayout = await page
      .locator('#sessionList .item')
      .first()
      .evaluate((item) => {
        const main = item.querySelector('.item-main');
        const meta = item.querySelector('.item-meta');
        const actions = item.querySelector('.item-actions');
        if (!main || !meta || !actions) throw new Error('Session row layout elements are missing.');

        const mainRect = main.getBoundingClientRect();
        const metaRect = meta.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        return {
          mainRight: mainRect.right,
          metaRight: metaRect.right,
          actionsLeft: actionsRect.left
        };
      });
    assert.ok(
      sidebarItemLayout.mainRight <= sidebarItemLayout.actionsLeft,
      `Session content overlaps actions: ${JSON.stringify(sidebarItemLayout)}`
    );
    assert.ok(
      sidebarItemLayout.metaRight <= sidebarItemLayout.actionsLeft,
      `Session metadata overlaps actions: ${JSON.stringify(sidebarItemLayout)}`
    );

    await page.locator('#messageInput').fill('Hello from Playwright smoke');
    await page.locator('#sendBtn').click();
    await page.locator('.message-text').getByText('Hello from Playwright smoke').waitFor();

    const messageNavigator = page.locator('#messageNavigator');
    assert.equal(await messageNavigator.isHidden(), false);
    assert.equal(await messageNavigator.locator('[data-message-nav-id]').count(), 1);
    assert.equal(await messageNavigator.locator('.message-nav-line').count(), 1);
    assert.equal(
      await messageNavigator.locator('.message-nav-preview').textContent(),
      'Hello from Playwright smoke'
    );
    await messageNavigator.hover();
    await page.waitForTimeout(200);
    const expandedNavigatorWidth = await messageNavigator.evaluate(
      (element) => element.getBoundingClientRect().width
    );
    assert.ok(
      expandedNavigatorWidth > 200,
      `Message navigator did not expand: ${expandedNavigatorWidth}px`
    );

    await page.locator('#renameSessionBtn').click();
    await page.locator('#appPromptInput').fill('Smoke Session Renamed');
    await page.locator('#saveAppPromptBtn').click();
    await page.getByRole('heading', { name: 'Smoke Session Renamed' }).waitFor();

    await page.locator('[data-trash-session]').first().click();
    await page.getByRole('heading', { name: 'No session selected' }).waitFor();

    await page.locator('#toggleTrashBtn').click();
    assert.equal(await page.locator('#toggleTrashBtn').getAttribute('aria-expanded'), 'true');
    await page.locator('#trashList').getByText('Smoke Session Renamed').waitFor();
    await page.locator('[data-restore-session]').first().click();
    await page.locator('#sessionList').getByText('Smoke Session Renamed').waitFor();

    const response = await fetch(`${baseUrl}/api/sessions`);
    const sessions = await response.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, 'Smoke Session Renamed');
    assert.equal(sessions[0].messageCount, 1);
    assert.deepEqual(await collectAccessibilityIssues(page), [], 'Dynamic UI accessibility audit failed.');
    assert.deepEqual(browserFailures, [], browserFailures.join('\n'));
  } finally {
    await browser.close();
    serverProcess.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => serverProcess.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  assert.equal(stderr.join('').trim(), '');
});
