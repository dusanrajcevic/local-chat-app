# Architecture

## Components

### Express API

`server.js` is now a small composition/compatibility entrypoint. It creates the app, starts the local listener, and re-exports the helpers used by tests and Electron. The actual server implementation lives under `src/server/`:

- `app.js`: Express app factory and middleware/route registration;
- `config.js`: process-env derived configuration, paths, and ID patterns;
- `middleware/security.js`: Host/origin checks, CORS policy, and paired-extension authorization;
- `middleware/security-headers.js`: Content Security Policy, Permissions Policy, frame/referrer, and MIME-sniffing headers;
- `http/collection-response.js`: offset pagination metadata, `Link` headers, and ETag/conditional-response helpers;
- `routes/`: route-level HTTP wiring for health, extension pairing, active-session, folders, sessions/messages/search, and trash;
- `services/`: session orchestration, extension pairing/authentication, search, export formatting, and summary formatting;
- `storage/`: symlink-resistant JSON reads/writes, atomic writes, file locks, mutation recovery, folder/state/session queries, storage-change events, and the derived session index;
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
- `message-navigator.mjs`: right-side user-message markers, hover/focus previews, active-turn tracking, and jump navigation;
- `export.mjs`: chat export text and continuation-context wrapping, including compacted context plus post-compaction messages for compacted sessions;
- `modals.mjs`: shared edit/prompt/search dialog state, focus containment, and focus restoration;
- `clipboard.mjs`: chat/message Markdown copy helpers and fenced-code copying;
- `controllers.mjs`: small controller composition root;
- `controllers/sessions.mjs`: session open/create/rename/pin/trash/restore workflows;
- `controllers/folders.mjs`: folder create/rename/delete/select and trash-section toggle behavior;
- `controllers/messages.mjs`: message create/edit/delete and edit-modal coordination;
- `controllers/active-session.mjs`: local/extension active-session persistence and external sync;
- `controllers/search.mjs`: recent-chat loading, debounced indexed search, highlighted snippets, and result opening;
- `events.mjs`: event delegation and keyboard wiring;
- `markdown.mjs`: escaping, URL sanitization, tables, lists, language-aware fenced-code headers/copy controls, and inline formatting.

`public/index.html` loads only `<script type="module" src="./app/main.mjs"></script>`, so browser execution no longer depends on global `window.LocalChat*` script ordering.

### Browser extension

The extension is split into:

- `local-api.js`: shared loopback-only local API URL validation;
- `background.js`: paired local API calls, protected extension storage, request timeouts, message routing, and the structured-compaction persistence bridge;
- `providers/*.js`: provider-specific host matching, turn selectors, content selectors, and sender/container preferences;
- `content-providers.js`: provider adapter registry used by Node tests and the browser runtime;
- `content-dom.js`: shared DOM/extraction orchestration used by tests and the runtime;
- `content-diagnostics.js`: privacy-preserving provider health reporting for selector hits, message discovery, sender inference, and extraction coverage;
- `content-compaction.js`: versioned provider compaction prompt/response contract, request-ID generation, strict response parsing, and local API payload conversion;
- `content-compaction-workflow.js`: Compact orchestration across provider composer send, structured response detection, persistence, active-session switching, and protocol-turn hiding;
- `content-message-save.js`: selected-text preference, provider clipboard capture/restoration, DOM fallback, and visible-message-container filtering for manual/autosave extraction;
- `content-autosave.js`: autosave state, assistant-readiness tracking, idempotency-key generation, prompt-capture scheduling, and outgoing/assistant save dedupe;
- `content-sidebar.js`: local sidebar replacement, provider-sidebar hiding/restoration, folder/session rendering, refresh, and session-selection behavior;
- `content-composer.js`: composer detection, transcript insertion, pasted-text attachment fallbacks, Load past conversations modal/search behavior, and top active-folder controls;
- `content-runtime.js`: local-app availability checks, auto-save toggle state/UI, Save local button target selection/injection, and content-script runtime scheduling;
- `content.js`: small bootstrap/coordinator that wires the DOM, message-save, autosave, sidebar, composer, compaction workflow, and runtime modules together;
- `popup.*`: loopback local API URL and pairing-code configuration.

The content-script runtime remains the largest maintenance risk because provider UIs change often. Reduced DOM fixtures cover provider extraction and Save local injection behavior, mutation tests vary neutral wrappers and presentation-oriented attributes, and the popup can request a privacy-preserving live adapter diagnostic report from the active provider tab. Provider-specific selectors and sender/container preferences now live in `providers/*.js`, `content-dom.js` keeps shared extraction and markdown conversion testable, `content-message-save.js` isolates clipboard/manual extraction behavior, `content-autosave.js` isolates autosave timing/dedupe state, `content-sidebar.js` isolates local sidebar replacement, `content-composer.js` isolates composer loading plus modal/search behavior, and `content-runtime.js` isolates app availability, auto-send toggle coordination, and Save local injection from the bootstrap coordinator.

### Electron shell

