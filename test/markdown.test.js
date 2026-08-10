const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const { pathToFileURL } = require('node:url');

let markdown;
before(async () => {
  markdown = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'app', 'markdown.mjs')).href);
});

test('escapeHtml encodes text inserted into rendered messages', () => {
  assert.equal(
    markdown.escapeHtml(`<script>alert("x")</script> & 'quoted'`),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#039;quoted&#039;'
  );
});

test('sanitizeUrl allows common safe protocols and blocks script URLs', () => {
  assert.equal(markdown.sanitizeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(markdown.sanitizeUrl('mailto:person@example.com'), 'mailto:person@example.com');
  assert.equal(markdown.sanitizeUrl('javascript:alert(1)'), '#');
  assert.equal(markdown.sanitizeUrl('data:text/html;base64,PHNjcmlwdD4='), '#');
});

test('renderInlineMarkdown handles emphasis, code, links, and escaping', () => {
  const html = markdown.renderInlineMarkdown('**bold** *italic* `x < y` [site](https://example.com) <bad>');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>x &lt; y<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com\/" target="_blank" rel="noopener noreferrer">site<\/a>/);
  assert.match(html, /&lt;bad&gt;/);
});

test('renderInlineMarkdown never emits unsafe link hrefs', () => {
  const html = markdown.renderInlineMarkdown('[bad](javascript:alert(1)) [ok](http://example.com)');
  assert.match(html, /<a href="#">bad<\/a>/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.match(html, /href="http:\/\/example.com\//);
});

test('table parser supports escaped pipes and code pipes', () => {
  assert.deepEqual(markdown.splitMarkdownTableRow('| a | b\\|c | `x|y` |'), ['a', 'b|c', '`x|y`']);
  assert.equal(markdown.isMarkdownTableStart(['A | B', '--- | :---:', '1 | 2'], 0), true);
});

test('renderMarkdown renders headings, paragraphs, lists, blockquotes, tables, and code fences', () => {
  const html = markdown.renderMarkdown(`# Title

Paragraph with **bold**.

- One
  - Two

> quoted

| A | B |
| --- | ---: |
| <x> | \\| |

\`\`\`js
const x = "<safe>";
\`\`\``);

  assert.match(html, /^<div class="markdown-body">/);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>Paragraph with <strong>bold<\/strong>\.<\/p>/);
  assert.match(html, /<ul><li>One<ul><li>Two<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /<td>&lt;x&gt;<\/td>/);
  assert.match(html, /<td style="text-align: right">\|<\/td>/);
  assert.match(html, /<span class="code-language">js<\/span>/);
  assert.match(html, /class="code-copy-btn"/);
  assert.match(html, /data-copy-code/);
  assert.match(html, /const x = &quot;&lt;safe&gt;&quot;/);
});

test('code fences render ChatGPT-style language headers and copy controls', () => {
  assert.equal(markdown.normalizeCodeLanguage('bash'), 'bash');
  assert.equal(markdown.normalizeCodeLanguage('cpp'), 'c++');
  assert.equal(markdown.normalizeCodeLanguage('cxx extra-metadata'), 'c++');
  assert.equal(markdown.normalizeCodeLanguage(''), '');

  const bash = markdown.renderMarkdown('```bash\necho hello\n```');
  assert.match(bash, /<div class="code-block">/);
  assert.match(bash, /<span class="code-language">bash<\/span>/);
  assert.match(bash, /aria-label="Copy code"/);
  assert.match(bash, /<code>echo hello<\/code>/);

  const cpp = markdown.renderMarkdown('```cpp\nstd::cout &lt;&lt; "hi";\n```');
  assert.match(cpp, /<span class="code-language">c\+\+<\/span>/);

  const unlabeled = markdown.renderMarkdown('```\nplain code\n```');
  assert.doesNotMatch(unlabeled, /class="code-language"/);
  assert.match(unlabeled, /data-copy-code/);
});

test('renderMarkdown returns a stable empty wrapper for empty input', () => {
  assert.equal(markdown.renderMarkdown(''), '<div class="markdown-body"></div>');
  assert.equal(markdown.renderMarkdown(null), '<div class="markdown-body"></div>');
});
