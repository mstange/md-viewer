import { spawn } from 'node:child_process';

/** Open a URL in the user's browser, honouring $BROWSER over the platform default. */
export function openBrowser(url, tool = 'md-viewer') {
  let command;
  let args;
  if (process.env.BROWSER) {
    [command, ...args] = process.env.BROWSER.split(' ');
    args.push(url);
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', url.replace(/&/g, '^&')];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.error(`${tool}: could not run ${command}, open the URL above.`));
  child.unref();
}