`electron/main.js` starts the same Express server on `127.0.0.1`, stores user data in Electron's app data directory, and opens the local UI in a sandboxed BrowserWindow. `electron/security.js` isolates navigation/external-link policy from Electron APIs so it can be unit-tested, while `electron/server-lifecycle.js` coordinates graceful HTTP shutdown before the app exits. Renderer-created child windows are denied, top-level navigation is limited to the local app document, and only allowlisted external URL schemes are delegated to the operating system.

## Storage layout

```text
data/
  .session-index.json     # derived summary/Bloom search index; safe to delete and rebuild
  .mutation-journal.json  # present only while a recoverable multi-file mutation is in progress
  extension-auth.json     # paired extension IDs and SHA-256 token hashes
  app-state.json
  folders.json
  YYYY-MM-DD/
    chat_<timestamp>_<random>.json
  trash/
    chat_<timestamp>_<random>.json
```

The format is intentionally inspectable and portable. Every chat file contains metadata and a `messages` array. A derived `.session-index.json` file stores only summary metadata, filesystem signatures, and a fixed-size Bloom search projection; canonical chat JSON remains authoritative, and a missing or malformed index is rebuilt. In-app file writes/deletes invalidate only the affected index entry, while periodic full reconciliation detects manual edits made outside the app. On macOS and Linux, the app creates data directories with mode `0700`, creates JSON and temporary files with mode `0600`, and tightens existing regular files during startup without following symlinks. Windows does not expose equivalent POSIX mode bits, so access remains governed by the user's Windows account and filesystem ACLs.

Multi-file mutations are serialized through a process-wide coordinator. Before changing more than one storage record, the server writes a small intent journal and flushes atomic file/directory metadata where supported. If the process stops after only part of a trash, restore, folder-delete, or permanent-delete workflow, startup replays the idempotent operation and removes the journal only after the intended state is complete. Corrupted journal data is rejected rather than discarded.

## Scaling and future directions

The largest structural blockers have now been reduced: the server has focused route/service/storage modules, the browser content script is split by responsibility, and the web UI uses native ES modules without global script ordering. The controller layer has also been split by domain under `public/app/controllers/`, while `controllers.mjs` remains a small composition root.

Large-archive listing and search use the derived session index, including dirty-entry invalidation, Bloom-filter candidate pruning, offset pagination, and revision-based conditional responses. `/api/sessions` preserves its legacy unpaginated body when no page parameters are supplied; newer callers can request bounded windows without changing the array response type. Search walks sorted Bloom candidates and stops after the requested exact-match page plus one look-ahead result. Session-index revisions back process-local ETags, so unchanged extension/web refreshes can return `304` without repeating transcript-level search work. If archive sizes eventually justify a larger migration, SQLite/FTS can still be evaluated as an optional storage backend while retaining JSON import/export.

The current test suite covers large-archive index invalidation/search pruning, pagination/ETag revalidation and client cache invalidation, server API/storage behavior, crash-recovery injection for multi-file mutations, security boundaries, concurrent writes, idempotency, markdown rendering and code-block copying, the chat-search modal, message navigation and per-message hover actions, web UI API/render/controller/event seams, a browser-level jsdom flow through the real web UI runtime, native ES module entrypoint loading, extension background API calls, provider-adapter resolution, content-script DOM fixtures plus mutation-resistance and diagnostics for provider extraction/injection, manual clipboard/message extraction, autosave idempotency/dedupe behavior, sidebar fixture behavior, composer/load-past modal behavior, runtime behavior for auto-send toggles, local-app availability, Save local delegation, dependency-free Electron navigation/security/shutdown helpers, a packaged-Electron launch smoke test, web UI accessibility contracts, modal focus behavior, and browser-level accessibility assertions.

## Quality gates

The repo now has public-portfolio quality gates:

- ESLint flat config in `eslint.config.mjs` for Node, browser, WebExtension, CommonJS, and native ES module files.
- Prettier config in `.prettierrc.json` with `.prettierignore` for generated/runtime artifacts.
- `npm run verify` runs linting, format checks, syntax checks, unit/jsdom tests, the required web Playwright smoke test, the real browser-extension compaction E2E workflow, and a packaged-Electron launch smoke test built with `electron-builder --dir`.
- `e2e/playwright-smoke.mjs` starts the real local server against an isolated temporary data directory and drives the actual web UI in Chromium, including accessible-name/ARIA checks and modal focus containment/restoration.
- `e2e/compaction-workflow.mjs` loads the real Manifest V3 extension in an isolated Chromium profile, pairs it to an isolated server, and drives the compact/continue/export/render/lifecycle plus malformed-response and cancellation paths against a controlled ChatGPT fixture.
- The required smoke test fails when Chromium is unavailable and also rejects uncaught page errors, browser `console.error` messages, and failed network requests.
- `npm run test:smoke:optional` is available only for lightweight local development where a missing browser may be skipped.
- CI installs Chromium with Playwright and runs `xvfb-run -a npm run verify` on Linux so the packaged Electron smoke test has a display; it never uses the optional smoke command.
