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

`npm test` runs the diff renderer's tests: no dependencies beyond the ones
above, since they read the rendered HTML directly.

## Usage

```
md-viewer [options] <file.md>
md-viewer [options] [user@]host:/path/to/file.md

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
| `MD_VIEWER_BUG_URL`  | Where a bug named in a commit message links, with `{id}` for the number. |
| `DIFF_VIEWER_PORT`   | Default port for `diff-viewer`.               |
| `MD_VIEWER_REMOTE_CMD` | Path to `md-viewer` on the remote host.     |

## Files on another machine

A target spelled the way `scp` spells one is opened over ssh:

```sh
md-viewer m4:/Volumes/build/firefox/artifacts/overview.md
```

The file is never copied. `md-viewer` runs on `m4`, serving on that host's
loopback interface, and this machine forwards a local port to it over the same
ssh connection — so the browser opens `http://127.0.0.1:<port>` as it always
does, and the tab behaves exactly as it does for a local file: live reload on
save, working relative links, and images served from the remote disk.

Nothing is exposed on either network. The server only ever listens on the
remote loopback, so the URL token and the file's contents stay inside the ssh
connection, and it works through NAT and firewalls since the only connection
made is the outgoing ssh one. Closing the tab ends the remote server, the
tunnel and the local command, in that order; Ctrl-C does the same.

`md-viewer` has to be installed on the remote host, and reachable from a
*non-interactive* ssh session — which does not read `~/.zshrc` or `~/.bashrc`,
so a `~/.local/bin` added there will not be found. Either put it somewhere on
the default PATH or name it:

```sh
MD_VIEWER_REMOTE_CMD=~/.local/bin/md-viewer md-viewer m4:notes.md
```

`diff-viewer` takes the same targets, but works differently: a diff cannot
change under you and has no relative images, so its bytes are fetched over ssh
and the page is served from here, with no tunnel involved. A remote file that
turns out to be a diff is handed to `diff-viewer` the same way a local one is.

`-n`/`--no-watch` has no remote meaning — the standalone HTML file it writes
would be left on the remote machine — so it is refused rather than ignored.

## What it renders

GitHub-flavoured Markdown: tables, task lists, strikethrough, fenced code with
syntax highlighting, footnotes, and raw HTML. Headings get anchor ids, code
blocks get a copy button, and the page follows your system light/dark setting.

Relative links work: images and other assets are served from disk, and a link
to another `.md` file opens that file in the same tab, watched like the first
one. Links to other sites open in a new tab, so following one never unloads the
preview.

## Commit links

A commit id written in backticks becomes a link to that commit's diff, opened
in a new tab as a review page — the same one `diff-viewer` shows, with the same
comment-and-copy workflow.

The commit is looked up in the git repository containing the file being viewed,
found by walking up from its directory. Only ids that repository really has
become links: a bug number, a hex colour or a sha from some other checkout is
left as the code span it was, so a document is not littered with dead links.

This is what makes a file that reviews a stack of work readable — a table of
shas becomes a table of diffs to click through:

| n | commit | what |
| --- | --- | --- |
| 1 | `dd8641c54ce3` | raise the window on SetFocus |
| 2 | `8d10d1bb756e` | un-skip the a11y test on mac |

Ids are recognised between 7 and 40 hex characters, and only when a code span
holds nothing else. A review copied out of a commit's tab names that commit by
its full sha, so comments on different commits of a stack stay apart once they
are pasted somewhere else.

The commit's message is shown above the diff, in full rather than as a subject
line: the message is where a change says *why*, which is most of what makes a
patch reviewable. It is ordinary content of the page, so a passage of it can be
commented on like any line of code — a claim in a message can be wrong when
every line of the diff is right. Such a comment names the message rather than a
file, and is quoted as prose rather than as a patch.

A bug named in the message, as in `Bug 1951421 - Hold the decision`, is a
link to that bug on Mozilla's Bugzilla, opened in a new tab. Set
`MD_VIEWER_BUG_URL` to point somewhere else, with `{id}` standing for the
number: `https://bugs.webkit.org/show_bug.cgi?id={id}`.

## File links

A markdown file named in backticks becomes a link to that file, opened in a new
tab, so a document that points at other documents is navigable without anyone
having written those links by hand:

| file | what it covers |
| --- | --- |
| `README.md` | the whole tool |
| `docs/architecture.md` | why the renderer is synchronous |

The path is resolved beside the file being viewed first, then from the root of
the repository around it — the two ways a path is actually written down, one
from a sibling reference and one copied out of a `git` command or a build log.
A path that starts with `./` or `../` is only read relative to the document,
since it already says where to start from.

As with a commit id, only a code span holding nothing but the path counts, and
only a file really on the disk becomes a link: a name that is a plan rather
than a file, a glob, a URL, or a path to something that is not markdown is left
as the code span it was. A document does not link to itself. Nothing is cached,
so a file written after the page was opened is a link on the next save.

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

A page opened from a commit link names the commit instead, so the review says
what it is about once it has left the tab:

~~~
Please address these review comments on commit dd8641c54ce3de977764fdc1afbe8de3ae6f1b18 (raise the window on SetFocus):

- the commit message, line 4 — "it always activated the app"

  ```
  Only raise the window when the caller asked for focus, since
  it always activated the app and stole focus from other spaces.
  ```

  this says the opposite of what the patch does
~~~

Unlike `md-viewer` there is nothing to watch — a diff piped in has no file
behind it and cannot change. So the page is self-contained, with its stylesheet
and scripts inlined, and the command exits a few seconds after the browser stops
asking for it. Reloading the tab keeps it alive that bit longer; once it has
gone, the tab still works, since comments were always page-local and copying
them out needs nothing from the process that served them.

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
