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

## Quotas (R20)

An optional cap on a project or a thread: `Quota { sharePct?, usdPerWeek?, onExceed: "warn" | "hold" }`
(contracts `usage.ts`), set with `quota.set`, removed by sending none.

- **What counts.** A project counts every thread whose top-level ancestor is in it (`rootThread`:
  a delegate may live in another project and still counts where the work started). A thread counts
  itself and its descendants. A turn's spend is its reported `costUsd`, else the price-table
  estimate (`quota/ledger.ts` `turnSpend`), filed under the instance that ran it.
- **Share cap.** Per instance with a weekly gauge (`ReadModel.limits[instance].weekly`): the scope's
  share of the window is `U × P / T`, where `U` is the window's used %, `P` the scope's spend inside
  the window and `T` all known spend on that instance inside it: Tide's turns plus, for a kind's
  default instance and with `glassBox.readHarnessLogs` on, the harness's own logs. Since `P ≤ T`,
  the share never passes the cap before `U` does. Spend Tide cannot see (another device, claude.ai)
  raises `U` but not `T`, so the share reads high and the cap trips early: every share figure is
  marked `approx`. A window whose reset has passed counts as 0% used. Harnesses with no weekly
  gauge are not measured by the share cap. A plan with one long window (Codex's 30-day one) is
  filed as `weekly`; the ledger uses its real length (`windowMins`).
- **Amount cap.** The scope's spend over every instance in the rolling last 7 days.
- **State.** `QuotaState { status ok|warning|exceeded, usedPct, basis, over, windowEndsAt?, liftedUntil?, approx? }`
  on the project or thread. `over` lists the instances past the share cap, or `*` for the amount
  cap. `warning` starts at 80% of the cap. `QuotaWorker` (`quota/worker.ts`) measures every minute
  and after `usage.reported`, `usage.corrected`, `quota.changed` and `turn.settled`, and records a
  state only when the status, `over`, `windowEndsAt` or the 5-point step of `usedPct` changed, or a
  stored window end has passed. The reactor also awaits one measurement before it settles a turn
  (`beforeSettle`), so the settle decides on that turn's own usage.
- **Hold.** `quotaBlock(model, thread, now)` (contracts `quota.ts`) is the one rule, shared by the
  decider, the workers and the clients: the thread's own quota, an ancestor's, or its root's
  project holds it when `onExceed` is `hold`, the state is `exceeded`, no lift is active, the
  window has not ended and `over` names the thread's instance or `*`. `decide()` post-checks every
  command (`decider/quotaGate.ts`): a turn that would start on a held thread is refused with
  `quota-exceeded`; a harness's own turn passes (it is already spending); a server wake-up
  (`turn.request` with a notification) is recorded as `queued`. A settle on a held thread carries
  `holdQueue`, so the projector leaves queued turns queued. `quota.lift` (until the window ends, or
  24 h for the amount cap), a new or removed cap, and a measurement that leaves `exceeded` emit
  `turn.released` for the oldest queued turn of each idle thread they free. The scheduler retries a
  refused fire each tick. A running turn is never stopped: a long turn can overshoot the cap.
- **Not counted**: one-shot calls (titles, commit text), the decision layer's own spend, and a Tide
  session continued in a terminal ("Open in terminal").

## Cost repair (R20)

Before R20 a resumed Claude session stored its whole running cost as one turn's delta
(providers.md, "Usage is a per-turn delta"). `tide usage repair` finds those reports; it is a dry
run unless `--apply`, and it goes through the running server's `usage.repair` RPC, never the
database file. `usage/repair.ts` is a pure planner over the stored event records: per Claude
session it walks the cost reports keeping the session's running total as Claude counts it. A
turn's first report is cumulative when the reports before it sum to a `cost-state` total of the
session's transcript and it is at least that total (transcript evidence), or, with no transcript,
when the session was reopened (a gap over 30 minutes, an error, a server stop, a rollback) and it
is at least the running total (heuristic evidence, applied only with `--include-heuristic`). The
corrected cost is the value minus that base. Applying dispatches `usage.correct` (a negative
`costUsd` delta), which sets `Turn.usageCorrected`, so a second run changes nothing. Token history
cannot be repaired from the log. Claude's own total can come out lower than the repaired sum: on
the series this was built from, one early process did not restore $31.02, so the true spend is
$245.47 against Claude's $214.45.

## Settings and the RPC

- `settings.glassBox.readHarnessLogs` (default on): off → no external rows, a note says the setting
  is off. `includeExternal: false` on the call does the same for one request.
- `since`/`until` are epoch ms; defaults: `until` = now, `since` = `until − 30 days`. Rejected with
  `invalid-params` when negative, inverted, or wider than 400 days.
- An ingester that throws becomes a note ("Codex logs could not be read: …"); the page still loads.
