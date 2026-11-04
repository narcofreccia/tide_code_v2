#!/usr/bin/env bash
# =============================================================================
# Tide v2 macOS release pipeline (runs locally on the dev Mac).
#
#   preflight -> quality gate -> sidecar -> web -> tauri build (app,dmg,updater)
#   -> entitlements guard -> notarize + staple -> headless tarballs -> upload to
#   R2 mac/ + server/<triple>/ + web/ -> merge latest.json (darwin-aarch64,
#   server[<host triple>], web) -> verify updater + headless end to end -> git tag
#
# House distribution rules (docs/RELEASING.md):
#   * fixed artifact names — the download links are permanent, overwrite in place
#   * every upload is Cache-Control: no-cache, and mac/ is pruned to the two files
#   * artifacts upload BEFORE the manifest — never publish a URL that 404s
#   * latest.json is shared by all platforms; this script merges ONLY its own key
#
# Windows/Linux are built by .github/workflows/release-{windows,linux}.yml.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_TAURI_DIR="$PROJECT_ROOT/apps/desktop/src-tauri"
TAURI_CONF="$SRC_TAURI_DIR/tauri.conf.json"
BUNDLE_DIR="$SRC_TAURI_DIR/target/release/bundle"
BUNDLE_MACOS_DIR="$BUNDLE_DIR/macos"
BUNDLE_DMG_DIR="$BUNDLE_DIR/dmg"
LATEST_JSON="$PROJECT_ROOT/latest.json"
ENV_BUILD_FILE="$PROJECT_ROOT/.env.build"
ENTITLEMENTS_DEFAULT="$SCRIPT_DIR/entitlements.plist"
UPDATER_KEY_DEFAULT="$HOME/.tauri/tidecode2.key"

# Fixed names under mac/ — permanent download links (see docs/RELEASING.md).
MAC_ARCHIVE_NAME="tide.app.tar.gz"
MAC_DMG_NAME="tide.dmg"
# Headless install / `tide update` (docs/internals/remote.md): fixed names too.
SERVER_TARBALL_NAME="tide-server.tar.gz"
WEB_TARBALL_NAME="web.tar.gz"
HEADLESS_DIR="$BUNDLE_DIR/headless"

DRY_RUN=0
MANIFEST_ONLY=0
SKIP_NOTARIZE=0
SKIP_UPLOAD=0
SKIP_TESTS=0
PLATFORM="darwin-aarch64"
SIGNATURE="${UPDATER_SIGNATURE:-}"
URL="${UPDATER_URL:-}"

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --dry-run          Print the plan and validate the setup; mutate nothing.
  --manifest-only    Skip building/uploading artifacts; only merge latest.json.
  --skip-notarize    Skip codesign/notarize/staple (unsigned local build).
  --skip-upload      Skip every R2 upload (and the remote verification).
  --skip-tests       Skip the pnpm typecheck && pnpm test gate (not for real releases).
  --platform <key>   Updater platform key (default: $PLATFORM).
  --signature <v>    Force the signature written into latest.json.
  --url <v>          Force the artifact URL written into latest.json.
  -h, --help         This help.

Config comes from .env.build (gitignored; see .env.build.example):
  APPLE_ID, APPLE_APP_PASSWORD (or APPLE_PASSWORD), APPLE_NOTARY_TEAM_ID
  (or APPLE_TEAM_ID), APPLE_SIGNING_IDENTITY,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  R2_RELEASE_ENDPOINT_URL, R2_RELEASE_BUCKET, R2_RELEASE_PUBLIC_URL, R2_RELEASE_PROFILE
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --manifest-only) MANIFEST_ONLY=1; shift ;;
    --skip-notarize) SKIP_NOTARIZE=1; shift ;;
    --skip-upload) SKIP_UPLOAD=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --signature) SIGNATURE="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
