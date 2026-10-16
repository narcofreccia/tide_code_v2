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
