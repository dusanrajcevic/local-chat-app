# API Overview

All endpoints are served from the local Express server.

## Health

`GET /api/health`

Returns `{ ok: true, authRequired: true, manualTokenConfigured: boolean }`. Browser-extension API requests require either a valid pairing token or the configured manual fallback token; same-origin local-app requests do not.

## Browser extension pairing

- `POST /api/extension/pairing-code` with `{}` creates a short-lived pairing code. This endpoint is available only to the local app origin.
- `POST /api/extension/pair` with `{ "code": "..." }` exchanges a valid code for a long-lived extension token. The request must come from a `chrome-extension://` origin and its `X-Local-Chat-Extension-Id` header must match that origin.

Paired tokens are bound to the extension ID. The server persists only a SHA-256 token hash in `extension-auth.json`; the raw token is returned once to the extension. All subsequent extension API requests include `X-Local-Chat-Extension-Id` and `X-Local-Chat-Token`. A pairing code expires after five minutes and is consumed after a successful exchange.

`LOCAL_CHAT_AUTH_TOKEN` remains a manual fallback. `LOCAL_CHAT_EXTENSION_IDS` may contain a comma-separated allowlist of extension IDs; when configured, other extension origins are rejected before pairing or token authorization.

## Active session

- `GET /api/active-session`
- `PUT /api/active-session` with `{ "sessionId": "chat_..." }`
- `DELETE /api/active-session`

The browser extension uses this to determine where manual saves should go when no explicit target session is supplied.

## Sessions

- `GET /api/sessions`
- `GET /api/sessions?offset=0&limit=100` for optional pagination
- `POST /api/sessions`
- `PUT /api/sessions/:sessionId/compaction`
- `GET /api/sessions/:sessionId`
- `PATCH /api/sessions/:sessionId`
- `PATCH /api/sessions/:sessionId/bot-name` with `{ "aiName": "..." }`
- `DELETE /api/sessions/:sessionId`
- `GET /api/sessions/:sessionId/export`
- `PATCH /api/sessions/:sessionId/pin`

`PUT /api/sessions/:sessionId/compaction` accepts a JSON object with `requestId`, `compactedMessage`, and an optional `providerKey`. The server derives the compaction boundary from the parent session's current stored messages, creates `Title (compacted)` on the first request, and reuses that same compacted child for later requests. The endpoint may be called with either the normal parent ID or its compacted child ID. Repeating the same `requestId` with the same content is idempotent; reusing it with different content returns `409 Conflict`. A new compaction replaces the child's previous compacted context and clears its ordinary messages because those messages are considered absorbed by the new context. The original parent transcript is not modified.

Compacted sessions share lifecycle metadata with their normal parent. Renaming the parent automatically derives the child's `Title (compacted)` name; the child cannot be renamed independently. AI-name and folder-pin changes made through either member are synchronized to both records. Trashing the parent moves the pair together and restoring either member of that paired trash state restores both. Trashing only the compacted child detaches it by clearing the parent's `compactedSessionId`, allowing a later compaction to create a replacement; restoring the detached child reattaches it only when the parent has not already acquired another compacted child. Permanently deleting a trashed parent deletes its paired compacted child, while deleting a detached child clears any remaining parent reference. These multi-file lifecycle updates use the recovery journal so an interrupted operation is replayed on startup.

`GET /api/sessions/:sessionId/export` keeps normal-session exports as the complete archival transcript. For a compacted session, continuation export uses the stored `compaction.text` as the historical context and then appends only that compacted session's post-compaction messages. This is the text used by the browser extension's Load past conversation flow, so continuing from a compacted child carries forward the condensed history without repasting messages already represented by the compaction.

## Messages

- `POST /api/sessions/:sessionId/messages`
- `PATCH /api/sessions/:sessionId/messages/:messageId`
- `DELETE /api/sessions/:sessionId/messages/:messageId`

`POST /messages` accepts an optional `Idempotency-Key` header or `idempotencyKey` body field. The key is bound to the normalized message request (`text`, requested `sender`, `source`, and `providerKey`). An identical retry returns the existing message instead of appending a duplicate; reusing the key with different normalized content returns `409 Conflict`.

## Folders

- `GET /api/folders`
- `POST /api/folders`
- `PATCH /api/folders/:folderId`
- `DELETE /api/folders/:folderId`

## Search and recent chats

- `GET /api/recent-chats?limit=100&offset=0`
- `GET /api/search-chats?q=query&limit=100&offset=0`

Collection pagination is offset-based. `limit` is clamped to 500 for recent/search endpoints and 1000 for `/api/sessions`. Calling `GET /api/sessions` without either `limit` or `offset` preserves the legacy behavior and returns the complete session array. Paginated session/recent responses remain arrays and publish metadata through `X-Total-Count`, `X-Page-Offset`, `X-Page-Limit`, `X-Has-More`, and RFC-style `Link` headers. Search keeps its existing object response and adds `offset`, `limit`, `hasMore`, and `nextOffset`; an empty-query search also includes `total`.

Session/recent/search responses include an `ETag` and `Cache-Control: private, no-cache, must-revalidate`. Clients may send `If-None-Match`; when the derived session index revision and request window are unchanged, the server returns `304 Not Modified` before doing transcript-level search work. Browser-extension CORS explicitly allows `If-None-Match` and exposes the pagination/ETag response headers.

## Trash

- `GET /api/trash`
- `POST /api/trash/:sessionId/restore`
- `DELETE /api/trash/:sessionId`

## Request body contract

Routes that accept a request body require `Content-Type: application/json` (or an `application/*+json` media type) and a top-level JSON object. Missing or unsupported content types return `415`. Empty, malformed, or non-object JSON bodies return `400`, and payloads over `LOCAL_CHAT_JSON_LIMIT` return `413`.

String fields are type-checked before whitespace normalization. Arrays, objects, numbers, and booleans are rejected rather than being converted with JavaScript string coercion.

## Validation and consistency notes

- Route IDs must match the generated `chat_...`, `msg_...`, or `folder_...` formats. Invalid IDs return `400` before any file path is touched.
- `pinnedFolderId` is optional, but when provided it must refer to an existing folder. Missing folders return `404`.
- Message bodies require non-empty `text`.
- Search and recent endpoints clamp large `limit` values to keep local requests bounded. Paginated search reads exact candidate transcripts only until it fills the requested offset/window plus one extra match needed to determine `hasMore`.
- Collection ETags are process-local validators derived from the session-index revision; restarting the server intentionally invalidates validators from the previous process.