step() { printf '\n--- %s ---\n' "$*"; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

# --- Config -----------------------------------------------------------------
if [[ -f "$ENV_BUILD_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_BUILD_FILE"
  set +a
fi

# Accept both house spellings of the Apple credentials (tide_reel / tide_share).
export APPLE_APP_PASSWORD="${APPLE_APP_PASSWORD:-${APPLE_PASSWORD:-}}"
export APPLE_NOTARY_TEAM_ID="${APPLE_NOTARY_TEAM_ID:-${APPLE_TEAM_ID:-}}"
export APPLE_PASSWORD="${APPLE_PASSWORD:-${APPLE_APP_PASSWORD:-}}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-${APPLE_NOTARY_TEAM_ID:-}}"

ENTITLEMENTS_PATH="${CODESIGN_ENTITLEMENTS_PATH:-$ENTITLEMENTS_DEFAULT}"
UPDATER_KEY_FILE="${TAURI_SIGNING_PRIVATE_KEY_FILE:-$UPDATER_KEY_DEFAULT}"
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$UPDATER_KEY_FILE" ]]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY_FILE")"
  export TAURI_SIGNING_PRIVATE_KEY
fi

need_cmd python3
[[ -f "$TAURI_CONF" ]] || die "missing tauri config: $TAURI_CONF"

# tauri.conf.json's "version" is a path to the root package.json — follow it.
VERSION="$(python3 - "$TAURI_CONF" <<'PY'
import json, sys
from pathlib import Path
conf_path = Path(sys.argv[1])
conf = json.loads(conf_path.read_text(encoding="utf-8"))
v = conf.get("version", "")
if isinstance(v, str) and v.endswith(".json"):
    v = json.loads((conf_path.parent / v).read_text(encoding="utf-8")).get("version", "")
print(v or "")
PY
)"
[[ -n "$VERSION" ]] || die "could not read the app version"

PUBLIC_BASE="${R2_RELEASE_PUBLIC_URL:-}"
[[ -n "$URL" || -z "$PUBLIC_BASE" ]] || URL="${PUBLIC_BASE%/}/mac/$MAC_ARCHIVE_NAME"
HOST_TRIPLE="$(rustc -vV 2>/dev/null | awk '/^host: /{print $2}' || echo unknown)"

SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application:.*\)".*/\1/p' | head -n1 || true)"
fi
# Tauri signs the .app (and every externalBin inside it) with this identity plus
# bundle.macOS.entitlements. Leave it unset when there is no identity so the
# bundler falls back to an unsigned build instead of failing.
if [[ -n "$SIGNING_IDENTITY" ]]; then export APPLE_SIGNING_IDENTITY="$SIGNING_IDENTITY"; else unset APPLE_SIGNING_IDENTITY || true; fi

