/**
 * Tests for stack-viewer.
 *
 *   node --test
 *
 * Two halves. Reading the stack out of a repository: the commits have to come
 * back oldest first, since that is the order a stack is reviewed in, and a
 * git range and a jj revset have to agree on that. And the page: it carries
 * whole documents inside a document, which is only safe if the way they are
 * carried survives the HTML parser — so that is what is checked, along with
 * the list and the script that drives it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { MAX_STACK_COMMITS, findStackRepository, openStack, readStack } from '../lib/stack.js';
import { buildStackPage, jsonForScript } from '../lib/stack-page.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const AUTHOR = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

/** A throwaway git repository with four commits on one branch. */
function scratchGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-stack-git-'));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...AUTHOR } });
  git('init', '-q', '-b', 'main');
  const shas = [];
  for (const [n, word] of ['one', 'two', 'three', 'four'].entries()) {
    fs.writeFileSync(path.join(dir, 'a.txt'), `${word}\n`);
    git('add', 'a.txt');
    git('commit', '-qm', `commit ${n + 1}: ${word}\n\nThe body of ${word}.`);
    shas.push(git('rev-parse', 'HEAD').trim());
  }
  return { dir, shas, git };
}

function haveJj() {
  try {
    execFileSync('jj', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A throwaway jj repository (colocated) with three described changes. */
function scratchJjRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-stack-jj-'));
  const env = {
    ...process.env,
    JJ_USER: 'T',
    JJ_EMAIL: 't@example.invalid',
    // A user's own config could add a pager or colour; this test wants neither.
    JJ_CONFIG: '/dev/null',
  };
  const jj = (...args) => execFileSync('jj', ['-R', dir, ...args], { encoding: 'utf8', env });
  execFileSync('jj', ['git', 'init', '--colocate', dir], { encoding: 'utf8', env });
  const changes = [];
  for (const [n, word] of ['one', 'two', 'three'].entries()) {
    fs.writeFileSync(path.join(dir, 'a.txt'), `${word}\n`);
    jj('describe', '-m', `change ${n + 1}: ${word}`);
    changes.push(jj('log', '-r', '@', '--no-graph', '-T', 'change_id.short(8)').trim());
    jj('new');
  }
  return { dir, changes, jj };
}

test('the repository around a directory is found by walking up, jj before git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-stack-find-'));
  fs.mkdirSync(path.join(root, '.git'));
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.deepEqual(findStackRepository(deep), { root, kind: 'git' });

  // A colocated repository has both, and it is jj's revsets that get typed.
  fs.mkdirSync(path.join(root, '.jj'));
  assert.deepEqual(findStackRepository(deep), { root, kind: 'jj' });

  assert.equal(findStackRepository(os.tmpdir()), null);
});

test('a git range lists its commits oldest first, and one commit lists itself', async () => {
  const { dir, shas } = scratchGitRepo();
  const stack = await openStack({ root: dir, kind: 'git' });
  assert.equal(stack.gitDir, fs.realpathSync(path.join(dir, '.git')));

  const range = await stack.list(`${shas[0]}..${shas[2]}`);
  assert.deepEqual(
    range.map((c) => c.sha),
    [shas[1], shas[2]],
    'the bottom of the range is excluded, as git excludes it, and the rest build upwards',
  );
  assert.equal(range[0].label, shas[1].slice(0, 12));

  // Without a range, rev-list would walk the whole history; a single commit
  // means that commit.
  const one = await stack.list(shas[1]);
  assert.deepEqual(one.map((c) => c.sha), [shas[1]]);
});

test('a commit is read as git show writes it, message first', async () => {
  const { dir, shas } = scratchGitRepo();
  const stack = await openStack({ root: dir, kind: 'git' });
  const source = await stack.show(shas[1]);
  assert.match(source, new RegExp(`^commit ${shas[1]}\n`));
  assert.match(source, /\n {4}commit 2: two\n/);
  assert.match(source, /^-one\n\+two$/m);
});

test('reading a stack keeps its order however the reads finish', async () => {
  const { dir, shas } = scratchGitRepo();
  const stack = await openStack({ root: dir, kind: 'git' });
  const commits = await stack.list(`${shas[0]}..${shas[3]}`);
  assert.equal(commits.length, 3);
  const patches = await readStack(stack, commits);
  assert.deepEqual(
    patches.map((p) => p.sha),
    shas.slice(1),
  );
  for (const [i, patch] of patches.entries()) {
    assert.match(patch.source, new RegExp(`^commit ${shas[i + 1]}`), `patch ${i} is its own commit`);
  }
});

