(function exposeLocalChatContentCompaction(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentCompaction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentCompaction() {
  'use strict';

  const COMPACTION_PROTOCOL = 'local-chat-compaction';
  const COMPACTION_PROTOCOL_VERSION = 1;
  const COMPACTION_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,160}$/;
  const REQUEST_START = '<<<LOCAL_CHAT_COMPACTION_REQUEST_V1>>>';
  const REQUEST_END = '<<<END_LOCAL_CHAT_COMPACTION_REQUEST_V1>>>';
  const RESPONSE_START = '<<<LOCAL_CHAT_COMPACTION_RESPONSE_V1>>>';
  const RESPONSE_END = '<<<END_LOCAL_CHAT_COMPACTION_RESPONSE_V1>>>';
  const MAX_COMPACTED_MESSAGE_LENGTH = 2_000_000;

  function normalizeRequestId(value) {
    const requestId = String(value || '').trim();
    if (!COMPACTION_REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error('Compaction request ID is invalid.');
    }
    return requestId;
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
    return normalizeRequestId(`compact:req:${Number(now).toString(36)}:${String(token).replace(/[^a-zA-Z0-9]/g, '')}`);
  }

  function buildCompactionPrompt({ requestId } = {}) {
    const safeRequestId = normalizeRequestId(requestId);
    const responseShape = JSON.stringify({
      protocol: COMPACTION_PROTOCOL,
      version: COMPACTION_PROTOCOL_VERSION,
      requestId: safeRequestId,
      compactedMessage: '<JSON-escaped compact continuation context>'
    });

    return [
      REQUEST_START,
      'Create a compact continuation context for the conversation up to this point.',
      '',
      'The context will replace the earlier turns when this conversation is continued later. Preserve durable information that is needed to continue accurately, including:',
      "- the user's goals, preferences, constraints, and decisions;",
      '- important facts, names, IDs, paths, commands, code details, and exact values that still matter;',
      '- work already completed and its verified result;',
      '- unresolved issues, pending decisions, and the next intended action;',
      '- corrections or superseded assumptions when they affect future work.',
      '',
      'Do not continue the task, answer a pending question, or add conversational commentary. Do not include hidden reasoning. Produce only the structured response below.',
      '',
      `The response must start with exactly: ${RESPONSE_START}`,
      `The response must end with exactly: ${RESPONSE_END}`,
      'Between those markers, output exactly one valid JSON object on any number of lines.',
      `Use this exact protocol/version/requestId: ${responseShape}`,
      'Replace only the compactedMessage placeholder. compactedMessage must be a single JSON string containing the complete compact continuation context.',
      'Do not wrap the JSON in Markdown fences and do not write anything before or after the protocol markers.',
      REQUEST_END
    ].join('\n');
  }

  function findSingleResponseEnvelope(text) {
    const source = String(text || '');
    const start = source.indexOf(RESPONSE_START);
    if (start < 0) throw new Error('Compaction response marker was not found.');

    const secondStart = source.indexOf(RESPONSE_START, start + RESPONSE_START.length);
    if (secondStart >= 0) throw new Error('Compaction response contains multiple protocol envelopes.');

    const payloadStart = start + RESPONSE_START.length;
    const end = source.indexOf(RESPONSE_END, payloadStart);
    if (end < 0) throw new Error('Compaction response end marker was not found.');

    const secondEnd = source.indexOf(RESPONSE_END, end + RESPONSE_END.length);
    if (secondEnd >= 0) throw new Error('Compaction response contains multiple protocol envelopes.');

    if (source.slice(0, start).trim() || source.slice(end + RESPONSE_END.length).trim()) {
      throw new Error('Compaction response contains text outside the protocol envelope.');
    }

    return source.slice(payloadStart, end).trim();
  }

  function parseCompactionResponse(text, { expectedRequestId } = {}) {
    const payloadText = findSingleResponseEnvelope(text);
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch (error) {
      throw new Error('Compaction response contains invalid JSON.', { cause: error });
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Compaction response payload must be a JSON object.');
    }
    if (payload.protocol !== COMPACTION_PROTOCOL) {
      throw new Error('Compaction response uses an unsupported protocol.');
    }
    if (payload.version !== COMPACTION_PROTOCOL_VERSION) {
      throw new Error('Compaction response uses an unsupported protocol version.');
    }

    const requestId = normalizeRequestId(payload.requestId);
    if (expectedRequestId && requestId !== normalizeRequestId(expectedRequestId)) {
      throw new Error('Compaction response does not match the active request.');
    }
    if (typeof payload.compactedMessage !== 'string') {
      throw new Error('Compaction response compactedMessage must be a string.');
    }

    const compactedMessage = payload.compactedMessage.trim();
    if (!compactedMessage) throw new Error('Compaction response is empty.');
    if (compactedMessage.length > MAX_COMPACTED_MESSAGE_LENGTH) {
      throw new Error('Compaction response is too long.');
    }

    return {
      protocol: COMPACTION_PROTOCOL,
      version: COMPACTION_PROTOCOL_VERSION,
      requestId,
      compactedMessage
    };
  }

  function isCompactionRequestText(text) {
    return String(text || '')
      .trimStart()
      .startsWith(REQUEST_START);
  }

  function isCompactionResponseText(text) {
    return String(text || '')
      .trimStart()
      .startsWith(RESPONSE_START);
  }

  function compactionApiPayload(response, providerKey = '') {
    if (!response || typeof response !== 'object') throw new Error('Compaction response is required.');
    const parsed = parseCompactionResponse(`${RESPONSE_START}\n${JSON.stringify(response)}\n${RESPONSE_END}`, {
      expectedRequestId: response.requestId
    });

    return {
      requestId: parsed.requestId,
      compactedMessage: parsed.compactedMessage,
      providerKey: String(providerKey || '').trim()
    };
  }

  return {
    COMPACTION_PROTOCOL,
    COMPACTION_PROTOCOL_VERSION,
    COMPACTION_REQUEST_ID_PATTERN,
    REQUEST_START,
    REQUEST_END,
    RESPONSE_START,
    RESPONSE_END,
    MAX_COMPACTED_MESSAGE_LENGTH,
    createCompactionRequestId,
    buildCompactionPrompt,
    parseCompactionResponse,
    isCompactionRequestText,
    isCompactionResponseText,
    compactionApiPayload
  };
});
