#!/usr/bin/env bash
# Remove the Squirrel backend LaunchAgent.

set -euo pipefail

LABEL="com.squirrel.backend"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$TARGET"
echo "Removed $TARGET"
