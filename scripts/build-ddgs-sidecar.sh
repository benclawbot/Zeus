#!/usr/bin/env bash
# Build the Zeus ddgs sidecar: a self-contained ddgs.exe that bundles
# Python + ddgs + curl-cffi into one binary so end-users don't need to
# pip-install anything.
#
# Output: src-tauri/binaries/ddgs-x86_64-pc-windows-msvc.exe
# (Tauri looks up sidecars by their build target triple suffix.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$SCRIPT_DIR/ddgs_sidecar_entry.py"
OUT_DIR="$REPO_ROOT/src-tauri/binaries"
OUT_NAME="ddgs"

# Detect target triple. Default to the triple the build env uses; allow
# override via TAURI_TARGET_TRIPLE for cross builds.
TARGET_TRIPLE="${TAURI_TARGET_TRIPLE:-x86_64-pc-windows-msvc}"

# Sanity checks.
[ -f "$ENTRY" ] || { echo "missing $ENTRY" >&2; exit 1; }
command -v python >/dev/null 2>&1 || { echo "python not on PATH" >&2; exit 1; }

# PyInstaller is a build-time dep; install it into the active venv if
# missing. We deliberately don't pin a version — ddgs depends on a
# specific curl-cffi transitively and pinning PyInstaller fights that.
python -c "import PyInstaller" 2>/dev/null || python -m pip install --quiet pyinstaller

# Build. --onefile bundles Python + ddgs + curl-cffi into a single exe.
# --name sets the output base name; --distpath is where --onefile drops it.
# --workpath /tmp keeps the build dir out of the repo.
mkdir -p "$OUT_DIR"
python -m PyInstaller \
  --onefile \
  --name "$OUT_NAME" \
  --distpath "$OUT_DIR/_stage" \
  --workpath "$OUT_DIR/_work" \
  --specpath "$OUT_DIR/_work" \
  --noconfirm \
  --clean \
  "$ENTRY"

# Tauri sidecar naming: <name>-<target-triple><.exe on Windows>.
case "$TARGET_TRIPLE" in
  *windows*) SIDECAR_EXE="$OUT_NAME-${TARGET_TRIPLE}.exe" ;;
  *)         SIDECAR_EXE="$OUT_NAME-${TARGET_TRIPLE}" ;;
esac

mv "$OUT_DIR/_stage/$OUT_NAME.exe" "$OUT_DIR/$SIDECAR_EXE" 2>/dev/null \
  || mv "$OUT_DIR/_stage/$OUT_NAME"   "$OUT_DIR/$SIDECAR_EXE"

rm -rf "$OUT_DIR/_stage" "$OUT_DIR/_work"

echo "wrote $OUT_DIR/$SIDECAR_EXE"
ls -lh "$OUT_DIR/$SIDECAR_EXE"