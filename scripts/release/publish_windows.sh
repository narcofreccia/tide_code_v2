#!/usr/bin/env bash
# =============================================================================
# Publish the Windows NSIS build to R2 — the Windows half of build_release.sh.
# Runs in CI (.github/workflows/release-windows.yml, git-bash on a
# windows-latest runner) after `tauri build --bundles nsis`; also works
# locally on a Windows machine.
#
# Same distribution rules as macOS (docs/RELEASING.md): FIXED artifact name
# (permanent download link), overwrite in place with no-cache, prune extras,
# and mutate ONLY the windows-x86_64 key of the shared latest.json via
# scripts/release/merge_manifest.py (mac/linux entries preserved). Ends with the same
# updater end-to-end verification as the mac script.
#
# Env: R2_ENDPOINT, R2_BUCKET (bucket/prefix), TIDE_PUBLIC_BUCKET
# (public base, e.g. https://pub-….r2.dev/tidecode),
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (the house r2 token).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# git-bash paths (/d/a/…) are opaque to the runner's native Windows Python and
# aws.exe — convert to mixed form (D:/a/…), which every tool understands.
if command -v cygpath >/dev/null 2>&1; then ROOT="$(cygpath -m "$ROOT")"; fi
BUNDLE_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle/nsis"
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
SETUP_SRC="$(ls -t "$BUNDLE_DIR/"*-setup.exe 2>/dev/null | head -1 || true)"
[[ -n "$SETUP_SRC" ]] || die "no NSIS *-setup.exe in $BUNDLE_DIR"
SIG_SRC="$SETUP_SRC.sig"
[[ -f "$SIG_SRC" ]] || die "missing updater signature: $SIG_SRC (createUpdaterArtifacts?)"

SETUP_NAME="tide-setup.exe" # fixed — permanent download link
PLATFORM_KEY="windows-x86_64"
ARTIFACT_URL="${TIDE_PUBLIC_BUCKET%/}/windows/$SETUP_NAME"
echo "==> v$VERSION · $PLATFORM_KEY · $(basename "$SETUP_SRC") → windows/$SETUP_NAME"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
if command -v cygpath >/dev/null 2>&1; then STAGE="$(cygpath -m "$STAGE")"; fi

# Start from the LIVE manifest so mac/linux keys are preserved.
curl -fsS --max-time 15 "${TIDE_PUBLIC_BUCKET%/}/latest.json" -o "$STAGE/latest.json" 2>/dev/null || : > "$STAGE/latest.json"

"$PY" "$ROOT/scripts/release/merge_manifest.py" \
  --manifest "$STAGE/latest.json" \
  --platform "$PLATFORM_KEY" \
  --version "$VERSION" \
  --signature "$(tr -d '\n' < "$SIG_SRC")" \
  --url "$ARTIFACT_URL"

# Artifact FIRST, manifest second — never point installed apps at a URL that
# doesn't resolve yet.
echo "==> Uploading artifact"
"${AWS[@]}" s3 cp "$SETUP_SRC" "s3://$R2_BUCKET/windows/$SETUP_NAME" --cache-control "no-cache"

echo "==> Uploading manifest"
"${AWS[@]}" s3 cp "$STAGE/latest.json" "s3://$R2_BUCKET/latest.json" \
  --content-type application/json --cache-control "no-cache"

echo "==> Pruning windows/ (keeping $SETUP_NAME)"
("${AWS[@]}" s3 ls "s3://$R2_BUCKET/windows/" || true) | awk '{print $NF}' | while read -r obj; do
  [[ -z "$obj" || "$obj" == "$SETUP_NAME" ]] && continue
  echo "    rm windows/$obj"
  "${AWS[@]}" s3 rm "s3://$R2_BUCKET/windows/$obj"
done

echo "==> Verifying updater path"
REMOTE_VERSION="$(curl -fsS --max-time 20 "${TIDE_PUBLIC_BUCKET%/}/latest.json" | "$PY" -c "import json,sys; d=json.load(sys.stdin); e=(d.get('platforms') or {}).get('$PLATFORM_KEY') or {}; print(d.get('version','') if e.get('url') and e.get('signature') else '')")"
[[ "$REMOTE_VERSION" == "$VERSION" ]] || die "published manifest failed verification (got '$REMOTE_VERSION', want '$VERSION')"
curl -fsIL --max-time 30 "$ARTIFACT_URL" >/dev/null || die "artifact URL not reachable: $ARTIFACT_URL"

echo "==> Done — fixed download link: $ARTIFACT_URL"
