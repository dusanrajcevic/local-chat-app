import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '@playwright/test';

import {
  apiJson,
  extensionServiceWorker,
  getFreePort,
  launchExtensionContext,
  pollUntil,
  readProviderFixture,
  responseHasProtocolText,
  waitForHealth
} from './compaction-workflow-support.mjs';
import { monitorBrowserFailures } from './playwright-support.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const EXTENSION_DIR = path.join(ROOT_DIR, 'browser-extension');
const PROVIDER_URL = 'https://chatgpt.com/local-chat-e2e?temporary-chat=true';
const PROTOCOL_MARKERS = ['<<<LOCAL_CHAT_HANDOFF_REQUEST_V1>>>', '<<<LOCAL_CHAT_HANDOFF_RESPONSE_V1>>>'];

async function createSourceSession(baseUrl, title, messagePrefix = title) {
  const session = await apiJson(baseUrl, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title, aiName: 'ChatGPT' })
  });

  for (const [index, sender] of ['me', 'bot', 'me', 'bot'].entries()) {
    await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        sender,
        text: `${messagePrefix} source message ${index + 1}`,
        source: 'e2e',
        providerKey: 'chatgpt'
      })
    });
  }

  await apiJson(baseUrl, '/api/active-session', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: session.id })
  });
  return apiJson(baseUrl, `/api/sessions/${encodeURIComponent(session.id)}`);
}

async function createPairingCode(baseUrl) {
  return apiJson(baseUrl, '/api/extension/pairing-code', {
    method: 'POST',
    body: JSON.stringify({})
  });
}

async function pairExtension(context, extensionId, baseUrl) {
  const pairing = await createPairingCode(baseUrl);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#localAppUrl').fill(baseUrl);
  await popup.locator('#pairingCode').fill(pairing.code);
  await popup.locator('#pair').click();
  await popup.locator('#status').filter({ hasText: 'Paired with Local Chat App' }).waitFor();
  return popup;
}

async function refreshExtensionSidebar(page) {
  await page.locator('[data-local-sidebar-refresh]').click();
  await page.waitForTimeout(120);
}

async function activateSourceSession(baseUrl, providerPage, sessionId) {
  await apiJson(baseUrl, '/api/active-session', {
    method: 'PUT',
    body: JSON.stringify({ sessionId })
  });
  await refreshExtensionSidebar(providerPage);
  await providerPage
    .locator(`[data-local-sidebar-session-id="${sessionId}"] .local-chat-sidebar-chat.active`)
    .waitFor();
}

async function waitForCompactionPhase(page, phase, timeout = 15_000) {
  return page.locator(`[data-local-compaction-phase="${phase}"]`).waitFor({ timeout });
}

