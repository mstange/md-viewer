/**
 * Tests for links to markdown files named in a document.
 *
 *   node --test
 *
 * The same two properties the commit links have. Which text is a candidate —
 * the scanner runs over raw source and has to leave alone the URLs, prose and
 * non-markdown paths a document is full of. And that a link is only drawn for a
 * file that is really on disk, which is what keeps a page of file names from
 * becoming a page of dead links.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findDocCandidates, renderMarkdown } from '../lib/render.js';
import { openDocuments } from '../lib/docs.js';

test('candidates are code spans holding nothing but a markdown path', () => {
  const source = [
    'See `README.md` and `docs/architecture.md` and `./notes.mdx`.',
    'Bare in prose: README.md — not offered.',
    'A span with more in it: `see README.md` — not offered.',
    'A URL: `https://example.com/a.md` — not a path on this disk.',
    'Another: `//host/a.md` — nor is this.',
    'Not markdown: `lib/render.js` — the viewer would not render it.',
    'A glob: `docs/*.md` — names an idea, not a file.',
  ].join('\n');
  assert.deepEqual(findDocCandidates(source), [
    'README.md',
    'docs/architecture.md',
    './notes.mdx',
  ]);
});

test('every extension the viewer renders is recognised, in any case', () => {
  const spans = ['a.md', 'a.markdown', 'a.mdown', 'a.mkd', 'a.mkdn', 'a.mdx', 'a.MD'];
  assert.deepEqual(
    findDocCandidates(spans.map((name) => `\`${name}\``).join(' ')),
    spans,
  );
});

/** A throwaway repository holding a document and a few files to point at. */
function scratchTree() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-docs-')));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'docs', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');
  fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan\n');
  fs.writeFileSync(path.join(dir, 'docs', 'deep', 'notes.md'), '# notes\n');
  return dir;
}

test('only files that are really there become links', async () => {
  const dir = scratchTree();
  const file = path.join(dir, 'docs', 'index.md');
  const source = 'see `plan.md`, and `missing.md`, and `lib/render.js`\n';
  fs.writeFileSync(file, source);

  const docs = openDocuments(file);
  await docs.resolve(findDocCandidates(source));

  assert.equal(docs.find('plan.md'), path.join(dir, 'docs', 'plan.md'));
  assert.equal(docs.find('missing.md'), null, 'nothing is on disk under that name');

  const { html } = renderMarkdown(source, { baseDir: path.dirname(file), docs });
  assert.match(
    html,
    new RegExp(`<a class="mdv-doc"[^>]*f=${encodeURIComponent(path.join(dir, 'docs', 'plan.md'))}`),
  );
  // The two that resolved to nothing are still code spans, unwrapped.
  assert.equal(html.match(/<a class="mdv-doc"/g).length, 1);
  assert.match(html, /<code>missing\.md<\/code>/);
});

test('a path is read beside the document first, then from the repository root', async () => {
  const dir = scratchTree();
  const file = path.join(dir, 'docs', 'index.md');
  // "README.md" is at the root, not beside the document; "deep/notes.md" is
  // beside it. Both are written the way someone would actually write them.
  const source = 'the `README.md` and the `deep/notes.md` and the `docs/plan.md`\n';
  fs.writeFileSync(file, source);

  const docs = openDocuments(file);
  await docs.resolve(findDocCandidates(source));

  assert.equal(docs.find('README.md'), path.join(dir, 'README.md'), 'found from the root');
  assert.equal(
    docs.find('deep/notes.md'),
    path.join(dir, 'docs', 'deep', 'notes.md'),
    'found beside the document',
  );
  assert.equal(
    docs.find('docs/plan.md'),
    path.join(dir, 'docs', 'plan.md'),
    'a root-relative path still works from a subdirectory',
  );
});

test('the nearer of two files with the same name wins', async () => {
  const dir = scratchTree();
  // A "plan.md" exists both beside the document and at the root. The one being
  // named is almost always the sibling, so that is the one linked.
  fs.writeFileSync(path.join(dir, 'plan.md'), '# the root plan\n');
  const file = path.join(dir, 'docs', 'index.md');
  const source = 'the `plan.md`\n';
  fs.writeFileSync(file, source);

  const docs = openDocuments(file);
  await docs.resolve(findDocCandidates(source));
  assert.equal(docs.find('plan.md'), path.join(dir, 'docs', 'plan.md'));
});

test('an explicitly relative path is not also read from the root', async () => {
  const dir = scratchTree();
  const file = path.join(dir, 'docs', 'index.md');
  // "./README.md" says where to start from, and there is no README beside the
  // document. Reading it from the root as well would be inventing a meaning.
  const source = 'the `./README.md`\n';
  fs.writeFileSync(file, source);

  const docs = openDocuments(file);
  await docs.resolve(findDocCandidates(source));
  assert.equal(docs.find('./README.md'), null);
});

test('a document does not link to itself', async () => {
  const dir = scratchTree();
  const file = path.join(dir, 'docs', 'plan.md');
  const source = 'this file is `plan.md`\n';
  fs.writeFileSync(file, source);

  const docs = openDocuments(file);
  await docs.resolve(findDocCandidates(source));
  assert.equal(docs.find('plan.md'), null, 'a link back to this page is noise');
});

test('a directory that happens to be named like a document is not one', async () => {
  const dir = scratchTree();
  fs.mkdirSync(path.join(dir, 'docs', 'stale.md'));
  const file = path.join(dir, 'docs', 'index.md');
  const source = 'the `stale.md`\n';
  fs.writeFileSync(file, source);

  const docs = openDocuments(file);
  await docs.resolve(findDocCandidates(source));
  assert.equal(docs.find('stale.md'), null);
});

test('a file outside any repository still finds its siblings', async () => {
  // No .git anywhere above, so there is no root to fall back to — but a
  // sibling is still a sibling, which is the common case on a scratch file.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-bare-')));
  fs.writeFileSync(path.join(dir, 'other.md'), '# other\n');
  const file = path.join(dir, 'index.md');
  const source = 'the `other.md` and the `docs/plan.md`\n';
  fs.writeFileSync(file, source);

  const docs = openDocuments(file);
  await docs.resolve(findDocCandidates(source));
  assert.equal(docs.find('other.md'), path.join(dir, 'other.md'));
  assert.equal(docs.find('docs/plan.md'), null);
});

test('a document with no lookup renders exactly as it did before', () => {
  const source = 'see `README.md` here\n';
  const { html } = renderMarkdown(source, { baseDir: os.tmpdir(), docs: null });
  assert.ok(!html.includes('mdv-doc'));
  assert.match(html, /<code>README\.md<\/code>/);
});

test('a file created after a render is picked up by the next one', async () => {
  const dir = scratchTree();
  const file = path.join(dir, 'docs', 'index.md');
  const source = 'the `later.md`\n';
  fs.writeFileSync(file, source);

  const docs = openDocuments(file);
  await docs.resolve(findDocCandidates(source));
  assert.equal(docs.find('later.md'), null);

  // Unlike a commit, a file can appear while the viewer is open, so a "no" is
  // never cached: the document is re-resolved on every render.
  fs.writeFileSync(path.join(dir, 'docs', 'later.md'), '# later\n');
  await docs.resolve(findDocCandidates(source));
  assert.equal(docs.find('later.md'), path.join(dir, 'docs', 'later.md'));
});
