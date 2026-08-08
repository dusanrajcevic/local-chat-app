const { app, BrowserWindow, dialog, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { installNavigationGuards } = require('./security');
const { closeHttpServer } = require('./server-lifecycle');

const LOCAL_CHAT_PORT = Number(process.env.PORT) || 3000;

let mainWindow = null;
let localServer = null;
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise = null;

function getLocalChatUrl() {
  return `http://127.0.0.1:${LOCAL_CHAT_PORT}`;
}

function configureElectronUserDataPath() {
  const override = process.env.LOCAL_CHAT_ELECTRON_USER_DATA_DIR;
  if (!override) return;

  const userDataDir = path.resolve(override);
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  app.setPath('userData', userDataDir);
}

function configureLocalDataPath() {
  // Packaged Electron apps are usually read-only inside the app bundle/asar.
  // Keep chats, folders, trash, and app-state in the user's writable app data dir.
  process.env.LOCAL_CHAT_DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.PORT = String(LOCAL_CHAT_PORT);
}

function configureElectronSecurity() {
  // The app UI is local-only and does not need browser permissions.
  // Deny permission prompts defensively so a compromised local page cannot request
  // camera, microphone, geolocation, notifications, USB, etc.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  if (typeof session.defaultSession.setPermissionCheckHandler === 'function') {
    session.defaultSession.setPermissionCheckHandler(() => false);
  }
}

async function startLocalServer() {
  configureLocalDataPath();

  const { startServer } = require('../server');

  try {
    localServer = await startServer({ port: LOCAL_CHAT_PORT, host: '127.0.0.1' });
  } catch (err) {
    const message =
      err && err.code === 'EADDRINUSE'
        ? `Port ${LOCAL_CHAT_PORT} is already in use. Close the other Local Chat App/Node process and open this app again.`
        : (err && err.message) || String(err);

    dialog.showErrorBox('Local Chat App could not start', message);
    app.quit();
  }
}

async function stopLocalServer() {
  if (!localServer) return;

  const server = localServer;
  localServer = null;
  await closeHttpServer(server);
}

function beginShutdown() {
  if (!shutdownPromise) shutdownPromise = stopLocalServer();
  return shutdownPromise;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    icon: path.join(__dirname, '../build/icon.png'),
    title: 'Local Chat App',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  installNavigationGuards(mainWindow.webContents, {
    localChatUrl: getLocalChatUrl(),
    openExternal: (url) => shell.openExternal(url)
  });

  mainWindow.loadURL(getLocalChatUrl());
}

configureElectronUserDataPath();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    configureElectronSecurity();
    await startLocalServer();
    if (!isQuitting) createMainWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && localServer) createMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    isQuitting = true;
    if (shutdownComplete) return;

    event.preventDefault();
    beginShutdown()
      .catch((error) => {
        console.error('Could not shut down the local server cleanly:', error);
      })
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });
}
