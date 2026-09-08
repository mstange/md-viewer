#!/usr/bin/env node
/**
 * md-viewer — preview a Markdown file in a browser tab.
 *
 * Serves the rendered file from a throwaway localhost server, opens it in the
 * default browser, re-renders on every save, and exits once the tab is closed.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderMarkdown } from './lib/render.js';
import { openBrowser } from './lib/browser.js';
import { looksLikeDiff } from './lib/diff.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

// How long to wait for a tab before exiting, once none is connected. No browser
// event says "this tab is closing" — the page sends the same goodbye on a close,
// a reload, a navigation and a browser shutdown — so which delay applies is
// decided from what the server itself saw, in scheduleExit() below.

/** The page said goodbye and no document is loading: it is really gone. Just
 *  long enough to cover a navigation request landing in the same loop turn. */
const CLOSE_GRACE_MS = 150;
/** A page is being served, so a document is on its way in: wait for its stream. */
const RELOAD_GRACE_MS = 20000;
/** The stream died with no goodbye, which a tab cannot report: a suspend, a VPN
 *  reconnect, a frozen content process. The tab usually outlives those. */
const OFFLINE_GRACE_MS = 60000;
/** A page served this recently still counts as a document on its way in. */
const PAGE_WINDOW_MS = 1000;

const debug = process.env.MD_VIEWER_DEBUG
  ? (message) => console.log(`md-viewer: [${new Date().toISOString().slice(11, 23)}] ${message}`)
  : () => {};

const USAGE = `md-viewer ${VERSION} — preview a Markdown file in your browser

Usage: md-viewer [options] <file.md>

Options:
  -n, --no-watch    Render once to a standalone HTML file, open it, and exit
                    immediately (same as MD_VIEWER_NO_WATCH=1).
  -p, --port <n>    Listen on this port instead of a random free one.
      --no-open     Print the URL instead of launching a browser.
  -h, --help        Show this help.
  -v, --version     Show the version.

While watching, md-viewer stays in the foreground and reloads the tab whenever
the file changes. Closing the tab exits the program.`;

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    file: null,
    watch: !['1', 'true', 'yes'].includes((process.env.MD_VIEWER_NO_WATCH || '').toLowerCase()),
    port: Number(process.env.MD_VIEWER_PORT) || 0,
    open: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
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
      case '-n':
      case '--no-watch':
        options.watch = false;
        break;
      case '--watch':
        options.watch = true;
        break;
      case '--no-open':
        options.open = false;
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
        if (options.file) {
          fail('only one file can be viewed at a time');
        }
        options.file = arg;
    }
  }

  if (!options.file) {
    fail(`no file given\n\n${USAGE}`);
  }
  return options;
}

