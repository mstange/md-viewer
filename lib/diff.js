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
 * marked `mdv-aside`, which review.js leaves out of the text it searches and
 * quotes, so a line drawn twice is still anchored and quoted once.
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
 * What two lines have in common: the length of the shared text, that length as
 * a fraction of the two, and the stretches of the *first* line that the second
 * accounts for. The ranges are what tells a line split in two from two rivals
 * for the same text — pieces of a split cover different parts of the original,
 * rivals cover the same part twice.
 */
function overlap(parts) {
  let common = 0;
  let total = 0;
  let at = 0;
  const ranges = [];
  for (const part of parts) {
    const length = part.value.length;
    total += length;
    if (part.added) {
      // Present only in the second line, so it advances nothing in the first.
      continue;
    }
    if (!part.removed) {
      common += length;
      ranges.push([at, at + length]);
    }
    at += length;
  }
  // Shared text is counted once but spans both lines, hence the doubling.
  return { common, ranges, ratio: total ? (2 * common) / (total + common) : 1 };
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
  const show = (text) => (showSpace ? visibleSpace(text) : escape(text));

  // The word diff hands back one part per word, so a changed phrase arrives as
  // several parts with the spaces between them unchanged. Marking each on its
  // own would draw a run of blocks with gaps at every space; the phrase is one
  // change, so it is gathered into one mark. Only whitespace is absorbed that
  // way — a space between two changed words is inside the phrase, while any
  // real text between them means they are two separate changes.
  let html = '';
  let run = '';
  /** Whitespace after the current run, pending a word that would extend it. */
  let gap = '';

  const flush = () => {
    if (run) {
      html += `<span class="dv-word">${run}</span>`;
      run = '';
    }
    html += gap;
    gap = '';
  };

  for (const part of parts) {
    if (part[theirs]) {
      continue;
    }
    if (part[mine]) {
      // The gap before this word is part of the phrase, not a break in it.
      run += gap + show(part.value);
      gap = '';
    } else if (run && !part.value.trim()) {
      gap += show(part.value);
    } else {
      flush();
      html += show(part.value);
    }
  }
  flush();
  return html;
}

