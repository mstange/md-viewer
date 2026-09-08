/**
 * Render a unified diff to HTML, Phabricator-style: a line changed only by
 * whitespace says so, and a line where one word moved shows that word rather
 * than lighting up whole.
 *
 * The markup is layout-agnostic: a changed line and the line it replaced sit
 * together in one row, and the stylesheet decides whether to stack them
 * (unified) or set them side by side. So the toggle in the page is a class
 * flip, never a re-render — which is what keeps review comments attached to
 * the passage they were written against.
 *
 * Side by side repeats each unchanged line in both columns. The second copy is
 * marked `mdv-mirror`, which review.js leaves out of the text it searches, so
 * a line drawn twice is still anchored, quoted and counted once.
 */

import parseDiff from 'parse-diff';
import { diffWordsWithSpace } from 'diff';

/**
 * Below this much shared text, a pair of lines is treated as a rewrite and
 * shown whole. Word highlighting on two unrelated lines is confetti: it marks
 * every word, which reads as noisier than no marking at all.
 */
const SIMILARITY_FLOOR = 0.35;
/** Pairing whole hunks is quadratic, so give up on the pathological ones. */
const MAX_PAIRED_RUN = 200;

const escape = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------------------
// Intra-line comparison
// ---------------------------------------------------------------------------

/** True once two lines differ in nothing but their spaces and tabs. */
function whitespaceOnly(before, after) {
  return before !== after && before.replace(/\s+/g, '') === after.replace(/\s+/g, '');
}

/**
 * Make whitespace visible, for the runs a whitespace-only change touches. The
 * point of such a line is the part you cannot see, so the changed spans show
 * their spaces and tabs; everywhere else keeps real characters, since a page
 * full of dots is harder to read than the code it stands for.
 */
function visibleSpace(text) {
  return escape(text).replace(/ /g, '·').replace(/\t/g, '→ ');
}

/**
 * How much two lines have in common, as a fraction of the longer one. Measured
 * on the word diff that is about to be rendered, so the score and the highlight
 * always agree about what changed.
 */
function similarity(parts) {
  let common = 0;
  let total = 0;
  for (const part of parts) {
    const length = part.value.length;
    total += length;
    if (!part.added && !part.removed) common += length;
  }
  // Shared text is counted once but spans both lines, hence the doubling.
  return total ? (2 * common) / (total + common) : 1;
}

/**
 * Mark up one side of a changed pair, highlighting the words that moved.
 * `side` picks which of the two the parts belong to: a deletion renders the
 * removed runs and skips the added ones, an insertion the reverse.
 */
function markUp(parts, side, showSpace) {
  const mine = side === 'del' ? 'removed' : 'added';
  const theirs = side === 'del' ? 'added' : 'removed';
  let html = '';
  for (const part of parts) {
    if (part[theirs]) continue;
    const text = showSpace ? visibleSpace(part.value) : escape(part.value);
    html += part[mine] ? `<span class="dv-word">${text}</span>` : text;
  }
  return html;
}

/**
 * A line that is a change from end to end: all of it is marked, so it reads in
 * the same colour as the words that moved on a line that was merely edited.
 * The indentation stays outside the mark — highlighting it would draw a block
 * of colour where there is nothing to read, and misalign the text against the
 * lines above and below.
 */
function whole(text) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, indent, body, trailing] = match;
  if (!body) {
    return escape(text);
  }
  return escape(indent) + `<span class="dv-word">${escape(body)}</span>` + escape(trailing);
}

/**
 * Pair the deletions and insertions of one changed run, so each line can be
 * compared against the line it replaced. Runs of unequal length pair as far as
 * they go: the leftovers are pure additions or removals with nothing to mark.
 */
