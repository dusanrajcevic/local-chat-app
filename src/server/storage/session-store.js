const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../config');
const { readJson, listDateDirs } = require('./file-store');
const { summarizeSession } = require('../services/session-format');

async function collectSessionSummaries() {
  const sessions = [];
  const dateDirs = await listDateDirs();

  for (const dateDir of dateDirs) {
    const dir = path.join(DATA_DIR, dateDir);
    const files = await fs.readdir(dir).catch(() => []);
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const filePath = path.join(dir, file);
      const session = await readJson(filePath, null);
      if (session?.id) sessions.push(summarizeSession(session, dateDir));
    }
  }

  sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return sessions;
}

async function collectSearchableSessions() {
  const sessions = [];
  const dateDirs = await listDateDirs();

  for (const dateDir of dateDirs) {
    const dir = path.join(DATA_DIR, dateDir);
    const files = await fs.readdir(dir).catch(() => []);
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const filePath = path.join(dir, file);
      const session = await readJson(filePath, null);
      if (session?.id) sessions.push({ session, dateDir });
    }
  }

  return sessions;
}

module.exports = { collectSessionSummaries, collectSearchableSessions };
