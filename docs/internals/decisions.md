# Decisions: the judge

Tide asks small classification questions about its own state: is this approval routine, have
the experts converged, did the delegate finish, which turns matter for a handoff, is this thread
stuck. All of them go through one entry point, `judge.ask(question)` in
`apps/server/src/decisions/judge.ts`. The judge annotates and suggests; the only automatic
actions are the ones the user opts into (`autoAllowRoutine`, `expertsAutoAdvance`).

## Backends

- **Jev** (`jevBackend.ts` over `client.ts`): TypeSafe's System One classifier. Calibrated: every
  answer carries a confidence. It is the first filter, cheap (`USD_PER_MILLION_INPUT_TOKENS`) and
  limited to a ~28k-token context (`JEV_CONTEXT_TOKENS`).
- **Fallback** (`fallback.ts`): the harness model the user picks in settings
  (`decisions.fallback`), called through `ProviderInstance.complete` — one-shot, tools off, scratch
  cwd `<dataDir>/judge`, one prompt at a time, 25 s timeout. It answers exactly one label; a
  match counts as confidence 1, anything else is an error verdict.
- **none**: feature off, site off, or no backend. Callers behave as if the layer did not exist.

## The gray zone

`decisions.grayZone = { low, high }` (default 0.6 / 0.85, `0 ≤ low < high ≤ 1`). A Jev verdict
with confidence below the question's threshold (`ask.threshold ?? question.threshold ?? high`)
is re-asked on the fallback, item by item; the fallback verdict replaces it. A fallback failure
keeps Jev's verdict. A threshold of 0 keeps a question Jev-only. `low` is for sites: below it a
verdict is neither shown nor acted on.

## Questions

`JudgeQuestion` is either a single state with one `label | yes-no | score` question (verdict id =
question id) or `per-item`: an optional `shared` state, `items: {key, state}[]`, and one question
(`instructions` + optional `labels`, ids `${id}:${key}`) or a `questions` map (ids
`${id}:${key}:${name}`). Verdicts: `label` (yes-no → `"true"`/`"false"`, score → level index),
`score` 0..1 (yes probability, or level / (levels − 1)), `confidence`, `source`, tokens, cost,
`error`. `judge.ask` never rejects for backend failures; failures are `none` verdicts with `error`.

## Budgeting (`budget.ts`)

Each site has a state cap and an item cap per call: handoff 6000 tok / 40, experts 8000 / 1,
delegates 3000 / 1, approvals 2500 / 1, stuck 8000 / 12. Per-item questions are packed greedily
into calls whose state (shared + those items) fits the cap and the model limits. An item that
cannot fit alone is refused (`none`, error `over budget`), never split or truncated. **No item's
state is ever sent twice** to Jev: each item lands in exactly one call or is refused. A single
state over its cap is refused the same way. `DecisionClient.askMany` sends the packed calls one by
one without re-splitting; a failed call costs only its own verdicts.

## Ledger (`ledger.ts`)

Every verdict a backend produced (Jev and fallback, including errors and refusals) is a row in
`judge_ledger`, a side table in the event-store database (`EventStore.sideTable`), never in the
event log. Rows of one Jev request share a `call_id` and split its tokens/cost exactly. RPC
`decisions.stats` returns today's spend (Jev / fallback: calls, tokens, usd), spend by site, and
the most recent verdicts.

## Plugging a site in

1. Build a `JudgeQuestion` with the site name and a stable id; keep states compact (the caps
   above are hard).
2. `if (!judge.enabled(site)) return;` before doing work, then `await judge.ask(question)`.
3. Ignore `source: "none"` verdicts; treat confidence below `judge.grayZone().low` as no signal.
4. Persist what the UI needs with the internal commands `judge.record` (thread, approval
   activity, experts session) or `handoff.refine` (pending handoffs only). Never act
   automatically unless the user opted in for that site.

Triage (`triage.ts`, `reactor.ts`) is the first site: one `per-item` question per project on site
`stuck`, three sub-questions per thread; only `stuck` may reach the fallback.

