# API Overview

All endpoints are served from the local Express server.

## Health

`GET /api/health`

Returns `{ ok: true, authRequired: boolean }`.

## Active session

- `GET /api/active-session`
- `PUT /api/active-session` with `{ "sessionId": "chat_..." }`
- `DELETE /api/active-session`

The browser extension uses this to determine where manual saves should go when no explicit target session is supplied.

## Sessions

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:sessionId`
- `PATCH /api/sessions/:sessionId`
- `DELETE /api/sessions/:sessionId`
- `GET /api/sessions/:sessionId/export`
- `PATCH /api/sessions/:sessionId/pin`

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

- `GET /api/recent-chats?limit=100`
- `GET /api/search-chats?q=query&limit=100`

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
- Search and recent endpoints clamp large `limit` values to keep local requests bounded.
