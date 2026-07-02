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
- Navigation and new-window handling compare URL origins rather than string prefixes.
- A second app instance focuses the existing window instead of starting another server.

## Troubleshooting

If the app cannot start because the port is in use, close the other Local Chat App process or start the Node version with a different `PORT`.
