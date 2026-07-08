#!/usr/bin/env bash
set -euo pipefail
# Minimal baseline: core defaults plus the dialog plugin, which Zeus uses
# for file/folder pickers from the Settings view. Update this list when
# adding a new plugin permission so the guard stays meaningful.
ALLOWED='["core:default","dialog:default"]'
for f in src-tauri/capabilities/*.json; do
  ACTUAL=$(jq -c '.permissions' "$f")
  if [[ "$ACTUAL" != "$ALLOWED" ]]; then
    echo "FAIL: $f grants $ACTUAL — expected exactly $ALLOWED"
    exit 1
  fi
done
echo "OK: capabilities unchanged from minimal baseline."
