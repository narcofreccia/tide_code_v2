#!/usr/bin/env bash
# Compiles apps/server into a single self-contained `tide-server` binary with Bun and
# drops it in apps/desktop/src-tauri/binaries/ under the Rust target-triple suffix that
# Tauri's `externalBin` resolution expects.
#
#   ./scripts/build-server-sidecar.sh          # host target only
#   ./scripts/build-server-sidecar.sh --all    # every documented cross target
#
# Notes
# -----
# * SQLite: apps/server/src/db/sqlite.ts picks `bun:sqlite` when `globalThis.Bun` exists,
#   so the compiled binary uses Bun's built-in driver and needs no native module. The
#   `node:sqlite` branch is marked external below so the bundler does not try to resolve it.
# * node-pty is a native (N-API) module. `bun build --compile` cannot embed a .node file,
#   so it is externalised too; the server only imports it lazily for the terminal feature
#   and degrades gracefully when the import fails. Terminals are therefore unavailable in
#   the bundled sidecar until a prebuilt .node is shipped alongside it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$REPO_ROOT/apps/server/src/bin.ts"
OUT_DIR="$REPO_ROOT/apps/desktop/src-tauri/binaries"

# rust-target-triple : bun --target
HOST_TRIPLE="$(rustc -vV | awk '/^host: /{print $2}')"
declare -a TARGETS=(
  "aarch64-apple-darwin:bun-darwin-arm64"
  "x86_64-apple-darwin:bun-darwin-x64"
  "x86_64-unknown-linux-gnu:bun-linux-x64"
  "aarch64-unknown-linux-gnu:bun-linux-arm64"
  "x86_64-pc-windows-msvc:bun-windows-x64"
)

bun_target_for() {
  for pair in "${TARGETS[@]}"; do
    [ "${pair%%:*}" = "$1" ] && { echo "${pair#*:}"; return 0; }
  done
  return 1
}

build_one() {
  local triple="$1" bun_target
  bun_target="$(bun_target_for "$triple")" || { echo "unsupported target $triple" >&2; return 1; }
  local suffix=""
  [[ "$triple" == *windows* ]] && suffix=".exe"
  local outfile="$OUT_DIR/tide-server-$triple$suffix"
  echo "==> $triple ($bun_target)"
  bun build --compile --target="$bun_target" \
    --external node-pty \
    --external "node:sqlite" \
    --outfile "$outfile" \
    "$ENTRY"
  chmod +x "$outfile" 2>/dev/null || true
  ls -lh "$outfile"
}

mkdir -p "$OUT_DIR"
command -v bun >/dev/null || { echo "bun is required (https://bun.sh)" >&2; exit 1; }

if [ "${1:-}" = "--all" ]; then
  for pair in "${TARGETS[@]}"; do build_one "${pair%%:*}" || true; done
else
  build_one "${1:-$HOST_TRIPLE}"
fi