function fail(message) {
  console.error(`md-viewer: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function renderFile(file, linkMode) {
  const source = await fsp.readFile(file, 'utf8');
  const { html, title } = renderMarkdown(source, { baseDir: path.dirname(file), linkMode });
  return { html, title: tabTitle(title, file) };
}

/**
 * The tab title: what the document calls itself, then the file it came from, so
 * that a strip of tabs full of SKILL.md and README.md can still be told apart.
 * Tabs truncate, which is why the document's own title leads.
 */
function tabTitle(title, file) {
  const base = path.basename(file);
  return !title || title === base ? base : `${title} — ${base}`;
}

/**
 * The file's path, shortened for display: a home-relative path beats an absolute
 * one at the top of a document, and the basename is the part worth reading, so
 * it stays unmuted. Many files worth previewing are named SKILL.md or README.md,
 * which is why the directory is shown at all.
 */
function pathHeader(file) {
  const home = os.homedir();
  const inHome = file === home || file.startsWith(home + path.sep);
  const shown = inHome ? '~' + file.slice(home.length) : file;
  const dir = shown.slice(0, shown.length - path.basename(shown).length);
  return (
    '<div class="mdv-path" title="' +
    escapeHtml(file) +
    '"><span class="mdv-path-dir">' +
    escapeHtml(dir) +
    '</span>' +
    escapeHtml(path.basename(shown)) +
    '</div>\n'
  );
}

function page({ title, body, file, head = '', tail = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}
</head>
<body>
<div id="mdv-root" data-file="${escapeHtml(file)}">
${pathHeader(file)}<article id="mdv-content">
${body}
</article>
</div>
${tail}
</body>
</html>
`;
}

/** Chrome added to the served page, but not to a standalone `-n` render. */
const STATUS_PILL = '<div id="mdv-status" class="mdv-status"></div>\n';
const REVIEW_BAR =
  '<div id="mdv-review" class="mdv-review-bar" hidden>' +
  '<span class="mdv-review-count"></span>' +
  '<button type="button" class="mdv-review-copy">Copy review</button>' +
  '</div>\n';
const SCRIPTS =
  '<script src="/_assets/review.js"></script>\n<script src="/_assets/client.js"></script>';

// ---------------------------------------------------------------------------
// One-shot mode: standalone HTML file, no server
// ---------------------------------------------------------------------------

async function renderStandalone(file, options) {
  const { html, title } = await renderFile(file, 'file');
  const css = await fsp.readFile(path.join(HERE, 'assets/style.css'), 'utf8');
  const document = page({
    title,
    body: html,
    file,
    head: `<style>\n${css}</style>`,
  });

  const digest = crypto.createHash('sha1').update(file).digest('hex').slice(0, 10);
  const output = path.join(os.tmpdir(), `md-viewer-${digest}.html`);
  await fsp.writeFile(output, document);

  const url = pathToFileURL(output).href;
  if (options.open) {
    openBrowser(url);
  }
  console.log(url);
}

// ---------------------------------------------------------------------------
// Watch mode: live server
// ---------------------------------------------------------------------------

/**
 * Watch a single file for content changes. The parent directory is watched as
 * well because editors commonly save by writing a new file and renaming it over
 * the old one, which leaves a watch on the original inode useless.
 */
function watchPath(file, onChange) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let timer = null;

  const signature = () => {
    try {
      const stats = fs.statSync(file);
      return `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
    } catch {
      return 'missing';
    }
  };

  // The directory watch and the polling fallback below often report the same
  // save, so a change only counts once the file itself looks different.
  let last = signature();
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const current = signature();
      if (current !== last) {
        last = current;
        onChange();
      }
    }, 40);
  };

  let watcher = null;
  try {
    watcher = fs.watch(dir, { persistent: false }, (event, name) => {
      if (!name || name === base) fire();
    });
    watcher.on('error', () => {});
  } catch {
    // inotify limits or an unsupported filesystem: polling below still works.
  }
  fs.watchFile(file, { interval: 1000, persistent: false }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) fire();
  });

  return () => {
    clearTimeout(timer);
    watcher?.close();
    fs.unwatchFile(file);
  };
}

function serve(initialFile, options) {
  const token = crypto.randomBytes(16).toString('hex');
  const assets = {
    '/_assets/style.css': {
      body: fs.readFileSync(path.join(HERE, 'assets/style.css')),
      type: MIME['.css'],
    },
    '/_assets/client.js': {
      body: fs.readFileSync(path.join(HERE, 'assets/client.js')),
      type: MIME['.js'],
    },
    '/_assets/review.js': {
      body: fs.readFileSync(path.join(HERE, 'assets/review.js')),
      type: MIME['.js'],
    },
  };

  /** @type {Set<{res: http.ServerResponse, file: string}>} */
  const clients = new Set();
  /** @type {Map<string, {refs: number, stop: () => void}>} */
  const watchers = new Map();
  let exitTimer = null;
  let seenClient = false;
  /** Set when a page reports its own unload, cleared once a tab is back. */
  let saidGoodbye = false;
  let pagesInFlight = 0;
  let lastPageAt = 0;

  function subscribe(client) {
    clients.add(client);
    seenClient = true;
    saidGoodbye = false;
    clearTimeout(exitTimer);
    exitTimer = null;

    const existing = watchers.get(client.file);
    if (existing) {
      existing.refs++;
      return;
    }
    watchers.set(client.file, {
      refs: 1,
      stop: watchPath(client.file, () => notify(client.file)),
    });
  }

  function unsubscribe(client) {
    if (!clients.delete(client)) {
      return;
    }
    const watcher = watchers.get(client.file);
    if (watcher && --watcher.refs === 0) {
      watcher.stop();
      watchers.delete(client.file);
    }
    scheduleExit('event stream closed');
  }

  function notify(file) {
    const event = fs.existsSync(file) ? 'change' : 'gone';
    for (const client of clients) {
      if (client.file === file) {
        client.res.write(`event: ${event}\ndata: 1\n\n`);
      }
    }
  }

  /**
   * A document is being loaded. Reloads and navigations commit the new response
   * before unloading the old document, so this always runs *before* the goodbye
   * and the stream close that follow — which is what lets scheduleExit() tell
   * them from a tab that is gone for good.
   */
  function notePageRequest(req) {
    pagesInFlight++;
    lastPageAt = Date.now();
    debug(`serving a page (${pagesInFlight} in flight)`);
    req.on('close', () => {
      pagesInFlight--;
      lastPageAt = Date.now();
    });
    scheduleExit('page request');
  }

  /**
   * Decide when to exit now that no tab is connected. Recomputed from scratch on
   * every signal, so it does not matter which order they arrive in.
   */
  function scheduleExit(signal) {
    clearTimeout(exitTimer);
    exitTimer = null;
    if (!seenClient || clients.size > 0) {
      return;
    }

    let delay;
    let reason;
    if (pagesInFlight > 0 || Date.now() - lastPageAt < PAGE_WINDOW_MS) {
      delay = RELOAD_GRACE_MS;
      reason = 'page load never connected';
    } else if (saidGoodbye) {
      delay = CLOSE_GRACE_MS;
      reason = 'browser tab closed';
    } else {
      delay = OFFLINE_GRACE_MS;
      reason = 'event stream lost';
    }

    debug(`${signal}: exiting in ${delay}ms unless a tab connects (${reason})`);
    exitTimer = setTimeout(() => {
      console.log(`md-viewer: ${reason}, exiting.`);
      process.exit(0);
    }, delay);
    exitTimer.unref?.();
  }

  function cookieToken(req) {
    const match = /(?:^|;\s*)mdv_token=([0-9a-f]+)/.exec(req.headers.cookie || '');
    return match?.[1];
  }

  function authorized(value) {
    return (
      typeof value === 'string' &&
      value.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token))
    );
  }

  function send(res, status, type, body) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  }

  async function handle(req, res, url) {
    if (url.pathname === '/') {
      notePageRequest(req);
    }

    // The token in the URL is exchanged for a cookie on the first load, so that
    // other pages the browser happens to be showing cannot read local files
    // through this server.
    if (url.pathname === '/' && authorized(url.searchParams.get('t'))) {
      url.searchParams.delete('t');
      // Name the file in the URL as well, so the address bar says which document
      // this is from the first load on. Without it the opening page is a bare
      // host and port, and only pages reached by following a link say anything.
      if (!url.searchParams.has('f')) {
        url.searchParams.set('f', initialFile);
      }
      res.writeHead(302, {
        'set-cookie': `mdv_token=${token}; Path=/; SameSite=Lax; HttpOnly`,
        location: url.pathname + url.search,
      });
      res.end();
      return;
    }

    if (!authorized(cookieToken(req))) {
      send(res, 403, MIME['.txt'], 'forbidden\n');
      return;
    }

    const asset = assets[url.pathname];
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
      res.end(asset.body);
      return;
    }

    switch (url.pathname) {
      case '/':
        await handlePage(res, url);
        return;
      case '/api/content':
        await handleContent(res, url);
        return;
      case '/api/events':
        handleEvents(req, res, url);
        return;
      case '/api/bye':
        send(res, 204, MIME['.txt'], '');
        // The document is gone for certain, but it may be a reload or a
        // navigation replacing it; scheduleExit() sorts out which.
        saidGoodbye = true;
        scheduleExit('page said goodbye');
        return;
      case '/_file':
        await handleRawFile(res, url);
        return;
      default:
        send(res, 404, MIME['.txt'], 'not found\n');
    }
  }

  function requestedFile(url) {
    const file = url.searchParams.get('f');
    return file ? path.resolve(file) : initialFile;
  }

  async function handlePage(res, url) {
    const file = requestedFile(url);
    let rendered;
    try {
      rendered = await renderFile(file, 'server');
    } catch (error) {
      send(
        res,
        404,
        MIME['.html'],
        page({
          title: path.basename(file),
          file,
          body: `<h1>Cannot read this file</h1><p><code>${escapeHtml(file)}</code></p><p>${escapeHtml(error.message)}</p>`,
          head: '<link rel="stylesheet" href="/_assets/style.css">',
        }),
      );
      return;
    }

    send(
      res,
      200,
      MIME['.html'],
      page({
        title: rendered.title,
        file,
        body: rendered.html,
        head: '<link rel="stylesheet" href="/_assets/style.css">',
        tail: REVIEW_BAR + STATUS_PILL + SCRIPTS,
      }),
    );
  }

  async function handleContent(res, url) {
    const file = requestedFile(url);
    try {
      send(res, 200, MIME['.json'], JSON.stringify(await renderFile(file, 'server')));
    } catch {
      send(res, 200, MIME['.json'], JSON.stringify({ missing: true }));
    }
  }

  function handleEvents(req, res, url) {
    const file = requestedFile(url);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write('retry: 500\n\n');

    const client = { res, file };
    subscribe(client);

    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    ping.unref?.();
    const drop = () => {
      clearInterval(ping);
      unsubscribe(client);
    };
    req.on('close', drop);
    res.on('error', drop);
  }

  async function handleRawFile(res, url) {
    const file = url.searchParams.get('p');
    if (!file) {
      send(res, 400, MIME['.txt'], 'missing path\n');
      return;
    }
    try {
      const stats = await fsp.stat(file);
      if (!stats.isFile()) {
        throw new Error('not a file');
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': stats.size,
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    } catch {
      send(res, 404, MIME['.txt'], 'not found\n');
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    handle(req, res, url).catch((error) => {
      send(res, 500, MIME['.txt'], `${error.message}\n`);
    });
  });

  server.on('error', (error) => fail(error.message));

  server.listen(options.port, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/?t=${token}`;
    console.log(`md-viewer: watching ${initialFile}`);
    console.log(`md-viewer: ${url}`);
    if (options.open) {
      openBrowser(url);
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log('');
      process.exit(0);
    });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const file = path.resolve(options.file);

  let stats;
  try {
    stats = await fsp.stat(file);
  } catch {
    fail(`no such file: ${options.file}`);
  }
  if (stats.isDirectory()) {
    fail(`${options.file} is a directory`);
  }

  // A patch handed to md-viewer is nobody's idea of markdown: lexed as one it
  // becomes a wall of paragraphs. Hand it to the diff viewer instead, which is
  // what the user meant, and say so rather than silently changing tools.
  if (looksLikeDiff(await fsp.readFile(file, 'utf8'))) {
    console.log('md-viewer: this looks like a diff, opening it with diff-viewer.');
    const viewer = path.join(HERE, 'diff-viewer.js');
    const child = spawn(process.execPath, [viewer, file], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  if (options.watch) {
    serve(file, options);
  } else {
    await renderStandalone(file, options);
  }
}

main().catch((error) => fail(error.stack || error.message));
