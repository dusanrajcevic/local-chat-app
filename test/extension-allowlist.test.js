const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-extension-allowlist-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;
process.env.LOCAL_CHAT_EXTENSION_IDS = 'cccccccccccccccccccccccccccccccc';
delete process.env.LOCAL_CHAT_AUTH_TOKEN;

const { ensureBaseFiles } = require('../src/server/storage/file-store');
const {
  createPairingCode,
  pairExtension,
  isAllowedExtensionId,
  resetPairingStateForTests
} = require('../src/server/services/extension-auth-service');

test.before(async () => {
  await ensureBaseFiles();
});

test.after(async () => {
  resetPairingStateForTests();
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

test('configured extension ID allowlist blocks other Chrome extension origins', async () => {
  assert.equal(isAllowedExtensionId('cccccccccccccccccccccccccccccccc'), true);
  assert.equal(isAllowedExtensionId('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), false);

  const code = createPairingCode();
  await assert.rejects(
    () =>
      pairExtension({
        origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        extensionIdHeader: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        code: code.code
      }),
    /not allowed/i
  );

  const paired = await pairExtension({
    origin: 'chrome-extension://cccccccccccccccccccccccccccccccc',
    extensionIdHeader: 'cccccccccccccccccccccccccccccccc',
    code: code.code
  });
  assert.equal(paired.extensionId, 'cccccccccccccccccccccccccccccccc');
});
