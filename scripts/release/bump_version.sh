#!/usr/bin/env bash
# =============================================================================
# Bump the release version in the two places that carry it.
#
#   scripts/release/bump_version.sh 2.0.0 [--no-commit]
#
#   package.json                          the source of truth — tauri.conf.json's
#                                         "version" points at this file
#   apps/desktop/src-tauri/Cargo.toml     the shell crate
#
# The updater manifest carries ONE global version, so every platform ships the
# same number: bump here, run the mac release, then trigger the two workflows.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMIT=1
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-commit) COMMIT=0; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) VERSION="$1"; shift ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -n "$VERSION" ]] || die "usage: bump_version.sh <semver> [--no-commit]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "not a semver: $VERSION"

CURRENT="$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")"
echo "$CURRENT -> $VERSION"

python3 - "$ROOT/package.json" "$VERSION" <<'PY'
import json, sys, collections
from pathlib import Path
p = Path(sys.argv[1])
d = json.loads(p.read_text(), object_pairs_hook=collections.OrderedDict)
d["version"] = sys.argv[2]
p.write_text(json.dumps(d, indent=2) + "\n")
PY

CARGO="$ROOT/apps/desktop/src-tauri/Cargo.toml"
# Only the [package] version — the first `version = "…"` line in the file.
python3 - "$CARGO" "$VERSION" <<'PY'
import re, sys
from pathlib import Path
p = Path(sys.argv[1])
s = p.read_text()
s, n = re.subn(r'^version = "[^"]*"$', 'version = "%s"' % sys.argv[2], s, count=1, flags=re.M)
assert n == 1, "no [package] version line in %s" % p
p.write_text(s)
PY

echo "updated package.json and $(basename "$CARGO")"

if [[ "$COMMIT" -eq 1 ]]; then
  git -C "$ROOT" add package.json apps/desktop/src-tauri/Cargo.toml
  git -C "$ROOT" commit -m "chore: v$VERSION"
  echo "committed 'chore: v$VERSION' — the tag is created by build_release.sh"
else
  echo "--no-commit: files changed, nothing committed"
fi
