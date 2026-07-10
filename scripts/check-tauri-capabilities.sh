#!/usr/bin/env bash
set -euo pipefail
# Minimal baseline: core defaults plus the dialog plugin, which Zeus uses
# for file/folder pickers from the Settings view. Update this list when
# adding a new plugin permission so the guard stays meaningful.
ALLOWED='["core:default","dialog:default"]'
for f in src-tauri/capabilities/*.json; do
  if command -v jq >/dev/null 2>&1; then
    ACTUAL=$(jq -c '.permissions' "$f")
  else
    ACTUAL=$(node -e 'const fs = require("fs"); const file = process.argv[1]; process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")).permissions));' "$f")
  fi
  if [[ "$ACTUAL" != "$ALLOWED" ]]; then
    echo "FAIL: $f grants $ACTUAL — expected exactly $ALLOWED"
    exit 1
  fi
done
echo "OK: capabilities unchanged from minimal baseline."