## Sites: handoff, stuck

**handoff** (`sites/handoff.ts`). Runs only when a recorded handoff had to omit turns, since that
is the only case where a ranking can change what the next harness reads. The latest request, the
latest answer and the original request are always kept. The judge labels each remaining item
`keep`/`drop` in one `per-item` question (`shared`: first and latest user text, ≤400 chars each;
items: `{kind, turn, text≤240}`, keyed by timeline position). The rank is `keep` → score or
confidence, `drop` → 1 − that, no verdict → 0.5. `selectHandoffRanked` fills the same budget in
that order (ties go to the newest item) and renders the same text, and `handoff.refine` records
it along with `{kept, dropped, source, confidence (mean), at}`. If every verdict is `none`,
nothing is dispatched. When a turn carrying the handoff opens, the provider reactor waits up to
1.5 s (`HANDOFF_READY_WAIT_MS`) for `pending(handoffId)` and reads the handoff after
`handoff.delivered`. A refine that lands after that point is refused with `conflict`, logged
once, and the recency selection stands. The handoff card shows
`N items, K kept by judge (jev 0.87), D dropped`.

**stuck** (triage). `thread.triage.stuck ≥ 0.7` on a running thread shows a banner above the
stream: `Looks stuck for N min (jev 0.78)`, where N comes from `selectIdleMs` (the client copy of
`lastActivityAt`). The banner offers **Stop** (`turn.interrupt`), **Nudge** (`turn.steer` with a
status-check question) and a dismiss that lasts for the current turn. It never acts on its own.

## Sites: delegates, approvals, experts

Each site (`apps/server/src/decisions/sites/`) is a small reactor: it subscribes to the engine,
checks `judge.enabled(site)`, asks exactly one clipped question at one moment, and persists the
verdict with `judge.record`. Nothing here blocks the flow it annotates.

- **delegates**: when a delegate (thread with `delegatedBy`) finishes, i.e. goes quiescent
  (`quiescedBy`: its turn settled with no background sub-agent left, or the last one left `running`),
  one `label` question (`delegate:<thread>:<latest turn>`: task ≤ 600, last reply ≤ 1500, outcome, error,
  pending question) with labels `done | blocked | needs-user | failed`, or `pass | fail |
  inconclusive` when the role matches `/review|test|qa/i`. The verdict lands on `Thread.judge`.
  The parent's wake-up (`delegation.ts`) never waits for it: if the verdict is there at the 2 s
  flush and its confidence is at least `grayZone.low`, the block gains
  `Judge: <label> (<source> <confidence>)` and a single-delegate summary becomes
  `<title> finished — <label>`. `agent.thread.wait` returns `judge: {label, confidence, source}` under
  the same rule. The rail shows the label next to the role tag (red for failed / blocked / fail).
- **approvals**: on a pending approval (once per activity id) one `routine | consequential` question
  with tool name, title, description, input (≤ 800 chars), the first 40 diff lines and path-like
  strings. The card shows the label as a pill when confidence ≥ `low`; the Inbox puts
  consequential approvals first. **Auto-allow is opt-in per thread** (`autoAllowRoutine`, header
  menu) and needs all three: the thread opted in; the verdict is `routine` from Jev with
  confidence ≥ `grayZone.high` (a fallback verdict never qualifies); the approval is still pending
  when the verdict lands. It then dispatches `approval.respond accept` and posts an info activity
  `Auto-allowed (routine, jev 0.93)`.
- **experts**: when every bound expert is idle in exploring / discussing and the session has more
  findings than at the last question, one `yes-no` ("have the experts converged?", id
  `experts:<session>:<findings>`) over the topic, phase, the last two findings per expert and the
  last message per expert. The Board shows "Experts agree — Move to <next>?" while the verdict is
  newer than the session's last change. With `expertsAutoAdvance`, a Jev yes at score ≥ `high`
  advances one phase, never twice for the same findings count.
