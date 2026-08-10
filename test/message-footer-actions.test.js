const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function createView({ trashed = false } = {}) {
  const { createRenderer } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'app', 'render.mjs')).href
  );

  return createRenderer({
    state: {
      currentSession: {
        trashed
      }
    },
    el: {},
    storage: null
  });
}

test('message footer actions render only copy, edit, and delete icon controls', async () => {
  const view = await createView();
  const html = view.renderMessageFooterActions({ id: 'message_1' });

  assert.match(html, /class="message-footer-actions"/);
  assert.match(html, /data-copy-message="message_1"/);
  assert.match(html, /data-edit-message="message_1"/);
  assert.match(html, /data-delete-message="message_1"/);
  assert.match(html, /data-tooltip="Copy markdown"/);
  assert.match(html, /data-tooltip="Edit"/);
  assert.match(html, /data-tooltip="Delete"/);
  assert.match(html, /message-action-copy-svg/);
  assert.match(html, /message-action-check-svg/);
  assert.equal((html.match(/class="message-action-icon/g) || []).length, 3);
  assert.doesNotMatch(html, /Like|Dislike|Regenerate|Share|More/);
});

test('top message actions remain text controls', async () => {
  const view = await createView();
  const html = view.renderMessageActions({ id: 'message_2' });

  assert.match(html, />Copy Markdown<\/button>/);
  assert.match(html, />Edit<\/button>/);
  assert.match(html, />Delete<\/button>/);
});

test('trashed messages remain read-only while keeping the bottom copy action', async () => {
  const view = await createView({ trashed: true });
  const html = view.renderMessageFooterActions({ id: 'message_3' });

  assert.match(html, /data-copy-message="message_3"/);
  assert.doesNotMatch(html, /data-edit-message=/);
  assert.doesNotMatch(html, /data-delete-message=/);
  assert.equal((html.match(/class="message-action-icon/g) || []).length, 1);
});

test('message quick-action hit area bridges the message and icon row', () => {
  const fs = require('node:fs');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const footerRule = css.match(/\.message-footer-actions\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(footerRule, /position\s*:\s*absolute/i);
  assert.match(footerRule, /(?:^|\n)\s*top\s*:\s*100%/i);
  assert.match(footerRule, /min-height\s*:\s*35px/i);
  assert.match(footerRule, /padding-top\s*:\s*3px/i);
  assert.doesNotMatch(footerRule, /top\s*:\s*calc\(100%\s*\+\s*3px\)/i);
});
