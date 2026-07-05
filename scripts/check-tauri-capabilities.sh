#!/usr/bin/env bash
set -euo pipefail
ALLOWED='["core:default"]'
for f in src-tauri/capabilities/*.json; do
  ACTUAL=$(jq -c '.permissions' "$f")
  if [[ "$ACTUAL" != "$ALLOWED" ]]; then
    echo "FAIL: $f grants $ACTUAL — expected exactly $ALLOWED"
    exit 1
  fi
done
echo "OK: capabilities unchanged from minimal baseline."