function pairRun(dels, adds) {
  const pairs = [];
  const paired = dels.length > MAX_PAIRED_RUN ? 0 : Math.min(dels.length, adds.length);
  for (let i = 0; i < paired; i++) {
    const before = dels[i].text;
    const after = adds[i].text;
    const parts = diffWordsWithSpace(before, after);
    const space = whitespaceOnly(before, after);
    // A rewrite shares too little to point at any one word.
    const words = space || similarity(parts) >= SIMILARITY_FLOOR;
    pairs.push({
      del: dels[i],
      add: adds[i],
      delHtml: words ? markUp(parts, 'del', space) : escape(before),
      addHtml: words ? markUp(parts, 'add', space) : escape(after),
      space,
    });
  }
  // A line with no counterpart is new or gone in its entirety, so all of it is
  // the change: it gets the same strong colour as the words that moved on a
  // line that was only edited.
  for (let i = paired; i < dels.length; i++) {
    pairs.push({ del: dels[i], add: null, delHtml: whole(dels[i].text), space: false });
  }
  for (let i = paired; i < adds.length; i++) {
    pairs.push({ del: null, add: adds[i], addHtml: whole(adds[i].text), space: false });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Turn a hunk's changes into rows holding both sides at once. Consecutive
 * deletions and insertions are gathered into a run first, because a line can
 * only be compared once its counterpart is known.
 */
function rowsOf(chunk) {
  const rows = [];
  let dels = [];
  let adds = [];

  const flush = () => {
    if (!dels.length && !adds.length) return;
    for (const pair of pairRun(dels, adds)) {
      rows.push({ type: 'change', ...pair });
    }
    dels = [];
    adds = [];
  };

  for (const change of chunk.changes) {
    // parse-diff keeps the leading +/-/space of the original line.
    const text = change.content.slice(1);
    if (change.type === 'del') {
      dels.push({ line: change.ln, text });
    } else if (change.type === 'add') {
      adds.push({ line: change.ln, text });
    } else {
      flush();
      rows.push({ type: 'context', oldLine: change.ln1, newLine: change.ln2, text });
    }
  }
  flush();
  return rows;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * A line of the diff.
 *
 * The two layouts differ only in where these land: unified puts every line in
 * one column, side by side puts deletions left and insertions right. Both are
 * grid placements of the same elements, so the toggle never re-renders.
 *
 * `data-line` is the number a review comment reports, and `data-side` says
 * which file that number belongs to.
 */
function lineHtml(side, oldLine, newLine, html, extra = '') {
  const marker = { del: '-', add: '+', ctx: ' ' }[side];
  const line = side === 'del' ? oldLine : newLine;
  return (
    `<div class="dv-line dv-line-${side}${extra}" data-side="${side}"` +
    (line == null ? '' : ` data-line="${line}"`) +
    '>' +
    `<span class="dv-num dv-num-old">${oldLine ?? ''}</span>` +
    `<span class="dv-num dv-num-new">${newLine ?? ''}</span>` +
    `<span class="dv-marker" aria-hidden="true">${marker}</span>` +
    `<span class="dv-text">${html}</span>` +
    '</div>'
  );
}

/**
 * A row of the diff: a context line, or a deletion and the insertion that
 * replaced it. Keeping a changed pair inside one element is what lets side by
 * side put the two halves on the same line however far either of them wraps.
 */
function rowHtml(row) {
  if (row.type === 'context') {
    const text = escape(row.text);
    // Side by side shows an unchanged line in both columns. The second copy is
    // marked as a mirror: review.js leaves mirrored text out of the document
    // text it searches, so the line still counts once when a comment is
    // anchored, however many times it is drawn.
    return (
      '<div class="dv-row dv-row-context">' +
      lineHtml('ctx', row.oldLine, row.newLine, text) +
      '<div class="dv-line dv-line-ctx dv-line-mirror mdv-mirror" aria-hidden="true">' +
      `<span class="dv-num dv-num-new">${row.newLine ?? ''}</span>` +
      '<span class="dv-marker"> </span>' +
      `<span class="dv-text">${text}</span>` +
      '</div>' +
      '</div>'
    );
  }

  const space = row.space ? ' dv-row-space' : '';
  const title = row.space ? ' title="whitespace-only change"' : '';
  let inner = '';
  // The deletion leads, as it does in a unified diff.
  if (row.del) {
    inner += lineHtml('del', row.del.line, null, row.delHtml, space);
  }
  if (row.add) {
    inner += lineHtml('add', null, row.add.line, row.addHtml, space);
  }
  const kind = row.del && row.add ? 'pair' : row.del ? 'del' : 'add';
  return `<div class="dv-row dv-row-change dv-row-${kind}${space}"${title}>${inner}</div>`;
}

/** The `@@ -a,b +c,d @@` line, with whatever section name git put after it. */
function hunkHeader(chunk) {
  return `<div class="dv-row dv-row-hunk">${escape(chunk.content)}</div>`;
}

/** What to call a file, preferring the new path and noting a rename. */
function fileName(file) {
  const from = file.from && file.from !== '/dev/null' ? file.from : null;
  const to = file.to && file.to !== '/dev/null' ? file.to : null;
  if (from && to && from !== to) return `${from} → ${to}`;
  return to || from || 'unknown file';
}

/** The path a review comment should quote: the new side, since that is what an agent edits. */
function commentPath(file) {
  const to = file.to && file.to !== '/dev/null' ? file.to : null;
  return to || file.from || 'unknown file';
}

function statusOf(file) {
  if (file.new) return 'added';
  if (file.deleted) return 'deleted';
  if (file.from && file.to && file.from !== file.to) return 'renamed';
  return 'changed';
}

function fileHtml(file, index) {
  const rows = file.chunks
    .map((chunk) => hunkHeader(chunk) + rowsOf(chunk).map(rowHtml).join(''))
    .join('');

  const stats =
    `<span class="dv-stat dv-stat-add">+${file.additions}</span>` +
    `<span class="dv-stat dv-stat-del">−${file.deletions}</span>`;

  return (
    `<section class="dv-file" id="dv-file-${index}" data-path="${escape(commentPath(file))}">` +
    '<header class="dv-file-header">' +
    `<span class="dv-file-name">${escape(fileName(file))}</span>` +
    `<span class="dv-file-status dv-status-${statusOf(file)}">${statusOf(file)}</span>` +
    stats +
    '</header>' +
    (file.chunks.length
      ? `<div class="dv-table">${rows}</div>`
      : '<div class="dv-file-empty">No textual changes.</div>') +
    '</section>'
  );
}

/**
 * Render a unified diff.
 * @returns {{html: string, files: number, additions: number, deletions: number}}
 */
export function renderDiff(source) {
  const files = parseDiff(source);
  if (!files.length) {
    return { html: '<div class="dv-empty-diff">This diff has no file changes.</div>', files: 0, additions: 0, deletions: 0 };
  }

  const html = files.map((file, i) => fileHtml(file, i)).join('\n');
  return {
    html,
    files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

/**
 * Guess whether some text is a diff, from the markers a unified diff has to
 * carry. Used to let the viewer accept a file without being told what it is.
 * Deliberately strict: a markdown document quoting a diff in a fenced block
 * should still be read as markdown.
 */
export function looksLikeDiff(source) {
  const head = source.slice(0, 8192).split('\n', 60);
  for (let i = 0; i < head.length; i++) {
    const line = head[i];
    if (/^diff --git /.test(line) || /^Index: /.test(line)) return true;
    // A --- / +++ / @@ trio is the minimum a bare unified diff can have.
    if (/^--- /.test(line) && /^\+\+\+ /.test(head[i + 1] || '') && /^@@ /.test(head[i + 2] || '')) {
      return true;
    }
  }
  return false;
}