/** Total length covered by a set of [start, end) ranges, counting overlaps once. */
function union(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -1;
  for (const [from, to] of sorted) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
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
  /** Per deletion, the stretches of it each candidate insertion accounts for. */
  const covered = dels.map(() => []);

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
      const before = dels[d].text;
      const after = adds[a].text;
      const { ranges, ratio } = overlap(diffWordsWithSpace(before, after));
      // Two lines that hold nothing but whitespace share no words to score, so
      // similarity puts them at zero however alike they are — and a line whose
      // indentation was changed or dropped is the clearest case there is of one
      // line becoming another. Pair them on being blank alone.
      const blank = !before.trim() && !after.trim();
      if (!blank && ratio < SIMILARITY_FLOOR) {
        continue;
      }
      // A blank pair scores above the floor so it can win its line, but below
      // any real match, which should always be preferred to it.
      const score = blank ? SIMILARITY_FLOOR : ratio;
      scores.push({ d, a, score });
      note(bestDel[d], score);
      note(bestAdd[a], score);
      covered[d].push(ranges);
    }
  }

  // A deletion was split rather than rewritten when its candidates account
  // between them for nearly all of it *and* each holds a part the others do
  // not. Both halves matter: coverage alone is met by a single near-identical
  // candidate, and distinctness alone by two lines sharing one word. Rivals for
  // the same line fail the second test — they cover the same stretch twice —
  // which is what leaves them to the tie rejection below. An empty line covers
  // nothing and is nobody's half.
  const split = dels.map((del, d) => {
    const pieces = covered[d];
    if (!del.text.length || pieces.length < 2) {
      return false;
    }
    if (union(pieces.flat()) < del.text.length * SPLIT_COVERAGE) {
      return false;
    }
    // Every piece has to earn its place: take it away and the coverage drops,
    // because it was holding text none of the others hold.
    const whole = union(pieces.flat());
    return pieces.every((_, i) => union(pieces.filter((__, j) => j !== i).flat()) < whole);
  });

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

  /** For each insertion, the deletion it is a piece of. */
  const pieceOf = new Map();
  for (const [d, list] of matched) {
    for (const at of list) pieceOf.set(at, d);
  }

  // Both sides are emitted in their own order — that order is the file, and no
  // amount of matching may disturb it. Deletions are laid against insertions
  // from the top down, so the nth old line of a run meets the nth new one.
  //
  // Position, not score, is what decides which row a deletion is drawn on. A
  // sentence rewritten over three lines often resembles one of the middle ones
  // most, because that is where its surviving words landed; drawing the old
  // line against that one would leave the insertions above it stranded and the
  // diff reading out of order. The matcher still says whether two lines are a
  // pair and how they are marked against each other — this only says where.
  const pairs = [];
  let d = 0;
  let at = 0;

  // Runs until both sides are spent. A row that carries the continuation of a
  // line drawn above takes an insertion without taking a deletion, so the two
  // sides do not advance in step and neither length alone bounds the walk.
  while (at < adds.length || d < dels.length) {
    const add = at < adds.length ? adds[at] : null;
    const del = d < dels.length ? dels[d] : null;

    // An insertion that continues a deletion drawn on an earlier row has no
    // deletion of its own: that line is already accounted for above.
    const owner = add ? pieceOf.get(at) : undefined;
    const continues = owner !== undefined && matched.get(owner)[0] !== at;

    if (add && continues) {
      at++;
      const before = dels[owner].text;
      const parts = diffWordsWithSpace(before, add.text);
      pairs.push({
        del: null,
        add,
        addHtml: markUp(parts, 'add', whitespaceOnly(before, add.text)),
        space: false,
      });
      continue;
    }

    if (!del) {
      at++;
      pairs.push({ del: null, add, addHtml: escape(add.text), space: false, entire: true });
      continue;
    }
    const mine = d;
    d++;
    if (!add) {
      pairs.push({ del, add: null, delHtml: escape(del.text), space: false, entire: true });
      continue;
    }
    const row = at;
    at++;

    // Whether these two are a version of each other, in the matcher's opinion.
    // A row can bring together a deletion and an insertion it was not matched
    // to — the two sides are laid out in their own order, and matching does not
    // have to agree with it. Those are shown plain: neither is an edit of the
    // other, and marking the words they happen to share would claim otherwise.
    const list = matched.get(mine);
    const before = del.text;
    if (!list || !list.includes(row)) {
      pairs.push({
        del,
        add,
        delHtml: escape(before),
        addHtml: escape(add.text),
        space: false,
        entire: true,
      });
      continue;
    }

    // The deletion is marked against every piece at once: text that moved to a
    // later line has not gone anywhere, and marking it as removed on a line
    // whose words are still in the file two lines down is the opposite of what
    // happened.
    const parts = diffWordsWithSpace(before, add.text);
    const space = whitespaceOnly(before, add.text);
    const lost = diffWordsWithSpace(before, list.map((i) => adds[i].text).join('\n'));
    pairs.push({
      del,
      add,
      delHtml: markUp(lost, 'del', space),
      addHtml: markUp(parts, 'add', space),
      space,
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Turn a hunk's changes into rows: a context line, or a deletion and the
 * insertion that replaced it, either of which may be missing. Consecutive
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
function lineHtml(side, oldLine, newLine, html, extra = '', attrs = '') {
  const marker = { del: '-', add: '+', ctx: ' ' }[side];
  const line = side === 'del' ? oldLine : newLine;
  return (
    `<div class="dv-line dv-line-${side}${extra}" data-side="${side}"` +
    (line == null ? '' : ` data-line="${line}"`) +
    (extra.includes('dv-line-space') ? ' title="whitespace-only change"' : '') +
    attrs +
    '>' +
    `<span class="dv-num dv-num-old mdv-aside">${oldLine ?? ''}</span>` +
    `<span class="dv-num dv-num-new mdv-aside">${newLine ?? ''}</span>` +
    `<span class="dv-marker mdv-aside" aria-hidden="true">${marker}</span>` +
    `<span class="dv-text">${html}</span>` +
    '</div>'
  );
}

/**
 * An unchanged line, drawn twice: side by side shows it in both columns. The
 * second copy is marked as an aside: review.js leaves that text out of the
 * document it searches and quotes, so the line still counts once when a
 * comment is anchored, however many times it is drawn.
 */
function contextHtml(row) {
  const text = escape(row.text);
  return (
    '<div class="dv-row dv-row-context">' +
    lineHtml('ctx', row.oldLine, row.newLine, text) +
    '<div class="dv-line dv-line-ctx dv-line-mirror mdv-aside" aria-hidden="true">' +
    `<span class="dv-num dv-num-new">${row.newLine ?? ''}</span>` +
    '<span class="dv-marker"> </span>' +
    `<span class="dv-text">${text}</span>` +
    '</div>' +
    '</div>'
  );
}

/**
 * A run of changed lines: the deletions, then the insertions that replaced
 * them, in the order the patch has them.
 *
 * That is the order a patch reads in, and the order the markup keeps. It used
 * to hold each deletion next to the insertion it was paired with, so that side
 * by side could draw the two on one row by nesting them — and unified, which
 * shows the markup as it is, then read del, add, del, add: two functions
 * shuffled together line by line. The pairing is still known, and is recorded
 * on each line as the row it belongs to, `--dv-row`; side by side places the
 * lines on their rows by that number, and unified needs nothing.
 *
 * Text selection follows the markup, so this is also what makes a drag down
 * the unified view select what it appears to.
 */
function blockHtml(rows) {
  const dels = [];
  const adds = [];
  rows.forEach((row, i) => {
    const place = ` style="--dv-row: ${i + 1}"`;
    const space = row.space ? ' dv-line-space' : '';
    // A line that is new or gone outright colours its whole row, rather than
    // pointing at any part of it.
    const extra = space + (row.entire ? ' dv-line-entire' : '');
    if (row.del) {
      dels.push(lineHtml('del', row.del.line, null, row.delHtml, extra, place));
    }
    if (row.add) {
      adds.push(lineHtml('add', null, row.add.line, row.addHtml, extra, place));
    }
  });
  return `<div class="dv-block">${dels.join('')}${adds.join('')}</div>`;
}

/** The rows of a hunk as markup, with each run of changes gathered in a block. */
function hunkRowsHtml(rows) {
  let html = '';
  let run = [];
  const flush = () => {
    if (run.length) html += blockHtml(run);
    run = [];
  };
  for (const row of rows) {
    if (row.type === 'context') {
      flush();
      html += contextHtml(row);
    } else {
      run.push(row);
    }
  }
  flush();
  return html;
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

/**
 * How many digits the widest line number in this file's hunks has. The
 * gutter is sized from it: a fixed width that fits four digits folds the
 * fifth onto a second row, and a file of ten thousand lines is not rare.
 * Three at least, so a short file's gutter is still a gutter.
 */
function gutterDigits(file) {
  let widest = 0;
  for (const chunk of file.chunks) {
    widest = Math.max(widest, chunk.oldStart + chunk.oldLines, chunk.newStart + chunk.newLines);
  }
  return Math.max(3, String(widest).length);
}

function fileHtml(file, index) {
  const rows = file.chunks.map((chunk) => hunkHeader(chunk) + hunkRowsHtml(rowsOf(chunk))).join('');

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
      ? `<div class="dv-table" style="--dv-digits: ${gutterDigits(file)}">${rows}</div>`
      : '<div class="dv-file-empty">No textual changes.</div>') +
    '</section>'
  );
}

// ---------------------------------------------------------------------------
// The commit message above a patch
// ---------------------------------------------------------------------------

/**
 * Split the preamble `git show` puts above the first file off the patch.
 *
 * A patch of a commit carries the message that explains it, and the message is
 * the part that says *why* — which is most of what a reviewer needs and all of
 * what the subject line alone leaves out. parse-diff only looks at the file
 * sections, so left in the source it is silently dropped.
 *
 * Recognised by the header `git show` always writes first: a `commit <sha>`
 * line. A patch from `git diff`, or one piped in from anywhere else, has no
 * such header and is returned unchanged — there is no message to find, and
 * guessing from arbitrary leading text would eat a real diff's context.
 *
 * @returns {{message: {headers: Array<[string, string]>, body: string}|null,
 *            patch: string}}
 */
export function splitCommitMessage(source) {
  if (!/^commit [0-9a-f]{7,40}/.test(source)) {
    return { message: null, patch: source };
  }
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  // The headers run to the first blank line: `commit`, then the trailer lines
  // git chooses — Author, Date, and on a merge a Merge line as well.
  const headers = [];
  let i = 0;
  for (; i < lines.length && lines[i].trim(); i++) {
    const match = /^(\w+):?\s+(.*)$/.exec(lines[i]);
    if (match) {
      headers.push([match[1], match[2].trim()]);
    }
  }

  // The message body is indented by four spaces; the diff and the --stat block
  // that may precede it are not, so the first line that is neither indented nor
  // blank ends the message.
  const body = [];
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('    ')) {
      body.push(line.slice(4));
    } else if (!line.trim()) {
      body.push('');
    } else {
      break;
    }
  }

  // Everything from here on is the --stat block and the diff itself. The stat
  // is left in the patch text: parse-diff ignores it, and the summary the page
  // draws is counted from the files rather than read out of it.
  return {
    message: { headers, body: body.join('\n').trim() },
    patch: lines.slice(i).join('\n'),
  };
}

