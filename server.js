const { createApp } = require('./src/server/app');
const {
  PORT,
  DEFAULT_HOST,
  DATA_DIR,
  SESSION_ID_PATTERN,
  MESSAGE_ID_PATTERN,
  FOLDER_ID_PATTERN
} = require('./src/server/config');
const { ensureBaseFiles, readJson, writeJson } = require('./src/server/storage/file-store');
const { recoverPendingMutation } = require('./src/server/storage/mutation-coordinator');
const { buildChatExportText, wrapChatExportForContinuation } = require('./src/server/services/export-service');
const { readFolders, folderExists } = require('./src/server/storage/folder-store');

const app = createApp();

async function startServer(options = {}) {
  const requestedPort = Number(options.port ?? PORT);
  const port = Number.isFinite(requestedPort) ? requestedPort : 3000;
  const host = options.host || DEFAULT_HOST;
  await ensureBaseFiles();
  await recoverPendingMutation();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      const displayHost = host === '127.0.0.1' ? '127.0.0.1' : host;
      server.localChatUrl = `http://${displayHost}:${actualPort}`;
      console.log(`Local chat app running at ${server.localChatUrl}`);
      resolve(server);
    });

    server.once('error', reject);
  });
}

if (require.main === module) {
  startServer({ port: PORT, host: DEFAULT_HOST }).catch((err) => {
    console.error('Could not start local chat app:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  ensureBaseFiles,
  readJson,
  writeJson,
  DATA_DIR,
  SESSION_ID_PATTERN,
  MESSAGE_ID_PATTERN,
  FOLDER_ID_PATTERN,
  buildChatExportText,
  wrapChatExportForContinuation,
  readFolders,
  folderExists
};
