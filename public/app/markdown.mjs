function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sanitizeUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '#';

  try {
    const baseOrigin =
      typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost';
    const parsed = new URL(trimmed, baseOrigin);
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return parsed.href;
  } catch {}

  return '#';
}

function makePlaceholderStore() {
  const values = [];
  return {
    add(value) {
      const key = `\u0000MDPH${values.length}\u0000`;
      values.push({ key, value });
      return key;
    },
    restore(text) {
      return values.reduce((next, item) => next.replaceAll(item.key, item.value), text);
    }
  };
}

function renderInlineMarkdown(value) {
  const placeholders = makePlaceholderStore();
  let text = String(value || '');

  text = text.replace(/`([^`]+)`/g, (_match, code) => {
    return placeholders.add(`<code>${escapeHtml(code)}</code>`);
  });

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label, url) => {
    const safeUrl = sanitizeUrl(url);
    const isSafe = safeUrl !== '#';
    const href = escapeHtml(safeUrl);
    const title = isSafe ? ` href="${href}" target="_blank" rel="noopener noreferrer"` : ' href="#"';
    return placeholders.add(`<a${title}>${escapeHtml(label)}</a>`);
  });

  let html = escapeHtml(text);

  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

  return placeholders.restore(html);
}

function splitMarkdownTableRow(line) {
  let value = String(line || '').trim();
  if (!value.includes('|')) return [];

  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);

  const cells = [];
  let current = '';
  let escaped = false;
  let inCode = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      current += char;
      continue;
    }

    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }

    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/\\\|/g, '|'));
}

function isTableDelimiterCell(cell) {
  return /^:?-{3,}:?$/.test(String(cell || '').trim());
}

function isMarkdownTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  const header = splitMarkdownTableRow(lines[index]);
  const delimiter = splitMarkdownTableRow(lines[index + 1]);

  return header.length >= 2 && delimiter.length >= 2 && delimiter.every(isTableDelimiterCell);
}

function tableAlignment(cell) {
  const value = String(cell || '').trim();
  if (value.startsWith(':') && value.endsWith(':')) return 'center';
  if (value.endsWith(':')) return 'right';
  if (value.startsWith(':')) return 'left';
  return '';
}

function renderMarkdownTable(lines, startIndex) {
  const header = splitMarkdownTableRow(lines[startIndex]);
  const delimiter = splitMarkdownTableRow(lines[startIndex + 1]);
  const alignments = delimiter.map(tableAlignment);
  const rows = [];
  let i = startIndex + 2;

  while (i < lines.length && lines[i].trim() && splitMarkdownTableRow(lines[i]).length >= 2) {
    rows.push(splitMarkdownTableRow(lines[i]));
    i += 1;
  }

  const columnCount = Math.max(header.length, delimiter.length, ...rows.map((row) => row.length));
  const normalizeCells = (row) => Array.from({ length: columnCount }, (_, index) => row[index] || '');
  const headerCells = normalizeCells(header);
  const bodyRows = rows.map(normalizeCells);

  const th = headerCells
    .map((cell, index) => {
      const align = alignments[index] ? ` style="text-align: ${alignments[index]}"` : '';
      return `<th${align}>${renderInlineMarkdown(cell)}</th>`;
    })
    .join('');

  const body = bodyRows
    .map((row) => {
      const cells = row
        .map((cell, index) => {
          const align = alignments[index] ? ` style="text-align: ${alignments[index]}"` : '';
          return `<td${align}>${renderInlineMarkdown(cell)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return {
    html: `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`,
    nextIndex: i
  };
}

function isMarkdownBlockStart(line) {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^-{3,}\s*$/.test(line)
  );
}

function getListMarkerInfo(line) {
  const match = String(line || '').match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
  if (!match) return null;

  return {
    indent: match[1].replace(/\t/g, '    ').length,
    type: match[2].endsWith('.') ? 'ol' : 'ul',
    text: match[3]
  };
}

function leadingIndentLength(line) {
  return String(line || '')
    .match(/^\s*/)[0]
    .replace(/\t/g, '    ').length;
}

function nextNonBlankLineIndex(lines, startIndex) {
  let index = startIndex;
  while (index < lines.length && !String(lines[index] || '').trim()) index += 1;
  return index;
}

