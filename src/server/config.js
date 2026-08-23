const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.LOCAL_CHAT_DATA_DIR || path.join(ROOT_DIR, 'data'));
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');
const STATE_FILE = path.join(DATA_DIR, 'app-state.json');
const MUTATION_JOURNAL_FILE = path.join(DATA_DIR, '.mutation-journal.json');
const EXTENSION_AUTH_FILE = path.join(DATA_DIR, 'extension-auth.json');
const SESSION_INDEX_FILE = path.join(DATA_DIR, '.session-index.json');
const AUTH_TOKEN = String(process.env.LOCAL_CHAT_AUTH_TOKEN || '').trim();
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const configuredExtensionIds = String(process.env.LOCAL_CHAT_EXTENSION_IDS || '')
  .split(',')
  .map((extensionId) => extensionId.trim().toLowerCase())
  .filter(Boolean);
const invalidExtensionId = configuredExtensionIds.find((extensionId) => !EXTENSION_ID_PATTERN.test(extensionId));
if (invalidExtensionId) {
  throw new Error(`LOCAL_CHAT_EXTENSION_IDS contains an invalid extension ID: ${invalidExtensionId}`);
}
const ALLOWED_EXTENSION_IDS = new Set(configuredExtensionIds);
const EXTRA_ALLOWED_ORIGINS = new Set(
  String(process.env.LOCAL_CHAT_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const SESSION_ID_PATTERN = /^chat_\d+_[a-f0-9]{8}$/;
const MESSAGE_ID_PATTERN = /^msg_\d+_[a-f0-9]{8}$/;
const FOLDER_ID_PATTERN = /^folder_\d+_[a-f0-9]{8}$/;
const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9._:-]{8,160}$/;
const IDEMPOTENCY_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CURRENT_SCHEMA_VERSION = 1;
const CURRENT_SESSION_SCHEMA_VERSION = 2;
const COMPACTION_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,160}$/;

module.exports = {
  ROOT_DIR,
  PORT,
  DEFAULT_HOST,
  DATA_DIR,
  TRASH_DIR,
  FOLDERS_FILE,
  STATE_FILE,
  MUTATION_JOURNAL_FILE,
  EXTENSION_AUTH_FILE,
  SESSION_INDEX_FILE,
  AUTH_TOKEN,
  EXTENSION_ID_PATTERN,
  ALLOWED_EXTENSION_IDS,
  EXTRA_ALLOWED_ORIGINS,
  SESSION_ID_PATTERN,
  MESSAGE_ID_PATTERN,
  FOLDER_ID_PATTERN,
  DATE_DIR_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_FINGERPRINT_PATTERN,
  COMPACTION_REQUEST_ID_PATTERN,
  CURRENT_SCHEMA_VERSION,
  CURRENT_SESSION_SCHEMA_VERSION
};
