const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.LOCAL_CHAT_DATA_DIR || path.join(ROOT_DIR, 'data'));
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');
const STATE_FILE = path.join(DATA_DIR, 'app-state.json');
const AUTH_TOKEN = String(process.env.LOCAL_CHAT_AUTH_TOKEN || '').trim();
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

module.exports = {
  ROOT_DIR,
  PORT,
  DEFAULT_HOST,
  DATA_DIR,
  TRASH_DIR,
  FOLDERS_FILE,
  STATE_FILE,
  AUTH_TOKEN,
  EXTRA_ALLOWED_ORIGINS,
  SESSION_ID_PATTERN,
  MESSAGE_ID_PATTERN,
  FOLDER_ID_PATTERN,
  DATE_DIR_PATTERN,
  IDEMPOTENCY_KEY_PATTERN
};
