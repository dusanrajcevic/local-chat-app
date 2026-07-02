# Security Notes

Local Chat App is intended for a single user on their own machine.

## Current protections

- The server binds to `127.0.0.1` by default.
- The API rejects requests with untrusted browser `Origin` headers.
- CORS only reflects same-origin requests, approved extension origins, or explicit `LOCAL_CHAT_ALLOWED_ORIGINS` values.
- Route IDs are validated before any file lookup.
- JSON writes use temp-file-and-rename atomic writes.
- Read-modify-write operations use in-process per-file locks.
- Extension auto-save can send idempotency keys to avoid duplicate message writes.
- Electron uses `contextIsolation`, disables Node integration, enables sandbox mode, denies permission prompts, and opens external URLs outside the app.

## Optional extension token

Set an API token before starting the server:

```bash
LOCAL_CHAT_AUTH_TOKEN="replace-with-a-random-token" npm start
```

Then paste the same token into the extension popup.

The token is mainly useful for extension-origin requests. The local web UI is same-origin and does not need it.

## Do not expose the API

Do not bind this app to `0.0.0.0` or expose port `3000` to a network unless you add a stronger authentication and authorization layer. The app is not designed as a shared hosted service.

## Remaining risks

- Browser extensions are powerful. Only load this extension from source you trust.
- AI chat provider DOMs are third-party surfaces and may change at any time.
- This app does not encrypt chat files at rest.
- In-process locks only protect writes within one running app process. Do not run multiple server processes against the same data directory.