/**
 * Where a bug number in a commit message points. Mozilla's Bugzilla unless
 * `MD_VIEWER_BUG_URL` says otherwise, with `{id}` standing for the number.
 */
const BUG_URL = process.env.MD_VIEWER_BUG_URL || 'https://bugzilla.mozilla.org/show_bug.cgi?id={id}';

/**
 * Turn `Bug 1951421` in an escaped line of the message into a link to the bug.
 *
 * The bug is where the message's context lives — the discussion, the earlier
 * attempts, the tests that failed — and a reviewer reading "Bug 1951421 -
 * Hold the gesture decision" wants to read the bug next. The whole reference
 * is the link, so the word is the click target and not only the number.
 *
 * Four digits at least: a message that says "bug 2" is not naming one. The
 * link opens in a new tab, as every outward link in the viewer does, so the
 * review being written in this one is not unloaded.
 *
 * Runs on escaped text, so the number is the only thing rewritten and the
 * text nodes review.js reads are unchanged apart from the boundary the link
 * adds — which a comment across it already survives, as it does a bold run.
 */
export function linkBugs(html) {
  return html.replace(/\b(bug\s+#?)(\d{4,8})\b/gi, (match, word, id) => {
    const href = BUG_URL.replace('{id}', id);
    return `<a class="dv-bug" href="${escape(href)}" target="_blank" rel="noopener">${match}</a>`;
  });
}

