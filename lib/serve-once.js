/**
 * Serving a page that cannot change: hand it to the browser, then leave.
 *
 * Shared by diff-viewer and stack-viewer, which both build one self-contained
 * document — stylesheet and scripts inlined — and have nothing further to say
 * to the tab once it has loaded. The tab keeps working on its own: review
 * comments were always page-local, and the copy button needs nothing from the
 * process that served the page.
 */

import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openBrowser } from './browser.js';

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

/**
 * Hand the page to the browser and leave. The token in the URL keeps other
 * pages in the browser from reading it, and since the document is served in
 * one response there is nothing to exchange it for a cookie for.
 *
 * `tool` names the command in what is printed, since the same server speaks
 * for more than one of them.
 */
export function serveOnce(document, { port = 0, open = true, tool }) {
  const fail = (message) => {
    console.error(`${tool}: ${message}`);
    process.exit(1);
  };

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

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
    console.log(`${tool}: ${url}`);
    if (open) {
      openBrowser(url, tool);
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

/** Write the page to `output` instead of serving it, and open that file. */
export async function writeStandalone(document, { output, open = true, tool }) {
  const file = path.resolve(output);
  await fsp.writeFile(file, document);
  const url = pathToFileURL(file).href;
  if (open) {
    openBrowser(url, tool);
  }
  console.log(url);
}
