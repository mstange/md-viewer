import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Marked, Renderer } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import hljs from 'highlight.js';
import { MARKDOWN_EXT, MARKDOWN_EXT_RE } from './docs.js';

/**
 * A code span holding nothing but a hex string of commit-id length.
 *
 * Only code spans are considered, and only ones with nothing else in them: a
 * sha is written in backticks by anyone who writes one down, and requiring the
 * span to be exactly the sha is what keeps `0xdeadbeef` and a prose sentence
 * that happens to contain a hex word out of it. Whether the id names a real
 * commit is a separate question, answered by the repository, not by shape.
 */
const SHA_SPAN = /^[0-9a-f]{7,40}$/;

/** Every commit id a document might be naming, in source order. Passed to the
 *  repository so one lookup can answer the whole file before it is rendered. */
export function findShaCandidates(source) {
  const found = [];
  // The same shape the renderer will accept, looked for in the raw source: a
  // full lex to find them would cost more than the over-collection does, and a
  // candidate that turns out not to be in a code span simply never gets asked
  // about again.
  const re = /`([0-9a-f]{7,40})`/g;
  let match;
  while ((match = re.exec(source))) {
    found.push(match[1]);
  }
  return found;
}

/**
 * A code span holding nothing but a path to a markdown file.
 *
 * The same rule as a sha: only code spans, and only ones with nothing else in
 * them, because that is how anyone naming a file in prose writes it down. A
 * leading "./" or "../" is allowed, and so are directories, since a document
 * pointing at another one usually says where it is. What is refused is anything
 * that is really a URL — a scheme or a "//" — and a name with a space or a
 * glob in it, which names an idea rather than a file. Whether the file is on
 * disk is a separate question, answered by the filesystem, not by shape.
 */
const DOC_SPAN = new RegExp(
  String.raw`^(?!//)(?![a-z][a-z0-9+.-]*:)[\w./~@+-]+\.(?:${MARKDOWN_EXT_RE})$`,
  'i',
);

/** Every markdown file a document might be naming, in source order. Passed to
 *  the lookup so one pass over the filesystem answers the whole file. */
