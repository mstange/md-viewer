/**
 * Tests for commit links.
 *
 *   node --test
 *
 * Two things are worth pinning down. Which text is even a candidate — the
 * scanner runs over raw source, so it has to leave alone the many hex-shaped
 * things a document about a repository is full of. And that a link is only
 * drawn for a commit the repository actually has, which is the property that
 * keeps a table of shas from becoming a table of dead links.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findShaCandidates, renderMarkdown } from '../lib/render.js';
import { findRepository, looksLikeSha, openRepository } from '../lib/git.js';

test('a sha is recognised by shape, between 7 and 40 hex characters', () => {
  assert.ok(looksLikeSha('d0f7a71'));
  assert.ok(looksLikeSha('d0f7a718c3d9b99071159a5e65271097e76754d3'));
  assert.ok(!looksLikeSha('d0f7a7'), 'too short to be worth linking');
  assert.ok(!looksLikeSha('d0f7a718c3d9b99071159a5e65271097e76754d3a'), 'longer than a sha');
  assert.ok(!looksLikeSha('D0F7A71'), 'git writes them in lower case');
  assert.ok(!looksLikeSha('d0f7a7g'), 'g is not hex');
  assert.ok(!looksLikeSha(''));
});

test('candidates come from code spans, and nothing else does', () => {
  const source = [
    'A commit `d0f7a71` and a full `d0f7a718c3d9b99071159a5e65271097e76754d3`.',
    'Bare in prose: d0f7a71 — not offered.',
    'A span with more in it: `see d0f7a71` — not offered.',
    'A colour: `#ff00aa` — not hex-only once the hash is counted.',
  ].join('\n');
  assert.deepEqual(findShaCandidates(source), [
    'd0f7a71',
    'd0f7a718c3d9b99071159a5e65271097e76754d3',
  ]);
});

test('a bug number is not a sha, however it is written', () => {
  // Decimal digits are also hex digits, which is why this is worth a test: a
  // document about a bug tracker is full of seven-digit numbers in backticks,
  // and it is the repository, not the shape, that rules them out.
  assert.deepEqual(findShaCandidates('bug `1937315` and bug `2063593`'), [
    '1937315',
    '2063593',
  ]);
});

/** A throwaway repository with two commits, for the tests below. */
function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-git-'));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'the first commit');
  const sha = git('rev-parse', 'HEAD').trim();
  return { dir, sha, git };
}

test('the repository is the one containing the file, found by walking up', () => {
  const { dir } = scratchRepo();
  const deep = path.join(dir, 'artifacts', 'notes');
  fs.mkdirSync(deep, { recursive: true });
  const file = path.join(deep, 'overview.md');
  fs.writeFileSync(file, '# notes\n');

  // macOS puts the temporary directory behind a symlink, so compare what git
  // itself would: the resolved path.
  assert.equal(fs.realpathSync(findRepository(file)), fs.realpathSync(dir));
  assert.equal(findRepository('/x.md'), null, 'no repository above the root');
});

test('only commits the repository has become links', async () => {
  const { dir, sha } = scratchRepo();
  const file = path.join(dir, 'notes.md');
  const short = sha.slice(0, 12);
  const source = `commit \`${short}\`, bug \`1937315\`, absent \`0123456789ab\`\n`;
  fs.writeFileSync(file, source);

  const commits = openRepository(file);
  await commits.resolve(findShaCandidates(source));

  assert.equal(commits.has(short), true);
  assert.equal(commits.full(short), sha, 'the short form resolves to the full sha');
  assert.equal(commits.has('1937315'), false, 'a bug number is in no repository');
  assert.equal(commits.has('0123456789ab'), false);

  const { html } = renderMarkdown(source, { baseDir: dir, commits });
  assert.match(html, new RegExp(`<a class="mdv-commit"[^>]*sha=${short}`));
  assert.match(html, new RegExp(`title="Review commit ${sha}"`));
  // The two non-commits are still code spans, and are not wrapped in a link.
  assert.equal(html.match(/mdv-commit/g).length, 1);
  assert.match(html, /<code>1937315<\/code>/);
});

test('a blob whose name is in the text is not offered as a commit', async () => {
  const { dir, git } = scratchRepo();
  const blob = git('rev-parse', 'HEAD:a.txt').trim();
  const file = path.join(dir, 'notes.md');
  const source = `the blob \`${blob.slice(0, 12)}\`\n`;
  fs.writeFileSync(file, source);

  const commits = openRepository(file);
  await commits.resolve(findShaCandidates(source));
  assert.equal(commits.has(blob.slice(0, 12)), false, 'a diff of a blob is not a thing');

  const { html } = renderMarkdown(source, { baseDir: dir, commits });
  assert.ok(!html.includes('mdv-commit'));
});

test('a document in no repository renders exactly as it did before', () => {
  const source = 'commit `d0f7a71` here\n';
  const { html } = renderMarkdown(source, { baseDir: os.tmpdir(), commits: null });
  assert.ok(!html.includes('mdv-commit'));
  assert.match(html, /<code>d0f7a71<\/code>/);
});

test('the patch of a commit is a diff the renderer can read', async () => {
  const { dir, sha, git } = scratchRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git('commit', '-qam', 'the second commit');
  const head = git('rev-parse', 'HEAD').trim();

  const commits = openRepository(path.join(dir, 'notes.md'));
  await commits.resolve([head.slice(0, 12)]);

  const patch = await commits.show(head.slice(0, 12));
  assert.match(patch, /^commit /, 'the message is kept above the diff');
  assert.match(patch, /diff --git a\/a\.txt b\/a\.txt/);
  assert.match(patch, /^\+two$/m);
  assert.equal(await commits.subject(head.slice(0, 12)), 'the second commit');
  assert.equal(await commits.subject(sha), 'the first commit');
});

test('showing something that is not a commit id is refused, not run', async () => {
  const { dir } = scratchRepo();
  const commits = openRepository(path.join(dir, 'notes.md'));
  // The route checks has() before getting here, but show() is the thing that
  // reaches a shell-less git call, so it refuses anything unshaped on its own.
  await assert.rejects(() => commits.show('HEAD; rm -rf /'), /not a commit id/);
  await assert.rejects(() => commits.show('--upload-pack=evil'), /not a commit id/);
});
