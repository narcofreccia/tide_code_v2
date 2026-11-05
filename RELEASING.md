# RELEASING — Tide

The step-by-step runbook. Follow it top to bottom. Each step says what to run, what you
should see, and what to do when it goes wrong. The design behind it (bucket rules,
entitlements guard, manifest merging) is in [`docs/RELEASING.md`](./docs/RELEASING.md).

You run every command in this file. An agent never bumps, builds, tags, uploads or
triggers a release workflow on its own.

**Order, every release:** bump → push → macOS (local) → Windows (Actions) → Linux (Actions).
All three ship the same version. macOS goes first because it is the step that writes the
version into the update manifest.

---

## 0. One-time setup (already done on the main Mac)

Check each line once per machine. Skip the ones that are already true.

| What | Check | If missing |
|---|---|---|
| Node 22 + pnpm | `source ~/.nvm/nvm.sh && nvm use 22 && pnpm -v` | `nvm install 22`, `corepack enable` |
| Rust + Bun | `cargo -V && bun -v` | rustup / `curl -fsSL https://bun.sh/install \| bash` |
| Updater key | `ls ~/.tauri/tidecode2.key` | **Do not regenerate.** A new key orphans every installed app. Find the old one. |
| R2 access | `aws --profile r2 s3 ls s3://storage/tidecode/` | `aws configure --profile r2` with the house r2 token |
| Apple + release env | `ls .env.build` | `cp .env.build.example .env.build` and fill it (same Apple values as tide_reel) |
| Developer ID cert | `security find-identity -v -p codesigning \| grep "Developer ID"` | install the cert from the Apple developer account |
| GitHub CLI | `gh auth status` | `gh auth login` |
| Repo secrets | `gh secret list` shows the four below | `gh secret set NAME` |

Repository secrets used by the Windows and Linux workflows:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/tidecode2.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key password (also in `.env.build`) |
| `R2_ACCESS_KEY_ID` | house r2 token access key |
| `R2_SECRET_ACCESS_KEY` | house r2 token secret |

---

## 1. Bump the version

```sh
source ~/.nvm/nvm.sh && nvm use 22
git status                         # clean tree, on main
pnpm release:bump 0.1.1            # writes package.json + Cargo.toml and commits "chore: v0.1.1"
git push origin main
```

- Versions only go up. Use `0.1.1` for a fix, `0.2.0` for features.
- The tag is created later by the mac build, not here.
- Push before step 3: the Windows and Linux runners build from `origin/main`.

## 2. Close the dev app

Quit anything running `pnpm desktop:dev` or `pnpm dev`. The release build uses the same
Rust target directory and the same ports for its checks.

## 3. macOS — build, notarize, publish (local, ~10–20 min)

Optional dry run first. It prints the plan and checks the setup without changing anything:

```sh
pnpm release:mac --dry-run
```

Then the real run:

```sh
pnpm release:mac
```

What it does, in order: refuses a version lower than the live one → typecheck + tests →
server sidecar → web client → `tauri build` → entitlements check → notarize and staple →
upload `mac/tide.dmg` and `mac/tide.app.tar.gz` → write the mac entry into `latest.json` →
verify the update path end to end → `git tag v<version>`.

**You should see** `Step 10: Verify the updater path end to end` pass and a new tag.
Then push the tag:

```sh
git push origin --tags
```

**First release only (0.1.0):** the bucket still holds a manifest from an unreleased August
test build at `2.0.0-alpha.0`. The script will refuse 0.1.0 as a downgrade. Nothing was ever
installed from it, so override once:

```sh
ALLOW_DOWNGRADE=1 pnpm release:mac
```

## 4. Windows — GitHub Actions (~25 min)

```sh
gh workflow run release-windows.yml --ref main -f version=0.1.1
gh run watch                        # pick the release-windows run
```

Or in the browser: **Actions → release-windows → Run workflow**, version `0.1.1`.

The job fails on purpose if `package.json` on main is not that version. It builds the NSIS
installer, installs it silently, starts the bundled server and checks `/health`, then uploads
`windows/tide-setup.exe` and writes the Windows entry into `latest.json`.

