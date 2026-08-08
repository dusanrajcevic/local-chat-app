# Desktop Build

The desktop app wraps the same Express server and web UI in Electron.

## Development

```bash
npm ci
npm run desktop
```

Electron starts the local server on `127.0.0.1` and stores runtime data in the OS app data directory instead of the app bundle.

## Build

```bash
npm run build:desktop
```

Platform-specific commands:

```bash
npm run build:mac
npm run build:win
```

Artifacts are written to `dist/` and should not be committed.

## Security-relevant behavior

- The BrowserWindow uses `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Electron denies permission prompts by default.
- Top-level navigation is limited to the local app document; renderer-created child windows are denied.
- External links are handed to the operating system only for `http:`, `https:`, and `mailto:` URLs. File, script, data, custom-protocol, and credential-bearing web URLs are rejected.
- The local server sends a restrictive Content Security Policy, Permissions Policy, frame protection, referrer policy, and MIME-sniffing protection.
- Quit waits for the local HTTP server to stop accepting requests and finish active work; lingering connections are force-closed after a short grace period.
- A second app instance focuses the existing window instead of starting another server.

## Troubleshooting

If the app cannot start because the port is in use, close the other Local Chat App process or start the Node version with a different `PORT`.

## Packaged launch smoke test

Run:

```bash
npm run test:electron-smoke
```

The test uses `electron-builder --dir` to create the current platform's unpacked production package, launches the packaged executable through Playwright's Electron API, confirms the application is running from `app.asar`, checks the hardened BrowserWindow and navigation behavior, verifies the bundled local server, then quits through Electron and confirms the listening port is released. The test uses an isolated temporary Electron user-data directory and does not touch normal desktop data.

On headless Linux, run it under Xvfb, for example `xvfb-run -a npm run test:electron-smoke`.
