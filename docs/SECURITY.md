# Security Notes

Local Chat App is intended for a single user on their own machine.

## Current protections

- The server binds to `127.0.0.1` by default.
- The API rejects requests with untrusted browser `Origin` headers.
- CORS only reflects same-origin requests, allowed Chrome extension origins, or explicit `LOCAL_CHAT_ALLOWED_ORIGINS` values.
- Route IDs are validated before any file lookup.
- JSON writes use temp-file-and-rename atomic writes, private file modes on POSIX systems, and symlink-resistant reads; symlinked metadata/session files and a symlinked data directory are rejected rather than followed.
- Read-modify-write operations use in-process locks; multi-file trash/restore/folder-delete workflows use a recovery journal.
- Browser-extension API access requires pairing or the explicit server-side compatibility token, and pairing tokens are bound to the extension ID.
- Extension auto-save can send idempotency keys to avoid duplicate message writes.
- Electron uses `contextIsolation`, disables Node integration, enables sandbox mode, denies permission prompts, blocks unexpected top-level navigation and child windows, and only opens allowlisted external URL schemes.
- The local web UI is served with a restrictive Content Security Policy, Permissions Policy, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and MIME-sniffing protection.
- Electron shutdown waits for the local HTTP server to close so in-flight API work can finish before the process exits.

## Browser-extension pairing

Pairing is the normal browser-extension authentication flow:

1. Start Local Chat App.
2. Click **Pair browser extension** in the local web or desktop UI.
3. Generate the short-lived pairing code.
4. Enter that code in the extension popup.

The server returns a random long-lived token only after a successful pairing exchange and stores only its SHA-256 hash. The extension keeps the token in `chrome.storage.local` with access restricted to trusted extension contexts, while non-sensitive preferences use sync storage when available.

For compatibility with API clients that already provide the extension identity header, a server-side manual token can still be configured:

```bash
LOCAL_CHAT_AUTH_TOKEN="replace-with-a-random-token" npm start
```

The extension popup does not accept this compatibility token. Same-origin local web-app requests do not require extension authentication. `LOCAL_CHAT_EXTENSION_IDS` can optionally restrict which Chrome extension IDs may pair or use the compatibility token.

## Do not expose the API

Do not bind this app to `0.0.0.0` or expose port `3000` to a network unless you add a stronger authentication and authorization layer. The app is not designed as a shared hosted service.

## Remaining risks

- Browser extensions are powerful. Only load this extension from source you trust.
- AI chat provider DOMs are third-party surfaces and may change at any time.
- This app does not encrypt chat files at rest.
- In-process locks only protect writes within one running app process. Do not run multiple server processes against the same data directory.
