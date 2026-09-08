/**
 * Tests for the diff renderer.
 *
 *   node --test
 *
 * The property the fuzz cases check is the one that has broken twice: every
 * line of the patch appears in the output exactly once, and in the order the
 * patch has it. An earlier version of this test compared the two as sets, and
 * so passed while the renderer was drawing new line 52 above new line 51 —
 * hence the sequence comparison here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDiff, looksLikeDiff } from '../lib/diff.js';

const TAB = String.fromCharCode(9);

/** Wrap a run of `-`/`+`/` ` lines in just enough diff to be parsed. */
function patch(body) {
  const lines = body.split('\n').filter((line) => line !== '');
  const old = lines.filter((line) => line[0] !== '+').length;
  const now = lines.filter((line) => line[0] !== '-').length;
  return `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,${old || 1} +1,${now || 1} @@\n${body}\n`;
}

const unescape = (text) =>
  text
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    // Whitespace-only changes are rendered with visible glyphs.
    .split('·')
    .join(' ')
    .split('→ ')
    .join(TAB);

/**
 * The changed lines of the rendered diff, in the order they are drawn.
 * @returns {{side: '-'|'+', text: string, entire: boolean, marks: number}[]}
 */
function rendered(body) {
  const html = renderDiff(patch(body)).html;
  const rows = [];
  const line = /<div class="(dv-line dv-line-(?:add|del)[^"]*)"[^>]*>([\s\S]*?)<\/div>/g;
  for (const match of html.matchAll(line)) {
    const text = /<span class="dv-text">([\s\S]*?)<\/span>\s*$/.exec(match[2]);
    rows.push({
      side: match[1].includes('dv-line-del') ? '-' : '+',
      text: unescape(text ? text[1] : ''),
      entire: match[1].includes('dv-line-entire'),
      marks: (match[2].match(/dv-word/g) || []).length,
    });
  }
  return rows;
}

/** The lines of one side of the patch, in the order it lists them. */
function source(body, side) {
  return body
    .split('\n')
    .filter((line) => line[0] === side)
    .map((line) => line.slice(1));
}

/**
 * Each side of the rendered diff has to hold exactly the lines the patch put
 * there, in that order. The two sides are checked separately because a diff
 * interleaves them — a deletion is drawn beside the insertion that replaced it,
 * not after every deletion in the run — so the order that matters is the order
 * within each side.
 */
function assertFaithful(body, label) {
  const rows = rendered(body);
  for (const side of ['-', '+']) {
    assert.deepEqual(
      rows.filter((row) => row.side === side).map((row) => row.text),
      source(body, side),
      `${label} (${side} side)`,
    );
  }
}

// ---------------------------------------------------------------------------

test('every changed line is drawn once, in the order the patch has it', async (t) => {
  const cases = {
    'crossed matches': [
      '-alpha alpha alpha alpha zzz',
      '-beta beta beta beta yyy',
      '+beta beta beta beta yyy!',
      '+COMPLETELY UNRELATED BRAND NEW LINE',
      '+alpha alpha alpha alpha zzz!',
    ],
    'fully reversed': ['-a', '-b', '-c', '+c', '+b', '+a'],
    'blank churn': ['-', '-', '+', '+', '+'],
    'pure deletion': ['-gone one', '-gone two'],
    'pure insertion': [' keep', '+new one', '+new two'],
    'rivals for one line': [
      '-the quick brown fox jumps over the lazy dog',
      '+the quick brown fox jumps over the lazy cat',
      '+the quick brown fox jumps over the lazy rat',
    ],
    // The line the deletion resembles most is not the first of the run: drawing
    // the pair there once left the lines above it stranded below.
    'best match is not the first line': [
      '-What you append: the job, plus dated later instructions from the user; a row per try push.',
      '+What you append: the job — the initial prompt *verbatim*, plus dated later instructions',
      '+from the user; a row per try push, the moment you push.',
      '+The `Needs you` list, items leaving it when they are done.',
    ],
    'more deletions than insertions': ['-one', '-two', '-three', '+only'],
    'trailing deletion after a split': [
      '-attached WIP patch, a linked revision. Its findings go into the status file, per test:',
      '-a second line that matches nothing at all here',
      '+attached WIP patch, a linked revision. Two cheap queries first:',
      '+Its findings go into the session log, per test:',
    ],
  };
  for (const [name, lines] of Object.entries(cases)) {
    await t.test(name, () => assertFaithful(lines.join('\n'), name));
  }
});

