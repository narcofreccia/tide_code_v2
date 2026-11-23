#!/usr/bin/env bash
# =============================================================================
# Publish the Windows NSIS build to R2 — the Windows half of build_release.sh.
# Runs in CI (.github/workflows/release-windows.yml, git-bash on a
# windows-latest runner) after `tauri build --bundles nsis`; also works
# locally on a Windows machine.
#
# Same distribution rules as macOS (docs/RELEASING.md): FIXED artifact name
# (permanent download link), overwrite in place with no-cache, prune extras,
# plus the headless server tarball (server/x86_64-pc-windows-msvc/), and mutate ONLY the windows-x86_64 key of the shared latest.json via
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
# Headless server tarball (`tide update`, headless installs): the sidecar built by
# `scripts/build-server-sidecar.sh --target windows-x64`, renamed tide-server.exe inside the tarball.
SERVER_TRIPLE="x86_64-pc-windows-msvc"
SERVER_BIN="$ROOT/apps/desktop/src-tauri/binaries/tide-server-$SERVER_TRIPLE.exe"
SERVER_TARBALL_NAME="tide-server.tar.gz"
SERVER_URL="${TIDE_PUBLIC_BUCKET%/}/server/$SERVER_TRIPLE/$SERVER_TARBALL_NAME"
[[ -f "$SERVER_BIN" ]] || die "no $SERVER_BIN — run scripts/build-server-sidecar.sh --target windows-x64 first"
ARTIFACT_URL="${TIDE_PUBLIC_BUCKET%/}/windows/$SETUP_NAME"
echo "==> v$VERSION · $PLATFORM_KEY · $(basename "$SETUP_SRC") → windows/$SETUP_NAME"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
if command -v cygpath >/dev/null 2>&1; then STAGE="$(cygpath -m "$STAGE")"; fi

mkdir -p "$STAGE/server"
cp "$SERVER_BIN" "$STAGE/server/tide-server.exe"
# Relative paths inside $STAGE: GNU tar (Git Bash) treats `C:/...` as a remote `host:path`.
(cd "$STAGE" && tar -czf "$SERVER_TARBALL_NAME" -C server tide-server.exe)
SERVER_SHA="$(sha256sum "$STAGE/$SERVER_TARBALL_NAME" | awk '{print $1}')"
echo "$SERVER_SHA  $SERVER_TARBALL_NAME" > "$STAGE/$SERVER_TARBALL_NAME.sha256"
echo "==> headless $SERVER_TRIPLE $SERVER_SHA"

# Start from the LIVE manifest so mac/linux keys are preserved.
curl -fsS --max-time 15 "${TIDE_PUBLIC_BUCKET%/}/latest.json" -o "$STAGE/latest.json" 2>/dev/null || : > "$STAGE/latest.json"

"$PY" "$ROOT/scripts/release/merge_manifest.py" \
  --manifest "$STAGE/latest.json" \
  --platform "$PLATFORM_KEY" \
  --version "$VERSION" \
  --signature "$(tr -d '\r\n' < "$SIG_SRC")" \
  --url "$ARTIFACT_URL" \
  --server-triple "$SERVER_TRIPLE" \
  --server-url "$SERVER_URL" \
  --server-sha256 "$SERVER_SHA"

# Artifact FIRST, manifest second — never point installed apps at a URL that
# doesn't resolve yet.
echo "==> Uploading artifact"
"${AWS[@]}" s3 cp "$SETUP_SRC" "s3://$R2_BUCKET/windows/$SETUP_NAME" --cache-control "no-cache"

echo "==> Uploading headless server tarball"
"${AWS[@]}" s3 cp "$STAGE/$SERVER_TARBALL_NAME" "s3://$R2_BUCKET/server/$SERVER_TRIPLE/$SERVER_TARBALL_NAME" --cache-control "no-cache"
"${AWS[@]}" s3 cp "$STAGE/$SERVER_TARBALL_NAME.sha256" "s3://$R2_BUCKET/server/$SERVER_TRIPLE/$SERVER_TARBALL_NAME.sha256" --content-type text/plain --cache-control "no-cache"
("${AWS[@]}" s3 ls "s3://$R2_BUCKET/server/$SERVER_TRIPLE/" || true) | awk '{print $NF}' | while read -r obj; do
  [[ -z "$obj" || "$obj" == "$SERVER_TARBALL_NAME" || "$obj" == "$SERVER_TARBALL_NAME.sha256" ]] && continue
  echo "    rm server/$SERVER_TRIPLE/$obj"
  "${AWS[@]}" s3 rm "s3://$R2_BUCKET/server/$SERVER_TRIPLE/$obj"
done

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
HEADLESS="$(curl -fsS --max-time 20 "${TIDE_PUBLIC_BUCKET%/}/latest.json" | "$PY" -c "import json,sys; d=json.load(sys.stdin); s=(d.get('server') or {}).get('$SERVER_TRIPLE') or {}; print('ok' if s.get('version') == '$VERSION' and s.get('sha256') == '$SERVER_SHA' else 'mismatch')")"
[[ "$HEADLESS" == "ok" ]] || die "published latest.json failed the headless verification ($HEADLESS)"
curl -fsIL --max-time 30 "$SERVER_URL" >/dev/null || die "headless artifact not reachable: $SERVER_URL"
curl -fsIL --max-time 30 "$SERVER_URL.sha256" >/dev/null || die "headless checksum not reachable: $SERVER_URL.sha256"

echo "==> Done — fixed download link: $ARTIFACT_URL"
