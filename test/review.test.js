/**
 * Tests for review mode, driven against the real page.
 *
 *   node --test
 *
 * These build the page the viewers serve, run its scripts in a DOM, and then
 * select text the way a reader does — by dragging from one place to another,
 * which is what a Range spanning two nodes is. The cases here are the ones
 * that came back wrong in a real review: side by side lays deletions and
 * insertions in two columns, but they are siblings in the markup, so a
 * selection dragged down one column runs through the other on the way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiffPage } from '../lib/diff-page.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The change from the review this test was written for. */
const PATCH = `diff --git a/browser_dbg-backgroundtask-debugging.js b/browser_dbg-backgroundtask-debugging.js
--- a/browser_dbg-backgroundtask-debugging.js
+++ b/browser_dbg-backgroundtask-debugging.js
@@ -49,8 +49,11 @@ add_task(async function test_backgroundtask_debugger() {
   await pushPref("devtools.browsertoolbox.enable-test-server", true);
   await pushPref("devtools.debugger.prompt-connection", false);

-  // Before we start the background task, the preference file must be flushed to disk.
-  Services.prefs.savePrefFile(null);
+  // savePrefFile(null) writes off the main thread; pass the file explicitly to
+  // force a blocking write.
+  const prefsFile = Services.dirsvc.get("ProfD", Ci.nsIFile);
+  prefsFile.append("prefs.js");
+  Services.prefs.savePrefFile(prefsFile);

   // This invokes the test-only background task \`BackgroundTask_jsdebugger.jsm\`.
   const p = do_backgroundtask("jsdebugger", {
`;

/**
 * The page, loaded and scripted, with the helpers a test needs to act on it.
 *
 * jsdom has no layout and no user, so the two things a reader does are done
 * here instead: `split()` picks the side-by-side layout the way the toggle
 * does, and `select()` makes the Range a drag would have left behind.
 */
