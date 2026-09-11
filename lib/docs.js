/**
 * Finding the markdown files a document names.
 *
 * A document that refers to another one usually just says its name — `SKILL.md`,
 * `docs/architecture.md` — rather than writing a markdown link to it, because in
 * a terminal or a diff that name is already the most useful form. In a browser
 * it is one click away from being useful and isn't, so the viewer resolves those
 * names against the disk and links the ones that are really there.
 *
 * Where it looks, in order: beside the document, then from the root of the
 * repository around it. The first is how a reference is nearly always written —
 * a sibling file, or a path relative to this one. The second is how a path is
 * written when it was copied from a `git` command or a build log, where
 * everything is relative to the checkout. Both are unambiguous and need no
 * configuration; nothing else is searched, because guessing at a file somewhere
 * else on the disk is how a link ends up pointing at the wrong document.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { findRepository } from './git.js';

/** The extensions a markdown file can have. Named here because this is the
 *  module that decides what counts as a document; the renderer imports it to
 *  route its links the same way. */
export const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx']);

/** The same extensions as the alternation of a pattern, for the scanner that
 *  has to recognise one at the end of a code span. */
export const MARKDOWN_EXT_RE = [...MARKDOWN_EXT].map((ext) => ext.slice(1)).join('|');

/**
 * A lookup of markdown files named by `file`, resolved against the disk.
 *
 * `find()` is synchronous, because the markdown renderer is: every candidate in
 * a document is resolved in one batch by `resolve()` before it is rendered, the
 * same arrangement the commit lookup uses.
 */
export function openDocuments(file) {
  const self = path.resolve(file);
  const dir = path.dirname(self);
  const repo = findRepository(self);

  /** @type {Map<string, string>} path as written -> absolute path. A path that
   *  resolved to nothing is simply absent. */
  const known = new Map();

  /** Where a written path could be, nearest meaning first. */
  const candidatePaths = (written) => {
    const places = [path.resolve(dir, written)];
    // A repository-relative reading only adds something when the document is
    // not already at the root, and only for a path that does not say where to
    // start from: "./notes.md" and "../notes.md" are explicitly relative to
    // this file, and reading them from the root as well would be inventing a
    // meaning the writer did not use.
    if (repo && repo !== dir && !written.startsWith('.')) {
      places.push(path.resolve(repo, written));
    }
    return places;
  };

  return {
    /**
     * Look up every candidate and remember the answer, forgetting the last
     * render's.
     *
     * Unlike a commit, a file can be created, moved or deleted while the viewer
     * is open, so no answer is cached across renders — a save re-resolves the
     * whole document, which is also when the reader would notice the link
     * appear. Within one render the set deduplicates, so a path named ten times
     * costs one stat.
     */
    async resolve(candidates) {
      known.clear();
      await Promise.all(
        [...new Set(candidates)].map(async (written) => {
          for (const abs of candidatePaths(written)) {
            // A link from a document back to the page it is on is noise.
            if (abs === self) {
              continue;
            }
            try {
              // isFile(), because a directory named "notes.md" is not one.
              if ((await fsp.stat(abs)).isFile()) {
                known.set(written, abs);
                return;
              }
            } catch {
              // Not there, or not readable: try the next place.
            }
          }
        }),
      );
    },

    /** The absolute path this text names, or null. Only answers what
     *  `resolve()` has already looked up. */
    find(written) {
      return known.get(written) || null;
    },
  };
}
