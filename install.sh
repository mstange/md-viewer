#!/usr/bin/env bash
# Symlink md-viewer into ~/.local/bin.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bindir="${MD_VIEWER_BINDIR:-$HOME/.local/bin}"
link="$bindir/md-viewer"

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -L "$link" ]]; then
    rm "$link"
    echo "removed $link"
  else
    echo "nothing to remove at $link"
  fi
  exit 0
fi

mkdir -p "$bindir"

if [[ -e "$link" && ! -L "$link" ]]; then
  echo "error: $link exists and is not a symlink" >&2
  exit 1
fi

if [[ ! -d "$here/node_modules" ]]; then
  echo "installing dependencies..."
  (cd "$here" && npm install --omit=dev --silent)
fi

chmod +x "$here/md-viewer.js"
ln -sfn "$here/md-viewer.js" "$link"
echo "linked $link -> $here/md-viewer.js"

case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "note: $bindir is not on your PATH; add it to use md-viewer directly." ;;
esac