## 5. Linux — GitHub Actions (~15 min)

```sh
gh workflow run release-linux.yml --ref main -f version=0.1.1
gh run watch
```

Uploads `linux/tide.deb` and `linux/tide.rpm`, then the headless server tarball
`server/x86_64-unknown-linux-gnu/tide-server.tar.gz` (+ `.sha256`) and merges only that
`server[...]` key into `latest.json` (the `platforms` keys and `web` are untouched). The
desktop app on Linux has **no auto-update**: Linux desktop users reinstall the package by
hand. A headless Linux server updates with `tide-server update`.

You can start Linux right after Windows without waiting for it, but only after macOS: the
merge refuses to lower the manifest version, and the mac release ships the `web` tarball
that a Linux `tide update` pulls.

## 6. Check the release

```sh
BASE=https://pub-7b3e5bbd605d43adbeb4601a962d84bd.r2.dev/tidecode
curl -s $BASE/latest.json | python3 -m json.tool      # version + darwin-aarch64 + windows-x86_64
curl -sI $BASE/mac/tide.dmg | head -1                 # 200
curl -sI $BASE/windows/tide-setup.exe | head -1       # 200
curl -sI $BASE/linux/tide.deb | head -1               # 200
```

Then by hand:

1. On a Mac with the previous version installed, launch Tide. Within a few seconds it asks
   *"Tide 0.1.1 is available — Install and relaunch?"*. Choose Install. The splash shows the
   download bar, the app relaunches, and the version under the splash reads the new one.
2. Fresh install: download `mac/tide.dmg`, drag to Applications, open. It must start without
   a Gatekeeper warning and reach Mission Control.

## 7. Record it

Add the release to `JOURNAL.html` (commit log + a dated note) and commit.

---

## Download links (permanent, share once)

| Platform | Link |
|---|---|
| macOS (Apple silicon) | `https://pub-7b3e5bbd605d43adbeb4601a962d84bd.r2.dev/tidecode/mac/tide.dmg` |
| Windows | `https://pub-7b3e5bbd605d43adbeb4601a962d84bd.r2.dev/tidecode/windows/tide-setup.exe` |
| Linux (Debian/Ubuntu) | `https://pub-7b3e5bbd605d43adbeb4601a962d84bd.r2.dev/tidecode/linux/tide.deb` |
| Linux (Fedora/RHEL) | `https://pub-7b3e5bbd605d43adbeb4601a962d84bd.r2.dev/tidecode/linux/tide.rpm` |

Every release overwrites these files in place, so the links never change.

---

## When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `live manifest is X and this build is Y (a downgrade)` | the version is not higher than what is live | bump higher; `ALLOW_DOWNGRADE=1` only for a deliberate reset |
| Tests fail in step 1 of the build | a real failure on main | fix and commit, rerun. `--skip-tests` is for local experiments only |
| Notarization rejected / times out | Apple credentials or a service hiccup | check `.env.build`; `xcrun notarytool history --apple-id … --team-id …`; rerun |
| Entitlements guard fails | a binary in `Tide.app` lacks the JIT entitlements | do not ship; see *The entitlements guard* in `docs/RELEASING.md` |
| Uploads failed after the build succeeded | R2 credentials or network | `pnpm release:mac --manifest-only` is **not** enough: rerun the full command |
| Windows job: `version mismatch` | main was not pushed, or the input is wrong | `git push origin main`, rerun with the right `version` |
| Installed app never offers the update | manifest version not higher, or signature mismatch | `curl $BASE/latest.json`; the version must be higher than the installed one |
| App says "Starting the local server…" forever | the bundled server cannot start | Retry button on the splash; logs: `log show --last 5m --predicate 'process == "tide-desktop"'` |

Republishing the **same** version (for example after fixing an upload) is allowed: the
check only refuses a lower version.

## What never to do

- Never regenerate the updater key.
- Never edit `latest.json` in the bucket by hand. The scripts merge it one platform at a time.
- Never release Windows or Linux at a version that macOS has not shipped.
- Never commit `.env.build` or anything from `~/.tauri/`.
