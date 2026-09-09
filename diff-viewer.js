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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderDiff, looksLikeDiff } from './lib/diff.js';
import { openBrowser } from './lib/browser.js';
import { parseRemoteTarget, readRemoteFile } from './lib/remote.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

/**
 * How long to wait for the browser to come and collect the page. Generous,
 * because it covers a cold browser start; only reached when the browser never
 * shows up at all.
 */
const PICKUP_TIMEOUT_MS = 60000;
/**
 * How long to keep serving after the last request. Covers a reload, and the
 * second connection a browser opens and then uses a moment later; long enough
 * that neither races the exit, short enough that the shell comes back promptly.
 */
const IDLE_EXIT_MS = 3000;

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

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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

function summary(rendered) {
  const files = `${rendered.files} file${rendered.files === 1 ? '' : 's'} changed`;
  return (
    `<span>${files}</span>` +
    `<span class="dv-stat dv-stat-add">+${rendered.additions}</span>` +
    `<span class="dv-stat dv-stat-del">−${rendered.deletions}</span>`
  );
}

const REVIEW_BAR =
  '<div id="mdv-review" class="mdv-review-bar" hidden>' +
  '<span class="mdv-review-count"></span>' +
  '<button type="button" class="mdv-review-copy">Copy review</button>' +
  '</div>';

/**
 * Build the whole page as one self-contained document: the stylesheets and
 * scripts are inlined, so nothing is fetched after this response and the
 * server is free to leave.
 */
async function buildPage(source, options) {
  const rendered = renderDiff(source);
  const title = options.title || defaultTitle(source, options.file);

  const [base, diffCss, reviewJs, diffJs] = await Promise.all([
    fsp.readFile(path.join(HERE, 'assets/style.css'), 'utf8'),
    fsp.readFile(path.join(HERE, 'assets/diff.css'), 'utf8'),
    fsp.readFile(path.join(HERE, 'assets/review.js'), 'utf8'),
    fsp.readFile(path.join(HERE, 'assets/diff.js'), 'utf8'),
  ]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${base}
${diffCss}</style>
</head>
<body>
<div id="mdv-root" class="dv-root" data-file="${escapeHtml(title)}">
<div class="dv-toolbar">
<div class="mdv-path">${escapeHtml(title)}</div>
<div class="dv-summary">${summary(rendered)}</div>
<label class="dv-layout-toggle"><input type="checkbox" id="dv-layout"> Side by side</label>
</div>
<article id="mdv-content">
${rendered.html}
</article>
</div>
${REVIEW_BAR}
<script>
${reviewJs}</script>
<script>
${diffJs}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/**
 * Hand the page to the browser and leave. The token in the URL keeps other
 * pages in the browser from reading it, and since the document is served in
 * one response there is nothing to exchange it for a cookie for.
 */
function serveOnce(document, options) {
  const token = crypto.randomBytes(16).toString('hex');
  let inFlight = 0;
  let served = false;
  let idleTimer = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/' || url.searchParams.get('t') !== token) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }

    inFlight++;
    clearTimeout(idleTimer);
    served = true;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    // Only once the response is on the wire is the page really the browser's;
    // exiting at write() time can cut the socket before it is all sent.
    res.end(document, () => {
      inFlight--;
      scheduleExit();
    });
  });

  /**
   * Leave once the page has been collected and nothing more is being asked for.
   *
   * Exiting the instant the first response completed was tempting — the page is
   * self-contained, so one request is all it needs — but the tab is a live
   * document that outlives this process, and reloading it is an ordinary thing
   * to do. A reload that lands on a dead port shows an error page and takes the
   * reader's review comments with it. So the server stays up for a short while
   * after each request, and a reload keeps it alive; only a genuinely quiet
   * stretch ends it.
   */
  function scheduleExit() {
    clearTimeout(idleTimer);
    if (inFlight > 0) {
      return;
    }
    idleTimer = setTimeout(() => {
      server.close();
      process.exit(0);
    }, IDLE_EXIT_MS);
  }

  server.on('error', (error) => fail(error.message));

  server.listen(options.port, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/?t=${token}`;
    console.log(`diff-viewer: ${url}`);
    if (options.open) {
      openBrowser(url, 'diff-viewer');
    }
  });

  // Nothing ever came to collect the page.
  setTimeout(() => {
    if (!served) {
      fail('the browser never loaded the page');
    }
  }, PICKUP_TIMEOUT_MS);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log('');
      process.exit(0);
    });
  }
}

async function writeStandalone(document, options) {
  const output = path.resolve(options.output);
  await fsp.writeFile(output, document);
  const url = pathToFileURL(output).href;
  if (options.open) {
    openBrowser(url, 'diff-viewer');
  }
  console.log(url);
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

  const document = await buildPage(source, options);
  if (options.output) {
    await writeStandalone(document, options);
  } else {
    serveOnce(document, options);
  }
}

main().catch((error) => fail(error.stack || error.message));
