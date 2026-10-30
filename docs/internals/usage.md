# Usage: the glass box

`usage.summary {since?, until?, includeExternal?}` answers "what did I spend, and where". It
adds two sources: the turns Tide ran (from the read model) and, when the user allows it, the
harnesses' own local logs for work done outside Tide. Code: `apps/server/src/usage/`, handler
`apps/server/src/rpc/usage.ts`.

The rule that shapes everything here: **an estimate is never presented as a reported cost.**
`costUsd` is only what a harness wrote down; `estimatedUsd` is Tide's arithmetic from a price
table, and the page labels it as such.

## Sources

| Source | Where | Granularity | Cost reported |
|---|---|---|---|
| Tide | `ReadModel.turns[*].usage` (deltas summed by the projector) | turn | Claude, OpenCode, Pi, ACP yes; Codex never |
| Claude Code | `~/.claude/projects/<slug>/**/*.jsonl` (subagents included) | model call (`assistant` line) | no |
| Codex | `~/.codex/state_5.sqlite` `threads` → `rollout_path`; else walk `~/.codex/sessions/YYYY/MM/DD/` | response (`token_usage_record`), or deltas of `event_msg/token_count` totals on older rollouts | no |
| OpenCode | `~/.local/share/opencode/opencode.db` `session_v2`; legacy `storage/message/**/*.json` only when there is no db | session (counted at `time_updated`) | yes |
| Pi | `~/.pi/agent/sessions/<slug>/*.jsonl` | assistant message | yes (`usage.cost.total`) |

Token fields are normalised so `inputTokens` always means **uncached** input. OpenAI-style totals
(Codex, both Tide's driver and the rollouts) count cached input inside `input_tokens`; it is
split into `cacheReadTokens` at the source. Reasoning tokens are billed as output: Codex already
includes them, OpenCode's `tokens_reasoning` is added to `outputTokens`.

## Double counting

Tide drives the same CLIs, so their logs also hold Tide's turns. An external record is dropped
when its session id is any thread's `nativeSessionId` or `providerSessions[*].nativeSessionId`,
or its cwd is under `<tideHome>/worktrees` or a thread's `worktreePath` (`ingest/dedupe.ts`).
A thread that runs in the project root without a worktree is matched by session id only.

Claude Code writes a streamed message once per content block with identical usage, and resumed
or forked sessions copy earlier lines into new files (about 13% of output tokens on a real
machine). Records are keyed by `message.id` + `requestId` across the whole scan; first sighting
wins, in path order. Codex records are keyed by `response_id`.

## Bounded reads

- Only files modified on or after `since − 1 day` are opened; files over 50 MB are skipped and
  counted in the notes.
- Lines are streamed (`readline`), never whole files. Claude lines are prefiltered on the
  substrings `"usage"` and `"assistant"` before `JSON.parse`.
- A file stops being read once a timestamp passes `until + 1 h` (logs are only roughly
  chronological). Such a partial read is not cached.
- Harness SQLite stores are copied (db + `-wal`) to a scratch dir and read there: even a read-only
  open of a WAL database writes the harness's `-shm`.

## The index

`<dataDir>/usage-index.json` caches each parsed log file: path → {mtime, size, records}. A file
whose mtime and size are unchanged is not read again. Records are the whole file, before window,
dedupe and exclusion, so one index serves every window. Entries for files untouched for 120 days
are pruned on save. On disk the records are tuples with the file's common session, cwd and model
list hoisted (about 7.6 MB for 30 days / 1,600 Claude files).

Measured on a Mac with 3.1 GB of Claude Code logs: a 30-day cold scan reads 1,622 files in about
8–10 s; warm, about 150–250 ms (one or two files changed). Seven days: 1.3 s cold, 50 ms warm.

On top of the index, `ExternalCache` memoises the external result for 5 minutes per window (the
default open-ended window shares one key) and shares an in-flight scan between callers.

## The summary

`summarize()` folds day buckets (`buckets.ts`: local day × provider × instance × model × source)
into rows and days.

- **Rows.** Tide rows group by provider + `providerId` + model, `source: "tide"`. External rows
  group by provider + model, `source: "external"`, no `providerId`. `turns` counts turns (Tide),
  model calls (Claude, Codex, Pi) or sessions (OpenCode).
- **`costUsd`** is present only when every turn/call in the row reported a cost. Otherwise it is
  absent and a note says why ("Codex reports no cost; shown as an estimate.", or "Some Pi calls
  reported no cost; …" for a mixed row).
- **`estimatedUsd`** is present when every call in the row has a price; a row with any unpriced
  model shows no estimate rather than an understated one, and a note names the model.
- **`days`**: `tokens` is input + output + cache read + cache write. `costUsd` only when every call
  that day reported one; `estimatedUsd` sums the priced calls.
- **`notes`**, in order: missing-cost notes, unpriced models, the price-table line, why external
  logs are absent (setting off / not requested), then per harness what was read ("Claude Code:
  1,622 log files read (1,620 unchanged, from the index), 61,788 model calls, N from Tide's own
  sessions left out (already counted as Tide), 2 files over 50 MB skipped.") and harnesses with
  nothing in the window.

## Pricing

`pricing.ts`: USD per million tokens (input, output, cache read, cache write), `PRICING_VERSION`
returned as `pricingVersion`. Match order: exact id → a dated/suffixed id of a row
(`claude-haiku-4-5-20251001`) → longest family prefix (`claude-opus`, `gpt-6.1`, `gpt-5`,
`opencode/` = free) → none. Provider prefixes (`anthropic/`, `openai/`) and `[1m]` suffixes are
stripped. Anthropic rows are list prices; OpenAI rows are approximate and unverified. To update:
edit the rows, bump `PRICING_VERSION`, run `src/usage/pricing.test.ts`.

## Settings and the RPC

- `settings.glassBox.readHarnessLogs` (default on): off → no external rows, a note says the setting
  is off. `includeExternal: false` on the call does the same for one request.
- `since`/`until` are epoch ms; defaults: `until` = now, `since` = `until − 30 days`. Rejected with
  `invalid-params` when negative, inverted, or wider than 400 days.
- An ingester that throws becomes a note ("Codex logs could not be read: …"); the page still loads.