/**
 * A stack too long to build has to be refused before it is read, not after.
 *
 * `main..HEAD` against a base branch that has not been pulled in months names
 * every commit since — thousands in a large repository — and building those
 * ran the heap out and dumped core after a minute. The count is known from one
 * `rev-list`, so the answer is available immediately and costs nothing.
 */
test('a stack longer than the limit is refused before a single patch is read', () => {
  const { dir, shas } = scratchGitRepo();
  // `show` throws: nothing may reach it, since the refusal comes first.
  const run = (...args) =>
    execFileSync(process.execPath, [path.join(HERE, '..', 'stack-viewer.js'), '--no-open', '-R', dir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...AUTHOR },
    });

  let failure;
  try {
    run('--max-commits', '2', `${shas[0]}..${shas[3]}`);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'a stack over the limit is an error');
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /names 3 commits, and stack-viewer builds at most 2/);
  assert.match(failure.stderr, /--max-commits 3 to build it anyway/, 'the way through is offered');

  // And the same stack under the limit is built, so the limit is all that
  // stopped it.
  const out = path.join(dir, 'page.html');
  run('--max-commits', '3', '-o', out, `${shas[0]}..${shas[3]}`);
  assert.match(fs.readFileSync(out, 'utf8'), /sv-entry/);
});

test('the base of a stale range is reported as the branch it tracks', async () => {
  const { dir, git } = scratchGitRepo();
  const stack = await openStack({ root: dir, kind: 'git' });
  assert.equal(await stack.upstreamOf('main'), null, 'a branch tracking nothing has no advice');

  // A remote to track, made by cloning this repository and pointing back.
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-stack-remote-'));
  execFileSync('git', ['clone', '-q', '--bare', dir, path.join(remote, 'origin.git')]);
  git('remote', 'add', 'origin', path.join(remote, 'origin.git'));
  git('fetch', '-q', 'origin');
  git('branch', '--set-upstream-to=origin/main', 'main');
  assert.equal(await stack.upstreamOf('main'), 'origin/main');

  assert.equal(await stack.upstreamOf('no-such-branch'), null, 'a name that resolves to nothing');
});

test('a stack whose patches are too large to carry stops while it can say so', async () => {
  const { dir, shas } = scratchGitRepo();
  const stack = await openStack({ root: dir, kind: 'git' });
  const commits = await stack.list(`${shas[0]}..${shas[3]}`);

  // A budget under one patch: the first read is already past it, so the stack
  // stops on the commit that broke it rather than on the last.
  await assert.rejects(readStack(stack, commits, { maxBytes: 1 }), /more than one page can carry/);

  // The same stack with the real budget is read whole.
  const patches = await readStack(stack, commits);
  assert.equal(patches.length, 3);
});

test('the default limit is a stack somebody might actually review', () => {
  assert.ok(MAX_STACK_COMMITS >= 35, 'a real stack of 35 commits has to fit');
});

