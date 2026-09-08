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
/**
 * How far ahead of the runner-up a match has to be to be believed. Two lines
 * that score within this of each other are not one line and its edit; they are
 * a paragraph reflowed, where the old line's text ended up spread across both.
 */
const DECISIVE_MARGIN = 0.08;
/**
 * How much of a deleted line its candidate insertions have to account for
 * between them before they count as the line split in two rather than rivals
 * for the same text.
 */
const SPLIT_COVERAGE = 0.8;
/** Matching a run is quadratic, so give up on the pathological ones. */
const MAX_PAIRED_CELLS = 40000;

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
 * How much two lines have in common: the length of the text they share, and
 * that length as a fraction of the two. Measured on the word diff that is about
 * to be rendered, so the score and the highlight always agree about what
 * changed.
 */
function overlap(parts) {
  let common = 0;
  let total = 0;
  for (const part of parts) {
    const length = part.value.length;
    total += length;
    if (!part.added && !part.removed) common += length;
  }
  // Shared text is counted once but spans both lines, hence the doubling.
  return { common, ratio: total ? (2 * common) / (total + common) : 1 };
}

/** How alike two lines are, from 0 to 1. */
function similarity(parts) {
  return overlap(parts).ratio;
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
 * Which insertion, if any, each deletion is a version of.
 *
 * Position is not enough. A run that rewrites one line and inserts ten above it
 * would pair the rewritten line with the first insertion and highlight the
 * words two unrelated lines happen to share, when the line it is really a
 * version of is further down. So every candidate is scored against every other
 * and the best matches win.
 *
 * A match also has to be *clearly* the best. Reflowing a paragraph moves text
 * across line breaks until two different new lines each hold part of an old
 * one, and neither is the line it became; the scores come out close, and
 * picking the higher one is a coin toss that lights up an arbitrary half of the
 * paragraph. Those are left unpaired, and shown as a line gone and lines
 * arrived. A real edit does not look like that: appending a sentence to a line
 * scores far above every other candidate, however lopsided the run is.
 *
 * @returns {Map<number, number[]>} index in `dels` to the indexes in `adds` it
 *   became — more than one only when the line was split in two.
 */
function matchLines(dels, adds) {
  const scores = [];
  /** The best and second-best score each line takes part in. */
  const bestDel = dels.map(() => [0, 0]);
  const bestAdd = adds.map(() => [0, 0]);
  /** How much of each deletion the insertions account for, taken together. */
  const covered = dels.map(() => 0);

  const note = (best, score) => {
    if (score > best[0]) {
      best[1] = best[0];
      best[0] = score;
    } else if (score > best[1]) {
      best[1] = score;
    }
  };

  for (let d = 0; d < dels.length; d++) {
    for (let a = 0; a < adds.length; a++) {
      const { common, ratio } = overlap(diffWordsWithSpace(dels[d].text, adds[a].text));
      if (ratio < SIMILARITY_FLOOR) {
        continue;
      }
      scores.push({ d, a, score: ratio });
      note(bestDel[d], ratio);
      note(bestAdd[a], ratio);
      covered[d] += common;
    }
  }

  // A deletion whose candidates together account for nearly all of it was not
  // rewritten, it was split: each candidate holds a different part of it, and
  // both are its continuation. Two lines that instead compete for the same text
  // cannot both cover it, so they stay under the bar and the tie below rejects
  // them — which is the difference between a line broken in two and a paragraph
  // reflowed until no pairing means anything.
  const split = dels.map((del, d) => covered[d] >= del.text.length * SPLIT_COVERAGE);

  // Best match first, so a strong pair claims its lines before a weaker one
  // that wanted the same line can. Ties keep the earlier line, which preserves
  // the order of a run whose lines are equally alike.
  scores.sort((x, y) => y.score - x.score || x.d - y.d || x.a - y.a);

  const byDel = new Map();
  const takenAdds = new Set();
  for (const { d, a, score } of scores) {
    // A split line claims every piece of itself; any other takes one match.
    if (takenAdds.has(a) || (byDel.has(d) && !split[d])) {
      continue;
    }
    // A near-tie means two insertions are equally good answers for one deleted
    // line, which is not an edit anyone made — unless they are the two halves
    // of it, which `split` has already established.
    const rival = Math.max(bestDel[d][1], bestAdd[a][1]);
    if (!split[d] && rival && score - rival < DECISIVE_MARGIN) {
      continue;
    }
    if (byDel.has(d)) {
      byDel.get(d).push(a);
    } else {
      byDel.set(d, [a]);
    }
    takenAdds.add(a);
  }
  // Kept in the order they appear, so the pieces of a split line read top down.
  for (const list of byDel.values()) {
    list.sort((x, y) => x - y);
  }
  return byDel;
}

/**
 * Pair the deletions and insertions of one changed run, so each line can be
 * compared against the line it replaced. A line with no counterpart is emitted
 * on its own: it was added or removed outright, and has nothing to be compared
 * against.
 */
function pairRun(dels, adds) {
  // Matching is quadratic in the size of the run, so a pathological one is
  // shown plain rather than allowed to hang the render.
  const matched =
    dels.length * adds.length > MAX_PAIRED_CELLS ? new Map() : matchLines(dels, adds);

  const pairs = [];
  const usedAdds = new Set();
  for (const list of matched.values()) {
    for (const a of list) usedAdds.add(a);
  }
  let next = 0;

  const flushAddsBefore = (limit) => {
    for (; next < limit; next++) {
      if (usedAdds.has(next)) continue;
      pairs.push({
        del: null,
        add: adds[next],
        addHtml: escape(adds[next].text),
        space: false,
        entire: true,
      });
    }
  };

  for (let d = 0; d < dels.length; d++) {
    const list = matched.get(d);

    // Nothing similar enough opposite this line to compare it against.
    if (!list) {
      pairs.push({
        del: dels[d],
        add: null,
        delHtml: escape(dels[d].text),
        space: false,
        entire: true,
      });
      continue;
    }

    // Insertions that come before this line's counterpart belong above it.
    flushAddsBefore(list[0]);
    next = list[0] + 1;

    const before = dels[d].text;
    // Each piece is compared against the whole of the line it came from, so a
    // line split in two shows, on both new lines, which of its words are
    // carried over and which are new.
    //
    // The deletion is drawn beside the first piece, but marked against all of
    // them at once: text that moved to a later piece has not gone anywhere, and
    // marking it as removed on a line whose words are still in the file two
    // lines down is the opposite of what happened.
    const survives = list.map((a) => adds[a].text).join('\n');
    const lost = diffWordsWithSpace(before, survives);
    for (let i = 0; i < list.length; i++) {
      const after = adds[list[i]].text;
      const parts = diffWordsWithSpace(before, after);
      const space = whitespaceOnly(before, after);
      if (i === 0) {
        pairs.push({
          del: dels[d],
          add: adds[list[0]],
          delHtml: markUp(lost, 'del', space),
          addHtml: markUp(parts, 'add', space),
          space,
        });
        continue;
      }
      // The later pieces have no deletion of their own to sit beside.
      flushAddsBefore(list[i]);
      next = list[i] + 1;
      pairs.push({
        del: null,
        add: adds[list[i]],
        addHtml: markUp(parts, 'add', space),
        space: false,
      });
    }
  }
  flushAddsBefore(adds.length);
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
  // A line that is new or gone outright colours its whole row, rather than
  // pointing at any part of it.
  const extra = space + (row.entire ? ' dv-line-entire' : '');
  let inner = '';
  // The deletion leads, as it does in a unified diff.
  if (row.del) {
    inner += lineHtml('del', row.del.line, null, row.delHtml, extra);
  }
  if (row.add) {
    inner += lineHtml('add', null, row.add.line, row.addHtml, extra);
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
