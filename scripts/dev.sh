#!/usr/bin/env bash
# Live-dev watcher: rebuilds on save and mirrors main.js/manifest.json/styles.css
# straight into the running Obsidian vault's plugin folder.
# Combined with the Hot Reload plugin, edits appear in Obsidian within ~1s.
set -euo pipefail

export VAULT_PLUGIN_DIR="${VAULT_PLUGIN_DIR:-$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/.obsidian/plugins/task-gantt}"

echo "Watching src/ -> $VAULT_PLUGIN_DIR"
cd "$(dirname "$0")/.."
exec npm run dev
