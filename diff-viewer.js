#!/usr/bin/env node
/**
 * diff-viewer — read a unified diff and review it in a browser tab.
 *
 * The diff usually comes from a command rather than a file, so stdin is the
 * normal way in:
 *
 *   git diff | diff-viewer
 *
 * Unlike md-viewer there is nothing to watch: a diff on stdin has no file
 * behind it and cannot change. So the page is self-contained — stylesheet and
 * scripts inlined — and the program leaves shortly after the browser stops
 * asking for it. The tab keeps working on its own: review comments were always
 * page-local, and the copy button needs nothing from this process.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeDiff } from './lib/diff.js';
import { buildDiffPage } from './lib/diff-page.js';
import { serveOnce, writeStandalone } from './lib/serve-once.js';
import { parseRemoteTarget, readRemoteFile } from './lib/remote.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

const USAGE = `diff-viewer ${VERSION} — review a diff in your browser

Usage: diff-viewer [options] [file.diff]
       diff-viewer [options] [user@]host:/path/to/file.diff
       <command producing a diff> | diff-viewer

Options:
  -o, --output <f>  Write a standalone HTML file instead of serving it.
  -p, --port <n>    Listen on this port instead of a random free one.
      --no-open     Print the URL instead of launching a browser.
  -t, --title <s>   Name this diff in the tab and page header.
  -h, --help        Show this help.
  -v, --version     Show the version.

Reads the diff from stdin when no file is given. A target with a host in front
of it is fetched over ssh; a diff cannot change under us, so it is served from
here. Exits shortly after the page is loaded — the tab stays usable, since
review comments live in the page.`;

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    file: null,
    output: null,
    port: Number(process.env.DIFF_VIEWER_PORT) || 0,
    open: true,
    title: null,
  };

  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (literal) {
      takeFile(options, arg);
      continue;
    }
    switch (arg) {
      case '--':
        // Everything after this is a path, even if it starts with a dash.
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
      case '-o':
      case '--output':
        options.output = argv[++i];
        if (!options.output) fail('--output needs a file name');
        break;
      case '-t':
      case '--title':
        options.title = argv[++i];
        if (options.title == null) fail('--title needs a value');
        break;
      case '-p':
      case '--port':
        options.port = Number(argv[++i]);
        if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
          fail(`invalid port: ${argv[i]}`);
        }
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') {
          fail(`unknown option: ${arg}\n\n${USAGE}`);
        }
        takeFile(options, arg);
    }
  }
  return options;
}

function takeFile(options, arg) {
  if (options.file) {
    fail('only one diff can be viewed at a time');
  }
  // "-" is the conventional spelling of "read stdin", and stays null.
  options.file = arg === '-' ? null : arg;
}

function fail(message) {
  console.error(`diff-viewer: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

async function readStdin() {
  if (process.stdin.isTTY) {
    fail(`no diff given, and stdin is a terminal\n\n${USAGE}`);
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** What to call this diff, when nothing named it. */
function defaultTitle(source, file) {
  if (file) return path.basename(file);
  const match = /^(?:diff --git \S+ b\/|\+\+\+ b?\/?)(\S+)/m.exec(source);
  return match ? `diff — ${match[1]}` : 'diff';
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // `host:path` only when there is no such file here, so that a local path
  // containing a colon still wins.
  const remote = options.file && !fs.existsSync(options.file)
    ? parseRemoteTarget(options.file)
    : null;

  let source;
  if (remote) {
    try {
      source = await readRemoteFile(remote);
    } catch (error) {
      fail(error.message);
    }
    // The title comes from the file name, and the host is the part that says
    // which of several same-named patches this one is.
    options.file = `${remote.hostSpec}:${remote.file}`;
  } else if (options.file) {
    try {
      source = await fsp.readFile(options.file, 'utf8');
    } catch (error) {
      fail(`cannot read ${options.file}: ${error.message}`);
    }
  } else {
    source = await readStdin();
  }

  if (!source.trim()) {
    fail('the diff is empty');
  }
  if (!looksLikeDiff(source)) {
    console.error('diff-viewer: this does not look like a unified diff; showing it anyway.');
  }

  const document = await buildDiffPage(source, {
    title: options.title || defaultTitle(source, options.file),
  });
  if (options.output) {
    await writeStandalone(document, { ...options, tool: 'diff-viewer' });
  } else {
    serveOnce(document, { ...options, tool: 'diff-viewer' });
  }
}

main().catch((error) => fail(error.stack || error.message));
