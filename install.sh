#!/usr/bin/env bash
# Symlinks statusLine.js into ~/.claude so Claude Code can run it from a stable path.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/statusLine.js"
DEST="$HOME/.claude/statusLine.js"

mkdir -p "$HOME/.claude"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  echo "$DEST exists and is not a symlink; move it aside first." >&2
  exit 1
fi
ln -sfn "$SRC" "$DEST"
echo "Linked $DEST -> $SRC"

cat <<'EOF'

If you haven't already, add this to ~/.claude/settings.json:

  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusLine.js",
    "padding": 0
  }
EOF
