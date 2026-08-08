# Architecture

## Components

### Express API

`server.js` is now a small composition/compatibility entrypoint. It creates the app, starts the local listener, and re-exports the helpers used by tests and Electron. The actual server implementation lives under `src/server/`:

- `app.js`: Express app factory and middleware/route registration;
- `config.js`: process-env derived configuration, paths, and ID patterns;
- `middleware/security.js`: security headers, origin checks, CORS policy, and paired-extension authorization;
- `routes/`: route-level HTTP wiring for health, extension pairing, active-session, folders, sessions/messages/search, and trash;
- `services/`: session orchestration, extension pairing/authentication, search, export formatting, and summary formatting;
- `storage/`: JSON-file reads/writes, atomic writes, file locks, recovery journaling, and folder/state/session queries;
- `validation.js`, `ids.js`, and `errors.js`: shared validation, ID/date helpers, and error handling.

The API exposes endpoints for folders, sessions, messages, trash, search, export, and active-session state.

Current hardening includes:

- loopback host binding by default;
- trusted-origin checks before CORS;
- short-lived browser-extension pairing codes with tokens bound to extension IDs and stored server-side only as SHA-256 hashes;
- optional manual-token fallback via `LOCAL_CHAT_AUTH_TOKEN` and optional extension-ID allowlisting via `LOCAL_CHAT_EXTENSION_IDS`;
- route ID validation;
- atomic JSON writes;
- private POSIX storage permissions (`0700` directories and `0600` files), including a startup migration for existing data;
- per-file write locks around read-modify-write operations;
- a process-wide mutation coordinator plus a persistent recovery journal for multi-file trash, restore, folder-delete, and permanent-delete workflows;
- payload-bound idempotency keys for extension auto-save messages.

### Web UI

`public/` is a vanilla JavaScript single-page UI served by Express. It is intentionally dependency-light and uses the same API as the extension. The old monolithic `public/app.js` has been replaced by native ES modules under `public/app/` and a single browser entrypoint:

- `main.mjs`: small browser bootstrap/composition root;
- `api.mjs`: fetch wrapper and API error handling;
- `state.mjs`: initial state, DOM element lookup, formatting helpers, and sender-name helpers;
- `render.mjs`: folder/session/trash/message rendering and sidebar state;
- `export.mjs`: chat export text and continuation-context wrapping;
- `modals.mjs`: edit-message and text-prompt modal state;
- `clipboard.mjs`: copy helpers, selected-message Markdown extraction, and full-chat copy;
- `controllers.mjs`: small controller composition root;
- `controllers/sessions.mjs`: session open/create/rename/pin/trash/restore workflows;
- `controllers/folders.mjs`: folder create/rename/delete/select and trash-section toggle behavior;
- `controllers/messages.mjs`: message create/edit/delete and edit-modal coordination;
- `controllers/active-session.mjs`: local/extension active-session persistence and external sync;
- `events.mjs`: event delegation and keyboard wiring;
- `markdown.mjs`: escaping, URL sanitization, tables, lists, code blocks, and inline formatting.

`public/index.html` loads only `<script type="module" src="./app/main.mjs"></script>`, so browser execution no longer depends on global `window.LocalChat*` script ordering.

### Browser extension

The extension is split into:

- `local-api.js`: shared loopback-only local API URL validation;
- `background.js`: paired local API calls, protected extension storage, request timeouts, and message routing;
- `providers/*.js`: provider-specific host matching, turn selectors, content selectors, and sender/container preferences;
- `content-providers.js`: provider adapter registry used by Node tests and the browser runtime;
- `content-dom.js`: shared DOM/extraction orchestration used by tests and the runtime;
- `content-message-save.js`: selected-text preference, provider clipboard capture/restoration, DOM fallback, and visible-message-container filtering for manual/autosave extraction;
- `content-autosave.js`: autosave state, assistant-readiness tracking, idempotency-key generation, prompt-capture scheduling, and outgoing/assistant save dedupe;
- `content-sidebar.js`: local sidebar replacement, provider-sidebar hiding/restoration, folder/session rendering, refresh, and session-selection behavior;
- `content-composer.js`: composer detection, transcript insertion, pasted-text attachment fallbacks, Load past conversations modal/search behavior, and top active-folder controls;
- `content-runtime.js`: local-app availability checks, auto-save toggle state/UI, Save local button target selection/injection, and content-script runtime scheduling;
- `content.js`: small bootstrap/coordinator that wires the DOM, message-save, autosave, sidebar, composer, and runtime modules together;
- `popup.*`: loopback local API URL and pairing-code configuration.

