const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function loadSupport() {
  return import('../e2e/electron-smoke-support.mjs');
}

function withTempDir(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-chat-electron-support-'));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('Electron smoke builder uses an unpacked package in an isolated output directory', async () => {
  const { electronBuilderCommand } = await loadSupport();
  const command = electronBuilderCommand({ outputDir: '/tmp/local-chat-electron-dist', platform: 'linux' });

  assert.equal(command.command, 'npm');
  assert.deepEqual(command.args, [
    'run',
    'build:desktop:dir',
    '--',
    '--config.directories.output=/tmp/local-chat-electron-dist'
  ]);
});

test('packaged executable discovery resolves macOS app bundles', async () => {
  const { findPackagedElectronExecutable } = await loadSupport();
  withTempDir((root) => {
    const executable = path.join(root, 'mac-arm64', 'Local Chat App.app', 'Contents', 'MacOS', 'Local Chat App');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '');
    assert.equal(findPackagedElectronExecutable(root, { platform: 'darwin' }), executable);
  });
});

test('packaged executable discovery resolves Windows unpacked builds', async () => {
  const { findPackagedElectronExecutable } = await loadSupport();
  withTempDir((root) => {
    const directory = path.join(root, 'win-unpacked');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'chrome_crashpad_handler.exe'), '');
    const executable = path.join(directory, 'Local Chat App.exe');
    fs.writeFileSync(executable, '');
    assert.equal(findPackagedElectronExecutable(root, { platform: 'win32' }), executable);
  });
});

test('packaged executable discovery resolves Linux unpacked builds', async () => {
  const { findPackagedElectronExecutable } = await loadSupport();
  withTempDir((root) => {
    const directory = path.join(root, 'linux-unpacked');
    fs.mkdirSync(directory, { recursive: true });
    const sharedLibrary = path.join(directory, 'libEGL.so');
    fs.writeFileSync(sharedLibrary, '');
    fs.chmodSync(sharedLibrary, 0o755);
    const executable = path.join(directory, 'local-chat-app');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    fs.chmodSync(executable, 0o755);
    assert.equal(findPackagedElectronExecutable(root, { platform: 'linux' }), executable);
  });
});

test('Electron smoke launch disables the Chromium sandbox only on Linux CI or as root', async () => {
  const { electronLaunchArgs } = await loadSupport();

  assert.deepEqual(electronLaunchArgs({ platform: 'linux', ci: true, uid: 1000 }), ['--no-sandbox']);
  assert.deepEqual(electronLaunchArgs({ platform: 'linux', ci: false, uid: 0 }), ['--no-sandbox']);
  assert.deepEqual(electronLaunchArgs({ platform: 'linux', ci: false, uid: 1000 }), []);
  assert.deepEqual(electronLaunchArgs({ platform: 'darwin', ci: true, uid: 501 }), []);
});
