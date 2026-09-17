/**
 * Reading a stack of commits out of a repository, for stack-viewer.
 *
 * A stack is named the way its tool names it: a jj revset such as `lqs::tvz`,
 * or in a plain git checkout a range such as `main..HEAD`. Either way what
 * comes back is the commits in the order they build on each other, oldest
 * first, which is the order a stack is reviewed in.
 *
 * The patches themselves are read with git, whichever tool named them. jj
 * keeps every commit in a git object store, the snapshotted working copy
 * included, and `git show` writes the exact form the diff renderer already
 * reads — the `commit <sha>` header, the indented message, the files — so a
 * commit in a stack renders as the same page a commit link in a document
 * does. `jj show --git` would draw the same diff under a different header
 * (`Commit ID:`, `Change ID:`, ...), which would need a second parser for
 * the message and gain nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { MAX_PATCH_BYTES, runGit, showArgs } from './git.js';

/** How many `git show` processes to run at once. A stack of thirty commits
 *  in a large repository should not be thirty git processes at once, and one
 *  at a time leaves the other cores idle. */
const SHOW_CONCURRENCY = 4;

/**
 * The repository containing `dir`, found by walking up, and which tool owns it.
 *
 * `.jj` is looked for first at each level: a colocated jj repository has both
 * a `.jj` and a `.git`, and it is jj's revsets the reader will be writing.
 * @returns {{root: string, kind: 'jj'|'git'}|null}
 */
export function findStackRepository(dir) {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, '.jj'))) {
      return { root: at, kind: 'jj' };
    }
    if (fs.existsSync(path.join(at, '.git'))) {
      return { root: at, kind: 'git' };
    }
    const parent = path.dirname(at);
    if (parent === at) {
      return null;
    }
    at = parent;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }, ...options },
      (error, stdout, stderr) => {
        if (error) {
          // jj's own messages start with `Error: `, which the caller adds too.
          reject(new Error(stderr.trim().replace(/^Error: /, '') || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * Open the repository at `root` for reading a stack out of.
 *
 * Resolves the git directory up front — `jj git root` for a jj repository,
 * which is `.git` when colocated and inside `.jj` when not, and `rev-parse`
 * for git, which follows a worktree's `.git` file to the real one.
 *
 * @returns {Promise<{
 *   root: string, kind: 'jj'|'git', gitDir: string,
 *   list(revset: string): Promise<{sha: string, label: string}[]>,
 *   show(sha: string): Promise<string>,
 * }>}
 */
export async function openStack({ root, kind }) {
  const gitDir =
    kind === 'jj'
      ? (await run('jj', ['-R', root, '--ignore-working-copy', 'git', 'root'])).trim()
      : (await runGit(['-C', root, 'rev-parse', '--absolute-git-dir'])).trim();

  return {
    root,
    kind,
    gitDir,

    /**
     * The commits `revset` names, oldest first, each with the label the reader
     * knows it by: jj's change id, which survives the commit being rewritten,
     * or for git a short sha.
     *
     * `jj log` snapshots the working copy before answering, which is wanted: a
     * stack that ends at `@` should show what is on disk now, as `jj diff`
     * would. The one-line template keeps the parsing to a split.
     */
    async list(revset) {
      if (kind === 'jj') {
        const out = await run('jj', [
          '-R',
          root,
          'log',
          '-r',
          revset,
          '--no-graph',
          '--reversed',
          '--color=never',
          '-T',
          'commit_id ++ " " ++ change_id.short(8) ++ "\\n"',
        ]);
        return parseListing(out);
      }
      // `rev-list` on a single commit walks its whole history, which nobody
      // reviewing a stack means; a range is the only spelling that walks.
      const walk = /\.\./.test(revset) ? ['--topo-order', '--reverse'] : ['--no-walk'];
      // A bare sha per line, which parseListing labels with a short prefix.
      return parseListing(await runGit(['-C', root, 'rev-list', ...walk, revset, '--']));
    },

    /** One commit as `git show` writes it, message and patch together. */
    show(sha) {
      return runGit(['--git-dir', gitDir, ...showArgs(sha)], { maxBuffer: MAX_PATCH_BYTES });
    },
  };
}

/** `<sha> <label>` per line, or a bare sha, which labels itself by prefix. */
function parseListing(out) {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, label] = line.split(/\s+/);
      return { sha, label: label || sha.slice(0, 12) };
    });
}

/**
 * Read every commit of a stack, a few at a time, keeping the stack's order.
 * @returns {Promise<{sha: string, label: string, source: string}[]>}
 */
export async function readStack(stack, commits) {
  const out = new Array(commits.length);
  let next = 0;
  const worker = async () => {
    while (next < commits.length) {
      const i = next++;
      out[i] = { ...commits[i], source: await stack.show(commits[i].sha) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, commits.length) }, worker));
  return out;
}
