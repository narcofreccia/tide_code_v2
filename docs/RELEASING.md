# Releasing Tide

Tide self-hosts its distribution under the **`tidecode/` prefix of the shared house
`storage` R2 bucket** (the same bucket and `r2` API token as tide_share / tide_reel /
tide_pos2). macOS builds run locally on the dev Mac; Windows and Linux run on GitHub
Actions, because Tauri cannot cross-compile.

**Releases are user-triggered only** — no agent, hook, or CI job publishes on its own.

## Bucket layout — only the latest release, fixed links

```
s3://storage/tidecode/latest.json              ONE updater manifest, all platforms
s3://storage/tidecode/mac/tide.dmg             installer — PERMANENT download link
s3://storage/tidecode/mac/tide.app.tar.gz      updater artifact (signed, fixed name)
s3://storage/tidecode/windows/tide-setup.exe   NSIS installer = updater artifact
s3://storage/tidecode/linux/tide.AppImage      installer — PERMANENT download link
s3://storage/tidecode/linux/tide.AppImage.tar.gz  updater artifact
```

Public base: `https://pub-7b3e5bbd605d43adbeb4601a962d84bd.r2.dev/tidecode`. The updater
endpoint baked into `tauri.conf.json` is `{public}/latest.json` — **it never moves**.

### Invariants

- **Fixed names, overwrite in place.** Download links are permanent; share them once.
  Every upload sets `Cache-Control: no-cache` so the r2.dev edge revalidates instead of
  serving a stale binary, and each script **prunes** its platform folder afterwards, so
  only the current release is hosted.
- **Artifact first, manifest second.** Never publish a manifest pointing at a URL that
  does not resolve yet. Both publish paths end with an end-to-end check (the published
  manifest carries the new version *and* the artifact URL answers). A failed check exits
  non-zero — do not announce the release.
- **One key per platform.** `latest.json` is shared, so every path merges only its own
  `platforms[...]` key through `scripts/release/merge_manifest.py`. A mac release never
  clobbers the Windows entry.
- **Versions only go up.** `merge_manifest.py` refuses a merge that would lower the
  manifest version (exit 2) — that once un-published a newer release for every platform.
  `--allow-downgrade` exists for a deliberate rollback.
- **One global version.** Ship all three platforms at the same version or the lagging
  one update-loops. `scripts/release/bump_version.sh` is the single place it is set.

## One-time setup (per machine)

1. **Updater keypair**: private key `~/.tauri/tidecode2.key` (password `tidecode2`),
   public key in `tauri.conf.json -> plugins.updater.pubkey`. Regenerating it orphans
   every installed app — only do it if the key is lost.
2. **R2 access**: the AWS CLI with the house `r2` profile (`aws configure --profile r2`);
   the same token the other house apps use covers the `storage` bucket.
3. **Apple credentials**: copy `.env.build.example` to `.env.build` (gitignored) and fill
   in `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_NOTARY_TEAM_ID`, `APPLE_SIGNING_IDENTITY`,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and the `R2_RELEASE_*` block. The build script
   also accepts the older `APPLE_PASSWORD` / `APPLE_TEAM_ID` spellings.

## Release runbook (macOS)

```sh
source ~/.nvm/nvm.sh && nvm use 22
./scripts/release/bump_version.sh 2.0.0        # package.json + Cargo.toml, commits
pnpm release:mac                               # or: bash scripts/release/build_release.sh
```

`build_release.sh` runs: preflight and remote-version guard → `pnpm typecheck && pnpm test`
→ `scripts/build-server-sidecar.sh` for the host triple → `pnpm --filter @tide/web build` →
`tauri build --bundles app,dmg,updater` → **entitlements guard** → notarize + staple →
upload `mac/` with pruning → merge `darwin-aarch64` into `latest.json` → verify the updater
path → `git tag -a v<version>`.

Flags: `--dry-run` (print the plan, change nothing) · `--manifest-only` ·
`--skip-notarize` · `--skip-upload` · `--skip-tests` · `--platform <key>` ·
`--signature`/`--url` overrides.

### The entitlements guard

The hardened runtime turns macOS library validation **on**. The bun-compiled
`tide-server` sidecar JITs and dlopens, so every Mach-O in `Contents/MacOS/` — the
`tide-desktop` binary *and* `tide-server` — must carry:

```
com.apple.security.cs.disable-library-validation
com.apple.security.cs.allow-jit
com.apple.security.cs.allow-unsigned-executable-memory
```

They come from `scripts/release/entitlements.plist`, wired in through
`bundle.macOS.entitlements`. The guard inspects each binary with
`codesign -d --entitlements :-` and **fails the build** on a violation: shipping a
hardened sidecar without them means the server silently never starts.

Verify by hand:

```sh
codesign -d --entitlements :- "apps/desktop/src-tauri/target/release/bundle/macos/Tide.app/Contents/MacOS/tide-server"
```

## Windows and Linux — GitHub Actions

Tauri cannot cross-compile, so these build on GitHub-hosted runners:

- `.github/workflows/release-windows.yml` — `windows-latest`: node 22, pnpm 10, bun,
  Rust stable → sidecar (`--target windows-x64`) → web build → `tauri build --bundles nsis`
  → **smoke test** (silent `/S` NSIS install, run the installed `tide-server.exe --dev
  --port 3799`, `curl /health`) → `scripts/release/publish_windows.sh`.
- `.github/workflows/release-linux.yml` — `ubuntu-latest` with
  `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` →
  `--bundles appimage` → `scripts/release/publish_linux.sh`.

Trigger: **Actions → release-windows → Run workflow** (or `gh workflow run
release-windows.yml`), after the mac release of the same version. The optional `version`
input fails the job if `package.json` disagrees.

Windows binaries are **not Authenticode-signed** (no cert; same as the other house apps),
so SmartScreen warns on first run. The minisign updater signature is what the auto-updater
trusts.

### Repository secrets

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/tidecode2.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `tidecode2` |
| `R2_ACCESS_KEY_ID` | the house `r2` token's access key (bucket `storage`) |
| `R2_SECRET_ACCESS_KEY` | the house `r2` token's secret |

The workflows map `R2_*` onto `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` with
`AWS_DEFAULT_REGION=auto`, and set `R2_ENDPOINT`, `R2_BUCKET=storage/tidecode` and
`TIDE_PUBLIC_BUCKET` as workflow env.

## Known limitation — no terminal on Windows

`bun build --compile` cannot embed the native `node-pty` module, and Bun's own PTY support
is macOS/Linux only. The Windows sidecar therefore ships **without terminals**: the server
reports the terminal feature as `unavailable` and degrades gracefully; every other feature
works. Fixing it means shipping a `node-pty` prebuild for `win32-x64` as a Tauri resource
and pointing the lazy import at it. Same note lives in the header of
`scripts/build-server-sidecar.sh`.

## In-app updater

`apps/desktop/src-tauri/src/updater.rs` runs once per launch, after the server reports
ready so it never competes with the splash. It checks the manifest, and on a hit shows a
native dialog — *"Tide &lt;version&gt; is available — Install and relaunch?"* — then
downloads, installs and restarts. Any failure is logged and ignored; the app still starts.
The web client stays Tauri-free (CLAUDE.md §4), so no update UI lives there.
