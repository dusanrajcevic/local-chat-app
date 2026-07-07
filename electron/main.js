const { app, BrowserWindow, dialog, shell, session } = require('electron');
const path = require('path');

const LOCAL_CHAT_PORT = Number(process.env.PORT) || 3000;

let mainWindow = null;
let localServer = null;
let isQuitting = false;

function getLocalChatUrl() {
  return `http://127.0.0.1:${LOCAL_CHAT_PORT}`;
}

function isLocalChatUrl(value) {
  try {
    return new URL(value).origin === new URL(getLocalChatUrl()).origin;
  } catch {
    return false;
  }
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocalChatUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalChatUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.loadURL(getLocalChatUrl());
}

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

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('quit', () => {
    if (localServer) localServer.close();
  });
}
