#!/usr/bin/env bash
# =============================================================================
# Publish the Linux AppImage build to R2 — the Linux half of build_release.sh.
# Runs in CI (.github/workflows/release-linux.yml on an ubuntu-latest runner)
# after `tauri build --bundles appimage`; also works locally on Linux.
#
# Same distribution rules as macOS (docs/RELEASING.md): FIXED artifact names
# (permanent download links), overwrite in place with no-cache, prune extras,
# and mutate ONLY the linux-x86_64 key of the shared latest.json via
# scripts/release/merge_manifest.py (mac/windows entries preserved). Ends with the same
# updater end-to-end verification as the mac script.
#
# Env: R2_ENDPOINT, R2_BUCKET (bucket/prefix), TIDE_PUBLIC_BUCKET
# (public base, e.g. https://pub-….r2.dev/tidecode),
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (the house r2 token).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
die() { echo "publish_linux: $*" >&2; exit 1; }

R2_ENDPOINT="${R2_ENDPOINT:-https://d76960bd74940e6213de6aa16f3e04fd.r2.cloudflarestorage.com}"
R2_BUCKET="${R2_BUCKET:-storage/tidecode}"
TIDE_PUBLIC_BUCKET="${TIDE_PUBLIC_BUCKET:-https://pub-7b3e5bbd605d43adbeb4601a962d84bd.r2.dev/tidecode}"
BUNDLE_ROOT="$ROOT/apps/desktop/src-tauri/target/release/bundle"
DEB_SRC="$(ls -t "$BUNDLE_ROOT/deb/"*.deb 2>/dev/null | head -1 || true)"
RPM_SRC="$(ls -t "$BUNDLE_ROOT/rpm/"*.rpm 2>/dev/null | head -1 || true)"
[[ -n "$DEB_SRC" || -n "$RPM_SRC" ]] || die "no .deb/.rpm under $BUNDLE_ROOT (tauri build --bundles deb,rpm)"

# Fixed names = permanent download links. Linux has no Tauri updater entry in latest.json:
# AppImage (the only Linux updater format we have verified) cannot be built while linuxdeploy
# chokes on the bun sidecar, so `platforms` is left untouched. What Linux DOES publish is the
# headless server tarball (`server/x86_64-unknown-linux-gnu/`) for `tide update` and headless
# installs (docs/internals/remote.md); the web tarball is the mac release's (one `web` key).
AWS=(aws --endpoint-url "$R2_ENDPOINT")
PY="$(command -v python3 || command -v python)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
SERVER_TRIPLE="x86_64-unknown-linux-gnu"
SERVER_BIN="$ROOT/apps/desktop/src-tauri/binaries/tide-server-$SERVER_TRIPLE"
SERVER_TARBALL_NAME="tide-server.tar.gz"
upload() { "${AWS[@]}" s3 cp "$1" "s3://$R2_BUCKET/linux/$2" --cache-control no-cache --only-show-errors; echo "uploaded linux/$2"; }
[[ -n "$DEB_SRC" ]] && upload "$DEB_SRC" "tide.deb"
[[ -n "$RPM_SRC" ]] && upload "$RPM_SRC" "tide.rpm"
# prune anything else in linux/ so only the newest build is hosted
# (same loop as publish_windows.sh: a filtering `grep -v` that matches nothing exits 1 and,
# under pipefail, failed the step after both uploads had succeeded)
("${AWS[@]}" s3 ls "s3://$R2_BUCKET/linux/" || true) | awk '{print $NF}' | while read -r key; do
  [[ -z "$key" || "$key" == "tide.deb" || "$key" == "tide.rpm" ]] && continue
  "${AWS[@]}" s3 rm "s3://$R2_BUCKET/linux/$key" --only-show-errors
  echo "pruned linux/$key"
done
for name in tide.deb tide.rpm; do
  curl -fsIL --max-time 30 "${TIDE_PUBLIC_BUCKET%/}/linux/$name" >/dev/null && echo "verified ${TIDE_PUBLIC_BUCKET%/}/linux/$name" || true
