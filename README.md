# md-viewer

Preview a Markdown file in a browser tab, with live reload on save.

```
md-viewer notes.md
```

Opens the rendered file in your default browser and stays in the foreground.
Save the file and the tab updates in place, keeping your scroll position. Close
the tab and `md-viewer` exits, giving you back your shell.

Its companion `diff-viewer` shows a diff the same way, to comment on and hand
back to an agent:

```
git diff | diff-viewer
```

## Install

```sh
npm install
./install.sh
```

That symlinks both commands into `~/.local/bin`. Use
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
| `MD_VIEWER_DEBUG`    | Log why and when the server decides to exit.  |
| `DIFF_VIEWER_PORT`   | Default port for `diff-viewer`.               |

## What it renders

GitHub-flavoured Markdown: tables, task lists, strikethrough, fenced code with
syntax highlighting, footnotes, and raw HTML. Headings get anchor ids, code
blocks get a copy button, and the page follows your system light/dark setting.

Relative links work: images and other assets are served from disk, and a link
to another `.md` file opens that file in the same tab, watched like the first
one. Links to other sites open in a new tab, so following one never unloads the
preview.

## Review comments

Select text in the preview and a box opens to comment on it. `Enter` saves,
`Shift+Enter` adds a newline, `Escape` cancels. Saved passages are highlighted;
click one to edit its comment, or empty it and press `Enter` to delete it.

A pill in the corner counts the comments and copies the lot out as a prompt:

```
Please address these review comments on /tmp/notes.md:

- notes.md:12 — "the first paragraph"
  this wording is vague

- notes.md:31 — "42"
  why this value?
```

The line numbers come from the renderer, which records the source line of every
block it emits, so an agent can go straight to the passage.

Comments live in the page and nothing is written to disk. Saving the file keeps
them: each one remembers the text it refers to along with the text either side,
so it re-attaches after the reload as long as that passage is still there. A
comment whose text you deleted stays in the list, with nothing left to point at.
Reloading the tab yourself starts over, so copy the prompt out before you do.

## Reviewing a diff

`diff-viewer` shows a unified diff with the same review comments. The diff
usually comes from a command rather than a file, so it reads stdin by default:

```
git diff | diff-viewer
git show HEAD | diff-viewer
diff-viewer changes.patch
```

`md-viewer` hands a file over to it automatically when the file turns out to be
a diff, so `md-viewer some.patch` does the right thing.

```
diff-viewer [options] [file.diff]

  -o, --output <f>  Write a standalone HTML file instead of serving it.
  -p, --port <n>    Listen on this port instead of a random free one.
      --no-open     Print the URL instead of launching a browser.
  -t, --title <s>   Name this diff in the tab and page header.
  -h, --help        Show help.
  -v, --version     Show the version.
```

### What it shows

Two things a plain `git diff` leaves you to work out for yourself:

- **A line changed only by whitespace says so.** The changed runs spell their
  spaces and tabs out as `·` and `→`, and the line is tagged `whitespace`, so a
  reindent is never mistaken for a real edit.
- **One word changing in a sentence highlights that word.** Lines are matched
  to the line they became by how much text they share, not by their position in
  the hunk, so an edit is still found when ten lines were inserted above it. A
  line broken in two is matched to both halves, and the words it kept are
  marked on each. Where two candidates are equally good and hold the same text,
  neither is the answer and the line is left unmarked — a paragraph reflowed
  has no one line that became another.
- **A line with no counterpart is coloured across its whole row**, rather than
  having its text highlighted: what changed there is the line, and a mark that
  hugs the words reads as a highlighter drawn over them.

A checkbox switches between unified and side-by-side. The starting choice comes
from the window width — side by side above 1400px — and then stays put, so a
resize never reflows the page while you are writing a comment.

### The prompt it copies

Each comment names the file and line, and quotes the diff around it:

~~~
Please address these review comments on the following diff:

- lib/render.js:47 — "return handleEverything(x)"

  ```diff
     let i = 0;
     while (i < n) {
  -    return handleEverything(x);
  +    throw new Error("nope");
     }
  ```

  why is this removed?
~~~

The surrounding lines are there because line numbers drift between revisions of
a patch: quoting the passage lets an agent find it even when the numbers have
moved. A comment on a deleted line says so, since its number belongs to the
original file rather than the new one.

Unlike `md-viewer` there is nothing to watch — a diff piped in has no file
behind it and cannot change. So the page is served once with its stylesheet and
scripts inlined, and the command exits as soon as the browser has taken it. The
tab keeps working on its own: comments were always page-local, and copying them
out needs nothing from the process that served them.

## How md-viewer works

A server on a random localhost port renders the file and holds a
`Server-Sent Events` connection to the tab. A change to the file pushes a
`change` event; the tab fetches the new HTML and swaps it in.

Exiting when the tab goes away is guesswork, because no browser event
distinguishes a close from a reload: the page reports the same `pagehide` for a
close, a reload, an in-tab navigation, a browser shutdown, and a tab Firefox
discards under memory pressure. What does distinguish them is the order requests
arrive in — a reload or a navigation commits its new response *before* the old
document unloads, so the page request is already served by the time the goodbye
lands. So once no event stream is left:

| What the server saw                     | It waits |
| --------------------------------------- | -------- |
| A goodbye, no page being served         | 150ms    |
| A page being served, or just served     | 20s      |
| A stream that died without a goodbye    | 60s      |

Closing the tab therefore returns the prompt right away, a slow reload is not a
race, and a dropped connection — a suspend, a VPN reconnect, a frozen content
process — no longer kills a viewer whose tab is still open. Set
`MD_VIEWER_DEBUG=1` to watch those decisions.

The page URL carries a one-time token that is exchanged for a `SameSite=Lax`
cookie, so other pages in the browser cannot use the server to read local
files. Raw HTML in the Markdown is rendered as-is and is not sanitised, which
is worth knowing before pointing this at an untrusted file.
