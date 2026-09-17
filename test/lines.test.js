/**
 * Tests for the source lines a review comment reports.
 *
 *   node --test
 *
 * A table or a list is one block to the markdown lexer, so stamping only
 * top-level blocks made every comment on a fourteen-row table say line 79 —
 * the line the table starts on, which names no row. These cases pin each row,
 * each item and each nested block to its own line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../lib/render.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Render `source` and return the line each passage of text was stamped with. */
function lines(source) {
  const { html } = renderMarkdown(source, { baseDir: os.tmpdir() });
  const dom = new JSDOM(`<article>${html}</article>`);
  /** The line of the innermost stamped block holding `text`. */
  return (text) => {
    const blocks = [...dom.window.document.querySelectorAll('[data-line]')].filter((element) =>
      element.textContent.includes(text)
    );
    assert.ok(blocks.length, `no block holds ${JSON.stringify(text)}`);
    // Innermost: the deepest match is the one a comment on that text reports.
    const block = blocks[blocks.length - 1];
    return Number(block.dataset.line);
  };
}

test('each row of a table is on its own line', () => {
  const line = lines(
    [
      '# Bugs', // 1
      '', //      2
      '| Bug | Do |', //       3
      '| --- | --- |', //      4
      '| 1970996 | reopen |', //  5
      '| 2031620 | reopen |', //  6
      '| 2064559 | comment |', // 7
      '', //      8
      'after', // 9
    ].join('\n')
  );

  assert.equal(line('Bug'), 3, 'the header row is the line the table starts on');
  assert.equal(line('1970996'), 5);
  assert.equal(line('2031620'), 6);
  assert.equal(line('2064559'), 7);
  assert.equal(line('after'), 9);
});

test('each item of a list is on its own line', () => {
  const line = lines(
    [
      '- first', //      1
      '- second', //     2
      '  - nested', //   3
      '- fourth', //     4
      '', //             5
      '1. ordered a', // 6
      '2. ordered b', // 7
    ].join('\n')
  );

  assert.equal(line('first'), 1);
  assert.equal(line('second'), 2);
  assert.equal(line('nested'), 3);
  assert.equal(line('fourth'), 4);
  assert.equal(line('ordered a'), 6);
  assert.equal(line('ordered b'), 7);
});

test('a block nested in a list item is on its own line', () => {
  const line = lines(
    [
      '- loose one', //             1
      '', //                        2
      '  its second paragraph', //  3
      '', //                        4
      '- loose two', //             5
      '', //                        6
      '  ```js', //                 7
      '  code();', //               8
      '  ```', //                   9
      '', //                       10
      '- loose three', //          11
    ].join('\n')
  );

  assert.equal(line('loose one'), 1);
  assert.equal(line('code();'), 7);
  assert.equal(line('loose three'), 11);
});

test('each paragraph of a quote is on its own line', () => {
  const line = lines(
    [
      '> quoted a', // 1
      '>', //          2
      '> quoted b', // 3
    ].join('\n')
  );

  assert.equal(line('quoted a'), 1);
  assert.equal(line('quoted b'), 3);
});

test('frontmatter moves every line down by the lines it takes', () => {
  const line = lines(
    [
      '---', //           1
      'title: X', //      2
      '---', //           3
      '', //              4
      '| a | b |', //     5
      '| --- | --- |', // 6
      '| r1 | x |', //    7
      '| r2 | y |', //    8
    ].join('\n')
  );

  assert.equal(line('r1'), 7);
  assert.equal(line('r2'), 8);
});

test('a table written with CRLF lines counts each line once', () => {
  // The lexer normalises line endings before tokenising, so the measurement
  // has to see the same text: \r\n is one line, not one and a bit.
  const { html } = renderMarkdown('| a |\r\n| --- |\r\n| r1 |\r\n', { baseDir: os.tmpdir() });
  assert.match(html, /<td data-line="3">r1<\/td>/);
});

// ---------------------------------------------------------------------------
// And the same thing through the page a reader actually comments on
// ---------------------------------------------------------------------------

/** The document under review: the shape that reported line 79 fourteen times. */
const DOC = [
  '# Burndown', //            1
  '', //                      2
  '### The Bugzilla edits', // 3
  '', //                      4
  '| Bug | Do | Why |', //     5
  '| --- | --- | --- |', //    6
  '| 1970996 | reopen | auto-closed while still failing |', //  7
  '| 2031620 | reopen | clicked a pinned tab |', //             8
  '| 2064559 | comment | carries the waitForPreloaded fix |', // 9
  '', //                     10
  '- and one list item', //  11
].join('\n');

/**
 * The served page, scripted, with the helpers a test needs to act on it. The
 * markup is the part of md-viewer's page that review mode reads: the article,
 * the file the comments are about, and the bar the copy button lives on.
 */
async function page(source = DOC) {
  const { html } = renderMarkdown(source, { baseDir: os.tmpdir() });
  const script = await fsp.readFile(path.join(ROOT, 'assets/review.js'), 'utf8');
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
<div id="mdv-root" data-file="/build/artifacts/overview.md">
<article id="mdv-content">${html}</article>
</div>
<div id="mdv-review" hidden>
<span class="mdv-review-count"></span>
<button type="button" class="mdv-review-copy">Copy review</button>
</div>
<script>${script}</script>
</body></html>`,
    { runScripts: 'dangerously' }
  );
  const { window } = dom;
  const document = window.document;

  return {
    /** Select the whole of the first element matching `selector`, as a drag does. */
    async select(selector) {
      const element = document.querySelector(selector);
      assert.ok(element, `nothing matches ${selector}`);
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));
      document.dispatchEvent(new window.Event('mouseup', { bubbles: true }));
      // Selections have to hold still before the comment box opens.
      return new Promise((resolve) => window.setTimeout(resolve, 400));
    },
    /** Write a comment on the pending selection and save it, as Enter does. */
    comment(text) {
      const box = document.querySelector('.mdv-review-box');
      assert.ok(box, 'a comment box should be open');
      const textarea = box.querySelector('textarea');
      textarea.value = text;
      textarea.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    },
    /** What Copy review would put on the clipboard. */
    prompt() {
      let copied = null;
      window.navigator.clipboard = { writeText: (text) => ((copied = text), Promise.resolve()) };
      document.querySelector('.mdv-review-copy').click();
      return copied;
    },
  };
}

test('comments on two rows of a table name the two rows', async () => {
  const p = await page();
  await p.select('tbody tr:nth-child(1) td:nth-child(2)');
  p.comment('done');
  await p.select('tbody tr:nth-child(2) td:nth-child(2)');
  p.comment('also done');

  const headers = p
    .prompt()
    .split('\n')
    .filter((line) => line.startsWith('- '));
  assert.deepEqual(headers, ['- overview.md:7 — "reopen"', '- overview.md:8 — "reopen"']);
});

test('a comment on a list item names the item', async () => {
  const p = await page();
  await p.select('ul li');
  p.comment('why');

  const header = p
    .prompt()
    .split('\n')
    .find((line) => line.startsWith('- '));
  assert.equal(header, '- overview.md:11 — "and one list item"');
});
