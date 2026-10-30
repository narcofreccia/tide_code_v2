#!/usr/bin/env bash
# Compiles apps/server into a single self-contained `tide-server` binary with Bun and
# drops it in apps/desktop/src-tauri/binaries/ under the Rust target-triple suffix that
# Tauri's `externalBin` resolution expects.
#
#   ./scripts/build-server-sidecar.sh                        # host target only
#   ./scripts/build-server-sidecar.sh --all                  # every cross target
#   ./scripts/build-server-sidecar.sh --target windows-x64   # one named target
#   ./scripts/build-server-sidecar.sh x86_64-apple-darwin    # one rust triple
#   ./scripts/build-server-sidecar.sh --with-web [target…]   # also copy apps/web/dist to binaries/web
#
# --target accepts the short names darwin-arm64 | darwin-x64 | linux-x64 |
# linux-arm64 | windows-x64; the output is always named for the matching Rust
# target triple (with .exe on Windows) because that is what Tauri's externalBin
# resolution looks for.
#
# Notes
# -----
# * Version: the root package.json version is embedded with `--define TIDE_BUILD_VERSION=…`
#   (apps/server/src/version.ts); the compiled binary cannot read package.json at run time.
# * --with-web: `tide serve` serves `<binaryDir>/web` (SPA) when present, so a headless
#   install is the binary plus that folder. Build the web app first (`pnpm --filter @tide/web build`).
# * SQLite: apps/server/src/db/sqlite.ts picks `bun:sqlite` when `globalThis.Bun` exists,
#   so the compiled binary uses Bun's built-in driver and needs no native module. The
#   `node:sqlite` branch is marked external below so the bundler does not try to resolve it.
# * node-pty is a native (N-API) module. `bun build --compile` cannot embed a .node file,
#   so it is externalised; the server only imports it lazily and degrades gracefully when
#   the import fails. Terminals still work in the bundled sidecar: apps/server/src/workspace/
#   pty/manager.ts picks the Bun backend (Bun.spawn's `terminal` option, bunBackend.ts)
#   whenever `globalThis.Bun` exists on a non-Windows platform, so node-pty is only the
#   Node/Windows path.
# * KNOWN LIMITATION (Windows): Bun's PTY support is macOS/Linux only, so the
#   windows-x64 sidecar has NO terminal at all — the server reports the terminal
#   feature as `unavailable` and every other feature works normally. Fixing this
#   means shipping a node-pty prebuild for win32-x64 as a Tauri resource and
#   pointing the lazy import at it. Documented in docs/RELEASING.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$REPO_ROOT/apps/server/src/bin.ts"
OUT_DIR="$REPO_ROOT/apps/desktop/src-tauri/binaries"


VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
WITH_WEB=0
if [ "${1:-}" = "--with-web" ]; then WITH_WEB=1; shift; fi

HOST_TRIPLE="$(rustc -vV | awk '/^host: /{print $2}')"
# rust-target-triple : bun --target ; short --target names map onto the same rows.
declare -a TARGETS=(
  "aarch64-apple-darwin:bun-darwin-arm64"
  "x86_64-apple-darwin:bun-darwin-x64"
  "x86_64-unknown-linux-gnu:bun-linux-x64"
  "aarch64-unknown-linux-gnu:bun-linux-arm64"
  "x86_64-pc-windows-msvc:bun-windows-x64"
)

# Short --target name -> rust triple.
declare -a ALIASES=(
  "darwin-arm64:aarch64-apple-darwin"
  "darwin-x64:x86_64-apple-darwin"
  "linux-x64:x86_64-unknown-linux-gnu"
  "linux-arm64:aarch64-unknown-linux-gnu"
  "windows-x64:x86_64-pc-windows-msvc"
)

triple_for() {
  for pair in "${ALIASES[@]}"; do
    [ "${pair%%:*}" = "$1" ] && { echo "${pair#*:}"; return 0; }
  done
  echo "$1"
}

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
    --define "TIDE_BUILD_VERSION=\"$VERSION\"" \
    --outfile "$outfile" \
    "$ENTRY"
  chmod +x "$outfile" 2>/dev/null || true
  ls -lh "$outfile"
}

mkdir -p "$OUT_DIR"
if [ "$WITH_WEB" = 1 ]; then
  [ -f "$REPO_ROOT/apps/web/dist/index.html" ] || { echo "apps/web/dist is missing: run pnpm --filter @tide/web build" >&2; exit 1; }
  rm -rf "$OUT_DIR/web" && cp -R "$REPO_ROOT/apps/web/dist" "$OUT_DIR/web"
  echo "==> web client copied to $OUT_DIR/web"
fi
command -v bun >/dev/null || { echo "bun is required (https://bun.sh)" >&2; exit 1; }

case "${1:-}" in
  --all)
    for pair in "${TARGETS[@]}"; do build_one "${pair%%:*}" || true; done
    ;;
  --target)
    [ -n "${2:-}" ] || { echo "--target needs a value" >&2; exit 1; }
    build_one "$(triple_for "$2")"
    ;;
  -h|--help)
    sed -n '2,36p' "${BASH_SOURCE[0]}"
    ;;
  "")
    build_one "$HOST_TRIPLE"
    ;;
  *)
    build_one "$(triple_for "$1")"
    ;;
esac