done

# --- Headless server tarball (artifact first, manifest second) -----------------------
[[ -f "$SERVER_BIN" ]] || die "no $SERVER_BIN — run scripts/build-server-sidecar.sh --target linux-x64 first"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/server"
cp "$SERVER_BIN" "$STAGE/server/tide-server" && chmod 755 "$STAGE/server/tide-server"
tar -czf "$STAGE/$SERVER_TARBALL_NAME" -C "$STAGE/server" tide-server
SERVER_SHA="$(sha256sum "$STAGE/$SERVER_TARBALL_NAME" | awk '{print $1}')"
echo "$SERVER_SHA  $SERVER_TARBALL_NAME" > "$STAGE/$SERVER_TARBALL_NAME.sha256"
SERVER_URL="${TIDE_PUBLIC_BUCKET%/}/server/$SERVER_TRIPLE/$SERVER_TARBALL_NAME"
echo "==> headless $SERVER_TRIPLE $SERVER_SHA"
"${AWS[@]}" s3 cp "$STAGE/$SERVER_TARBALL_NAME" "s3://$R2_BUCKET/server/$SERVER_TRIPLE/$SERVER_TARBALL_NAME" --cache-control no-cache --only-show-errors
"${AWS[@]}" s3 cp "$STAGE/$SERVER_TARBALL_NAME.sha256" "s3://$R2_BUCKET/server/$SERVER_TRIPLE/$SERVER_TARBALL_NAME.sha256" --content-type text/plain --cache-control no-cache --only-show-errors
("${AWS[@]}" s3 ls "s3://$R2_BUCKET/server/$SERVER_TRIPLE/" || true) | awk '{print $NF}' | while read -r key; do
  [[ -z "$key" || "$key" == "$SERVER_TARBALL_NAME" || "$key" == "$SERVER_TARBALL_NAME.sha256" ]] && continue
  "${AWS[@]}" s3 rm "s3://$R2_BUCKET/server/$SERVER_TRIPLE/$key" --only-show-errors
  echo "pruned server/$SERVER_TRIPLE/$key"
done

# Merge ONLY server[linux triple] into the live manifest (mac/windows keys and `web` survive).
# Runs after the mac release of the same version; merge_manifest.py refuses a downgrade.
curl -fsS --max-time 15 "${TIDE_PUBLIC_BUCKET%/}/latest.json" -o "$STAGE/latest.json" 2>/dev/null || : > "$STAGE/latest.json"
"$PY" "$ROOT/scripts/release/merge_manifest.py" \
  --manifest "$STAGE/latest.json" \
  --version "$VERSION" \
  --server-triple "$SERVER_TRIPLE" \
  --server-url "$SERVER_URL" \
  --server-sha256 "$SERVER_SHA"
"${AWS[@]}" s3 cp "$STAGE/latest.json" "s3://$R2_BUCKET/latest.json" --content-type application/json --cache-control no-cache --only-show-errors
echo "uploaded latest.json (server[$SERVER_TRIPLE] = $VERSION)"

CHECK="$(curl -fsS --max-time 20 "${TIDE_PUBLIC_BUCKET%/}/latest.json" | "$PY" -c "
import json, sys
d = json.load(sys.stdin)
s = (d.get('server') or {}).get('$SERVER_TRIPLE') or {}
print('ok' if d.get('version') == '$VERSION' and s.get('version') == '$VERSION' and s.get('sha256') == '$SERVER_SHA' else 'mismatch')" || echo unparseable)"
[[ "$CHECK" == "ok" ]] || die "published latest.json failed the headless verification ($CHECK)"
curl -fsIL --max-time 30 "$SERVER_URL" >/dev/null || die "headless artifact not reachable: $SERVER_URL"
curl -fsIL --max-time 30 "$SERVER_URL.sha256" >/dev/null || die "headless checksum not reachable: $SERVER_URL.sha256"
echo "headless verified: $SERVER_URL"
echo "linux publish done"
