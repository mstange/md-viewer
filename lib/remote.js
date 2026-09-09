/**
 * Viewing a file that lives on another machine.
 *
 * The file cannot usefully be rendered here: it changes over there, and its
 * images and relative links are over there too, so copying it would freeze it
 * and break half its content. Instead md-viewer runs on the remote host,
 * serving on that host's loopback interface, and ssh forwards a local port to
 * it. The browser talks to 127.0.0.1 as it always does, and every byte —
 * including the URL token — stays inside the ssh connection.
 *
 * Nothing is exposed on either machine's network, and it works through NAT and
 * firewalls, since the only connection made is the outgoing ssh one.
 *
 * The remote port cannot be known in advance: the remote server asks its own
 * kernel for a free one, which is the only way to avoid a collision on a
 * machine we know nothing about. So the forward cannot be set up with the usual
 * `ssh -L` at connection time. It is added afterwards instead, through a
 * control socket (`ssh -O forward`), once the remote has said which port it
 * picked. The local port is chosen the same way, by the local kernel.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** How long to wait for the remote viewer to print its URL. Covers an ssh
 *  handshake, a password or touch-your-key prompt, and a slow node start. */
const READY_TIMEOUT_MS = 120000;

/**
 * Recognise a remote target: the scp/rsync spelling, `[user@]host:path`.
 *
 * A bare absolute path never matches, and neither does a local relative path
 * containing a colon, since the part before the colon has to look like a
 * hostname — which also excludes a Windows drive letter, being one character.
 */
const REMOTE_TARGET = /^(?:([^@/:\s]+)@)?([A-Za-z0-9][A-Za-z0-9._-]+):(.+)$/;

export function parseRemoteTarget(target) {
  const match = REMOTE_TARGET.exec(target);
  if (!match) {
    return null;
  }
  const [, user, host, file] = match;
  // `https://host/path` splits as cleanly as `host:path` does and means
  // something else entirely; a remote path is a path, so it never starts `//`.
  if (file.startsWith('//')) {
    return null;
  }
  return { user, host, hostSpec: user ? `${user}@${host}` : host, file };
}

/** A free local port, asked of the kernel the same way a server would. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Quote a string for the remote shell. ssh hands its command to the remote
 * login shell, so a path with a space or a quote in it needs protecting even
 * though nothing here goes through a local shell.
 */
