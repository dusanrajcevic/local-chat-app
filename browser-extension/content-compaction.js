(function exposeLocalChatContentCompaction(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentCompaction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentCompaction() {
  'use strict';

  // The provider-facing protocol intentionally uses "handoff" terminology. The
  // local app still stores the result as a compaction, but provider prompts must
  // not resemble provider-internal conversation compaction/state instructions.
  const COMPACTION_PROTOCOL = 'local-chat-handoff';
  const LEGACY_COMPACTION_PROTOCOL = 'local-chat-compaction';
  const COMPACTION_PROTOCOL_VERSION = 1;
  const COMPACTION_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,160}$/;
  const REQUEST_START = '<<<LOCAL_CHAT_HANDOFF_REQUEST_V1>>>';
  const REQUEST_END = '<<<END_LOCAL_CHAT_HANDOFF_REQUEST_V1>>>';
  const RESPONSE_START = '<<<LOCAL_CHAT_HANDOFF_RESPONSE_V1>>>';
  const RESPONSE_END = '<<<END_LOCAL_CHAT_HANDOFF_RESPONSE_V1>>>';
  const LEGACY_REQUEST_START = '<<<LOCAL_CHAT_COMPACTION_REQUEST_V1>>>';
  const LEGACY_REQUEST_END = '<<<END_LOCAL_CHAT_COMPACTION_REQUEST_V1>>>';
  const LEGACY_RESPONSE_START = '<<<LOCAL_CHAT_COMPACTION_RESPONSE_V1>>>';
  const LEGACY_RESPONSE_END = '<<<END_LOCAL_CHAT_COMPACTION_RESPONSE_V1>>>';
  const MAX_COMPACTED_MESSAGE_LENGTH = 2_000_000;

  function normalizeRequestId(value) {
    const requestId = String(value || '').trim();
    if (!COMPACTION_REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error('Compaction request ID is invalid.');
    }
    return requestId;
  }

  function normalizeCompactedMessage(value, label = 'Compaction response') {
    if (typeof value !== 'string') {
      throw new Error(`${label} message must be a string.`);
    }

    const compactedMessage = value.trim();
    if (!compactedMessage) throw new Error(`${label} is empty.`);
    if (compactedMessage.length > MAX_COMPACTED_MESSAGE_LENGTH) {
      throw new Error(`${label} is too long.`);
    }
    return compactedMessage;
  }

  function randomToken() {
    const values = new Uint32Array(2);
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.getRandomValues) {
      cryptoApi.getRandomValues(values);
      return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('');
    }

    return `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`.slice(0, 16).padEnd(16, '0');
  }

  function createCompactionRequestId(options = {}) {
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const token = typeof options.randomToken === 'function' ? options.randomToken() : randomToken();
    return normalizeRequestId(`handoff:req:${Number(now).toString(36)}:${String(token).replace(/[^a-zA-Z0-9]/g, '')}`);
  }

  function buildCompactionPrompt({ requestId } = {}) {
    const safeRequestId = normalizeRequestId(requestId);
    const responseShape = JSON.stringify({
      protocol: COMPACTION_PROTOCOL,
      version: COMPACTION_PROTOCOL_VERSION,
      requestId: safeRequestId,
      handoffMessage: '<JSON-escaped Local Chat handoff snapshot>'
    });

    return [
      REQUEST_START,
      'This is a browser-extension data export request for Local Chat.',
      '',
      'Read the user-visible conversation above and create a concise handoff snapshot that another chat can use to resume',
      "the user's work accurately.",
      '',
      'Preserve durable information that would matter when resuming the work, including:',
      "- the user's goals, preferences, constraints, and decisions;",
      '- important facts, names, IDs, paths, commands, code details, and exact values that still matter;',
      '- work already completed and its verified result;',
      '- unresolved issues, pending decisions, and the next intended action;',
      '- corrections or superseded assumptions when they affect future work.',
      '',
      'Do not continue the task, answer a pending question, or add conversational commentary.',
      'Do not describe this request, mention provider-internal behavior, or add anything except the requested handoff',
      'snapshot.',
      'Do not include hidden reasoning.',
      '',
      'Return only the machine-readable envelope below.',
      `The response must start with exactly: ${RESPONSE_START}`,
      `The response must end with exactly: ${RESPONSE_END}`,
      'Between those markers, output exactly one valid JSON object on any number of lines.',
      `Use this exact protocol/version/requestId: ${responseShape}`,
      'Replace only the handoffMessage placeholder. handoffMessage must be a single JSON string containing the complete',
      'Local Chat handoff snapshot.',
      'Do not wrap the JSON in Markdown fences and do not write anything before or after the protocol markers.',
      REQUEST_END
    ].join('\n');
  }

  function responseEnvelopeMarkers(source) {
    const text = String(source || '');
    const hasCurrentStart = text.includes(RESPONSE_START);
    const hasCurrentEnd = text.includes(RESPONSE_END);
    const hasLegacyStart = text.includes(LEGACY_RESPONSE_START);
    const hasLegacyEnd = text.includes(LEGACY_RESPONSE_END);

    if ((hasCurrentStart || hasCurrentEnd) && (hasLegacyStart || hasLegacyEnd)) {
      throw new Error('Compaction response mixes multiple protocol envelope versions.');
    }
    if (hasCurrentStart || hasCurrentEnd) {
      return { start: RESPONSE_START, end: RESPONSE_END, legacy: false };
    }
    if (hasLegacyStart || hasLegacyEnd) {
      return { start: LEGACY_RESPONSE_START, end: LEGACY_RESPONSE_END, legacy: true };
    }
    return null;
  }

  function findSingleResponseEnvelope(text) {
    const source = String(text || '');
    const markers = responseEnvelopeMarkers(source);
    if (!markers) throw new Error('Compaction response marker was not found.');

    const start = source.indexOf(markers.start);
    if (start < 0) throw new Error('Compaction response marker was not found.');

    const secondStart = source.indexOf(markers.start, start + markers.start.length);
    if (secondStart >= 0) throw new Error('Compaction response contains multiple protocol envelopes.');

    const payloadStart = start + markers.start.length;
    const end = source.indexOf(markers.end, payloadStart);
    if (end < 0) throw new Error('Compaction response end marker was not found.');

    const secondEnd = source.indexOf(markers.end, end + markers.end.length);
    if (secondEnd >= 0) throw new Error('Compaction response contains multiple protocol envelopes.');

    if (source.slice(0, start).trim() || source.slice(end + markers.end.length).trim()) {
      throw new Error('Compaction response contains text outside the protocol envelope.');
    }

    return {
      payloadText: source.slice(payloadStart, end).trim(),
      legacy: markers.legacy
    };
  }

  function parseCompactionResponse(text, { expectedRequestId } = {}) {
    const envelope = findSingleResponseEnvelope(text);
    let payload;
    try {
      payload = JSON.parse(envelope.payloadText);
    } catch (error) {
      throw new Error('Compaction response contains invalid JSON.', { cause: error });
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Compaction response payload must be a JSON object.');
    }

    const expectedProtocol = envelope.legacy ? LEGACY_COMPACTION_PROTOCOL : COMPACTION_PROTOCOL;
    if (payload.protocol !== expectedProtocol) {
      throw new Error('Compaction response uses an unsupported protocol.');
    }
    if (payload.version !== COMPACTION_PROTOCOL_VERSION) {
      throw new Error('Compaction response uses an unsupported protocol version.');
    }

    const requestId = normalizeRequestId(payload.requestId);
    if (expectedRequestId && requestId !== normalizeRequestId(expectedRequestId)) {
      throw new Error('Compaction response does not match the active request.');
    }

    const message = envelope.legacy ? payload.compactedMessage : payload.handoffMessage;
    const compactedMessage = normalizeCompactedMessage(message);

    return {
      protocol: COMPACTION_PROTOCOL,
      version: COMPACTION_PROTOCOL_VERSION,
      requestId,
      compactedMessage,
      responseFormat: envelope.legacy ? 'legacy-structured' : 'structured'
    };
  }

  function parseCompactionResponseOrPlainText(text, { expectedRequestId } = {}) {
    const source = String(text || '').trim();
    if (!source) throw new Error('Compaction response is empty.');

    if (responseEnvelopeMarkers(source)) {
      return parseCompactionResponse(source, { expectedRequestId });
    }

    const requestId = normalizeRequestId(expectedRequestId);
    if (isCompactionRequestText(source)) {
      throw new Error('Provider echoed the Local Chat handoff request instead of returning a handoff snapshot.');
    }

    return {
      protocol: COMPACTION_PROTOCOL,
      version: COMPACTION_PROTOCOL_VERSION,
      requestId,
      compactedMessage: normalizeCompactedMessage(source, 'Provider handoff response'),
      responseFormat: 'plain-text-fallback'
    };
  }

  function isCompactionRequestText(text) {
    const source = String(text || '').trimStart();
    return source.startsWith(REQUEST_START) || source.startsWith(LEGACY_REQUEST_START);
  }

  function isCompactionResponseText(text) {
    const source = String(text || '').trimStart();
    return source.startsWith(RESPONSE_START) || source.startsWith(LEGACY_RESPONSE_START);
  }

  function compactionApiPayload(response, providerKey = '') {
    if (!response || typeof response !== 'object') throw new Error('Compaction response is required.');
    if (response.protocol !== COMPACTION_PROTOCOL) {
      throw new Error('Compaction response uses an unsupported protocol.');
    }
    if (response.version !== COMPACTION_PROTOCOL_VERSION) {
      throw new Error('Compaction response uses an unsupported protocol version.');
    }

    const requestId = normalizeRequestId(response.requestId);
    const compactedMessage = normalizeCompactedMessage(response.compactedMessage);

    return {
      requestId,
      compactedMessage,
      providerKey: String(providerKey || '').trim()
    };
  }

  return {
    COMPACTION_PROTOCOL,
    LEGACY_COMPACTION_PROTOCOL,
    COMPACTION_PROTOCOL_VERSION,
    COMPACTION_REQUEST_ID_PATTERN,
    REQUEST_START,
    REQUEST_END,
    RESPONSE_START,
    RESPONSE_END,
    LEGACY_REQUEST_START,
    LEGACY_REQUEST_END,
    LEGACY_RESPONSE_START,
    LEGACY_RESPONSE_END,
    MAX_COMPACTED_MESSAGE_LENGTH,
    createCompactionRequestId,
    buildCompactionPrompt,
    parseCompactionResponse,
    parseCompactionResponseOrPlainText,
    isCompactionRequestText,
    isCompactionResponseText,
    compactionApiPayload
  };
});
