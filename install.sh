#!/usr/bin/env bash
# Symlink md-viewer, diff-viewer and stack-viewer into ~/.local/bin.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bindir="${MD_VIEWER_BINDIR:-$HOME/.local/bin}"
tools=(md-viewer diff-viewer stack-viewer)

if [[ "${1:-}" == "--uninstall" ]]; then
  for tool in "${tools[@]}"; do
    link="$bindir/$tool"
    if [[ -L "$link" ]]; then
      rm "$link"
      echo "removed $link"
    else
      echo "nothing to remove at $link"
    fi
  done
  exit 0
fi

mkdir -p "$bindir"

for tool in "${tools[@]}"; do
  link="$bindir/$tool"
  if [[ -e "$link" && ! -L "$link" ]]; then
    echo "error: $link exists and is not a symlink" >&2
    exit 1
  fi
done

if [[ ! -d "$here/node_modules" ]]; then
  echo "installing dependencies..."
  (cd "$here" && npm install --omit=dev --silent)
fi

for tool in "${tools[@]}"; do
  chmod +x "$here/$tool.js"
  ln -sfn "$here/$tool.js" "$bindir/$tool"
  echo "linked $bindir/$tool -> $here/$tool.js"
done

case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "note: $bindir is not on your PATH; add it to use these directly." ;;
esac
