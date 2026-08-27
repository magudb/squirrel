#!/usr/bin/env bash
# Install the Squirrel backend as a macOS LaunchAgent.
# Substitutes paths from the current environment and bootstraps the agent.

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
    echo "This installer is for macOS only. On Linux, use squirrel-backend.service." >&2
    exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO/launchd/com.squirrel.backend.plist"
TARGET="$HOME/Library/LaunchAgents/com.squirrel.backend.plist"
LABEL="com.squirrel.backend"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
    echo "Could not locate node on PATH. Install Node or set NODE_BIN=/path/to/node." >&2
    exit 1
fi

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
if [[ -z "$CLAUDE_BIN" ]]; then
    echo "Warning: 'claude' CLI not found on PATH. /api/analyze-link will fail until you install it." >&2
    CLAUDE_BIN="claude"
fi

DRAFTS_DIR="${SQUIRREL_DRAFTS_DIR:-$HOME/Documents/projects/magudb.github.io/_drafts}"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

sed \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__DRAFTS_DIR__|$DRAFTS_DIR|g" \
    -e "s|__CLAUDE_BIN__|$CLAUDE_BIN|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__PATH__|$(dirname "$NODE_BIN"):$(dirname "$CLAUDE_BIN"):/usr/local/bin:/usr/bin:/bin|g" \
    "$TEMPLATE" > "$TARGET"

# Reload: bootout if already loaded, then bootstrap.
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$TARGET"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

echo "Installed $TARGET"
echo "  node:        $NODE_BIN"
echo "  repo:        $REPO"
echo "  drafts dir:  $DRAFTS_DIR"
echo "  claude bin:  $CLAUDE_BIN"
echo
echo "Logs: ~/Library/Logs/squirrel-backend.{out,err}.log"
echo "Status: launchctl print gui/$UID_NUM/$LABEL"
echo "Health: curl http://localhost:3001/health"