function shellQuote(value) {
  return `'` + String(value).replace(/'/g, `'\\''`) + `'`;
}

/**
 * Quote a path, but leave a leading `~/` for the remote shell to expand.
 *
 * `~` only means the home directory unquoted, and the home directory in
 * question is the remote one — so this side cannot expand it and must not quote
 * it away either. Everything after the slash is quoted as usual, which is what
 * keeps a space or a quote further along the path safe.
 */
function shellQuotePath(value) {
  const path = String(value);
  if (path === '~') {
    return '~';
  }
  if (path.startsWith('~/')) {
    return '~/' + shellQuote(path.slice(2));
  }
  return shellQuote(path);
}

/** The remote's URL with the port swapped for the forwarded local one; the
 *  token and the rest of the query have to survive intact. */
function localUrl(remoteUrl, localPort) {
  const url = new URL(remoteUrl);
  url.hostname = '127.0.0.1';
  url.port = String(localPort);
  return url.href;
}

/** Where this session's control socket lives. Short, because a Unix socket
 *  path is limited to about a hundred characters and `%r@%h:%p` can be long. */
function controlPath() {
  const name = `mdv-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(os.tmpdir(), name);
}

const SSH_BASE = [
  // Batch-friendly but not BatchMode: a passphrase or a hardware-key touch is
  // a normal part of connecting, and this side has a terminal for it.
  '-o',
  'ControlMaster=auto',
  '-o',
  'ExitOnForwardFailure=yes',
];

/**
 * Keep a path from being read as an option, without relying on `--`.
 *
 * Only a relative path can start with a dash, and prefixing `./` leaves it
 * naming the same file while making the leading character harmless.
 */
function dashSafe(file) {
  return file.startsWith('-') ? `./${file}` : file;
}

/**
 * Wrap a remote command so that it runs with the PATH the user actually has.
 *
 * ssh runs a command through a *non-interactive* shell, which reads neither
 * ~/.zshrc nor ~/.bashrc — so a Homebrew prefix or a ~/.local/bin put on the
 * PATH there is invisible, and both `md-viewer` and the `node` in its shebang
 * come back "not found". Asking for a login shell picks up ~/.zprofile and
 * /etc/paths, which is where those entries normally come from, and matches what
 * the user sees when they ssh in and run the command by hand.
 *
 * `exec` twice over so no shell is left waiting in the middle: a signal down
 * the ssh channel reaches the viewer itself rather than a wrapper.
 */
function loginShellCommand(command) {
  // ssh sets SHELL from the account's shell, but not on every system, and a
  // login /bin/sh still reads /etc/profile.
  const shell = '"$' + '{SHELL:-/bin/sh}"';
  return `exec ${shell} -l -c ${shellQuote(`exec ${command}`)}`;
}

/**
 * Run `tool` on the target host against the target file, forward a local port
 * to it, and return the URL to open in the browser.
 *
 * Resolves with the ssh child still running: it is the tunnel *and* the remote
 * server's lifetime at once, so the caller keeps it, and exits when it exits —
 * which is when the remote viewer saw its tab close.
 */
export async function startRemoteViewer({ target, tool, args = [], localPort }) {
  const socket = controlPath();
  // A port asked for on the command line is the local end of the tunnel; the
  // remote end is always the remote kernel's choice.
  const port = localPort || (await freePort());

  // No `--` before the path: the remote md-viewer is a separate installation
  // and may predate this one, so the command line sent over has to be one that
  // every version understands. A path starting with a dash is protected by
  // `./` instead, which needs nothing of the far side.
  const remoteCommand = loginShellCommand([
    shellQuotePath(tool),
    '--no-open',
    ...args.map(shellQuote),
    shellQuotePath(dashSafe(target.file)),
  ].join(' '));

  // -T: no remote tty. With one, ssh would put the terminal in raw mode and
  // the remote's output would arrive with \r\n and no line buffering; without
  // one the remote viewer sees a plain pipe, which is what it expects.
  const ssh = spawn(
    'ssh',
    ['-T', ...SSH_BASE, '-o', `ControlPath=${socket}`, target.hostSpec, remoteCommand],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let settled = false;
  let stderrText = '';
  const cleanup = () => {
    // The socket is removed by ssh itself on a clean exit; this covers a kill.
    fs.rmSync(socket, { force: true });
  };

  try {
    const remoteUrl = await new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(() => {
        ssh.kill();
        finish(
          reject,
          new Error(
            `${target.hostSpec} did not report a URL within ${READY_TIMEOUT_MS / 1000}s.\n` +
              (stderrText.trim() ? stderrText.trim() : 'Is md-viewer installed there?'),
          ),
        );
      }, READY_TIMEOUT_MS);
      timer.unref?.();

      let out = '';
      ssh.stdout.setEncoding('utf8');
      ssh.stdout.on('data', (chunk) => {
        out += chunk;
        // The remote prints its own loopback URL, with the token in the query.
        const found = /http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/\S*/.exec(out);
        if (found) {
          finish(resolve, found[0]);
        }
      });

      // Collected while connecting, so that a failure can explain itself once
      // rather than twice; echoed from then on, since the remote viewer's own
      // diagnostics belong to the user. ssh's password and host-key prompts go
      // straight to the tty rather than down this pipe, so they still show.
      ssh.stderr.setEncoding('utf8');
      ssh.stderr.on('data', (chunk) => {
        if (settled) {
          process.stderr.write(chunk);
        } else {
          stderrText += chunk;
        }
      });

      ssh.on('error', (error) =>
        finish(reject, new Error(`could not run ssh: ${error.message}`)),
      );
      ssh.on('exit', (code) =>
        finish(reject, new Error(remoteFailure(target, tool, code, stderrText))),
      );
    });

    const remotePort = Number(new URL(remoteUrl).port);
    await addForward(socket, target.hostSpec, port, remotePort);

    // From here on the ssh child is the session. When the remote viewer exits
    // because its tab was closed, ssh follows, and so do we.
    ssh.on('exit', (code) => {
      cleanup();
      process.exit(code ?? 0);
    });

    return { ssh, url: localUrl(remoteUrl, port), localPort: port, remotePort };
  } catch (error) {
    ssh.kill();
    cleanup();
    throw error;
  }
}

/**
 * Ask the running master to forward a local port to the remote server. This is
 * the step that cannot happen at connection time, since the remote port is only
 * known once the remote server has chosen it.
 */
function addForward(socket, hostSpec, localPort, remotePort) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      ['-o', `ControlPath=${socket}`, '-O', 'forward', '-L',
       `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, hostSpec],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errors = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (errors += chunk));
    child.on('error', (error) => reject(new Error(`could not run ssh: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`could not forward port ${localPort}: ${errors.trim() || `ssh exited with ${code}`}`));
      }
    });
  });
}

/** Escape a string for use inside a RegExp; a tool path is full of dots. */
function escapeForRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Explain an ssh session that ended before printing a URL. The remote's own
 * message is usually the useful part; the exit code mostly says who failed.
 */
function remoteFailure(target, tool, code, errors) {
  const text = errors.trim();

  // The remote's own message is the useful part and always comes first: an
  // earlier version of this guessed from the exit status alone and reported
  // "not installed" for a remote whose `node` was the thing missing, which is
  // a fix in a different place entirely.
  const detail = text ? `${target.hostSpec}: ${text}` : null;

  // `env: node: No such file or directory` — the tool is there, its
  // interpreter is not, and no amount of MD_VIEWER_REMOTE_CMD will help.
  if (/env: [^:]+: No such file or directory/.test(text)) {
    return (
      `${detail}\n\n` +
      `${tool} is installed on ${target.hostSpec}, but the node in its #! line was\n` +
      `not found. It has to be on the PATH of a login shell on that host.`
    );
  }

  // A shell that could not find the command names it, and only the tool's own
  // name means the tool itself; `env: node:` and friends mean its interpreter.
  const notFound = /command not found|no such file or directory/i.test(text);
  const namesTool = new RegExp(escapeForRegExp(tool), 'i').test(text);
  if ((notFound && namesTool) || (code === 127 && !text)) {
    return (
      (detail ? detail + '\n\n' : '') +
      `${tool} was not found on ${target.hostSpec}. Install it there, or point\n` +
      `MD_VIEWER_REMOTE_CMD at it:\n` +
      `  MD_VIEWER_REMOTE_CMD=~/.local/bin/md-viewer md-viewer ${target.hostSpec}:${target.file}`
    );
  }

  if (detail) {
    return detail;
  }
  return `ssh to ${target.hostSpec} exited with status ${code} before reporting a URL`;
}

