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
BUNDLE_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle/appimage"
TAURI_CONF="$ROOT/apps/desktop/src-tauri/tauri.conf.json"

PY="$(command -v python3 || command -v python)"
AWS=(aws --endpoint-url "$R2_ENDPOINT")

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -n "${R2_ENDPOINT:-}" && -n "${R2_BUCKET:-}" && -n "${TIDE_PUBLIC_BUCKET:-}" ]] || die "R2 env missing"

# tauri.conf.json's "version" is a path to the root package.json — follow it.
VERSION="$("$PY" -c "
import json, os
conf = json.load(open('$TAURI_CONF'))
v = conf.get('version', '')
if isinstance(v, str) and v.endswith('.json'):
    v = json.load(open(os.path.join(os.path.dirname('$TAURI_CONF'), v)))['version']
print(v)")"
# The AppImage is the download; the .AppImage.tar.gz is what the updater fetches.
APPIMAGE_SRC="$(ls -t "$BUNDLE_DIR/"*.AppImage 2>/dev/null | head -1 || true)"
[[ -n "$APPIMAGE_SRC" ]] || die "no *.AppImage in $BUNDLE_DIR"
UPDATER_SRC="$(ls -t "$BUNDLE_DIR/"*.AppImage.tar.gz 2>/dev/null | head -1 || true)"
[[ -n "$UPDATER_SRC" ]] || die "no *.AppImage.tar.gz in $BUNDLE_DIR (createUpdaterArtifacts?)"
SIG_SRC="$UPDATER_SRC.sig"
[[ -f "$SIG_SRC" ]] || die "missing updater signature: $SIG_SRC (createUpdaterArtifacts?)"

APPIMAGE_NAME="tide.AppImage"          # fixed — permanent download link
UPDATER_NAME="tide.AppImage.tar.gz"    # fixed — updater artifact
PLATFORM_KEY="linux-x86_64"
ARTIFACT_URL="${TIDE_PUBLIC_BUCKET%/}/linux/$UPDATER_NAME"
echo "==> v$VERSION · $PLATFORM_KEY · $(basename "$APPIMAGE_SRC") → linux/$APPIMAGE_NAME"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Start from the LIVE manifest so mac/windows keys are preserved.
curl -fsS --max-time 15 "${TIDE_PUBLIC_BUCKET%/}/latest.json" -o "$STAGE/latest.json" 2>/dev/null || : > "$STAGE/latest.json"

"$PY" "$ROOT/scripts/release/merge_manifest.py" \
  --manifest "$STAGE/latest.json" \
  --platform "$PLATFORM_KEY" \
  --version "$VERSION" \
  --signature "$(tr -d '\n' < "$SIG_SRC")" \
  --url "$ARTIFACT_URL"

# Artifact FIRST, manifest second — never point installed apps at a URL that
# doesn't resolve yet.
echo "==> Uploading artifacts"
"${AWS[@]}" s3 cp "$APPIMAGE_SRC" "s3://$R2_BUCKET/linux/$APPIMAGE_NAME" --cache-control "no-cache"
"${AWS[@]}" s3 cp "$UPDATER_SRC" "s3://$R2_BUCKET/linux/$UPDATER_NAME" --cache-control "no-cache"

echo "==> Uploading manifest"
"${AWS[@]}" s3 cp "$STAGE/latest.json" "s3://$R2_BUCKET/latest.json" \
  --content-type application/json --cache-control "no-cache"

echo "==> Pruning linux/ (keeping $APPIMAGE_NAME, $UPDATER_NAME)"
("${AWS[@]}" s3 ls "s3://$R2_BUCKET/linux/" || true) | awk '{print $NF}' | while read -r obj; do
  [[ -z "$obj" || "$obj" == "$APPIMAGE_NAME" || "$obj" == "$UPDATER_NAME" ]] && continue
  echo "    rm linux/$obj"
  "${AWS[@]}" s3 rm "s3://$R2_BUCKET/linux/$obj"
done

echo "==> Verifying updater path"
REMOTE_VERSION="$(curl -fsS --max-time 20 "${TIDE_PUBLIC_BUCKET%/}/latest.json" | "$PY" -c "import json,sys; d=json.load(sys.stdin); e=(d.get('platforms') or {}).get('$PLATFORM_KEY') or {}; print(d.get('version','') if e.get('url') and e.get('signature') else '')")"
[[ "$REMOTE_VERSION" == "$VERSION" ]] || die "published manifest failed verification (got '$REMOTE_VERSION', want '$VERSION')"
curl -fsIL --max-time 30 "$ARTIFACT_URL" >/dev/null || die "artifact URL not reachable: $ARTIFACT_URL"

echo "==> Done — fixed download link: ${TIDE_PUBLIC_BUCKET%/}/linux/$APPIMAGE_NAME"
