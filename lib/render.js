import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Marked, Renderer } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import hljs from 'highlight.js';

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx']);

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
 * Render markdown to HTML.
 * @returns {{html: string, title: string|null}}
 */
export function renderMarkdown(source, { baseDir, linkMode = 'server' } = {}) {
  const options = { baseDir, linkMode };
  // A fresh instance per render keeps heading-id de-duplication from drifting
  // across reloads.
  const md = new Marked(highlight, gfmHeadingId(), {
    gfm: true,
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') {
        token.href = rewrite(token.href, options, token.type === 'image');
      }
    },
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

  const html = md.parse(source, { async: false });

  const heading = md.lexer(source).find((token) => token.type === 'heading');
  const title = heading ? inlineText(md, heading.text) : null;

  return { html, title };
}