async function assertNoCompactedChild(baseUrl, parentId) {
  const parent = await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(parentId)}`);
  assert.equal(parent.kind, 'normal');
  assert.equal(parent.compactedSessionId, null);
  assert.equal(responseHasProtocolText(parent, PROTOCOL_MARKERS), false);
}

async function stopServer(serverProcess) {
  if (serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => serverProcess.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 4_000))
  ]);
  if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
}

test('browser extension compaction workflow works end to end', { timeout: 90_000 }, async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-chat-compaction-e2e-data-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-chat-compaction-e2e-browser-'));
  const providerFixture = readProviderFixture(ROOT_DIR);
  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOCAL_CHAT_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = [];
  serverProcess.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  let context;
  try {
    await waitForHealth(baseUrl);
    const happyParent = await createSourceSession(baseUrl, 'Compaction E2E source', 'Happy');

    context = await launchExtensionContext({ chromium, userDataDir, extensionPath: EXTENSION_DIR });
    const serviceWorker = await extensionServiceWorker(context);
    const extensionId = serviceWorker.url().split('/')[2];
    assert.match(extensionId, /^[a-p]{32}$/);
    await pairExtension(context, extensionId, baseUrl);

    await context.route('https://chatgpt.com/**', async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: providerFixture });
        return;
      }
      await route.fulfill({ status: 204, body: '' });
    });

    const providerPage = await context.newPage();
    const providerFailures = monitorBrowserFailures(providerPage);
    providerPage.setDefaultTimeout(15_000);
    await providerPage.goto(PROVIDER_URL, { waitUntil: 'domcontentloaded' });
    await providerPage.locator('[data-local-chat-sidebar]').waitFor();
    await providerPage
      .locator(`[data-local-sidebar-session-id="${happyParent.id}"] .local-chat-sidebar-chat.active`)
      .waitFor();

    const compactButton = providerPage.locator('[data-local-sidebar-compact]');
    assert.equal(await compactButton.isEnabled(), true);
    await compactButton.click();
    await waitForCompactionPhase(providerPage, 'waiting-response');
    await waitForCompactionPhase(providerPage, 'complete');

    const requestTurn = providerPage.locator('[data-local-chat-compaction-turn="request"]');
    const responseTurn = providerPage.locator('[data-local-chat-compaction-turn="response"]');
    await requestTurn.waitFor({ state: 'attached' });
    await responseTurn.waitFor({ state: 'attached' });
    assert.equal(await requestTurn.evaluate((element) => getComputedStyle(element).display), 'none');
    assert.equal(await responseTurn.evaluate((element) => getComputedStyle(element).display), 'none');

    const activeAfterCompaction = await pollUntil(
      () => apiJson(baseUrl, '/api/active-session'),
      (active) => Boolean(active.sessionId && active.sessionId !== happyParent.id),
      { label: 'compacted child activation' }
    );
    const childId = activeAfterCompaction.sessionId;
    let parent = await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(happyParent.id)}`);
    let child = await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(childId)}`);

    assert.equal(parent.kind, 'normal');
    assert.equal(parent.compactedSessionId, childId);
    assert.equal(parent.messages.length, 4);
    assert.equal(child.kind, 'compacted');
    assert.equal(child.parentSessionId, happyParent.id);
    assert.equal(child.compaction.sourceMessageCount, 4);
    assert.match(child.compaction.text, /testing Local Chat App compaction end to end/i);
    assert.equal(child.messages.length, 0);
    assert.equal(responseHasProtocolText(parent, PROTOCOL_MARKERS), false);
    assert.equal(responseHasProtocolText(child, PROTOCOL_MARKERS), false);

    await providerPage.locator('#prompt-textarea').fill('Continue after compacting the conversation.');
    await providerPage.locator('#send-button').click();

    child = await pollUntil(
      () => apiJson(baseUrl, `/api/sessions/${encodeURIComponent(childId)}`),
      (session) => session.messages.length >= 2,
      { timeoutMs: 20_000, label: 'post-compaction autosave' }
    );
    parent = await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(happyParent.id)}`);
    assert.deepEqual(
      child.messages.map((message) => message.sender),
      ['me', 'bot']
    );
    assert.match(child.messages[0].text, /Continue after compacting/);
    assert.match(child.messages[1].text, /Continuation response/);
    assert.equal(parent.messages.length, 6);
    assert.deepEqual(
      parent.messages.slice(-2).map((message) => message.text),
      child.messages.map((message) => message.text)
    );
    assert.equal(responseHasProtocolText(parent, PROTOCOL_MARKERS), false);
    assert.equal(responseHasProtocolText(child, PROTOCOL_MARKERS), false);

    const childExport = await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(childId)}/export`);
    const parentExport = await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(happyParent.id)}/export`);
    assert.match(childExport.text, /Compacted context \(4 source messages\):/);
    assert.match(childExport.text, /testing Local Chat App compaction end to end/i);
    assert.match(childExport.text, /Continue after compacting the conversation\./);
    assert.doesNotMatch(childExport.text, /Happy source message 1/);
    assert.match(parentExport.text, /Happy source message 1/);
    assert.match(parentExport.text, /Continue after compacting the conversation\./);

    const localPage = await context.newPage();
    const localFailures = monitorBrowserFailures(localPage);
    localPage.setDefaultTimeout(15_000);
    await localPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await localPage.getByRole('heading', { name: /Compaction E2E source \(compacted\)/ }).waitFor();
    const contextToggle = localPage.locator('[data-toggle-compacted-context]');
    assert.equal(await contextToggle.getAttribute('aria-expanded'), 'false');
    assert.match(await contextToggle.textContent(), /4 source messages/);
    assert.equal(await localPage.locator('#compactedContextContent').isHidden(), true);
    await contextToggle.click();
    assert.equal(await contextToggle.getAttribute('aria-expanded'), 'true');
    await localPage
      .locator('#compactedContextContent')
      .getByText(/testing Local Chat App compaction end to end/i)
      .waitFor();
    assert.equal(await localPage.locator('.compacted-context .message-actions').count(), 0);
    assert.equal(await localPage.locator('#messageNavigator [data-message-nav-id]').count(), 1);

    await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(happyParent.id)}`, { method: 'DELETE' });
    let trash = await apiJson(baseUrl, '/api/trash');
    assert.equal(
      trash.some((session) => session.id === happyParent.id),
      true
    );
    assert.equal(
      trash.some((session) => session.id === childId),
      true
    );
    await apiJson(baseUrl, `/api/trash/${encodeURIComponent(happyParent.id)}/restore`, { method: 'POST' });
    parent = await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(happyParent.id)}`);
    child = await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(childId)}`);
    assert.equal(parent.compactedSessionId, childId);
    assert.equal(child.parentSessionId, happyParent.id);

    const malformedParent = await createSourceSession(baseUrl, 'Malformed compaction source', 'Malformed');
    await providerPage.evaluate(() => window.__localChatE2E.setMode('malformed'));
    await activateSourceSession(baseUrl, providerPage, malformedParent.id);
    await compactButton.click();
    await waitForCompactionPhase(providerPage, 'error');
    assert.match(await providerPage.locator('[data-local-compaction-phase="error"]').textContent(), /failed/i);
    await assertNoCompactedChild(baseUrl, malformedParent.id);
    await providerPage.locator('[data-local-sidebar-dismiss-compaction]').click();

    const plainParent = await createSourceSession(baseUrl, 'Plain handoff source', 'Plain');
    await providerPage.evaluate(() => window.__localChatE2E.setMode('plain'));
    await activateSourceSession(baseUrl, providerPage, plainParent.id);
    await compactButton.click();
    await waitForCompactionPhase(providerPage, 'complete');
    const plainActive = await apiJson(baseUrl, '/api/active-session');
    const plainChild = await apiJson(baseUrl, `/api/sessions/${encodeURIComponent(plainActive.sessionId)}`);
    assert.equal(plainChild.parentSessionId, plainParent.id);
    assert.match(plainChild.compaction.text, /handoff fallback end to end/i);
    assert.equal(responseHasProtocolText(plainChild, PROTOCOL_MARKERS), false);

    const cancelledParent = await createSourceSession(baseUrl, 'Cancelled compaction source', 'Cancelled');
    await providerPage.evaluate(() => window.__localChatE2E.setMode('hold'));
    await activateSourceSession(baseUrl, providerPage, cancelledParent.id);
    await compactButton.click();
    await waitForCompactionPhase(providerPage, 'waiting-response');
    await providerPage.locator('[data-local-sidebar-cancel-compaction]').click();
    await waitForCompactionPhase(providerPage, 'cancelled');
    assert.match(
      await providerPage.locator('[data-local-compaction-phase="cancelled"]').textContent(),
      /No compacted session was created/i
    );
    await assertNoCompactedChild(baseUrl, cancelledParent.id);

    assert.deepEqual(providerFailures, [], `Provider browser failures:\n${providerFailures.join('\n')}`);
    assert.deepEqual(localFailures, [], `Local app browser failures:\n${localFailures.join('\n')}`);
  } finally {
    await context?.close().catch(() => {});
    await stopServer(serverProcess);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  assert.equal(serverProcess.exitCode === 0 || serverProcess.signalCode === 'SIGTERM', true, stderr.join(''));
});
