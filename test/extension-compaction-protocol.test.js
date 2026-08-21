const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const protocol = require('../browser-extension/content-compaction');

function responseText(payload) {
  return [protocol.RESPONSE_START, JSON.stringify(payload), protocol.RESPONSE_END].join('\n');
}

function legacyResponseText(payload) {
  return [protocol.LEGACY_RESPONSE_START, JSON.stringify(payload), protocol.LEGACY_RESPONSE_END].join('\n');
}

test('builds a neutral provider handoff request with a stable request ID', () => {
  const requestId = protocol.createCompactionRequestId({
    now: () => 1_700_000_000_000,
    randomToken: () => 'deadbeefcafebabe'
  });
  const prompt = protocol.buildCompactionPrompt({ requestId });

  assert.equal(requestId, 'handoff:req:loyw3v28:deadbeefcafebabe');
  assert.match(prompt, /LOCAL_CHAT_HANDOFF_REQUEST_V1/);
  assert.match(prompt, /LOCAL_CHAT_HANDOFF_RESPONSE_V1/);
  assert.match(prompt, new RegExp(requestId.replaceAll(':', '\\:')));
  assert.match(prompt, /browser-extension data export request/i);
  assert.match(prompt, /do not include hidden reasoning/i);
  assert.doesNotMatch(prompt, /\bcompaction\b/i);
  assert.doesNotMatch(prompt, /compact continuation context/i);
  assert.doesNotMatch(prompt, /conversation state/i);
  assert.equal(protocol.isCompactionRequestText(prompt), true);
  assert.equal(protocol.isCompactionResponseText(prompt), false);
});

test('parses the current handoff envelope into normalized compaction data', () => {
  const requestId = 'handoff:req:parse-001';
  const compactedMessage = [
    '# Handoff snapshot',
    '- Goal: keep the local archive release-ready.',
    '- Next action: add the handoff workflow.'
  ].join('\n');
  const parsed = protocol.parseCompactionResponse(
    responseText({
      protocol: protocol.COMPACTION_PROTOCOL,
      version: protocol.COMPACTION_PROTOCOL_VERSION,
      requestId,
      handoffMessage: compactedMessage
    }),
    { expectedRequestId: requestId }
  );

  assert.deepEqual(parsed, {
    protocol: 'local-chat-handoff',
    version: 1,
    requestId,
    compactedMessage,
    responseFormat: 'structured'
  });
  assert.equal(
    protocol.isCompactionResponseText(
      responseText({
        protocol: protocol.COMPACTION_PROTOCOL,
        version: 1,
        requestId,
        handoffMessage: compactedMessage
      })
    ),
    true
  );
});

test('accepts legacy structured compaction envelopes for compatibility', () => {
  const requestId = 'compact:req:legacy-001';
  const parsed = protocol.parseCompactionResponse(
    legacyResponseText({
      protocol: protocol.LEGACY_COMPACTION_PROTOCOL,
      version: protocol.COMPACTION_PROTOCOL_VERSION,
      requestId,
      compactedMessage: 'Legacy durable context.'
    }),
    { expectedRequestId: requestId }
  );

  assert.deepEqual(parsed, {
    protocol: 'local-chat-handoff',
    version: 1,
    requestId,
    compactedMessage: 'Legacy durable context.',
    responseFormat: 'legacy-structured'
  });
  assert.equal(protocol.isCompactionRequestText(`${protocol.LEGACY_REQUEST_START}\nlegacy`), true);
  assert.equal(
    protocol.isCompactionResponseText(
      legacyResponseText({
        protocol: protocol.LEGACY_COMPACTION_PROTOCOL,
        version: 1,
        requestId,
        compactedMessage: 'Legacy durable context.'
      })
    ),
    true
  );
});

test('uses a completed plain assistant reply as an exact-request fallback', () => {
  const requestId = 'handoff:req:plain-001';
  const plain =
    'Conversation state: Preserve the Local Chat App project goal, the verified fixes, and the next pending action.';

  assert.deepEqual(protocol.parseCompactionResponseOrPlainText(plain, { expectedRequestId: requestId }), {
    protocol: 'local-chat-handoff',
    version: 1,
    requestId,
    compactedMessage: plain,
    responseFormat: 'plain-text-fallback'
  });
});

test('rejects mismatched, malformed, ambiguous, or conversational structured responses', () => {
  const requestId = 'handoff:req:reject-001';
  const valid = {
    protocol: protocol.COMPACTION_PROTOCOL,
    version: protocol.COMPACTION_PROTOCOL_VERSION,
    requestId,
    handoffMessage: 'Durable handoff snapshot.'
  };

  assert.throws(
    () =>
      protocol.parseCompactionResponse(responseText(valid), {
        expectedRequestId: 'handoff:req:other-001'
      }),
    /does not match/i
  );
  assert.throws(
    () => protocol.parseCompactionResponse(`${protocol.RESPONSE_START}\nnot-json\n${protocol.RESPONSE_END}`),
    /invalid JSON/i
  );
  assert.throws(
    () => protocol.parseCompactionResponse(`Here you go.\n${responseText(valid)}`),
    /outside the protocol envelope/i
  );
  assert.throws(
    () => protocol.parseCompactionResponse(`${responseText(valid)}\n${responseText(valid)}`),
    /multiple protocol envelopes/i
  );
  assert.throws(
    () => protocol.parseCompactionResponse(responseText({ ...valid, version: 2 })),
    /unsupported protocol version/i
  );
  assert.throws(() => protocol.parseCompactionResponse(responseText({ ...valid, handoffMessage: '   ' })), /empty/i);
  assert.throws(
    () =>
      protocol.parseCompactionResponseOrPlainText(
        [protocol.RESPONSE_START, '{bad json', protocol.RESPONSE_END].join('\n'),
        { expectedRequestId: requestId }
      ),
    /invalid JSON/i
  );
});

test('converts normalized provider output into the server compaction payload', () => {
  const response = {
    protocol: protocol.COMPACTION_PROTOCOL,
    version: protocol.COMPACTION_PROTOCOL_VERSION,
    requestId: 'handoff:req:payload-001',
    compactedMessage: 'Keep this exact handoff snapshot.',
    responseFormat: 'plain-text-fallback'
  };

  assert.deepEqual(protocol.compactionApiPayload(response, 'chatgpt'), {
    requestId: 'handoff:req:payload-001',
    compactedMessage: 'Keep this exact handoff snapshot.',
    providerKey: 'chatgpt'
  });
});

test('extension manifest loads the compaction protocol before autosave and bootstrap code', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'manifest.json'), 'utf8')
  );
  const scripts = manifest.content_scripts[0].js;
  const compactionIndex = scripts.indexOf('content-compaction.js');
  const autosaveIndex = scripts.indexOf('content-autosave.js');
  const bootstrapIndex = scripts.indexOf('content.js');

  assert.ok(compactionIndex >= 0);
  assert.ok(autosaveIndex > compactionIndex);
  assert.ok(bootstrapIndex > compactionIndex);
});
