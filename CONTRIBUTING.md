# Contributing

This project is a local-first chat archive with three user-facing surfaces: the local web UI, the browser extension, and the Electron desktop shell. Keep changes small, testable, and explicit about local-only security assumptions.

## Development workflow

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Start the local web app:

   ```bash
   npm start
   ```

3. Open the app at:

   ```text
   http://127.0.0.1:3000
   ```

4. For extension work, load `browser-extension/` as an unpacked Chromium extension.

5. For desktop-shell work, run:

   ```bash
   npm run desktop
   ```

Use a throwaway data directory when testing destructive behavior:

```bash
LOCAL_CHAT_DATA_DIR=/tmp/local-chat-dev npm start
```

Do not commit runtime data, generated packages, screenshots with private chats, local logs, `.env` files, or OS metadata.

## Quality gates

Run the full verification suite before submitting or publishing changes:

```bash
npm run verify
```

That command runs:

- ESLint
- Prettier format checks
- recursive JavaScript syntax checks
- Node/jsdom tests
- the Playwright smoke test against a live local server

Useful targeted commands:

```bash
npm run lint
npm run format:check
npm run check:syntax
npm test
npm run test:coverage
npm run test:smoke
npm run test:smoke:optional
npm run test:electron-smoke
```

The required web Playwright smoke test fails when Chromium is unavailable. This keeps `npm run verify` and CI from succeeding without browser-level coverage. The packaged-Electron smoke test is also part of `npm run verify`; it builds the current platform with `electron-builder --dir` and launches the packaged executable. Linux CI runs verification under `xvfb-run` so Electron has a display.

In CI, Chromium is installed with:

```bash
npx playwright install --with-deps chromium
```

Locally, you may also point Playwright at an existing Chromium binary:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run test:smoke
```

For a lightweight local web check that may skip only when the Playwright browser is missing, use:

```bash
npm run test:smoke:optional
```

Run the packaged desktop check separately with:

```bash
npm run test:electron-smoke
```

Do not use the optional command in CI or release verification. The smoke test also fails on uncaught page errors, browser `console.error` messages, failed network requests, missing accessible control names, invalid ARIA references, and dialog focus regressions.

Run `npm run format` only when you are ready to accept formatter changes across the repo.

### Accessibility

Keep interactive controls programmatically labelled, preserve visible keyboard focus, expose selected/expanded state with ARIA where appropriate, and route transient copy/save feedback through the live status region. Dialog changes must preserve focus containment while open and return focus to the control that opened the dialog when it closes.

## Architecture expectations

### Server

`server.js` should stay a small compatibility/bootstrap file. New server behavior belongs under `src/server/`:

- routes in `src/server/routes/`
- orchestration in `src/server/services/`
- file access in `src/server/storage/`
- validation in `src/server/validation.js`
- security middleware in `src/server/middleware/security.js`

Keep route handlers thin. Validate IDs at the route boundary. Do not read or write JSON files directly outside the storage layer. Preserve atomic writes and per-file locking for read-modify-write flows.

Session-list/search performance depends on `src/server/storage/session-index.js`. Treat `.session-index.json` as derived data only: never make correctness depend on it, never store raw transcript text in it, and ensure new session mutation paths continue to flow through `writeJson()` / `unlinkDataFile()` so index invalidation events are emitted. For performance changes, preserve the optional `/api/sessions` pagination compatibility contract, keep ETags tied to canonical-session/index changes rather than wall-clock time, and run `npm run benchmark:index -- 1000` in addition to the normal verification suite.

Security defaults should stay conservative: bind to loopback, reject untrusted browser origins, require paired extension access, keep the manual-token fallback narrow, and do not broaden CORS or local-API URL validation without a documented reason and tests.

### Web UI

The web UI uses native ES modules under `public/app/` with `public/app/main.mjs` as the single entrypoint. Avoid reintroducing ordered global script tags.

Keep domain logic split by responsibility:

- `api.mjs` for HTTP calls
- `state.mjs` for runtime state
- `render.mjs` for DOM rendering
- `events.mjs` for delegated event wiring
- `controllers/` for folder, session, message, and active-session workflows
- `markdown.mjs` for markdown rendering and sanitization

When changing behavior, add or update jsdom tests. For full-flow UI behavior, prefer integration coverage in `test/public-web-flow.test.js`.

### Browser extension

`browser-extension/content.js` should remain a composition root. Do not move large behavior back into it.

Current extension boundaries:

- `content-providers.js` and `providers/*` for provider adapters
- `content-dom.js` for shared DOM extraction orchestration
- `content-diagnostics.js` for privacy-preserving adapter health reporting
- `content-message-save.js` for manual save and clipboard extraction
- `content-autosave.js` for autosave state and scheduling
- `content-sidebar.js` for local sidebar replacement
- `content-composer.js` for composer loading and the load-past modal
- `content-runtime.js` for Save local injection, local-app availability, and auto-send toggle coordination

Provider-specific selectors and heuristics belong in provider adapters, not in generic orchestration modules. Generic code should describe what it needs, not which website it is on.

### Documentation

Update docs when behavior or setup changes. Keep the root README concise and move detail to `docs/` when possible. Be clear about known limitations, especially DOM fragility and local-only security assumptions.

## Adding a new provider adapter

Use this checklist when adding support for another AI chat site.

1. Create `browser-extension/providers/<provider>.js`.
2. Define the adapter metadata and selectors:
   - provider ID/name
   - host matching
   - turn/message selectors
   - content-root selectors
   - sender inference hints
   - transient/status-text patterns, if needed
3. Register the adapter in `browser-extension/content-providers.js`.
4. Update `browser-extension/manifest.json` match patterns if the provider uses a new domain.
5. Add reduced DOM fixtures under the relevant content-script tests. Do not rely only on live-site manual testing. Add at least one mutation case that changes neutral wrappers or presentation-oriented classes/test IDs while preserving semantic message structure.
6. Test at least these behaviors:
   - provider detection
   - user/assistant sender inference
   - message content extraction
   - Save local button injection
   - status/transient text rejection
   - code-copy or nested-copy button rejection, if applicable
   - provider diagnostics report the expected adapter and do not expose message text
   - neutral wrapper/presentation-attribute mutations do not silently change sender inference or extraction
7. Update `browser-extension/README.md` and the root README support list if the provider is user-visible.
8. Run:

   ```bash
   npm run verify
   npm run test:coverage
   ```

9. Manually test on the live provider UI and document any known limitations.

## Pull request checklist

Before publishing or merging a change, confirm that:

- runtime data is not committed
- public API behavior is either preserved or documented
- security defaults are not weakened
- tests cover the changed behavior
- `npm run verify` passes
- documentation reflects user-visible changes
