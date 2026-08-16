(function exposeLocalChatContentDom(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalChatContentDom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalChatContentDom() {
  'use strict';

  const EXT_MARKER = 'data-local-chat-save-button';
  const NEW_SESSION_MARKER = 'data-local-chat-new-session-button';
  const LOAD_PAST_MARKER = 'data-local-chat-load-past-button';
  const TOP_PIN_SELECT_MARKER = 'data-local-chat-top-pin-select';
  const AUTO_SEND_TOGGLE_MARKER = 'data-local-chat-auto-send-toggle';
  const AUTO_SEND_TOGGLE_MOUNT_MARKER = 'data-local-chat-auto-send-toggle-mount';
  const AUTO_SEND_COMPOSER_MARKER = 'data-local-chat-auto-send-composer';
  const AUTO_SEND_LAYOUT_MARKER = 'data-local-chat-auto-send-layout';
  const LOCAL_SIDEBAR_MARKER = 'data-local-chat-sidebar';
  const LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER = 'data-local-chat-native-sidebar-hidden';
  const LOAD_PAST_MODAL_ID = 'local-chat-load-past-modal';

  const LocalChatContentProviders = (() => {
    if (typeof require === 'function') return require('./content-providers');
    if (typeof globalThis !== 'undefined' && globalThis.LocalChatContentProviders)
      return globalThis.LocalChatContentProviders;
    throw new Error('LocalChatContentProviders must be loaded before content-dom.js');
  })();

  function currentProviderAdapter() {
    return LocalChatContentProviders.adapterForLocation(location);
  }

  function providerInfo() {
    return LocalChatContentProviders.providerInfoForLocation(location);
  }

  function matchesSelector(element, selector) {
    try {
      return Boolean(element?.matches?.(selector));
    } catch {
      return false;
    }
  }

  function matchesAny(element, selectors = []) {
    return selectors.some((selector) => matchesSelector(element, selector));
  }

  function querySelectorAny(element, selectors = []) {
    for (const selector of selectors) {
      try {
        const match = element?.querySelector?.(selector);
        if (match) return match;
      } catch {
        // Provider DOM changes should not break the whole content script.
      }
    }
    return null;
  }

  function hasDescendantMatching(element, selectors = []) {
    return Boolean(querySelectorAny(element, selectors));
  }

  function providerLabelText(element) {
    return [element?.getAttribute?.('aria-label'), element?.getAttribute?.('data-testid'), element?.className]
      .filter(Boolean)
      .join(' ')
      .toString()
      .toLowerCase();
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function hashText(value) {
    const input = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function buttonLabel(button) {
    return [
      button?.getAttribute?.('aria-label'),
      button?.getAttribute?.('title'),
      button?.getAttribute?.('data-testid'),
      button?.textContent
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function isCopyButton(button) {
    if (!button || button.nodeType !== Node.ELEMENT_NODE) return false;
    if (button.hasAttribute(EXT_MARKER)) return false;

    const label = [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.getAttribute('data-testid'),
      button.textContent
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (!/\b(copy|copied)\b/i.test(label)) return false;
    if (label.includes('copyright')) return false;

    const container = findMessageContainer(button);
    if (!container) return false;

    // Code blocks and rendered tables often expose their own small Copy buttons.
    // Those are not message-level actions, and using them can save partial content
    // while the assistant is still rendering.
    if (isNestedContentCopyButton(button, container)) return false;

    // Avoid browser/app-level copy buttons when they are not inside a chat turn.
    return true;
  }

  function isNestedContentCopyButton(button, container) {
    if (!button || !container) return true;

    const sender = inferSender(container);
    const messageBody = messageExtractionSource(container, sender);
    if (messageBody && messageBody !== container && messageBody.contains?.(button)) return true;

    const label = buttonLabel(button);
    if (/\bcopy\s+(code|table|csv|cell|row|column|snippet|block)\b/i.test(label)) return true;

    if (button.closest?.('pre, code, table, thead, tbody, tfoot, .cm-editor, .hljs')) return true;

    // Message-level copy buttons normally live in the turn action bar, outside the
    // markdown/prose body. Copy buttons inside these roots usually belong to code
    // fences, tables, or other rendered artifacts inside the assistant message.
    const markdownRoot = button.closest?.('.markdown, .prose');
    if (markdownRoot && container.contains(markdownRoot)) return true;

    // Some providers render code/table copy controls as siblings of the <pre> or
    // <table> inside a small wrapper instead of inside the rich element itself.
    let node = button.parentElement;
    let depth = 0;
    while (node && node !== container && node !== document.body && depth < 6) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const looksLikeRichWrapper = node.matches?.(
          [
            '[data-testid*="code" i]',
            '[data-testid*="table" i]',
            '[class*="code" i]',
            '[class*="table" i]',
            '[class*="highlight" i]',
            '[class*="overflow-x" i]'
          ].join(',')
        );

        const hasRichContent = Boolean(node.querySelector?.('pre, code, table'));
        const hasNestedTurn = Boolean(
          node.querySelector?.('[data-message-author-role], [data-testid^="conversation-turn"]')
        );

        if (hasRichContent && !hasNestedTurn && looksLikeRichWrapper) return true;
      }

      node = node.parentElement;
      depth += 1;
    }

    return false;
  }

  function closestMatching(element, selectors = []) {
    for (const selector of selectors) {
      try {
        const match = element?.closest?.(selector);
        if (match) return match;
      } catch {
        // Provider DOM changes should not break the whole content script.
      }
    }
    return null;
  }

  function nearbyMessageContainer(subtree, adapter, options = {}) {
    if (!subtree || subtree.nodeType !== Node.ELEMENT_NODE) return null;

    const allowTurnWithoutContentRoot = Boolean(options.allowTurnWithoutContentRoot);
    const hasEnoughText = normalizeText(subtree.innerText || subtree.textContent || '').length > 20;
    const hasContentRoot =
      matchesAny(subtree, adapter.contentSelectors) || hasDescendantMatching(subtree, adapter.contentSelectors);
    if (
      matchesAny(subtree, adapter.turnContainerSelectors) &&
      hasEnoughText &&
      (hasContentRoot || allowTurnWithoutContentRoot)
    )
      return subtree;

    for (const selector of adapter.turnContainerSelectors || []) {
      try {
        const turns = Array.from(subtree.querySelectorAll?.(selector) || []).filter((element) => {
          const text = normalizeText(element.innerText || element.textContent || '');
          return (
            text.length > 20 &&
            (allowTurnWithoutContentRoot ||
              matchesAny(element, adapter.contentSelectors) ||
              hasDescendantMatching(element, adapter.contentSelectors))
          );
        });
        if (turns.length) return turns[turns.length - 1];
      } catch {
        // Ignore invalid selectors from stale provider adapters.
      }
    }

    if (!hasContentRoot || !hasEnoughText) return null;

    const content = querySelectorAny(subtree, adapter.contentSelectors);
    if (!content) return matchesAny(subtree, adapter.contentSelectors) ? subtree : null;

    for (const selector of adapter.turnContainerSelectors || []) {
      try {
        const turn = content.closest?.(selector);
        if (turn && subtree.contains(turn)) return turn;
      } catch {
        // Ignore invalid selectors from stale provider adapters.
      }
    }

    return content;
  }

  function precedingTurnContainer(actionBar, adapter) {
    if (!actionBar || !adapter.turnContainerSelectors?.length) return null;

    const selectors = adapter.turnContainerSelectors.join(',');
    let turns = [];
    try {
      turns = Array.from(document.querySelectorAll(selectors));
    } catch {
      return null;
    }

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!turn || turn.contains?.(actionBar)) continue;

      const position = turn.compareDocumentPosition?.(actionBar) || 0;
      if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) continue;

      const text = normalizeText(turn.innerText || turn.textContent || '');
      if (text.length > 20) return turn;
    }

    return null;
  }

  function findMessageContainerForActionBar(startNode, adapter) {
    const actionBar = closestMatching(startNode, adapter.actionBarSelectors || []);
    if (!actionBar) return null;

    const containingTurn = closestMatching(actionBar, adapter.turnContainerSelectors || []);
    if (containingTurn && normalizeText(containingTurn.innerText || containingTurn.textContent || '').length > 20) {
      return containingTurn;
    }

    let branch = actionBar;
    let parent = actionBar.parentElement;
    let depth = 0;

    while (parent && parent !== document.body && depth < 8) {
      let sibling = branch.previousElementSibling;
      while (sibling) {
        const candidate = nearbyMessageContainer(sibling, adapter, { allowTurnWithoutContentRoot: true });
        if (candidate) return candidate;
        sibling = sibling.previousElementSibling;
      }

      branch = parent;
      parent = parent.parentElement;
      depth += 1;
    }

    return precedingTurnContainer(actionBar, adapter);
  }

  function isProviderActionBarControl(startNode) {
    const adapter = currentProviderAdapter();
    if (!adapter.actionBarCompletionSignal) return false;
    return Boolean(closestMatching(startNode, adapter.actionBarSelectors || []));
  }

  function providerActionBarSaveTargets() {
    const adapter = currentProviderAdapter();
    const actionBarSelectors = adapter.actionBarSelectors || [];
    const copySelectors = adapter.actionBarCopySelectors || [];
    if (!actionBarSelectors.length || !copySelectors.length) return [];

    const actionBars = uniqueElements(
      actionBarSelectors.flatMap((selector) => {
        try {
          return Array.from(document.querySelectorAll?.(selector) || []);
        } catch {
          return [];
        }
      })
    );

    return actionBars
      .map((actionBar) => {
        const copyButton = querySelectorAny(actionBar, copySelectors);
        if (!copyButton) return null;

        const container = findMessageContainerForActionBar(copyButton, adapter);
        if (!container) return null;

        return {
          container,
          copyButton,
          sender: inferSender(container)
        };
      })
      .filter(Boolean);
  }

  function findMessageContainer(startNode) {
    const adapter = currentProviderAdapter();
    const actionBarContainer = findMessageContainerForActionBar(startNode, adapter);
    if (actionBarContainer) return actionBarContainer;

    let node = startNode;
    let depth = 0;
    const candidates = [];

    while (node && node !== document.body && depth < 18) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        const hasTurnMarker = matchesAny(element, adapter.turnContainerSelectors);
        const hasAuthorRole = matchesAny(element, adapter.roleContainerSelectors);
        const hasMessageRole = hasDescendantMatching(element, adapter.roleContainerSelectors);
        const hasContentRoot = hasDescendantMatching(element, adapter.contentSelectors);
        const hasEnoughText = normalizeText(element.innerText || element.textContent || '').length > 20;

        if ((hasTurnMarker || hasAuthorRole || hasMessageRole || hasContentRoot) && hasEnoughText) {
          candidates.push(element);
        }
      }

      node = node.parentElement;
      depth += 1;
    }

    if (!candidates.length) return null;

    const selectedByProvider = pickProviderMessageContainer(candidates, adapter);
    if (selectedByProvider) return selectedByProvider;

    return candidates[candidates.length - 1];
  }

  function pickProviderMessageContainer(candidates, adapter) {
    for (const preference of adapter.containerPreference || []) {
      const matching = candidates.filter((element) => {
        if (preference.kind === 'single-role') return containerSenderRoles(element).length === 1;
        if (preference.kind === 'labeled') return isProviderLabeledMessageContainer(element, adapter);
        return matchesAny(element, preference.selectors || []);
      });

      if (matching.length) return preference.position === 'last' ? matching[matching.length - 1] : matching[0];
    }

    return null;
  }

  function isProviderLabeledMessageContainer(element, adapter = currentProviderAdapter()) {
    if (matchesSelector(element, 'main') || matchesSelector(element, '[role="main"]')) return false;
    const label = providerLabelText(element);
    return adapter.userLabelPattern.test(label) || adapter.assistantLabelPattern.test(label);
  }

  function selectionInside(container) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';

    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      const startInside = container.contains(range.startContainer);
      const endInside = container.contains(range.endContainer);
      if (startInside && endInside) return selection.toString().trim();
    }

    return '';
  }

  function removeUiNoise(clone) {
    clone
      .querySelectorAll(
        [
          'button',
          'svg',
          '[role="button"]',
          '[aria-label*="Copy" i]',
          '[aria-label*="Share" i]',
          '[aria-label*="Regenerate" i]',
          '[aria-label*="Like" i]',
          '[aria-label*="Dislike" i]',
          '[data-local-chat-save-button]',
          '[data-local-chat-new-session-button]',
          '[data-local-chat-load-past-button]',
          '[data-local-chat-auto-send-toggle]',
          '[data-local-chat-sidebar]',
          '#local-chat-load-past-modal'
        ].join(',')
      )
      .forEach((node) => node.remove());
  }

  function escapeMarkdownText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function textContentClean(node) {
    return normalizeText(node?.innerText || node?.textContent || '');
  }

  function markdownForInline(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const element = node;
    const tag = element.tagName.toLowerCase();
    const children = Array.from(element.childNodes).map(markdownForInline).join('');

    if (tag === 'code' && element.closest('pre')) return element.textContent || '';
    if (tag === 'code') return `\`${element.textContent || children}\``;
    if (tag === 'strong' || tag === 'b') return `**${children}**`;
    if (tag === 'em' || tag === 'i') return `*${children}*`;
    if (tag === 'del' || tag === 's') return `~~${children}~~`;
    if (tag === 'a') {
      const href = element.getAttribute('href');
      const label = escapeMarkdownText(children) || href || '';
      if (!href) return label;
      return `[${label}](${href})`;
    }
    if (tag === 'br') return '\n';

    return children;
  }

  function markdownForElement(element, listDepth = 0) {
    if (!element) return '';
    if (element.nodeType === Node.TEXT_NODE) return element.textContent || '';
    if (element.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = element.tagName.toLowerCase();

    if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'button') return '';

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return `${'#'.repeat(level)} ${escapeMarkdownText(markdownForInline(element))}`;
    }

    if (tag === 'pre') {
      const codeElement = element.querySelector('code');
      const languageClass = codeElement?.className?.match(/language-([\w-]+)/)?.[1] || '';
      const code = (codeElement?.innerText || element.innerText || '').replace(/\n+$/g, '');
      return `\`\`\`${languageClass}\n${code}\n\`\`\``;
    }

    if (tag === 'blockquote') {
      return markdownForChildren(element, listDepth)
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n');
    }

    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(element.children).filter((child) => child.tagName?.toLowerCase() === 'li');
      return items
        .map((li, index) => {
          const marker = tag === 'ol' ? `${index + 1}.` : '-';
          const indent = '  '.repeat(listDepth);
          const liClone = li.cloneNode(true);
          const nestedLists = Array.from(liClone.querySelectorAll(':scope > ul, :scope > ol'));
          nestedLists.forEach((nested) => nested.remove());
          const ownText = normalizeText(markdownForInline(liClone)).replace(/\n+/g, ' ');
          const nestedMarkdown = Array.from(li.children)
            .filter((child) => ['ul', 'ol'].includes(child.tagName?.toLowerCase()))
            .map((child) => markdownForElement(child, listDepth + 1))
            .filter(Boolean)
            .join('\n');
          return `${indent}${marker} ${ownText}${nestedMarkdown ? `\n${nestedMarkdown}` : ''}`;
        })
        .join('\n');
    }

    if (tag === 'li') return `- ${normalizeText(markdownForInline(element))}`;
    if (tag === 'hr') return '---';
    if (tag === 'p') return normalizeText(markdownForInline(element));
    if (tag === 'table') return tableToMarkdown(element);

    const blockTags = new Set(['div', 'section', 'article', 'main']);
    if (blockTags.has(tag)) return markdownForChildren(element, listDepth);

    return normalizeText(markdownForInline(element));
  }

  function markdownForChildren(element, listDepth = 0) {
    return Array.from(element.childNodes)
      .map((child) => markdownForElement(child, listDepth))
      .map((part) => normalizeText(part))
      .filter(Boolean)
      .join('\n\n');
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll('tr'))
      .map((row) => {
        return Array.from(row.querySelectorAll('th, td')).map((cell) => {
          return escapeMarkdownText(markdownForInline(cell)).replace(/\|/g, '\\|');
        });
      })
      .filter((row) => row.length);

    if (!rows.length) return textContentClean(table);

    const columnCount = Math.max(...rows.map((row) => row.length));
    const padded = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] || ''));
    const header = padded[0];
    const separator = Array.from({ length: columnCount }, () => '---');
    const body = padded.slice(1);

    return [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`).join('\n');
  }

  function messageExtractionSource(container, senderHint = null) {
    if (!container || container.nodeType !== Node.ELEMENT_NODE) return container;

    const adapter = currentProviderAdapter();
    const roleElement = messageRoleElement(container, senderHint);
    const root = roleElement || container;
    const preferred = querySelectorAny(root, adapter.contentSelectors);

    return preferred || root;
  }

  function isProviderTranscriptText(value) {
    const text = normalizeText(value);
    if (!text) return false;

    const hasYouSaid = /(^|\n)\s*#{0,6}\s*(you said|you)\s*:?\s*(\n|$)/i.test(text);
    const hasAiSaid = /(^|\n)\s*#{0,6}\s*(chatgpt said|assistant said|ai said)\s*:?\s*(\n|$)/i.test(text);
    if (hasYouSaid && hasAiSaid) return true;

    return /(^|\n)\s*#{1,6}\s*(you said|chatgpt said|assistant said)\s*:?\s*(\n|$)/i.test(text);
  }

  function isTransientAssistantStatusText(value) {
    const text = normalizeText(value).replace(/[.…]+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

    if (!text) return true;
    return /^(thinking|reasoning|analyzing|working|searching|loading|generating|starting|one moment|just a moment)$/.test(
      text
    );
  }

  function stripTransientAssistantStatusLines(value) {
    const lines = String(value || '')
      .replace(/\r\n?/g, '\n')
      .split('\n');

    while (lines.length && isTransientAssistantStatusText(lines[0])) {
      lines.shift();
      while (lines.length && !normalizeText(lines[0])) lines.shift();
    }

    return normalizeText(lines.join('\n'));
  }

  function cleanExtractedMessageText(value, sender) {
    const text = normalizeText(value);
    if (sender === 'bot') return stripTransientAssistantStatusLines(text);
    return text;
  }

  function shouldSkipExtractedMessageText(value, sender, source = '') {
    const text = normalizeText(value);
    if (!text) return true;
    if (isProviderTranscriptText(text)) return true;
    if (sender === 'bot' && isTransientAssistantStatusText(text)) return true;

    // DOM fallback saves for user prompts should only save the user's own turn.
    // ChatGPT can briefly render an accessibility transcript containing both
    // "You said" and "ChatGPT said: Thinking"; do not import that as a second
    // local "Me" message.
    if (sender === 'me' && /dom|fallback/i.test(source) && /chatgpt said|assistant said|ai said/i.test(text))
      return true;

    return false;
  }

  function extractMessageTextFallback(container, senderHint = null) {
    const source = messageExtractionSource(container, senderHint);
    const selectedText = selectionInside(source) || selectionInside(container);
    if (selectedText) return selectedText;

    const clone = source.cloneNode(true);
    removeUiNoise(clone);

    const markdown = normalizeText(markdownForElement(clone));
    if (markdown) return markdown;

    return textContentClean(clone);
  }

  function roleToSender(role) {
    if (role === 'user') return 'me';
    if (role === 'assistant') return 'bot';
    return null;
  }

  function senderToRole(sender) {
    if (sender === 'me' || sender === 'user') return 'user';
    if (sender === 'bot' || sender === 'assistant') return 'assistant';
    return null;
  }

  function messageRoleElement(container, senderHint = null) {
    if (!container || container.nodeType !== Node.ELEMENT_NODE) return null;

    const adapter = currentProviderAdapter();
    const roleSelectors = adapter.roleContainerSelectors || [];
    if (!roleSelectors.length) return null;

    const preferredRole = senderToRole(senderHint);
    if (preferredRole) {
      const preferredSelector = `[data-message-author-role="${preferredRole}"]`;
      if (roleSelectors.includes('[data-message-author-role]') && container.matches?.(preferredSelector))
        return container;
      const scoped = roleSelectors.includes('[data-message-author-role]')
        ? container.querySelector?.(preferredSelector)
        : null;
      if (scoped) return scoped;
    }

    if (matchesAny(container, roleSelectors)) return container;

    const roles = uniqueElements(
      roleSelectors.flatMap((selector) => {
        try {
          return Array.from(container.querySelectorAll?.(selector) || []);
        } catch {
          return [];
        }
      })
    ).filter(
      (element) =>
        !element.closest?.(
          `[${EXT_MARKER}], [${NEW_SESSION_MARKER}], [${LOAD_PAST_MARKER}], [${TOP_PIN_SELECT_MARKER}], [${AUTO_SEND_TOGGLE_MARKER}], [${LOCAL_SIDEBAR_MARKER}], #${LOAD_PAST_MODAL_ID}`
        )
    );

    const topLevelRoles = roles.filter(
      (element) => !roles.some((other) => other !== element && other.contains(element))
    );
    return topLevelRoles.length === 1 ? topLevelRoles[0] : null;
  }

  function uniqueElements(elements) {
    return [...new Set(elements.filter(Boolean))];
  }

  function containerSenderRoles(container) {
    if (!container || container.nodeType !== Node.ELEMENT_NODE) return [];

    const adapter = currentProviderAdapter();
    const roleSelectors = adapter.roleContainerSelectors || [];
    const roleElements = [];

    if (matchesAny(container, roleSelectors)) roleElements.push(container);
    for (const selector of roleSelectors) {
      try {
        roleElements.push(...Array.from(container.querySelectorAll?.(selector) || []));
      } catch {
        // Ignore invalid selectors from stale provider adapters.
      }
    }

    return [
      ...new Set(
        roleElements
          .map((element) => element.getAttribute?.('data-message-author-role'))
          .map(roleToSender)
          .filter(Boolean)
      )
    ];
  }

  function inferSender(container) {
    const adapter = currentProviderAdapter();
    if (typeof adapter.senderFromContainer === 'function') {
      try {
        const sender = adapter.senderFromContainer(container);
        if (sender === 'me' || sender === 'bot') return sender;
      } catch {
        // Fall through to generic sender inference when a provider hook becomes stale.
      }
    }

    const roleSelectors = adapter.roleContainerSelectors || [];
    const closestRole =
      roleSelectors.length && matchesAny(container, roleSelectors)
        ? container
        : roleSelectors
            .map((selector) => {
              try {
                return container?.closest?.(selector);
              } catch {
                return null;
              }
            })
            .find(Boolean);
    const closestSender = roleToSender(closestRole?.getAttribute?.('data-message-author-role'));
    if (closestSender) return closestSender;

    const roles = containerSenderRoles(container);
    if (roles.length === 1) return roles[0];

    const label = providerLabelText(container);
    if (adapter.userLabelPattern.test(label)) return 'me';
    if (adapter.assistantLabelPattern.test(label)) return 'bot';

    // Copy buttons beside generated answers are usually assistant-message buttons.
    return 'bot';
  }

  function assistantContentSignature(container) {
    const source = messageExtractionSource(container, 'bot');
    const text = cleanExtractedMessageText(normalizeText(source?.innerText || source?.textContent || ''), 'bot');
    if (!text || shouldSkipExtractedMessageText(text, 'bot', 'assistant-signature')) return '';
    return `${text.length}:${hashText(text)}`;
  }

  function hasStreamingMarker(container) {
    if (!container || container.nodeType !== Node.ELEMENT_NODE) return false;

    const selectors = currentProviderAdapter().streamingSelectors || [];
    return matchesAny(container, selectors) || hasDescendantMatching(container, selectors);
  }

  return {
    markers: {
      EXT_MARKER,
      NEW_SESSION_MARKER,
      LOAD_PAST_MARKER,
      TOP_PIN_SELECT_MARKER,
      AUTO_SEND_TOGGLE_MARKER,
      AUTO_SEND_TOGGLE_MOUNT_MARKER,
      AUTO_SEND_COMPOSER_MARKER,
      AUTO_SEND_LAYOUT_MARKER,
      LOCAL_SIDEBAR_MARKER,
      LOCAL_SIDEBAR_NATIVE_HIDDEN_MARKER,
      LOAD_PAST_MODAL_ID
    },
    providerInfo,
    currentProviderAdapter,
    normalizeText,
    hashText,
    isCopyButton,
    isNestedContentCopyButton,
    isProviderActionBarControl,
    providerActionBarSaveTargets,
    findMessageContainer,
    selectionInside,
    removeUiNoise,
    escapeMarkdownText,
    textContentClean,
    markdownForInline,
    markdownForElement,
    markdownForChildren,
    tableToMarkdown,
    messageExtractionSource,
    isProviderTranscriptText,
    isTransientAssistantStatusText,
    stripTransientAssistantStatusLines,
    cleanExtractedMessageText,
    shouldSkipExtractedMessageText,
    extractMessageTextFallback,
    roleToSender,
    senderToRole,
    messageRoleElement,
    containerSenderRoles,
    inferSender,
    assistantContentSignature,
    hasStreamingMarker
  };
});