/**
 * Read a remote file's contents over ssh.
 *
 * This is the right shape for a diff, and the wrong one for a markdown file: a
 * diff is a snapshot with nothing to watch and no relative images to resolve,
 * so a copy of the bytes is the whole document. A markdown file is neither,
 * which is why it gets a tunnel instead.
 */
export function readRemoteFile(target, { maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    // `cat` needs no login shell to be found, but the path may well start with
    // a `~`, which only a shell expands. `dd` rather than `head -c` when a
    // limit is given: `head -c` is not in POSIX and older busybox lacks it.
    const read = maxBytes
      ? `dd bs=${maxBytes} count=1 2>/dev/null <${shellQuotePath(target.file)}`
      : `cat -- ${shellQuotePath(target.file)}`;
    const ssh = spawn(
      'ssh',
      ['-T', target.hostSpec, loginShellCommand(read)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const chunks = [];
    let errors = '';
    ssh.stdout.on('data', (chunk) => chunks.push(chunk));
    // Collected rather than echoed: the failure below reports it, and a
    // duplicate of `cat: no such file` is worse than none. ssh's own prompts
    // go to the tty directly, not down this pipe, so nothing is swallowed.
    ssh.stderr.setEncoding('utf8');
    ssh.stderr.on('data', (chunk) => (errors += chunk));
    ssh.on('error', (error) => reject(new Error(`could not run ssh: ${error.message}`)));
    ssh.on('exit', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        reject(
          new Error(
            `cannot read ${target.hostSpec}:${target.file}` +
              (errors.trim() ? `: ${errors.trim().split('\n').pop()}` : ` (ssh exited with ${code})`),
          ),
        );
      }
    });
  });
}
