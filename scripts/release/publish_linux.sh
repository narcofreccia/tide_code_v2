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

# Fixed names = permanent download links. Linux has no updater entry in latest.json yet:
# AppImage (the only Linux updater format we have verified) cannot be built while linuxdeploy
# chokes on the bun sidecar, so the manifest is left untouched here on purpose.
AWS=(aws --endpoint-url "$R2_ENDPOINT")
upload() { "${AWS[@]}" s3 cp "$1" "s3://$R2_BUCKET/linux/$2" --cache-control no-cache --only-show-errors; echo "uploaded linux/$2"; }
[[ -n "$DEB_SRC" ]] && upload "$DEB_SRC" "tide.deb"
[[ -n "$RPM_SRC" ]] && upload "$RPM_SRC" "tide.rpm"
# prune anything else in linux/ so only the newest build is hosted
"${AWS[@]}" s3 ls "s3://$R2_BUCKET/linux/" | awk '{print $4}' | grep -vE '^(tide\.deb|tide\.rpm)$' | while read -r key; do
  [[ -n "$key" ]] && "${AWS[@]}" s3 rm "s3://$R2_BUCKET/linux/$key" --only-show-errors && echo "pruned linux/$key"
done
for name in tide.deb tide.rpm; do
  curl -fsIL --max-time 30 "${TIDE_PUBLIC_BUCKET%/}/linux/$name" >/dev/null && echo "verified ${TIDE_PUBLIC_BUCKET%/}/linux/$name" || true
done
echo "linux publish done"
