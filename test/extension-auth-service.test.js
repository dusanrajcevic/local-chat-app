const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = path.join(os.tmpdir(), `local-chat-extension-auth-service-${process.pid}-${Date.now()}`);
process.env.LOCAL_CHAT_DATA_DIR = tempDataDir;
delete process.env.LOCAL_CHAT_AUTH_TOKEN;
delete process.env.LOCAL_CHAT_EXTENSION_IDS;

const { ensureBaseFiles } = require('../src/server/storage/file-store');
const { EXTENSION_AUTH_FILE } = require('../src/server/config');
const {
  createPairingCode,
  pairExtension,
  authorizeExtension,
  resetPairingStateForTests,
  validateStoredExtensionAuth
} = require('../src/server/services/extension-auth-service');

const extensionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const origin = `chrome-extension://${extensionId}`;

test.before(async () => {
  await ensureBaseFiles();
});

test.after(async () => {
  resetPairingStateForTests();
  await fs.rm(tempDataDir, { recursive: true, force: true });
});

test('pairing stores only a token hash and authorizes the matching extension', async () => {
  const pairingCode = createPairingCode();
  const paired = await pairExtension({
    origin,
    extensionIdHeader: extensionId,
    code: pairingCode.code
  });

  assert.equal(paired.extensionId, extensionId);
  assert.ok(paired.token.length >= 40);
  assert.equal(
    await authorizeExtension({ origin, extensionIdHeader: extensionId, token: paired.token }),
    true
  );
  assert.equal(
    await authorizeExtension({ origin, extensionIdHeader: extensionId, token: 'wrong-token' }),
    false
  );

  const storedText = await fs.readFile(EXTENSION_AUTH_FILE, 'utf8');
  const stored = JSON.parse(storedText);
  assert.match(stored.pairings[0].tokenHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(storedText.includes(paired.token), false);
});

test('pairing rejects extension identity mismatches without consuming the code', async () => {
  const pairingCode = createPairingCode();
  await assert.rejects(
    () =>
      pairExtension({
        origin,
        extensionIdHeader: 'cccccccccccccccccccccccccccccccc',
        code: pairingCode.code
      }),
    /identity/i
  );

  const paired = await pairExtension({
    origin,
    extensionIdHeader: extensionId,
    code: pairingCode.code
  });
  assert.equal(paired.extensionId, extensionId);
});

test('pairing codes are single-use and stored auth records are schema checked', async () => {
  const pairingCode = createPairingCode();
  await pairExtension({ origin, extensionIdHeader: extensionId, code: pairingCode.code });
  await assert.rejects(
    () => pairExtension({ origin, extensionIdHeader: extensionId, code: pairingCode.code }),
    /expired/i
  );

  assert.throws(
    () =>
      validateStoredExtensionAuth({
        schemaVersion: 1,
        pairings: [{ extensionId, tokenHash: 'plaintext-token', pairedAt: new Date().toISOString() }]
      }),
    /invalid/i
  );
});
