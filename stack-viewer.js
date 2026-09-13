#!/usr/bin/env node
/**
 * stack-viewer — review a stack of commits in one browser tab.
 *
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
import { findStackRepository, openStack, readStack } from './lib/stack.js';
import { buildStackPage } from './lib/stack-page.js';
import { serveOnce, writeStandalone } from './lib/serve-once.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

const USAGE = `stack-viewer ${VERSION} — review a stack of commits in your browser

Usage: stack-viewer [options] <revset>

Options:
  -R, --repo <dir>  The repository to read from. Defaults to the one around
                    the current directory.
  -o, --output <f>  Write a standalone HTML file instead of serving it.
  -p, --port <n>    Listen on this port instead of a random free one.
      --no-open     Print the URL instead of launching a browser.
  -h, --help        Show this help.
  -v, --version     Show the version.

In a jj repository the argument is a revset, such as lqs::tvz or 'trunk()..@'.
In a git repository it is a range, such as main..HEAD, or one commit. The
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
  if (!options.revset) {
    fail(`no revset given\n\n${USAGE}`);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const found = findStackRepository(options.repo);
  if (!found) {
    fail(`${options.repo} is not inside a jj or git repository`);
  }

  let stack;
  let commits;
  try {
    stack = await openStack(found);
    commits = await stack.list(options.revset);
  } catch (error) {
    fail(error.message);
  }
  if (!commits.length) {
    fail(`no commits match ${options.revset}`);
  }

  let patches;
  try {
    patches = await readStack(stack, commits);
  } catch (error) {
    fail(`cannot read the commits: ${error.message}`);
  }

  const document = await buildStackPage(patches, { title: options.revset, where: stack.root });
  if (options.output) {
    await writeStandalone(document, { ...options, tool: 'stack-viewer' });
  } else {
    serveOnce(document, { ...options, tool: 'stack-viewer' });
  }
}

main().catch((error) => fail(error.stack || error.message));