The content-script runtime remains the largest maintenance risk because provider UIs change often. Reduced DOM fixtures cover provider extraction and Save local injection behavior. Provider-specific selectors and sender/container preferences now live in `providers/*.js`, `content-dom.js` keeps shared extraction and markdown conversion testable, `content-message-save.js` isolates clipboard/manual extraction behavior, `content-autosave.js` isolates autosave timing/dedupe state, `content-sidebar.js` isolates local sidebar replacement, `content-composer.js` isolates composer loading plus modal/search behavior, and `content-runtime.js` isolates app availability, auto-send toggle coordination, and Save local injection from the bootstrap coordinator.

### Electron shell

`electron/main.js` starts the same Express server on `127.0.0.1`, stores user data in Electron's app data directory, and opens the local UI in a sandboxed BrowserWindow. `electron/security.js` isolates navigation/external-link policy from Electron APIs so it can be unit-tested, while `electron/server-lifecycle.js` coordinates graceful HTTP shutdown before the app exits. Renderer-created child windows are denied, top-level navigation is limited to the local app document, and only allowlisted external URL schemes are delegated to the operating system.

## Storage layout

```text
data/
  .mutation-journal.json  # present only while a recoverable multi-file mutation is in progress
  extension-auth.json     # paired extension IDs and SHA-256 token hashes
  app-state.json
  folders.json
  YYYY-MM-DD/
    chat_<timestamp>_<random>.json
  trash/
    chat_<timestamp>_<random>.json
```

The format is intentionally inspectable and portable. Every chat file contains metadata and a `messages` array. On macOS and Linux, the app creates data directories with mode `0700`, creates JSON and temporary files with mode `0600`, and tightens existing regular files during startup without following symlinks. Windows does not expose equivalent POSIX mode bits, so access remains governed by the user's Windows account and filesystem ACLs.

Multi-file mutations are serialized through a process-wide coordinator. Before changing more than one storage record, the server writes a small intent journal and flushes atomic file/directory metadata where supported. If the process stops after only part of a trash, restore, folder-delete, or permanent-delete workflow, startup replays the idempotent operation and removes the journal only after the intended state is complete. Corrupted journal data is rejected rather than discarded.

## Recommended next refactor

The largest structural blockers have now been reduced: the server has focused route/service/storage modules, the browser content script is split by responsibility, and the web UI uses native ES modules without global script ordering. The controller layer has also been split by domain under `public/app/controllers/`, while `controllers.mjs` remains a small composition root.

The next architecture improvement should focus on mutation-resistant provider fixtures and large-archive performance; the packaged-Electron launch smoke test now exercises the production bundle directly. A TypeScript migration can still be considered later, but it is no longer required to express the current module boundaries.

The current test suite covers server API/storage behavior, crash-recovery injection for multi-file mutations, security boundaries, concurrent writes, idempotency, markdown rendering, web UI API/render/controller/event seams, a browser-level jsdom flow through the real web UI runtime, native ES module entrypoint loading, extension background API calls, provider-adapter resolution, content-script DOM fixtures for provider extraction/injection, manual clipboard/message extraction, autosave idempotency/dedupe behavior, sidebar fixture behavior, composer/load-past modal behavior, runtime behavior for auto-send toggles, local-app availability, Save local delegation, dependency-free Electron navigation/security/shutdown helpers, a packaged-Electron launch smoke test, web UI accessibility contracts, modal focus behavior, and browser-level accessibility assertions.

## Quality gates

The repo now has public-portfolio quality gates:

- ESLint flat config in `eslint.config.mjs` for Node, browser, WebExtension, CommonJS, and native ES module files.
- Prettier config in `.prettierrc.json` with `.prettierignore` for generated/runtime artifacts.
- `npm run verify` runs linting, format checks, syntax checks, unit/jsdom tests, the required web Playwright smoke test, and a packaged-Electron launch smoke test built with `electron-builder --dir`.
- `e2e/playwright-smoke.mjs` starts the real local server against an isolated temporary data directory and drives the actual web UI in Chromium, including accessible-name/ARIA checks and modal focus containment/restoration.
- The required smoke test fails when Chromium is unavailable and also rejects uncaught page errors, browser `console.error` messages, and failed network requests.
- `npm run test:smoke:optional` is available only for lightweight local development where a missing browser may be skipped.
- CI installs Chromium with Playwright before running `npm run verify` and never uses the optional command.
