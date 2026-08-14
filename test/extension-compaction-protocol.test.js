const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const protocol = require('../browser-extension/content-compaction');

function responseText(payload) {
  return [protocol.RESPONSE_START, JSON.stringify(payload), protocol.RESPONSE_END].join('\n');
}

test('builds a versioned compaction request with a stable request ID', () => {
  const requestId = protocol.createCompactionRequestId({
    now: () => 1_700_000_000_000,
    randomToken: () => 'deadbeefcafebabe'
  });
  const prompt = protocol.buildCompactionPrompt({ requestId });

  assert.equal(requestId, 'compact:req:loyw3v28:deadbeefcafebabe');
  assert.match(prompt, /LOCAL_CHAT_COMPACTION_REQUEST_V1/);
  assert.match(prompt, /LOCAL_CHAT_COMPACTION_RESPONSE_V1/);
  assert.match(prompt, new RegExp(requestId.replaceAll(':', '\\:')));
  assert.match(prompt, /do not include hidden reasoning/i);
  assert.equal(protocol.isCompactionRequestText(prompt), true);
  assert.equal(protocol.isCompactionResponseText(prompt), false);
});

test('parses the exact response envelope and returns the compacted continuation context', () => {
  const requestId = 'compact:req:parse-001';
  const compactedMessage = [
    '# Continuation context',
    '- Goal: keep the local archive release-ready.',
    '- Next action: add the compaction workflow.'
  ].join('\n');
  const parsed = protocol.parseCompactionResponse(
    responseText({
      protocol: protocol.COMPACTION_PROTOCOL,
      version: protocol.COMPACTION_PROTOCOL_VERSION,
      requestId,
      compactedMessage
    }),
    { expectedRequestId: requestId }
  );

  assert.deepEqual(parsed, {
    protocol: 'local-chat-compaction',
    version: 1,
    requestId,
    compactedMessage
  });
  assert.equal(protocol.isCompactionResponseText(responseText(parsed)), true);
});

test('rejects mismatched, malformed, ambiguous, or conversational compaction responses', () => {
  const requestId = 'compact:req:reject-001';
  const valid = {
    protocol: protocol.COMPACTION_PROTOCOL,
    version: protocol.COMPACTION_PROTOCOL_VERSION,
    requestId,
    compactedMessage: 'Durable compact context.'
  };

  assert.throws(
    () =>
      protocol.parseCompactionResponse(responseText(valid), {
        expectedRequestId: 'compact:req:other-001'
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
  assert.throws(
    () => protocol.parseCompactionResponse(responseText({ ...valid, compactedMessage: '   ' })),
    /empty/i
  );
});

test('converts a validated structured response into the server compaction payload', () => {
  const response = {
    protocol: protocol.COMPACTION_PROTOCOL,
    version: protocol.COMPACTION_PROTOCOL_VERSION,
    requestId: 'compact:req:payload-001',
    compactedMessage: 'Keep this exact compact context.'
  };

  assert.deepEqual(protocol.compactionApiPayload(response, 'chatgpt'), {
    requestId: 'compact:req:payload-001',
    compactedMessage: 'Keep this exact compact context.',
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
