# md-viewer

Preview a Markdown file in a browser tab, with live reload on save.

```
md-viewer notes.md
```

Opens the rendered file in your default browser and stays in the foreground.
Save the file and the tab updates in place, keeping your scroll position. Close
the tab and `md-viewer` exits, giving you back your shell.

## Install

```sh
npm install
./install.sh
```

That symlinks `md-viewer.js` into `~/.local/bin/md-viewer`. Use
`./install.sh --uninstall` to remove the symlink, or set `MD_VIEWER_BINDIR` to
link somewhere else.

Requires Node 20.11 or newer.

## Usage

```
md-viewer [options] <file.md>

  -n, --no-watch    Render once to a standalone HTML file in the temp
                    directory, open it, and exit immediately.
  -p, --port <n>    Listen on this port instead of a random free one.
      --no-open     Print the URL instead of launching a browser.
  -h, --help        Show help.
  -v, --version     Show the version.
```

Environment variables:

| Variable             | Effect                                        |
| -------------------- | --------------------------------------------- |
| `MD_VIEWER_NO_WATCH` | Set to `1` for the same behaviour as `-n`.    |
| `MD_VIEWER_PORT`     | Default port.                                 |
| `MD_VIEWER_BINDIR`   | Install directory used by `install.sh`.       |
| `BROWSER`            | Command used to open the URL.                 |

## What it renders

GitHub-flavoured Markdown: tables, task lists, strikethrough, fenced code with
syntax highlighting, footnotes, and raw HTML. Headings get anchor ids, code
blocks get a copy button, and the page follows your system light/dark setting.

Relative links work: images and other assets are served from disk, and a link
to another `.md` file opens that file in the same tab, watched like the first
one.

## How it works

A server on a random localhost port renders the file and holds a
`Server-Sent Events` connection to the tab. A change to the file pushes a
`change` event; the tab fetches the new HTML and swaps it in. When the last
event stream disconnects and none reconnects within three seconds, the process
exits — that covers closing the tab while surviving reloads and navigation.

The page URL carries a one-time token that is exchanged for a `SameSite=Lax`
cookie, so other pages in the browser cannot use the server to read local
files. Raw HTML in the Markdown is rendered as-is and is not sanitised, which
is worth knowing before pointing this at an untrusted file.