async function page(source = PATCH) {
  const html = await buildDiffPage(source, { title: 'f', commit: 'abc123', subtitle: 'a change' });
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  const document = window.document;

  /** The text cell of the nth line of the diff, counting mirrors out. */
  const line = (n) =>
    document.querySelectorAll('#mdv-content .dv-line:not(.dv-line-mirror)')[n].querySelector(
      '.dv-text'
    );

  /** The line holding this text, as the page's own markers say it. */
  const marker = (n) => {
    const side = line(n).closest('.dv-line').dataset.side;
    return side === 'add' ? '+' : side === 'del' ? '-' : ' ';
  };

  /** Every text node under an element, in order, since a line is marked up. */
  const texts = (element) => {
    const out = [];
    const walker = document.createTreeWalker(element, window.NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
  };

  return {
    window,
    document,
    line,
    marker,
    split() {
      const toggle = document.getElementById('dv-layout');
      toggle.checked = true;
      toggle.dispatchEvent(new window.Event('change'));
    },
    /** Drag from the start of line `from` to the end of line `to`. */
    select(from, to) {
      const first = texts(line(from))[0];
      const rest = texts(line(to));
      const last = rest[rest.length - 1];
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent.length);
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

test('a selection down the new column quotes the new column only', async () => {
  const p = await page();
  p.split();
  // The markup runs in patch order: del, del, add, add, add, add, add. The
  // reader drags down the right column from the first insertion to the last;
  // within one run that stays in the right column, and the deletions are what
  // the drag must not pick up when a run's insertions follow them.
  assert.deepEqual([3, 4, 5, 6, 7, 8, 9].map(p.marker), ['-', '-', '+', '+', '+', '+', '+']);
  await p.select(5, 9);
  p.comment('this is abusing a bug of the pref service');

  const prompt = p.prompt();
  assert.match(prompt, /savePrefFile\(null\) writes off the main thread/);
  assert.doesNotMatch(
    prompt.split('```diff')[0],
    /Before we start the background task/,
    'the quote should not reach into the old column'
  );
  assert.doesNotMatch(
    prompt.split('```diff')[0],
    /savePrefFile\(null\);/,
    'the deleted call sits between the selected lines, and is not part of them'
  );
});

test('the quoted diff covers every line the comment was written on', async () => {
  const p = await page();
  p.split();
  await p.select(5, 9);
  p.comment('why');

  const quoted = p.prompt().split('```diff')[1].split('```')[0];
  for (const text of [
    'writes off the main thread',
    'force a blocking write',
    'Services.dirsvc.get',
    'prefsFile.append',
  ]) {
    assert.ok(quoted.includes(text), `the quoted diff should include ${text}`);
  }
});

test('the quoted diff reads as a patch does, both sides in order', async () => {
  const p = await page();
  p.split();
  await p.select(5, 5);
  p.comment('why');

  const quoted = p.prompt().split('```diff')[1].split('```')[0];
  const markers = quoted
    .split('\n')
    .map((line) => line.trim()[0])
    .filter((c) => c === '+' || c === '-');
  // Deletions come before the insertions that replaced them, as in a unified
  // diff, and the two sides are not interleaved.
  assert.deepEqual(markers, ['-', '-', '+', '+', '+']);
});

test('a comment on several lines names them instead of running them together', async () => {
  const p = await page();
  p.split();
  await p.select(5, 9);
  p.comment('why');

  const header = p.prompt().split('\n').find((line) => line.startsWith('- '));
  assert.match(header, /5 lines from "\/\/ savePrefFile\(null\) writes off the main thread/);
  // Five lines of code on one line is what the quote used to be.
  assert.doesNotMatch(header, /prefsFile\.append/);
});

test('a comment within one line still quotes the words it is about', async () => {
  const p = await page();
  p.split();
  await p.select(5, 5);
  p.comment('why');

  const header = p.prompt().split('\n').find((line) => line.startsWith('- '));
  assert.match(header, /— "\/\/ savePrefFile\(null\) writes off the main thread/);
});

test('a comment survives a live reload of the same diff', async () => {
  const p = await page();
  p.split();
  await p.select(5, 9);
  p.comment('why');
  const before = p.prompt();

  // A reload re-renders the article and asks review mode to find its anchors
  // again, which it does from the text it recorded them against.
  p.window.mdvReviewReattach();
  assert.equal(p.document.querySelectorAll('mark.mdv-mark[data-comment-id]').length > 0, true);
  assert.equal(p.prompt(), before);
});

test('unified reads every line, since it has only one column', async () => {
  const p = await page();
  // No split, so no two sides to keep apart: a drag from the first deletion to
  // the last insertion means all of it, and the quoted diff says so.
  await p.select(3, 9);
  p.comment('why');
  const prompt = p.prompt();

  const header = prompt.split('\n').find((line) => line.startsWith('- '));
  assert.match(header, /7 lines from "\/\/ Before we start the background task/);
  const quoted = prompt.split('```diff')[1].split('```')[0];
  assert.match(quoted, /Before we start the background task/);
  assert.match(quoted, /writes off the main thread/);
});

/** Select the whole of one paragraph, the way dragging across it does. */
async function selectParagraph(window, index) {
  const d = window.document;
  const range = d.createRange();
  range.selectNodeContents(d.querySelectorAll('#mdv-content p')[index].firstChild);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  d.dispatchEvent(new window.Event('selectionchange'));
  // Selections have to hold still before the comment box opens.
  await new Promise((resolve) => window.setTimeout(resolve, 400));
}

/** The markdown page, the plainest thing review mode runs on. */
async function markdownPage() {
  const review = await fsp.readFile(path.join(ROOT, 'assets', 'review.js'), 'utf8');
  const dom = new JSDOM(
    '<div id="mdv-root" data-file="notes.md"><article id="mdv-content">' +
      '<p>The first paragraph.</p><p>The second paragraph.</p>' +
      '</article></div>' +
      '<div id="mdv-review" class="mdv-review-bar" hidden>' +
      '<span class="mdv-review-count"></span>' +
      '<button type="button" class="mdv-review-copy"></button></div>' +
      `<script>${review}<\/script>`,
    { runScripts: 'dangerously' }
  );
  return dom.window;
}

/** Press a key on the document, as a reader who has not clicked anything does. */
const press = (window, key, init) =>
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  );

/**
 * A markdown document has no columns and no hooks, so review mode there is the
 * plain case: the whole article is one text, and a comment quotes what was
 * selected. This is the behaviour the diff work had to leave alone.
 */
test('a markdown document quotes the selection, as it always did', async () => {
  const window = await markdownPage();
  const d = window.document;

  await selectParagraph(window, 1);

  const textarea = d.querySelector('.mdv-review-box textarea');
  assert.ok(textarea, 'a comment box should be open');
  textarea.value = 'say which one';
  textarea.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );

  let copied = null;
  window.navigator.clipboard = { writeText: (text) => ((copied = text), Promise.resolve()) };
  d.querySelector('.mdv-review-copy').click();
  assert.match(copied, /review comments on notes\.md/);
  assert.match(copied, /— "The second paragraph\."/);
  assert.match(copied, /say which one/);
});

test('the selection stays put when the comment box opens, so it can be copied', async () => {
  const window = await markdownPage();

  await selectParagraph(window, 1);

  assert.ok(window.document.querySelector('.mdv-review-box'), 'a comment box should be open');
  assert.equal(
    window.getSelection().toString(),
    'The second paragraph.',
    'the reader should still be able to copy what they selected'
  );
  assert.notEqual(
    window.document.activeElement.nodeName,
    'TEXTAREA',
    'the box should not have taken the focus, which would collapse the selection'
  );
});

test('typing hands the focus to the comment box, which is what typing meant', async () => {
  const window = await markdownPage();

  await selectParagraph(window, 1);
  press(window, 'a');

  assert.equal(window.document.activeElement.nodeName, 'TEXTAREA');
});

test('escape cancels the comment even though the box never took the focus', async () => {
  const window = await markdownPage();
  const d = window.document;

  await selectParagraph(window, 1);
  press(window, 'Escape');

  assert.equal(d.querySelector('.mdv-review-box'), null, 'the box should be gone');
  assert.equal(
    d.querySelectorAll('mark.mdv-mark').length,
    0,
    'the highlight should go with it, rather than being left behind'
  );
});

test('escape keeps a comment already saved, having only closed its box', async () => {
  const window = await markdownPage();
  const d = window.document;

  await selectParagraph(window, 1);
  press(window, 'a');
  const textarea = d.querySelector('.mdv-review-box textarea');
  textarea.value = 'say which one';
  textarea.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );

  d.querySelector('mark.mdv-mark').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  press(window, 'Escape');

  assert.equal(d.querySelector('.mdv-review-box'), null);
  assert.equal(d.querySelectorAll('mark.mdv-mark').length, 1, 'the comment should still be there');
});

test('a box that closes takes its waiting-to-type listener with it', async () => {
  const window = await markdownPage();
  const d = window.document;

  // Only the capturing keydown listener is the one that waits for typing.
  let live = 0;
  const add = d.addEventListener.bind(d);
  const remove = d.removeEventListener.bind(d);
  d.addEventListener = (type, fn, capture) => {
    if (type === 'keydown' && capture === true) live++;
    return add(type, fn, capture);
  };
  d.removeEventListener = (type, fn, capture) => {
    if (type === 'keydown' && capture === true) live--;
    return remove(type, fn, capture);
  };

  for (let i = 0; i < 3; i++) {
    await selectParagraph(window, i % 2);
    press(window, 'Escape');
  }

  assert.equal(live, 0, 'selecting again and again should not pile up listeners');
});

test('a copy shortcut leaves the selection alone, since copying is why it is there', async () => {
  const window = await markdownPage();

  await selectParagraph(window, 1);
  press(window, 'c', { metaKey: true });

  assert.notEqual(window.document.activeElement.nodeName, 'TEXTAREA');
  assert.equal(window.getSelection().toString(), 'The second paragraph.');
});

/**
 * Pasting is the other way a comment gets written, and it used to be lost: the
 * focus was still on the document, where a paste has nowhere to go, because the
 * wait-for-typing rule refused every keystroke carrying a modifier.
 */
test('a paste hands the focus to the box, since pasting is also writing', async () => {
  const window = await markdownPage();

  await selectParagraph(window, 1);
  press(window, 'v', { metaKey: true });

  assert.equal(
    window.document.activeElement.nodeName,
    'TEXTAREA',
    'the text being pasted has to land somewhere'
  );
});

test('Ctrl+V pastes too, for a keyboard that says Ctrl', async () => {
  const window = await markdownPage();

  await selectParagraph(window, 1);
  press(window, 'v', { ctrlKey: true });

  assert.equal(window.document.activeElement.nodeName, 'TEXTAREA');
});

test('AltGr+V is a letter on the layouts that write one', async () => {
  const window = await markdownPage();

  await selectParagraph(window, 1);
  // Windows reports AltGr as Ctrl+Alt, so this pair is not a paste shortcut.
  // The letter it produces arrives as its own keydown, which does focus the box.
  press(window, 'v', { ctrlKey: true, altKey: true });

  assert.notEqual(window.document.activeElement.nodeName, 'TEXTAREA');
});

test('the focus moves before the paste, so the pasted text is the comment', async () => {
  const window = await markdownPage();
  const d = window.document;

  await selectParagraph(window, 1);
  // The keydown is not consumed, so the paste that follows it is delivered
  // normally — by which time the textarea is where it goes.
  press(window, 'v', { metaKey: true });

  const textarea = d.querySelector('.mdv-review-box textarea');
  const pasted = new window.Event('paste', { bubbles: true, cancelable: true });
  d.activeElement.dispatchEvent(pasted);
  assert.equal(pasted.target, textarea, 'the paste should be aimed at the comment box');

  // jsdom carries no clipboard, so stand in for what the browser would insert.
  textarea.value = 'pasted words';
  textarea.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );

  let copied = null;
  window.navigator.clipboard = { writeText: (text) => ((copied = text), Promise.resolve()) };
  d.querySelector('.mdv-review-copy').click();
  assert.match(copied, /pasted words/);
});

test('a comment across a bug link in the message quotes the text as written', async () => {
  const shown =
    'commit 0123456789abcdef0123456789abcdef01234567\nAuthor: A <a@example.invalid>\n\n' +
    '    Bug 1951421 - Hold the decision as one value\n\n' +
    PATCH;
  const p = await page(shown);
  // The first line of the page is the subject, which the link splits into
  // three text nodes; the reader drags across all of them.
  assert.equal(p.line(0).closest('.dv-line').dataset.side, 'msg');
  assert.ok(p.line(0).querySelector('a.dv-bug'), 'the bug is a link');
  await p.select(0, 0);
  p.comment('is this the right bug?');

  const prompt = p.prompt();
  assert.match(prompt, /- the commit message, line 1 — "Bug 1951421 - Hold the decision as one value"/);
  assert.match(prompt, /\n  Bug 1951421 - Hold the decision as one value\n/, 'quoted as prose, once');
});