export function findDocCandidates(source) {
  const found = [];
  // As with shas, the raw source is scanned rather than the token stream: a
  // candidate that turns out not to have been a code span is simply never
  // asked about again, which is cheaper than a second full lex.
  const re = /`([^`\n]+)`/g;
  let match;
  while ((match = re.exec(source))) {
    if (DOC_SPAN.test(match[1])) {
      found.push(match[1]);
    }
  }
  return found;
}

/**
 * Renderers whose output gets a `data-line` attribute. A row and a list item
 * are in the list because a table or a list is one block to the lexer: without
 * them every comment on a twenty-row table reports the line the table starts
 * on, which names no row at all.
 */
const LINED = [
  'heading',
  'paragraph',
  'blockquote',
  'list',
  'listitem',
  'code',
  'table',
  'tablecell',
  'html',
];

const highlight = markedHighlight({
  emptyLangClass: 'hljs',
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language }).value;
  },
});

/** True for hrefs that point somewhere other than the local filesystem. */
function isRemote(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

/** True for hrefs whose click would navigate this tab to another site. */
function leavesTheSite(href) {
  return /^https?:\/\//i.test(href) || href.startsWith('//');
}

/** Split "dir/file.md#anchor" into its path and its "#anchor" suffix. */
function splitHash(href) {
  const i = href.indexOf('#');
  return i < 0 ? [href, ''] : [href.slice(0, i), href.slice(i)];
}

function decode(target) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/**
 * Rewrite a relative link found in `baseDir` so that it still resolves once the
 * document is served over HTTP (linkMode 'server') or written to a temporary
 * standalone file (linkMode 'file').
 */
function rewrite(href, { baseDir, linkMode }, isImage) {
  if (!href || href.startsWith('#') || isRemote(href)) {
    return href;
  }
  const [target, hash] = splitHash(href);
  if (!target) {
    return href;
  }
  const abs = path.resolve(baseDir, decode(target));
  if (linkMode === 'file') {
    return pathToFileURL(abs).href + hash;
  }
  const isMarkdown = !isImage && MARKDOWN_EXT.has(path.extname(abs).toLowerCase());
  const route = isMarkdown ? '/?f=' : '/_file?p=';
  return route + encodeURIComponent(abs) + hash;
}

/** Plain-text form of an inline markdown string, for use as the tab title. */
function inlineText(md, markdown) {
  return md
    .parseInline(markdown)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

const escape = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Split a leading YAML frontmatter block off the source. The delimiters have to
 * be the very first line and a matching `---` later on; anything else is just a
 * document that happens to start with a horizontal rule, and is left alone.
 * @returns {{fields: Array<[string, string]>|null, body: string, offset: number}}
 *   `offset` is how many lines were consumed, so body blocks can still report
 *   their line number in the original file.
 */
function splitFrontmatter(source) {
  const none = { fields: null, body: source, offset: 0 };
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) {
    return none;
  }
  const fields = parseFields(match[1]);
  if (!fields.length) {
    return none;
  }
  const consumed = match[0].replace(/\r\n/g, '\n');
  return {
    fields,
    body: source.slice(match[0].length),
    offset: consumed.split('\n').length - 1,
  };
}

/**
 * Read the `key: value` pairs of a frontmatter block. Deliberately shallow: the
 * point is to show a header, not to load a config, so nested mappings are kept
 * as the raw text under their key. Block scalars (`|`, `>`) and one-per-line
 * sequences are folded into a single value, since that is how a multi-line
 * description or a tool list is usually written. Returns [] on anything that
 * does not look like a mapping, which sends the caller back to plain markdown.
 */
function parseFields(block) {
  const fields = [];
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    const match = /^([\w.$-]+)[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    if (!match) {
      return [];
    }
    const parts = [];
    let isList = false;
    const scalar = (match[2] ?? '').trim();
    // A lone block-scalar indicator carries no text of its own.
    if (scalar && !/^[|>][+-]?$/.test(scalar)) {
      parts.push(scalar);
    }
    // Absorb this key's continuation lines: the indented remainder of a wrapped
    // value or block scalar, and the "- item" lines of a sequence.
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      const item = /^[ \t]*-[ \t]+\S/.test(next);
      if (!item && !/^[ \t]+\S/.test(next)) {
        break;
      }
      isList = isList || item;
      parts.push(next.trim().replace(/^-[ \t]+/, ''));
      i++;
    }
    // A sequence reads as a list; a wrapped value reads as one sentence.
    fields.push([match[1], parts.join(isList ? ', ' : ' ')]);
  }
  return fields;
}

/** Render the frontmatter fields as a header block above the document. */
function frontmatterHtml(fields, md) {
  const rows = fields
    .map(([key, value]) => {
      // Values are inline markdown, so that backticks and links in a
      // description render the way they do in the body. Unlike the body, a raw
      // tag in a value is shown rather than run: these are YAML scalars, where
      // "<b>" means those five characters, and a `description` is not a place
      // anyone means to write markup. Escaping just "<" leaves every markdown
      // construct working, since none of them need that character.
      const text = value ? md.parseInline(value.replace(/</g, '&lt;')) : '';
      return (
        '<div class="mdv-fm-row">' +
        `<dt>${escape(key)}</dt>` +
        `<dd>${text}</dd>` +
        '</div>'
      );
    })
    .join('\n');
  return `<dl class="mdv-frontmatter">\n${rows}\n</dl>\n`;
}

/** How many lines past its first a token's raw text spans. */
function newlines(raw) {
  let count = 0;
  for (const char of raw) {
    if (char === '\n') count++;
  }
  return count;
}

/** Containers whose children are located by walking their raw text. */
const NESTS = new Set(['blockquote', 'list', 'list_item']);

/**
 * Map the blocks inside a container to their own lines, so that a comment on
 * one table row or one list item names that row or item rather than the line
 * the whole table or list starts on.
 *
 * Children carry their own raw text, which keeps every newline of the source
 * even where a bullet and its indentation have been stripped, so a running
 * count of them locates each one. Table rows are the exception: they have no
 * raw text, but a GFM table spends exactly one line per row, after the header
 * and the rule under it.
 *
 * Nothing is mapped past the end of the container: a child landing there means
 * the raw text did not account for the source after all, and the container's
 * own line, coarse as it is, beats a line that is wrong.
 */
function nestedLines(token, line, lines) {
  const last = line + newlines(token.raw);
  if (token.type === 'table') {
    for (const cell of token.header) {
      lines.set(cell, line);
    }
    for (const [i, row] of token.rows.entries()) {
      if (line + 2 + i > last) return;
      for (const cell of row) {
        lines.set(cell, line + 2 + i);
      }
    }
    return;
  }
  if (!NESTS.has(token.type)) {
    return;
  }
  let child = line;
  for (const token_ of token.items ?? token.tokens) {
    if (child > last) return;
    lines.set(token_, child);
    nestedLines(token_, child, lines);
    child += newlines(token_.raw);
  }
}

/**
 * Map each token to the source line it starts on. The top-level tokens tile
 * the source exactly, so a running total of their raw lengths locates every
 * block in the file, and the blocks nested in each one are located from there.
 * `first` is the line `source` starts on in the real file, which is past 1
 * when a frontmatter block was split off. Returns null if the total does not
 * add up, since a preview with no line numbers beats one with wrong ones.
 */
function lineNumbers(tokens, source, first = 1) {
  // The lexer normalises line endings before tokenising, so measure against
  // the same text it saw. Collapsing "\r\n" does not move any line.
  const length = source.replace(/\r\n/g, '\n').length;
  const lines = new WeakMap();
  let offset = 0;
  let line = first;
  for (const token of tokens) {
    lines.set(token, line);
    nestedLines(token, line, lines);
    line += newlines(token.raw);
    offset += token.raw.length;
  }
  return offset === length ? lines : null;
}

/** Add `data-line` to the opening tag of a rendered block, if its line is known. */
function withLine(html, line) {
  if (!line || !html.startsWith('<')) {
    return html;
  }
  const end = html.indexOf('>');
  if (end < 0 || html[end - 1] === '/') {
    return html;
  }
  return `${html.slice(0, end)} data-line="${line}"${html.slice(end)}`;
}

/**
 * Render markdown to HTML.
 * @returns {{html: string, title: string|null}}
 */
export function renderMarkdown(
  source,
  { baseDir, linkMode = 'server', commits = null, docs = null } = {},
) {
  const options = { baseDir, linkMode };
  /** @type {WeakMap<object, number>|null} Filled in once the source is lexed. */
  let lines = null;

  // Frontmatter is metadata, not prose: left in the source it lexes into a
  // horizontal rule and a setext heading made of the whole YAML block, which
  // also becomes the tab title. Pull it out and present it as a header instead.
  const { fields, body, offset } = splitFrontmatter(source);

  const walkTokens = (token) => {
    if (token.type === 'link' || token.type === 'image') {
      token.href = rewrite(token.href, options, token.type === 'image');
    }
  };

  // A fresh instance per render keeps heading-id de-duplication from drifting
  // across reloads.
  const md = new Marked(highlight, gfmHeadingId(), {
    gfm: true,
    walkTokens,
    renderer: {
      // Send links to other sites to their own tab: following one in this tab
      // unloads the preview, which md-viewer reads as the tab going away.
      link(token) {
        if (!leavesTheSite(token.href)) {
          return false;
        }
        const html = Renderer.prototype.link.call(this, token);
        return html.startsWith('<a ') ? `<a target="_blank" rel="noopener"${html.slice(2)}` : html;
      },

      // Two kinds of code span name something this viewer can show, and become
      // links when it turns out to really be there.
      //
      // A commit id that the repository around this document actually has
      // becomes a link to its diff. The sha stays in code style, since that is
      // what it is and the reader is scanning a column of them; only the fact
      // that it is now worth clicking is added. A new tab, because the reader
      // is working through a list and the document is what they come back to —
      // and because navigating away is what md-viewer reads as the tab closing.
      codespan(token) {
        const code = Renderer.prototype.codespan.call(this, token);
        if (commits && SHA_SPAN.test(token.text) && commits.has(token.text)) {
          return (
            `<a class="mdv-commit" target="_blank" rel="noopener" ` +
            `href="/_commit?sha=${encodeURIComponent(token.text)}` +
            `&amp;f=${encodeURIComponent(commits.file)}" ` +
            `title="Review commit ${escape(commits.full(token.text) || token.text)}">` +
            `${code}</a>`
          );
        }
        // And a markdown file that is on the disk becomes a link to that file,
        // on the same terms: still a code span, its own tab.
        const doc = docs && DOC_SPAN.test(token.text) ? docs.find(token.text) : null;
        if (!doc) {
          return code;
        }
        return (
          `<a class="mdv-doc" target="_blank" rel="noopener" ` +
          `href="/?f=${encodeURIComponent(doc)}" ` +
          `title="Open ${escape(doc)}">${code}</a>`
        );
      },
    },
  });

  // Stamp each block with the source line it came from, so that a review
  // comment can name the line it refers to. This wraps the renderer the
  // extensions above already composed — decorating their output rather than
  // replacing it, which is what keeps heading ids and highlighting intact.
  // A block whose line could not be measured is absent from `lines` and passes
  // through unchanged.
  const renderer = md.defaults.renderer;
  for (const type of LINED) {
    const inner = renderer[type].bind(renderer);
    renderer[type] = (token) => withLine(inner(token), lines?.get(token));
  }

  // Lexing by hand, rather than letting parse() do it, is what gives the
  // renderer the token objects whose source lines were just measured. Going
  // through parser() skips the walkTokens pass, so it runs here instead.
  const tokens = md.lexer(body);
  lines = lineNumbers(tokens, body, offset + 1);
  // The composed hook, not the one above: it also carries the syntax
  // highlighter, which rewrites code tokens before they reach the renderer.
  md.walkTokens(tokens, md.defaults.walkTokens);
  const html = (fields ? frontmatterHtml(fields, md) : '') + md.parser(tokens);

  // The document's own title is its `h1`, or failing that a `title`/`name` from
  // the frontmatter. A lower-level heading is a section of the document, not its
  // name, so it is not used: files whose first heading is an "## Overview" would
  // all end up sharing a tab title that says nothing about which file it is.
  const h1 = tokens.find((token) => token.type === 'heading' && token.depth === 1);
  const named = fields?.find(([key]) => key === 'title' || key === 'name');
  const title = h1 ? inlineText(md, h1.text) : (named?.[1] ?? null);

  return { html, title };
}
