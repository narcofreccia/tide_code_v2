#!/usr/bin/env python3
"""Merge ONE platform entry into a Tauri updater manifest (latest.json).

House distribution rule (docs/RELEASING.md): latest.json is shared by all
platforms, and each platform's release path mutates ONLY its own key under
"platforms" — a mac release must never clobber the windows entry and vice
versa. This script is that single merge implementation, used by
scripts/release/build_release.sh (darwin-aarch64) and scripts/release/publish_windows.sh
(windows-x86_64); linux-x86_64 rides the same path via scripts/release/publish_linux.sh.

Usage:
  merge_manifest.py --manifest FILE --platform KEY --version V \
                    --signature SIG --url URL [--out FILE]

The manifest FILE may be missing or empty (fresh bucket) — a new manifest is
created. Warns on stderr when the version changes (other platforms must ship
the same version or their installs will update-loop).

VERSIONS ONLY GO UP. A merge that would LOWER the manifest version is refused
(exit 2). This is not theoretical: on 2026-07-14 a Windows CI run built from
an un-pushed main (still 0.6.6) and its manifest write landed 2s after the mac
0.6.7 upload — it downgraded the global manifest back to 0.6.6 AND restored a
stale mac signature that no longer matched the 0.6.7 artifact sitting at the
fixed mac URL. Installed apps stopped seeing the update. Pass
--allow-downgrade only for a deliberate rollback.
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path

VALID_PLATFORMS = {"darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"}


def version_tuple(v: str) -> tuple[int, ...]:
    """Parse a dotted version for ordering; unparseable → (0,) so it never wins."""
    parts: list[int] = []
    for chunk in str(v).split("."):
        digits = ""
        for ch in chunk:
            if not ch.isdigit():
                break
            digits += ch
        if not digits:
            return (0,)
        parts.append(int(digits))
    return tuple(parts) if parts else (0,)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="existing latest.json (may be empty/missing)")
    ap.add_argument("--platform", required=True, choices=sorted(VALID_PLATFORMS))
    ap.add_argument("--version", required=True)
    ap.add_argument("--signature", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", help="output path (default: overwrite --manifest)")
    ap.add_argument(
        "--allow-downgrade",
        action="store_true",
        help="permit lowering the manifest version (deliberate rollback only)",
    )
    args = ap.parse_args()

    path = Path(args.manifest)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}

    platforms = data.get("platforms")
    if not isinstance(platforms, dict):
        platforms = {}

    prev_version = data.get("version")
    if prev_version and prev_version != args.version:
        if version_tuple(args.version) < version_tuple(prev_version) and not args.allow_downgrade:
            print(
                f"REFUSING to downgrade the updater manifest: {prev_version} -> {args.version}.\n"
                "  The manifest carries ONE global version. Writing a lower one un-publishes the\n"
                "  newer release for every platform (and can leave a stale signature pointing at a\n"
                "  newer fixed-name artifact, which then fails verification).\n"
                "  Usually this means the build ran from a stale checkout — push the version bump\n"
                "  and rebuild. Use --allow-downgrade for a deliberate rollback.",
                file=sys.stderr,
            )
            return 2
        print(
            f"NOTE: manifest version {prev_version} -> {args.version} — "
            "other platforms must ship this version too (single global version).",
            file=sys.stderr,
        )

    platforms[args.platform] = {
        "signature": args.signature.strip(),
        "url": args.url,
    }

    data["version"] = args.version
    data["notes"] = f"v{args.version}"
    data["pub_date"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data["platforms"] = platforms

    out = Path(args.out) if args.out else path
    out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"merged {args.platform} into {out} (platforms: {', '.join(sorted(platforms))})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