cat <<EOF
=== Tide v2 release pipeline (macOS) ===
Version:          $VERSION
Platform key:     $PLATFORM
Host triple:      $HOST_TRIPLE
Signing identity: ${SIGNING_IDENTITY:-<none — build will be unsigned>}
Entitlements:     $ENTITLEMENTS_PATH
Updater key:      $UPDATER_KEY_FILE $([[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] && echo "(loaded)" || echo "(MISSING)")
Artifact URL:     ${URL:-<unset>}
R2 bucket:        ${R2_RELEASE_BUCKET:-<unset>} (profile ${R2_RELEASE_PROFILE:-default})
manifest-only:$MANIFEST_ONLY  skip-notarize:$SKIP_NOTARIZE  skip-upload:$SKIP_UPLOAD  skip-tests:$SKIP_TESTS
EOF

# Warn early when the version was not bumped.
if [[ -n "$PUBLIC_BASE" ]]; then
  REMOTE_VERSION="$(curl -sf --max-time 10 "${PUBLIC_BASE%/}/latest.json" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || true)"
  if [[ -n "$REMOTE_VERSION" && "$REMOTE_VERSION" == "$VERSION" ]]; then
    echo "WARNING: the published manifest already carries $VERSION — bump it first (scripts/release/bump_version.sh)."
  fi
fi

# Preflight: refuse a version that would LOWER the live manifest BEFORE building or
# uploading anything. merge_manifest.py refuses too, but only after step 7 has already
# replaced mac/tide.app.tar.gz, leaving a live signature that no longer matches it.
# ALLOW_DOWNGRADE=1 is for a deliberate reset (installed newer builds will not auto-update).
if [[ -n "$PUBLIC_BASE" ]]; then
  LIVE_VERSION="$(curl -fsS --max-time 15 "${PUBLIC_BASE%/}/latest.json" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("version",""))
except Exception: print("")' || true)"
  if [[ -n "$LIVE_VERSION" ]] && python3 "$SCRIPT_DIR/merge_manifest.py" --compare "$LIVE_VERSION" "$VERSION"; then
    :
  elif [[ -n "$LIVE_VERSION" && "${ALLOW_DOWNGRADE:-0}" != "1" ]]; then
    die "live manifest is $LIVE_VERSION and this build is $VERSION (a downgrade). Bump higher, or rerun with ALLOW_DOWNGRADE=1 for a deliberate reset."
  fi
fi
DOWNGRADE_FLAG=()
[[ "${ALLOW_DOWNGRADE:-0}" == "1" ]] && DOWNGRADE_FLAG=(--allow-downgrade)

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<EOF

--dry-run: planned steps
  1. gate      pnpm typecheck && pnpm test $([[ "$SKIP_TESTS" -eq 1 ]] && echo "(skipped)")
  2. sidecar   scripts/build-server-sidecar.sh $HOST_TRIPLE
  3. web       pnpm --filter @tide/web build
  4. bundle    tauri build --bundles app,dmg,updater
  5. guard     entitlements on every Mach-O in Contents/MacOS/
  6. notarize  xcrun notarytool submit --wait + stapler staple $([[ "$SKIP_NOTARIZE" -eq 1 ]] && echo "(skipped)")
  7. headless $SERVER_TARBALL_NAME (signed Contents/MacOS/tide-server) + $WEB_TARBALL_NAME, each with .sha256
  8. upload    ${R2_RELEASE_BUCKET:-<unset>}/mac/{$MAC_DMG_NAME,$MAC_ARCHIVE_NAME}, server/$HOST_TRIPLE/, web/ + prune $([[ "$SKIP_UPLOAD" -eq 1 ]] && echo "(skipped)")
  9. manifest  merge_manifest.py --platform $PLATFORM --version $VERSION --server-triple $HOST_TRIPLE --web-url …
 10. verify    curl the published manifest + the updater and headless artifact URLs
 11. tag       git tag -a v$VERSION

no mutations performed
EOF
  exit 0
fi

APP_BUNDLE=""
APP_TAR_GZ=""
SERVER_TARBALL=""
WEB_TARBALL=""
SERVER_SHA=""
WEB_SHA=""

if [[ "$MANIFEST_ONLY" -eq 0 ]]; then
  need_cmd pnpm

  if [[ "$SKIP_TESTS" -eq 0 ]]; then
    step "Step 1: Quality gate (typecheck + tests)"
    (cd "$PROJECT_ROOT" && pnpm typecheck && pnpm test)
  else
    step "Step 1: Quality gate SKIPPED (--skip-tests)"
  fi

  step "Step 2: Build the tide-server sidecar for $HOST_TRIPLE"
  "$PROJECT_ROOT/scripts/build-server-sidecar.sh" "$HOST_TRIPLE"

  step "Step 3: Build the web client"
  (cd "$PROJECT_ROOT" && pnpm --filter @tide/web build)
  # bundled as a Tauri resource (bundle.resources) so the packaged server can serve it to other devices
  rm -rf "$PROJECT_ROOT/apps/desktop/src-tauri/binaries/web"
  cp -R "$PROJECT_ROOT/apps/web/dist" "$PROJECT_ROOT/apps/desktop/src-tauri/binaries/web"

  step "Step 4: Bundle the desktop app (app, dmg, updater)"
  [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] || die "TAURI_SIGNING_PRIVATE_KEY unset and $UPDATER_KEY_FILE missing — the updater artifact cannot be signed"
  if [[ "$SKIP_NOTARIZE" -eq 1 ]]; then
    # The bundler notarizes the .app by itself as soon as it sees the Apple
    # credentials; hide them so --skip-notarize really skips notarization.
    # The signing identity stays, so the build is still signed.
    (cd "$PROJECT_ROOT" && env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_APP_PASSWORD \
       -u APPLE_TEAM_ID -u APPLE_NOTARY_TEAM_ID \
       pnpm --filter @tide/desktop exec tauri build --bundles app,dmg,updater)
  else
    (cd "$PROJECT_ROOT" && pnpm --filter @tide/desktop exec tauri build --bundles app,dmg,updater)
  fi

  APP_BUNDLE="$(ls -td "$BUNDLE_MACOS_DIR"/*.app 2>/dev/null | head -n1 || true)"
  [[ -n "$APP_BUNDLE" && -d "$APP_BUNDLE" ]] || die ".app bundle not found in $BUNDLE_MACOS_DIR"
  APP_TAR_GZ="$(ls -t "$BUNDLE_MACOS_DIR"/*.app.tar.gz 2>/dev/null | head -n1 || true)"
  [[ -n "$APP_TAR_GZ" ]] || die "updater archive (*.app.tar.gz) not found — is createUpdaterArtifacts true?"
  [[ -f "$APP_TAR_GZ.sig" ]] || die "missing updater signature: $APP_TAR_GZ.sig"
  [[ -n "$SIGNATURE" ]] || SIGNATURE="$(tr -d '\r\n' < "$APP_TAR_GZ.sig")"
  DMG_PATH="$(ls -t "$BUNDLE_DMG_DIR"/*.dmg 2>/dev/null | head -n1 || true)"

  if [[ "$SKIP_NOTARIZE" -eq 0 ]]; then
    step "Step 5: Notarize + staple"
    if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" && -n "${APPLE_NOTARY_TEAM_ID:-}" ]]; then
      need_cmd xcrun
      [[ -n "$SIGNING_IDENTITY" ]] || die "no Developer ID Application identity; set APPLE_SIGNING_IDENTITY in .env.build"
      if [[ -n "$DMG_PATH" && -f "$DMG_PATH" ]]; then
        xcrun notarytool submit "$DMG_PATH" \
          --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" \
          --team-id "$APPLE_NOTARY_TEAM_ID" --wait
        xcrun stapler staple "$DMG_PATH"
      else
        echo "WARNING: no .dmg in $BUNDLE_DMG_DIR; nothing to notarize"
      fi
    else
      echo "Skipping notarization: APPLE_ID / APPLE_APP_PASSWORD / APPLE_NOTARY_TEAM_ID not fully set"
    fi
  else
    step "Step 5: Notarization SKIPPED (--skip-notarize)"
  fi

  # --- Entitlements guard --------------------------------------------------
  # Hardened runtime turns library validation ON. The bun-compiled `tide-server`
  # sidecar JITs and dlopens, so every Mach-O we ship in Contents/MacOS/ must
  # carry disable-library-validation + allow-jit + allow-unsigned-executable-memory.
  # Shipping a hardened binary without them means the server never starts.
  # Turn a violation into a build failure.
  step "Step 6: Entitlements guard over Contents/MacOS/"
  need_cmd codesign
  REQUIRED_ENTITLEMENTS=(
    "com.apple.security.cs.disable-library-validation"
    "com.apple.security.cs.allow-jit"
    "com.apple.security.cs.allow-unsigned-executable-memory"
  )
  GUARD_FAILED=0
  for bin in "$APP_BUNDLE"/Contents/MacOS/*; do
    [[ -f "$bin" ]] || continue
    name="$(basename "$bin")"
    flags="$(codesign -dv --verbose=2 "$bin" 2>&1 | sed -n 's/.*flags=\([^ ]*\).*/\1/p')"
    if [[ "$flags" != *runtime* ]]; then
      echo "  OK (not hardened, dev build): $name"
      continue
    fi
    ent="$(codesign -d --entitlements :- "$bin" 2>/dev/null || true)"
    missing=""
    for key in "${REQUIRED_ENTITLEMENTS[@]}"; do
      printf '%s' "$ent" | grep -q "$key" || missing="$missing $key"
    done
    if [[ -n "$missing" ]]; then
      echo "  FAIL: $name is hardened but lacks:$missing"
      GUARD_FAILED=1
    else
      echo "  OK (hardened + entitled): $name"
    fi
  done
  if [[ "$GUARD_FAILED" -eq 1 ]]; then
    die "entitlements guard failed — check bundle.macOS.entitlements in tauri.conf.json (expects scripts/release/entitlements.plist)"
  fi

  # --- Headless artifacts (`tide update`, headless install) ---------------
  # The server binary comes from the signed bundle (hardened + entitled, checked
  # above); the web tarball holds a top-level web/ so it unpacks beside the binary.
  step "Step 7: Headless tarballs (server $HOST_TRIPLE + web)"
  need_cmd shasum
  rm -rf "$HEADLESS_DIR" && mkdir -p "$HEADLESS_DIR/server"
  SERVER_BIN="$APP_BUNDLE/Contents/MacOS/tide-server"
  [[ -f "$SERVER_BIN" ]] || SERVER_BIN="$SRC_TAURI_DIR/binaries/tide-server-$HOST_TRIPLE"
  [[ -f "$SERVER_BIN" ]] || die "no tide-server binary for the headless tarball"
  cp "$SERVER_BIN" "$HEADLESS_DIR/server/tide-server"
  chmod 755 "$HEADLESS_DIR/server/tide-server"
  [[ -f "$SRC_TAURI_DIR/binaries/web/index.html" ]] || die "binaries/web is missing — the web step did not run"
  SERVER_TARBALL="$HEADLESS_DIR/$SERVER_TARBALL_NAME"
  WEB_TARBALL="$HEADLESS_DIR/$WEB_TARBALL_NAME"
  COPYFILE_DISABLE=1 tar -czf "$SERVER_TARBALL" -C "$HEADLESS_DIR/server" tide-server
  COPYFILE_DISABLE=1 tar -czf "$WEB_TARBALL" -C "$SRC_TAURI_DIR/binaries" web
  SERVER_SHA="$(shasum -a 256 "$SERVER_TARBALL" | awk '{print $1}')"
  WEB_SHA="$(shasum -a 256 "$WEB_TARBALL" | awk '{print $1}')"
  echo "$SERVER_SHA  $SERVER_TARBALL_NAME" > "$SERVER_TARBALL.sha256"
  echo "$WEB_SHA  $WEB_TARBALL_NAME" > "$WEB_TARBALL.sha256"
  echo "  $SERVER_TARBALL_NAME $SERVER_SHA"
  echo "  $WEB_TARBALL_NAME $WEB_SHA"

  if [[ "$SKIP_UPLOAD" -eq 0 ]]; then
    step "Step 8: Upload artifacts to R2 mac/, server/$HOST_TRIPLE/, web/ (fixed names, no-cache)"
    [[ -n "${R2_RELEASE_ENDPOINT_URL:-}" && -n "${R2_RELEASE_BUCKET:-}" ]] \
      || die "R2_RELEASE_ENDPOINT_URL / R2_RELEASE_BUCKET unset — cannot upload"
    need_cmd aws
    AWS=(aws --endpoint-url "$R2_RELEASE_ENDPOINT_URL")
    [[ -z "${R2_RELEASE_PROFILE:-}" ]] || AWS+=(--profile "$R2_RELEASE_PROFILE")

    "${AWS[@]}" s3 cp "$APP_TAR_GZ" "$R2_RELEASE_BUCKET/mac/$MAC_ARCHIVE_NAME" --cache-control "no-cache"
    if [[ -n "$DMG_PATH" && -f "$DMG_PATH" ]]; then
      "${AWS[@]}" s3 cp "$DMG_PATH" "$R2_RELEASE_BUCKET/mac/$MAC_DMG_NAME" --cache-control "no-cache"
    else
      echo "WARNING: no .dmg to upload"
    fi

    echo "Pruning mac/ (keeping $MAC_ARCHIVE_NAME, $MAC_DMG_NAME)"
    ("${AWS[@]}" s3 ls "$R2_RELEASE_BUCKET/mac/" || true) | awk '{print $NF}' | while read -r obj; do
      [[ -z "$obj" || "$obj" == "$MAC_ARCHIVE_NAME" || "$obj" == "$MAC_DMG_NAME" ]] && continue
      echo "    rm mac/$obj"
      "${AWS[@]}" s3 rm "$R2_RELEASE_BUCKET/mac/$obj"
    done

    # headless: artifact + .sha256 per folder, then prune the folder to those two
    upload_headless() {
      local folder="$1" file="$2" name
      name="$(basename "$file")"
      "${AWS[@]}" s3 cp "$file" "$R2_RELEASE_BUCKET/$folder/$name" --cache-control "no-cache"
      "${AWS[@]}" s3 cp "$file.sha256" "$R2_RELEASE_BUCKET/$folder/$name.sha256" \
        --content-type text/plain --cache-control "no-cache"
      ("${AWS[@]}" s3 ls "$R2_RELEASE_BUCKET/$folder/" || true) | awk '{print $NF}' | while read -r obj; do
        [[ -z "$obj" || "$obj" == "$name" || "$obj" == "$name.sha256" ]] && continue
        echo "    rm $folder/$obj"
        "${AWS[@]}" s3 rm "$R2_RELEASE_BUCKET/$folder/$obj"
      done
    }
    upload_headless "server/$HOST_TRIPLE" "$SERVER_TARBALL"
    upload_headless "web" "$WEB_TARBALL"
  else
    step "Step 8: Upload SKIPPED (--skip-upload)"
  fi
fi

# Headless keys go into the manifest only when this run built them; --manifest-only
# leaves the live server/web entries alone (their own "version" tells `tide update` they lag).
HEADLESS_FLAGS=()
if [[ -n "$SERVER_SHA" && -n "$WEB_SHA" && -n "$PUBLIC_BASE" ]]; then
  HEADLESS_FLAGS=(
    --server-triple "$HOST_TRIPLE"
    --server-url "${PUBLIC_BASE%/}/server/$HOST_TRIPLE/$SERVER_TARBALL_NAME"
    --server-sha256 "$SERVER_SHA"
    --web-url "${PUBLIC_BASE%/}/web/$WEB_TARBALL_NAME"
    --web-sha256 "$WEB_SHA"
  )
fi

[[ -n "$SIGNATURE" ]] || die "no updater signature (pass --signature, or build the artifacts)"
[[ -n "$URL" ]] || die "no artifact URL (pass --url, or set R2_RELEASE_PUBLIC_URL)"

step "Step 9: Merge $PLATFORM (+ headless server/web) into latest.json"
# Start from the LIVE manifest so the windows/linux keys written by CI survive.
MANIFEST_STAGE="$(mktemp -d)/latest.json"
if [[ -n "$PUBLIC_BASE" ]] && curl -fsS --max-time 15 "${PUBLIC_BASE%/}/latest.json" -o "$MANIFEST_STAGE" 2>/dev/null; then
  echo "Merging into the published manifest"
else
  echo "Published manifest unreachable — merging into the repo copy"
  cp "$LATEST_JSON" "$MANIFEST_STAGE" 2>/dev/null || : > "$MANIFEST_STAGE"
fi

python3 "$SCRIPT_DIR/merge_manifest.py" \
  --manifest "$MANIFEST_STAGE" \
  --platform "$PLATFORM" \
  --version "$VERSION" \
  --signature "$SIGNATURE" \
  --url "$URL" \
  ${HEADLESS_FLAGS[@]+"${HEADLESS_FLAGS[@]}"} \
  ${DOWNGRADE_FLAG[@]+"${DOWNGRADE_FLAG[@]}"}

# The repo copy is the reviewable record of what is live.
cp "$MANIFEST_STAGE" "$LATEST_JSON"

if [[ "$SKIP_UPLOAD" -eq 0 && -n "${R2_RELEASE_ENDPOINT_URL:-}" && -n "${R2_RELEASE_BUCKET:-}" ]]; then
  step "Step 9b: Upload latest.json"
  need_cmd aws
  AWS=(aws --endpoint-url "$R2_RELEASE_ENDPOINT_URL")
  [[ -z "${R2_RELEASE_PROFILE:-}" ]] || AWS+=(--profile "$R2_RELEASE_PROFILE")
  "${AWS[@]}" s3 cp "$LATEST_JSON" "$R2_RELEASE_BUCKET/latest.json" \
    --content-type application/json --cache-control "no-cache"

  if [[ -n "$PUBLIC_BASE" ]]; then
    step "Step 10: Verify the updater and headless paths end to end"
    CHECK="$(curl -fsS --max-time 20 "${PUBLIC_BASE%/}/latest.json" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print('unparseable'); print(''); raise SystemExit
entry = (data.get('platforms') or {}).get('$PLATFORM') or {}
ok = data.get('version') == '$VERSION' and entry.get('url') and entry.get('signature')
headless = '$HOST_TRIPLE' if ${#HEADLESS_FLAGS[@]} else ''
server = (data.get('server') or {}).get(headless) or {} if headless else {}
web = (data.get('web') or {}) if headless else {}
if headless:
    ok = ok and server.get('version') == '$VERSION' and server.get('sha256') == '$SERVER_SHA' and web.get('sha256') == '$WEB_SHA'
print('ok' if ok else 'mismatch')
print(entry.get('url', ''))
print(server.get('url', ''))
print(web.get('url', ''))
" || printf 'unparseable\n\n\n\n')"
    [[ "$(echo "$CHECK" | head -n1)" == "ok" ]] || die "published latest.json failed verification — the updater is broken"
    CHECK_URL="$(echo "$CHECK" | sed -n 2p)"
    curl -fsIL --max-time 30 "$CHECK_URL" >/dev/null || die "artifact URL is not reachable: $CHECK_URL"
    echo "Updater verified: $PLATFORM v$VERSION -> $CHECK_URL"
    for HEADLESS_URL in "$(echo "$CHECK" | sed -n 3p)" "$(echo "$CHECK" | sed -n 4p)"; do
      [[ -n "$HEADLESS_URL" ]] || continue
      curl -fsIL --max-time 30 "$HEADLESS_URL" >/dev/null || die "headless artifact URL is not reachable: $HEADLESS_URL"
      curl -fsIL --max-time 30 "$HEADLESS_URL.sha256" >/dev/null || die "headless checksum is not reachable: $HEADLESS_URL.sha256"
      echo "Headless verified: $HEADLESS_URL"
    done
  fi
fi

step "Step 11: Git tag"
TAG_NAME="v$VERSION"
if git -C "$PROJECT_ROOT" rev-parse "$TAG_NAME" >/dev/null 2>&1; then
  echo "WARNING: tag $TAG_NAME already exists — skipping"
else
  git -C "$PROJECT_ROOT" tag -a "$TAG_NAME" -m "Release $TAG_NAME"
  echo "Created git tag $TAG_NAME"
fi

echo
echo "Release pipeline completed."
