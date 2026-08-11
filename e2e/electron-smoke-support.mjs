import fs from 'node:fs';
import path from 'node:path';

function childDirectories(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name));
}

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || null;
}

export function findPackagedElectronExecutable(outputDir, { platform = process.platform } = {}) {
  const outputChildren = childDirectories(outputDir);

  if (platform === 'darwin') {
    for (const directory of outputChildren.filter((entry) => path.basename(entry).startsWith('mac'))) {
      const appBundle = childDirectories(directory).find((entry) => entry.endsWith('.app'));
      if (!appBundle) continue;

      const macOsDir = path.join(appBundle, 'Contents', 'MacOS');
      if (!fs.existsSync(macOsDir)) continue;

      const executable = fs.readdirSync(macOsDir, { withFileTypes: true }).find((entry) => entry.isFile());
      if (executable) return path.join(macOsDir, executable.name);
    }
  }

  if (platform === 'win32') {
    for (const directory of outputChildren.filter((entry) => path.basename(entry).endsWith('-unpacked'))) {
      const executables = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
        .map((entry) => path.join(directory, entry.name));
      const preferred = executables.find(
        (entry) => !/^(chrome|elevate|notification_helper)/i.test(path.basename(entry))
      );
      if (preferred) return preferred;
    }
  }

  if (platform === 'linux') {
    const unpackedDirs = outputChildren.filter((entry) => path.basename(entry).endsWith('-unpacked'));
    for (const directory of unpackedDirs) {
      const candidates = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(directory, entry.name))
        .filter((entry) => {
          if (/^(chrome-sandbox|chrome_crashpad_handler)$/i.test(path.basename(entry))) return false;
          try {
            fs.accessSync(entry, fs.constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
      if (candidates.length) return candidates[0];
    }
  }

  const diagnostic = firstExisting(outputChildren) || outputDir;
  throw new Error(`Could not find the packaged Electron executable under ${diagnostic}.`);
}

export function electronBuilderCommand({ outputDir, platform = process.platform } = {}) {
  if (!outputDir) throw new Error('An Electron smoke build output directory is required.');

  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', 'build:desktop:dir', '--', `--config.directories.output=${outputDir}`]
  };
}

export async function getFreePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (!port) reject(new Error('Could not allocate a local Electron smoke-test port.'));
        else resolve(port);
      });
    });
  });
}

export async function waitForPortRelease(port, timeoutMs = 10_000) {
  const net = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const released = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (error) => {
        lastError = error;
        resolve(false);
      });
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });

    if (released) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Port ${port} was not released after Electron shutdown.`, { cause: lastError });
}
