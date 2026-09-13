/**
 * The stack review page: one commit's review page per commit, in a single tab.
 *
 * Each commit is the diff page diff-viewer serves, unchanged, and is shown in
 * an iframe. That is what keeps a comment on one commit a comment on that
 * commit: the review scripts hold their comments in the page they run in, and
 * the copied prompt names the page's commit, so a frame per commit gives each
 * its own review without the scripts having to know they are one of several.
 *
 * The pages are carried inside the outer document rather than fetched, since
 * the process that built this page leaves shortly after serving it. They sit
 * in JSON script blocks and are parsed into a frame the first time the reader
 * opens that commit — a stack can be long, and parsing every diff at once
 * would make the tab slow to appear for the sake of commits not yet looked at.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiffDocument } from './diff-page.js';
import { splitCommitMessage } from './diff.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * JSON safe to put inside a `<script>` element. The parser ends a script at
 * the first `</script` it sees, and treats `<!--` as the start of a region
 * where it looks for one differently; a document that holds whole documents
 * holds both. JSON allows `\/` and `<`, so both are escaped and the text
 * parses back to what it was.
 */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/<!--/g, '\\u003c!--');
}

/** `+12 −3`, or a word when the commit changed nothing. */
function stats(rendered) {
  if (!rendered.files) {
    return '<span class="sv-entry-stat sv-entry-empty">no changes</span>';
  }
  return (
    `<span class="sv-entry-stat dv-stat-add">+${rendered.additions}</span>` +
    `<span class="sv-entry-stat dv-stat-del">−${rendered.deletions}</span>`
  );
}

/**
 * Build the page.
 *
 * `patches` are the commits oldest first, each with the `source` `git show`
 * wrote for it and the `label` the reader knows it by. `title` names the stack
 * — the revset as it was typed — and `where` says which repository.
 */
export async function buildStackPage(patches, { title, where }) {
  const [base, stackCss, stackJs] = await Promise.all([
    fsp.readFile(path.join(ASSETS, 'style.css'), 'utf8'),
    fsp.readFile(path.join(ASSETS, 'stack.css'), 'utf8'),
    fsp.readFile(path.join(ASSETS, 'stack.js'), 'utf8'),
  ]);

  const pages = [];
  for (const patch of patches) {
    // The subject is wanted before the page is built, since the page shows it
    // in its heading; the same parser the renderer uses finds it.
    const subject = splitCommitMessage(patch.source).message?.body.split('\n')[0] || '';
    const { html, rendered } = await buildDiffDocument(patch.source, {
      title: patch.label,
      subtitle: subject || null,
      commit: patch.sha,
    });
    pages.push({ ...patch, subject, html, rendered });
  }

  const entries = pages
    .map(
      (page, i) =>
        `<li><button type="button" class="sv-entry" data-index="${i}">` +
        `<span class="sv-entry-n">${i + 1}</span>` +
        `<span class="sv-entry-id">${escapeHtml(page.label)}</span>` +
        `<span class="sv-entry-subject">${escapeHtml(page.subject || '(no description)')}</span>` +
        `<span class="sv-entry-stats">${stats(page.rendered)}</span>` +
        `<span class="sv-entry-comments" hidden></span>` +
        '</button></li>',
    )
    .join('\n');

  const blocks = pages
    .map(
      (page, i) =>
        `<script type="application/json" id="sv-page-${i}">${jsonForScript(page.html)}</script>`,
    )
    .join('\n');

  const meta = pages.map((page) => ({ sha: page.sha, label: page.label, subject: page.subject }));
  const count = `${pages.length} commit${pages.length === 1 ? '' : 's'}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(path.basename(where))}</title>
<style>
${base}
${stackCss}</style>
</head>
<body class="sv-body">
<div id="sv-root" class="sv-root" data-title="${escapeHtml(title)}">
<header class="sv-header">
<button type="button" class="sv-list-toggle" id="sv-list-toggle" title="Show or hide the list (Alt+L)" aria-label="Show or hide the list">☰</button>
<div class="sv-title"><span class="sv-title-revset">${escapeHtml(title)}</span> <span class="sv-title-where">${escapeHtml(where)}</span></div>
<span class="sv-count">${count}</span>
<div class="sv-review" id="sv-review" hidden>
<span class="sv-review-count"></span>
<button type="button" class="sv-review-copy" id="sv-review-copy">Copy all reviews</button>
</div>
</header>
<nav class="sv-list" id="sv-list" aria-label="Commits">
<ol>
${entries}
</ol>
</nav>
<main class="sv-pane" id="sv-pane"></main>
</div>
<script type="application/json" id="sv-meta">${jsonForScript(meta)}</script>
${blocks}
<script>
${stackJs}</script>
</body>
</html>
`;
}