/**
 * The commit message as a block above the files.
 *
 * Inside the article rather than in the toolbar, and built out of the same
 * line rows the diff uses: a reviewer wants to comment on the message at least
 * as often as on the code — a claim in it can be wrong when every line of the
 * patch is right — and only content in the document can be selected, anchored
 * and quoted back. `data-side="msg"` is what tells the page's review hooks that
 * a comment here belongs to the message and not to a file.
 */
function messageHtml(message) {
  const rows = message.body
    .split('\n')
    .map(
      (line, i) =>
        `<div class="dv-line dv-line-msg" data-side="msg" data-msg-line="${i + 1}">` +
        `<span class="dv-num"></span>` +
        // A blank line stays genuinely empty. Padding it with a non-breaking
        // space would give the row its height, but it also becomes the row's
        // text — and a review that quotes the message back would carry a
        // U+00A0 where the writer left an empty line. The height comes from
        // CSS instead, which the copied text cannot see.
        `<span class="dv-text">${linkBugs(escape(line))}</span>` +
        '</div>',
    )
    .join('');

  const headers = message.headers
    .filter(([key]) => key !== 'commit')
    .map(
      ([key, value]) =>
        `<div class="dv-msg-header"><span class="dv-msg-key">${escape(key)}</span>` +
        `<span class="dv-msg-value">${escape(value)}</span></div>`,
    )
    .join('');

  return (
    '<section class="dv-file dv-message" data-path="the commit message">' +
    '<header class="dv-file-header">' +
    '<span class="dv-file-name">Commit message</span>' +
    headers +
    '</header>' +
    `<div class="dv-table dv-msg-table">${rows}</div>` +
    '</section>'
  );
}

/**
 * Render a unified diff.
 * @returns {{html: string, files: number, additions: number, deletions: number}}
 */
export function renderDiff(source) {
  const { message, patch } = splitCommitMessage(source);
  const head = message ? messageHtml(message) : '';
  const files = parseDiff(patch);
  if (!files.length) {
    return {
      html: head + '<div class="dv-empty-diff">This diff has no file changes.</div>',
      files: 0,
      additions: 0,
      deletions: 0,
      message: message?.body || null,
    };
  }

  const html = head + files.map((file, i) => fileHtml(file, i)).join('\n');
  return {
    html,
    message: message?.body || null,
    files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

/**
 * Guess whether some text is a diff, from the markers a unified diff has to
 * carry. Used to let the viewer accept a file without being told what it is.
 *
 * Fenced code blocks are skipped: a document that shows a patch in a ```diff
 * block is a document about a patch, and reading it as one would throw away
 * every word around it. Markdown is the only format this has to be careful
 * about, since it is the only one the caller would otherwise render.
 */
export function looksLikeDiff(source) {
  const head = source.slice(0, 8192).split('\n', 200);
  let fence = null;
  for (let i = 0; i < head.length; i++) {
    const line = head[i];

    // ``` or ~~~, any length from three up; the same run has to close it.
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) {
        fence = marker[1][0].repeat(3);
        continue;
      }
      if (marker[1].startsWith(fence)) {
        fence = null;
      }
      continue;
    }
    if (fence) {
      continue;
    }

    if (/^diff --git /.test(line) || /^Index: /.test(line)) return true;
    // A --- / +++ / @@ trio is the minimum a bare unified diff can have.
    if (/^--- /.test(line) && /^\+\+\+ /.test(head[i + 1] || '') && /^@@ /.test(head[i + 2] || '')) {
      return true;
    }
  }
  return false;
}
