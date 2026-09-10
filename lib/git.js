/**
 * Reading commits out of the git repository a document lives in.
 *
 * A markdown file that reviews a stack of work names its commits by sha, and a
 * sha on its own is unreadable — the point of writing it down is the diff behind
 * it. So the viewer resolves those shas against a repository and turns the ones
 * that exist into links.
 *
 * Which repository: the one containing the file being viewed, found by walking
 * up from its directory. A document about a checkout is nearly always inside
 * that checkout — a notes file, a generated report in an artifacts directory —
 * and picking the enclosing repository needs no configuration and cannot point
 * at the wrong one the way a global default would.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

/** A hex string long enough to name a commit. Git itself refuses fewer than 4
 *  characters; 7 is the shortest anyone writes down, and 40 is a full sha. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Cap on `git show` output. A commit that touches a vendored tree can run to
 *  hundreds of megabytes, which no browser will render and which would be paid
 *  for in this process's memory first. */
const MAX_PATCH_BYTES = 32 * 1024 * 1024;

/** Lines of unchanged code around each hunk.
 *
 *  Git's own default is 3, which is tuned for applying a patch rather than
 *  reading one: it is enough to place the change in the file and not enough to
 *  see what the change is doing. A reviewer wants the function around it. */
const CONTEXT_LINES = 10;

/** True if `text` could name a commit. Cheap, and no repository needed. */
export function looksLikeSha(text) {
  return SHA_RE.test(text);
}

/**
 * The root of the git repository containing `file`, or null if there is none.
 *
 * Walks up looking for `.git` rather than shelling out to `rev-parse`: this
 * runs for every file the viewer opens, including the many that are in no
 * repository at all, and a stat per directory beats a process per file.
 * `.git` as a *file* counts too — that is how a worktree and a submodule
 * record where their real git directory is, and both are repositories to `git`.
 */
export function findRepository(file) {
  let dir = path.resolve(path.dirname(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function git(repo, args, { maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, ...args],
      // A pager would never exit, and a repository configured with one is not
      // unusual; the locale keeps git's own words predictable for the caller.
      { maxBuffer, env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * A lookup of commits in the repository around `file`, or null when that file
 * is in no repository.
 *
 * `has()` is synchronous, because it is called from the markdown renderer,
 * which is synchronous — so the shas of a document are resolved in one batch
 * before it is rendered, by `resolve()`. One `git cat-file --batch-check` run
 * answers the whole document, however many shas it names; asking per sha would
 * be a process each.
 */
export function openRepository(file) {
  const repo = findRepository(file);
  if (!repo) {
    return null;
  }

  /** @type {Map<string, string|null>} sha as written -> full sha, or null. */
  const known = new Map();

  return {
    repo,
    /** The document these commits were resolved for. A commit link carries it
     *  back to the server, which is how the request finds this repository
     *  again — the sha alone would not say which checkout it belongs to. */
    file,

    /**
     * Look up every candidate not seen before, and remember the answer. Results
     * are cached for the life of the process: a sha names one immutable object,
     * so an answer of "yes, this commit" cannot go stale. A "no" can — the
     * commit may be written later — so those are not kept.
     */
    async resolve(candidates) {
      const fresh = [...new Set(candidates)].filter(
        (sha) => looksLikeSha(sha) && !known.has(sha),
      );
      if (!fresh.length) {
        return;
      }
      // `^{commit}` makes the answer "is this a commit" rather than "is this
      // any object", so a blob whose name happens to be in the text is not
      // offered as a diff. --batch-check prints one line per query, in order.
      const lines = (await batchCheck(repo, fresh)).split('\n');
      fresh.forEach((sha, i) => {
        const parts = (lines[i] || '').trim().split(' ');
        known.set(sha, parts.length === 3 && parts[1] === 'commit' ? parts[0] : null);
      });
      for (const sha of fresh) {
        if (!known.get(sha)) {
          known.delete(sha);
        }
      }
    },

    /** The full sha this text names, or null. Only answers what `resolve()`
     *  has already looked up. */
    full(sha) {
      return known.get(sha) || null;
    },

    has(sha) {
      return Boolean(known.get(sha));
    },

    /**
     * The commit as a patch, in the form the diff renderer reads.
     *
     * `--patch` with `--no-color` and no pager is plain unified diff, and the
     * message above it is left in: it is the first thing a reviewer wants, and
     * the diff renderer passes through what it cannot parse.
     */
    async show(sha) {
      if (!looksLikeSha(sha)) {
        throw new Error(`not a commit id: ${sha}`);
      }
      return git(
        repo,
        [
          '--no-pager',
          'show',
          '--no-color',
          '--patch',
          `--unified=${CONTEXT_LINES}`,
          '--stat',
          '--find-renames',
          `${sha}^{commit}`,
        ],
        { maxBuffer: MAX_PATCH_BYTES },
      );
    },

    /** The commit's subject line, for the tab title. Cheap enough to ask for
     *  alongside the patch, and worth far more than a sha in a strip of tabs. */
    async subject(sha) {
      if (!looksLikeSha(sha)) {
        return null;
      }
      try {
        return (await git(repo, ['log', '-1', '--format=%s', `${sha}^{commit}`])).trim();
      } catch {
        return null;
      }
    },
  };
}

/**
 * `git cat-file --batch-check` over a list of shas, fed to it on stdin.
 *
 * One process for the whole document, however many shas it names. Spawned by
 * hand rather than through the execFile helper above, which has nowhere to put
 * the input. A failure resolves to no output, which reads as "none of these are
 * commits" — the right answer for a directory that turned out not to be a
 * repository after all, and a link is not worth an error page.
 */
function batchCheck(repo, shas) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch-check'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
    child.stdin.on('error', () => {});
    child.stdin.end(shas.map((sha) => `${sha}^{commit}`).join('\n') + '\n');
  });
}