test('fuzzed runs keep every line, once and in order', () => {
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'.split(' ');
  // A fixed generator, so a failure is reproducible.
  let state = 7;
  const random = () => ((state = (state * 1103515245 + 12345) | 0) >>> 16) / 65536;
  const sentence = () =>
    Array.from({ length: 1 + Math.floor(random() * 6) }, () => words[Math.floor(random() * words.length)]).join(' ');

  for (let round = 0; round < 800; round++) {
    const dels = Math.floor(random() * 6);
    const adds = Math.floor(random() * 6);
    const body = [
      ...Array.from({ length: dels }, () => '-' + sentence()),
      ...Array.from({ length: adds }, () => '+' + sentence()),
    ].join('\n');
    if (body) {
      assertFaithful(body, `round ${round}: ${JSON.stringify(body)}`);
    }
  }
});

// ---------------------------------------------------------------------------

test('a line changed only by whitespace says so', async (t) => {
  const marked = (body) => renderDiff(patch(body)).html.includes('dv-row-space');
  const cases = [
    ['spaces around an operator', '-const v = f(a);\n+const v  =  f(a);', true],
    ['indent respaced to a tab', '-    x = 1;\n+' + TAB + 'x = 1;', true],
    ['trailing space removed', '-foo(); \n+foo();', true],
    ['a blank line loses its indent', '-    \n+', true],
    ['a real edit is not whitespace', '-alpha beta\n+alpha gamma', false],
    ['adding a blank line changes none', '-\n-\n+\n+\n+', false],
  ];
  for (const [name, body, want] of cases) {
    await t.test(name, () => assert.equal(marked(body), want));
  }
});

test('a word that moved is marked, a line that is new is not', async (t) => {
  await t.test('one word in a sentence', () => {
    const rows = rendered('-The quick brown fox jumps over the dog.\n+The quick brown fox leaps over the dog.');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.marks, 1, 'exactly the word that changed');
      assert.equal(row.entire, false);
    }
  });

  await t.test('a phrase is one mark, not one per word', () => {
    const rows = rendered(
      '-attached WIP patch, a linked revision. Its findings go into the status file, per test:\n' +
        '+attached WIP patch, a linked revision. Two cheap queries first:',
    );
    // "Two cheap queries first" is four words but one change.
    assert.equal(rows[1].marks, 1);
  });

  await t.test('an unrelated rewrite is left plain', () => {
    const rows = rendered('-return handleEverythingCarefully(x);\n+throw new Error("nope");');
    for (const row of rows) {
      assert.equal(row.marks, 0, 'no words in common worth pointing at');
    }
  });

  await t.test('a wholly new line colours its row', () => {
    const rows = rendered(' keep\n+brand new line');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entire, true);
    assert.equal(rows[0].marks, 0, 'the row is the mark');
  });

  await t.test('a line split in two marks the words each half kept', () => {
    const rows = rendered(
      '-attached WIP patch, a linked revision. Its findings go into the status file, per test:\n' +
        '+attached WIP patch, a linked revision. Two cheap queries first:\n' +
        '+Its findings go into the session log, per test:',
    );
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.ok(row.marks > 0, 'each line shows what changed in it');
      assert.equal(row.entire, false, 'none of them is new in its entirety');
    }
  });
});

// ---------------------------------------------------------------------------

test('diff content is escaped', () => {
  const html = renderDiff(patch('-safe text here now\n+<script>alert(1)</script> here now')).html;
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('a markdown document that quotes a diff is not one', async (t) => {
  const cases = [
    ['a git diff', true, 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'],
    ['a bare unified diff', true, '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'],
    [
      'a release note showing a patch',
      false,
      '# Notes\n\nWe changed the loader:\n\n```diff\n--- a/c.js\n+++ b/c.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n```\n\nReview before merging.\n',
    ],
    ['a tilde-fenced patch', false, '# Notes\n\n~~~\ndiff --git a/a b/a\n~~~\n\nprose\n'],
    ['prose with a horizontal rule', false, '# Hello\n\nText --- with a dash\n\n---\n\nMore.\n'],
    [
      'a diff after a closed fence',
      true,
      '# Notes\n\n```js\nconst x = 1;\n```\n\ndiff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n',
    ],
  ];
  for (const [name, want, source] of cases) {
    await t.test(name, () => assert.equal(looksLikeDiff(source), want));
  }
});

test('a diff with no file changes still renders', () => {
  const result = renderDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n');
  assert.equal(result.files, 1);
  assert.ok(result.html.includes('No textual changes'));
});