function renderList(lines, startIndex, baseIndent = null, listType = null) {
  const first = getListMarkerInfo(lines[startIndex]);
  if (!first) return { html: '', nextIndex: startIndex };

  const indent = baseIndent ?? first.indent;
  const type = listType ?? first.type;
  const items = [];
  let i = startIndex;

  while (i < lines.length) {
    if (!String(lines[i] || '').trim()) {
      const nextIndex = nextNonBlankLineIndex(lines, i + 1);
      const nextInfo = nextIndex < lines.length ? getListMarkerInfo(lines[nextIndex]) : null;

      if (nextInfo && nextInfo.indent >= indent) {
        i = nextIndex;
        continue;
      }

      break;
    }

    const info = getListMarkerInfo(lines[i]);
    if (!info || info.indent < indent) break;

    if (info.indent > indent) {
      if (!items.length) break;
      const nested = renderList(lines, i, info.indent, info.type);
      if (!nested.html || nested.nextIndex === i) break;
      items[items.length - 1].children.push(nested.html);
      i = nested.nextIndex;
      continue;
    }

    if (info.type !== type) break;

    const item = {
      content: renderInlineMarkdown(info.text.trim()),
      children: []
    };
    items.push(item);
    i += 1;

    while (i < lines.length) {
      if (!String(lines[i] || '').trim()) {
        const nextIndex = nextNonBlankLineIndex(lines, i + 1);
        if (nextIndex >= lines.length) {
          i = nextIndex;
          break;
        }

        const nextInfo = getListMarkerInfo(lines[nextIndex]);
        const nextIndent = leadingIndentLength(lines[nextIndex]);

        if (nextInfo) {
          if (nextInfo.indent > indent) {
            i = nextIndex;
            continue;
          }

          i = nextIndex;
          break;
        }

        if (nextIndent > indent && !isMarkdownBlockStart(lines[nextIndex])) {
          item.content += '<br><br>';
          i = nextIndex;
          continue;
        }

        break;
      }

      const nextInfo = getListMarkerInfo(lines[i]);
      const nextIndent = leadingIndentLength(lines[i]);

      if (nextInfo) {
        if (nextInfo.indent > indent) {
          const nested = renderList(lines, i, nextInfo.indent, nextInfo.type);
          if (!nested.html || nested.nextIndex === i) break;
          item.children.push(nested.html);
          i = nested.nextIndex;
          continue;
        }

        break;
      }

      if (nextIndent <= indent) break;

      item.content += `<br>${renderInlineMarkdown(lines[i].trim())}`;
      i += 1;
    }
  }

  return {
    html: `<${type}>${items.map((item) => `<li>${item.content}${item.children.join('')}</li>`).join('')}</${type}>`,
    nextIndex: i
  };
}

function normalizeCodeLanguage(language) {
  const token = String(language || '')
    .trim()
    .split(/\s+/, 1)[0]
    .toLowerCase();
  if (!token) return '';

  if (['cpp', 'cxx', 'cc'].includes(token)) return 'c++';
  return token;
}

function renderCodeCopyButton() {
  return `
    <button class="code-copy-btn" type="button" data-copy-code aria-label="Copy code" title="Copy code">
      <span class="code-copy-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <rect x="8" y="8" width="11" height="11" rx="2"></rect>
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
        </svg>
      </span>
      <span class="code-copy-check" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="m5 12 4 4L19 6"></path>
        </svg>
      </span>
    </button>`;
}

function renderCodeBlock(code, language = '') {
  const normalizedLanguage = normalizeCodeLanguage(language);
  const languageLabel = normalizedLanguage
    ? `<span class="code-language">${escapeHtml(normalizedLanguage)}</span>`
    : '';

  return `<div class="code-block"><div class="code-block-header">${languageLabel}${renderCodeCopyButton()}</div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const language = line.replace(/^```/, '').trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(renderCodeBlock(codeLines.join('\n'), language));
      continue;
    }

    if (isMarkdownTableStart(lines, i)) {
      const table = renderMarkdownTable(lines, i);
      blocks.push(table.html);
      i = table.nextIndex;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^-{3,}\s*$/.test(line)) {
      blocks.push('<hr>');
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push(`<blockquote>${quoteLines.map(renderInlineMarkdown).join('<br>')}</blockquote>`);
      continue;
    }

    if (getListMarkerInfo(line)) {
      const list = renderList(lines, i);
      blocks.push(list.html);
      i = list.nextIndex;
      continue;
    }

    const paragraphLines = [];
    while (i < lines.length && lines[i].trim() && !isMarkdownBlockStart(lines[i]) && !isMarkdownTableStart(lines, i)) {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p>${paragraphLines.map(renderInlineMarkdown).join('<br>')}</p>`);
  }

  return `<div class="markdown-body">${blocks.join('')}</div>`;
}

export {
  escapeHtml,
  sanitizeUrl,
  renderInlineMarkdown,
  splitMarkdownTableRow,
  isTableDelimiterCell,
  isMarkdownTableStart,
  renderMarkdownTable,
  normalizeCodeLanguage,
  renderCodeBlock,
  renderMarkdown
};
