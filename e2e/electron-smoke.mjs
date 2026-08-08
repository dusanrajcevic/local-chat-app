import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { _electron as electron } from '@playwright/test';

import { collectAccessibilityIssues } from './accessibility-support.mjs';
import {
  electronBuilderCommand,
  findPackagedElectronExecutable,
  getFreePort,
  waitForPortRelease
} from './electron-smoke-support.mjs';
import { monitorBrowserFailures } from './playwright-support.mjs';

const PROJECT_DIR = path.resolve(import.meta.dirname, '..');

function runElectronBuilder(outputDir) {
  const { command, args } = electronBuilderCommand({ outputDir });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          [
            `electron-builder failed (${signal ? `signal ${signal}` : `exit ${code}`}).`,
            stdout.join('').trim(),
            stderr.join('').trim()
          ]
            .filter(Boolean)
            .join('\n')
        )
      );
    });
  });
}

async function assertUrlRemains(page, expectedUrl, durationMs = 500) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    assert.equal(page.url(), expectedUrl);
    await page.waitForTimeout(50);
  }
}

test('packaged Electron app launches securely and shuts down cleanly', { timeout: 180_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-chat-electron-smoke-'));
  const buildDir = path.join(tempRoot, 'dist');
  const userDataDir = path.join(tempRoot, 'user-data');
  fs.mkdirSync(userDataDir, { recursive: true });
  const port = await getFreePort();
  let electronApp = null;
  let electronClosed = false;

  try {
    await runElectronBuilder(buildDir);
    const executablePath = findPackagedElectronExecutable(buildDir);
    assert.ok(fs.existsSync(executablePath), `Packaged Electron executable is missing: ${executablePath}`);

    const args = [];
    if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
      args.push('--no-sandbox');
    }

    electronApp = await electron.launch({
      executablePath,
      args,
      env: {
        ...process.env,
        PORT: String(port),
        LOCAL_CHAT_ELECTRON_USER_DATA_DIR: userDataDir
      },
      timeout: 30_000
    });
    electronApp.once('close', () => {
      electronClosed = true;
    });

    const mainWindow = await electronApp.firstWindow({ timeout: 30_000 });
    mainWindow.setDefaultTimeout(10_000);
    const browserFailures = monitorBrowserFailures(mainWindow);

    await mainWindow.getByRole('heading', { name: 'Start a new local chat' }).waitFor();
    assert.equal(await mainWindow.title(), 'Local Chat App');
    assert.deepEqual(
      await collectAccessibilityIssues(mainWindow),
      [],
      'Packaged Electron UI accessibility audit failed.'
    );

    const runtime = await electronApp.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        userDataPath: app.getPath('userData'),
        windowCount: BrowserWindow.getAllWindows().length,
        webPreferences: window?.webContents.getLastWebPreferences() || null
      };
    });

    assert.equal(runtime.isPackaged, true);
    assert.equal(path.basename(runtime.appPath), 'app.asar');
    assert.equal(path.resolve(runtime.userDataPath), path.resolve(userDataDir));
    assert.equal(runtime.windowCount, 1);
    assert.equal(runtime.webPreferences?.contextIsolation, true);
    assert.equal(runtime.webPreferences?.nodeIntegration, false);
    assert.equal(runtime.webPreferences?.sandbox, true);

    const rootUrl = mainWindow.url();
    const root = new URL(rootUrl);
    assert.equal(root.hostname, '127.0.0.1');
    assert.equal(root.port, String(port));
    assert.equal(root.pathname, '/');

    const liveServer = await mainWindow.evaluate(async () => {
      const [healthResponse, documentResponse] = await Promise.all([fetch('/api/health'), fetch('/')]);
      return {
        healthStatus: healthResponse.status,
        health: await healthResponse.json(),
        csp: documentResponse.headers.get('content-security-policy'),
        permissionsPolicy: documentResponse.headers.get('permissions-policy')
      };
    });
    assert.equal(liveServer.healthStatus, 200);
    assert.equal(liveServer.health.ok, true);
    assert.match(liveServer.csp || '', /frame-ancestors 'none'/);
    assert.match(liveServer.permissionsPolicy || '', /camera=\(\)/);

    assert.deepEqual(browserFailures, [], browserFailures.join('\n'));

    await mainWindow.evaluate((url) => {
      window.location.href = url;
    }, `${root.origin}/api/health`);
    await assertUrlRemains(mainWindow, rootUrl);

    await mainWindow.evaluate(() => {
      window.open('data:text/html,blocked-child-window', '_blank');
    });
    await mainWindow.waitForTimeout(200);
    assert.equal(electronApp.windows().length, 1, 'Renderer-created child window was not denied.');

    await mainWindow.evaluate(() => {
      window.location.href = 'data:text/html,blocked-navigation';
    });
    await assertUrlRemains(mainWindow, rootUrl);

    const closePromise = new Promise((resolve) => electronApp.once('close', resolve));
    await electronApp.evaluate(({ app }) => {
      setImmediate(() => app.quit());
      return true;
    });
    await closePromise;
    electronClosed = true;
    await waitForPortRelease(port);
  } finally {
    if (electronApp && !electronClosed) {
      await electronApp.close().catch(() => {});
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
