#!/usr/bin/env node
/**
 * stack-viewer — review a stack of commits in one browser tab.
 *
 *   stack-viewer
 *   stack-viewer lqs::tvz
 *   stack-viewer -R ~/src/firefox 'trunk()..@'
 *
 * Names a stack the way jj does, by revset, and shows one review page per
 * commit — each the page diff-viewer would show for that commit alone, with
 * the same comments — behind a list of the commits to switch between. In a
 * plain git checkout the argument is a git range instead.
 *
 * Like diff-viewer there is nothing to watch: the commits are read once and
 * the page is self-contained, so the program leaves shortly after the browser
 * has collected it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_STACK_COMMITS, findStackRepository, openStack, readStack } from './lib/stack.js';
import { buildStackPage } from './lib/stack-page.js';
import { serveOnce, writeStandalone } from './lib/serve-once.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

const USAGE = `stack-viewer ${VERSION} — review a stack of commits in your browser

Usage: stack-viewer [options] [revset]

Options:
  -R, --repo <dir>  The repository to read from. Defaults to the one around
                    the current directory.
  -o, --output <f>  Write a standalone HTML file instead of serving it.
  -p, --port <n>    Listen on this port instead of a random free one.
      --no-open     Print the URL instead of launching a browser.
      --max-commits <n>
                    Build at most this many commits (default ${MAX_STACK_COMMITS}).
  -h, --help        Show this help.
  -v, --version     Show the version.

In a jj repository the argument is a revset, such as lqs::tvz or 'trunk()..@'.
In a git repository it is a range, such as main..HEAD, or one commit. With no
argument it is the stack that is applied now: everything from trunk() up to
the tip of the stack @ is in, less the empty commit jj new leaves on top. The
commits are shown oldest first, each with its own review comments. Exits
shortly after the page is loaded — the tab stays usable, since the comments
live in the page.`;

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    revset: null,
    repo: process.cwd(),
    output: null,
    port: Number(process.env.STACK_VIEWER_PORT) || 0,
    open: true,
    maxCommits: MAX_STACK_COMMITS,
  };

  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (literal) {
      takeRevset(options, arg);
      continue;
    }
    switch (arg) {
      case '--':
        // Everything after this is the revset, even if it starts with a dash.
        literal = true;
        break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      case '-v':
      case '--version':
        console.log(VERSION);
        process.exit(0);
        break;
      case '--no-open':
        options.open = false;
        break;
      case '-R':
      case '--repo':
        options.repo = argv[++i];
        if (!options.repo) fail('--repo needs a directory');
        break;
      case '-o':
      case '--output':
        options.output = argv[++i];
        if (!options.output) fail('--output needs a file name');
        break;
      case '--max-commits':
        options.maxCommits = Number(argv[++i]);
        if (!Number.isInteger(options.maxCommits) || options.maxCommits < 1) {
          fail(`--max-commits needs a count: ${argv[i]}`);
        }
        break;
      case '-p':
      case '--port':
        options.port = Number(argv[++i]);
        if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
          fail(`invalid port: ${argv[i]}`);
        }
        break;
      default:
        // A revset can start with a dash — `-foo` is not one, but `--` gets
        // any odd spelling through — so only a dash that is an option is one.
        if (arg.startsWith('-')) {
          fail(`unknown option: ${arg}\n\n${USAGE}`);
        }
        takeRevset(options, arg);
    }
  }
  return options;
}

function takeRevset(options, arg) {
  if (options.revset) {
    fail('only one revset can be viewed at a time; combine them with | in the revset');
  }
  options.revset = arg;
}

function fail(message) {
  console.error(`stack-viewer: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

/**
 * Why a stack is not being built, and what to do about it.
 *
 * A range thousands of commits long is almost never what was meant -- it is
 * `main..HEAD` where `main` is months behind -- so the base's upstream is
 * offered, since that is the range the reader was reaching for. The limit can
 * be lifted for anyone who really did mean it, with the count already filled
 * in: the answer to "how many" is the number they just saw.
 */
async function tooLong(stack, options, count) {
  let message =
    `${options.revset} names ${count} commits, and stack-viewer builds at most ` +
    `${options.maxCommits}: each one becomes a review page inside the one tab.`;

  // Only a range has a base that can be stale; `a..b` and `a...b` both do.
  const base = /^([^.]\S*?)\.\.\.?\S*$/.exec(options.revset)?.[1];
  const upstream = base ? await stack.upstreamOf(base) : null;
  if (upstream) {
    message +=
      `\n\nA range this long usually means ${base} is behind what it tracks. ` +
      `Try ${options.revset.replace(base, upstream)}`;
  }
  return `${message}\n\nOr pass --max-commits ${count} to build it anyway.`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const found = findStackRepository(options.repo);
  if (!found) {
    fail(`${options.repo} is not inside a jj or git repository`);
  }

  let stack;
  let commits;
  // With no revset the stack to review is the one that is applied, which only
  // the repository can say; its own name for it is what the page is titled.
  let title = options.revset;
  let base = null;
  try {
    stack = await openStack(found);
    if (!options.revset) {
      ({ revset: options.revset, title, base } = await stack.defaultStack());
    }
    commits = await stack.list(options.revset);
  } catch (error) {
    fail(error.message);
  }
  if (!commits.length) {
    fail(base ? `nothing is applied on top of ${base}` : `no commits match ${options.revset}`);
  }
  if (commits.length > options.maxCommits) {
    fail(await tooLong(stack, options, commits.length));
  }

  let patches;
  try {
    patches = await readStack(stack, commits);
  } catch (error) {
    fail(`cannot read the commits: ${error.message}`);
  }

  const document = await buildStackPage(patches, { title, where: stack.root });
  if (options.output) {
    await writeStandalone(document, { ...options, tool: 'stack-viewer' });
  } else {
    serveOnce(document, { ...options, tool: 'stack-viewer' });
  }
}

main().catch((error) => fail(error.stack || error.message));
