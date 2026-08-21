import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Marked, Renderer } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import hljs from 'highlight.js';

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx']);

/** Block renderers whose output gets a `data-line` attribute. */
const BLOCK_TOKENS = ['heading', 'paragraph', 'blockquote', 'list', 'code', 'table', 'html'];

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

/**
 * Map each top-level token to the source line it starts on. The tokens tile
 * the source exactly, so a running total of their raw lengths locates every
 * block in the file. Returns null if that total does not add up, since a
 * preview with no line numbers beats one with wrong ones.
 */
function lineNumbers(tokens, source) {
  // The lexer normalises line endings before tokenising, so measure against
  // the same text it saw. Collapsing "\r\n" does not move any line.
  const length = source.replace(/\r\n/g, '\n').length;
  const lines = new WeakMap();
  let offset = 0;
  let line = 1;
  for (const token of tokens) {
    lines.set(token, line);
    for (const char of token.raw) {
      if (char === '\n') line++;
    }
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
export function renderMarkdown(source, { baseDir, linkMode = 'server' } = {}) {
  const options = { baseDir, linkMode };
  /** @type {WeakMap<object, number>|null} Filled in once the source is lexed. */
  let lines = null;

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
    },
  });

  // Stamp each top-level block with the source line it came from, so that a
  // review comment can name the line it refers to. This wraps the renderer the
  // extensions above already composed — decorating their output rather than
  // replacing it, which is what keeps heading ids and highlighting intact.
  // Nested blocks are absent from `lines` and pass through unchanged.
  const renderer = md.defaults.renderer;
  for (const type of BLOCK_TOKENS) {
    const inner = renderer[type].bind(renderer);
    renderer[type] = (token) => withLine(inner(token), lines?.get(token));
  }

  // Lexing by hand, rather than letting parse() do it, is what gives the
  // renderer the token objects whose source lines were just measured. Going
  // through parser() skips the walkTokens pass, so it runs here instead.
  const tokens = md.lexer(source);
  lines = lineNumbers(tokens, source);
  // The composed hook, not the one above: it also carries the syntax
  // highlighter, which rewrites code tokens before they reach the renderer.
  md.walkTokens(tokens, md.defaults.walkTokens);
  const html = md.parser(tokens);

  const heading = tokens.find((token) => token.type === 'heading');
  const title = heading ? inlineText(md, heading.text) : null;

  return { html, title };
}
