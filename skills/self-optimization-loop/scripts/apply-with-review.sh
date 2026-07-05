#!/usr/bin/env bash
set -euo pipefail
PROPOSAL="${1:?Usage: apply-with-review.sh <proposal.json>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_LOG="$SCRIPT_DIR/../../../.security/apply-audit.log"
mkdir -p "$(dirname "$AUDIT_LOG")"

python3 -c "import json,sys; p=json.load(open('$PROPOSAL')); print(p.get('diff',''))"
echo
echo "Target skill : $(python3 -c "import json;print(json.load(open('$PROPOSAL'))['target_skill'])")"
echo "Risk label   : $(python3 -c "import json;print(json.load(open('$PROPOSAL'))['risk'])")  (informational only — not trusted)"
read -rp 'Type exactly "APPLY" to confirm you read the diff above: ' CONFIRM
[[ "$CONFIRM" == "APPLY" ]] || { echo "Aborted."; exit 1; }
read -rp "Reason for approval (logged): " REASON

echo "$(date -u +%FT%TZ) | user=$(whoami) | proposal=$PROPOSAL | reason=$REASON" >> "$AUDIT_LOG"
python3 "$SCRIPT_DIR/core.py" apply --proposal "$PROPOSAL" --approve
