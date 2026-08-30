#!/usr/bin/env bash
# Regenerates the Codex app-server protocol bindings from the INSTALLED codex CLI.
# Run after every `codex` upgrade; commit the result (CLAUDE.md §7).
#
#   packages/driver-codex/scripts/regen.sh [path-to-codex]
#
# `codex app-server generate-ts` emits extensionless relative imports, which NodeNext
# module resolution rejects, so we rewrite them to explicit `.ts` specifiers afterwards.
# Nothing else about the generated tree is touched.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../src/generated"
codex="${1:-codex}"

echo "regenerating bindings from $("$codex" --version)"
rm -rf "$out"
"$codex" app-server generate-ts --out "$out"

# `from "./Foo"` -> `from "./Foo.ts"`, `from "./v2"` -> `from "./v2/index.ts"`
find "$out" -name '*.ts' -print0 | xargs -0 perl -pi -e '
  s{from "(\.{1,2}/[^"]*?)"}{ my $p = $1; $p =~ m{/(?:v2|serde_json)$} ? qq(from "$p/index.ts") : qq(from "$p.ts") }ge;
'
echo "wrote $(find "$out" -name '*.ts' | wc -l | tr -d " ") files to $out"