test('a jj revset lists its commits oldest first, labelled by change id', { skip: !haveJj() }, async () => {
  const { dir, changes } = scratchJjRepo();
  const found = findStackRepository(dir);
  assert.equal(found.kind, 'jj');
  const stack = await openStack(found);
  assert.equal(fs.realpathSync(stack.gitDir), fs.realpathSync(path.join(dir, '.git')));

  const commits = await stack.list(`${changes[0]}::${changes[2]}`);
  assert.deepEqual(
    commits.map((c) => c.label),
    changes,
    'jj log lists newest first; the stack wants the order the changes build in',
  );
  for (const commit of commits) {
    assert.match(commit.sha, /^[0-9a-f]{40}$/);
  }

  // The patch of a jj change is read from the git store behind it.
  const source = await stack.show(commits[1].sha);
  assert.match(source, /\n {4}change 2: two\n/);
  assert.match(source, /^-one\n\+two$/m);
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const SHA1 = '1111111111111111111111111111111111111111';
const SHA2 = '2222222222222222222222222222222222222222';

/** What `git show` writes for a small commit. */
function commit(sha, subject, before, after) {
  return (
    `commit ${sha}\nAuthor: T <t@example.invalid>\nDate:   Mon Sep 1 10:00:00 2025 +0200\n\n` +
    `    ${subject}\n\n    Explains itself.\n\n` +
    ` a.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\n` +
    `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n`
  );
}

const PATCHES = [
  { sha: SHA1, label: 'kxwptuls', source: commit(SHA1, 'first change', 'one', 'two') },
  {
    sha: SHA2,
    label: 'psmyywvy',
    // A line of code that would end a script block if it were carried raw.
    source: commit(SHA2, 'second change', 'x', '</script><!-- <script>'),
  },
];

test('JSON carried in a script block cannot end the block', () => {
  const json = jsonForScript('a</script>b<!--c');
  assert.ok(!json.includes('</'), json);
  assert.ok(!json.includes('<!--'), json);
  assert.equal(JSON.parse(json), 'a</script>b<!--c');
});

test('the page lists the commits in order and carries each one whole', async () => {
  const html = await buildStackPage(PATCHES, { title: 'kxwptuls::psmyywvy', where: '/src/repo' });
  const dom = new JSDOM(html);
  const { document } = dom.window;

  assert.equal(document.title, 'kxwptuls::psmyywvy — repo');

  const entries = [...document.querySelectorAll('.sv-entry')];
  assert.deepEqual(
    entries.map((e) => e.querySelector('.sv-entry-subject').textContent),
    ['first change', 'second change'],
  );
  assert.deepEqual(
    entries.map((e) => e.querySelector('.sv-entry-id').textContent),
    ['kxwptuls', 'psmyywvy'],
  );
  assert.equal(entries[0].querySelector('.dv-stat-add').textContent, '+1');

  // Each commit's page comes back out of its block as the page diff-viewer
  // would have served, naming its commit — including the one whose diff holds
  // the very text that ends a script.
  for (const [i, patch] of PATCHES.entries()) {
    const block = document.getElementById(`sv-page-${i}`);
    assert.ok(block, `block ${i}`);
    const page = JSON.parse(block.textContent);
    assert.match(page, /^<!DOCTYPE html>/);
    assert.ok(page.includes(`data-commit="${patch.sha}"`), `page ${i} names its commit`);
    assert.ok(page.includes('mdvReviewComments'), 'the page carries the review scripts');
  }
  const second = JSON.parse(document.getElementById('sv-page-1').textContent);
  assert.ok(second.includes('&lt;/script&gt;&lt;!-- &lt;script&gt;'), 'the diff text is intact');

  const meta = JSON.parse(document.getElementById('sv-meta').textContent);
  assert.deepEqual(meta, [
    { sha: SHA1, label: 'kxwptuls', subject: 'first change' },
    { sha: SHA2, label: 'psmyywvy', subject: 'second change' },
  ]);
});

test('the list switches commits, and the hash remembers which', async () => {
  const html = await buildStackPage(PATCHES, { title: 'kxwptuls::psmyywvy', where: '/src/repo' });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1/#2' });
  const { window } = dom;
  const { document } = window;

  // Opened at #2, so the second commit is the current one, and the only frame.
  const entries = document.querySelectorAll('.sv-entry');
  assert.equal(entries[1].getAttribute('aria-current'), 'true');
  assert.equal(entries[0].getAttribute('aria-current'), null);
  assert.equal(document.querySelectorAll('.sv-frame').length, 1, 'frames are made when opened');
  assert.match(document.title, /^second change — /);

  entries[0].click();
  assert.equal(entries[0].getAttribute('aria-current'), 'true');
  assert.equal(window.location.hash, '#1');
  const frames = document.querySelectorAll('.sv-frame');
  assert.equal(frames.length, 2);
  assert.ok(frames[1].classList.contains('sv-frame-current'), 'the newest frame is the current one');
  assert.ok(!frames[0].classList.contains('sv-frame-current'), 'the other is kept, hidden');
  assert.match(frames[1].srcdoc, /data-commit="1111/);

  // Alt+Down steps forward; a bare arrow is the page's own.
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(window.location.hash, '#1');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
  assert.equal(window.location.hash, '#2');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
  assert.equal(window.location.hash, '#2', 'the last commit is the end');

  // The review across the stack is hidden until a commit has a comment.
  assert.equal(document.getElementById('sv-review').hidden, true);
});
