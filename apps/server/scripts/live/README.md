# Live checks (R17)

Hand-run smoke scripts against scratch servers; they talk to real harnesses and real git,
so they are not part of `pnpm test`. Run from `apps/server` with node ≥ 22:

```sh
S=/tmp/tide-live; mkdir -p $S/home1 $S/home2 $S/smoke
(cd $S/smoke && git init -q -b main . && echo hello > a.txt && git add . && git commit -qm init)
TIDE_HOME=$S/home1 node --experimental-strip-types src/bin.ts serve --dev --port 3821 --host 127.0.0.1 --name machine-a &
TIDE_HOME=$S/home2 node --experimental-strip-types src/bin.ts serve --dev --port 3822 --host 0.0.0.0  --name machine-b &
S=$S node --experimental-strip-types scripts/live/fresh-session.mts   # Claude: /clear drops the native context, boundary in the timeline
S=$S node --experimental-strip-types scripts/live/two-machines.mts    # repo identity → ensure/clone on B → merge on B → pull on A; pairing/revoke; mDNS discover
```

`fresh-session.mts` needs a logged-in Claude; `two-machines.mts` needs none (the merge is a
local commit) but uses the text model for the squash subject when one is available. It turns on
`git.pushBaseAfterMerge` on machine B (off by default), so B's merge reaches origin and A can pull it.

## R20: usage after a resume, quota hold

One scratch server is enough (`home1`, any free port; pass it as `PORT`). Both need a logged-in Claude
and spend a few one-line haiku turns.

```sh
S=$S PORT=3821 node --experimental-strip-types scripts/live/usage-resume.mts first    # two turns
# stop the server and start it again on the same TIDE_HOME, then:
S=$S PORT=3821 node --experimental-strip-types scripts/live/usage-resume.mts second   # turn 3 must cost its own delta
mkdir -p $S/smoke-quota && (cd $S/smoke-quota && git init -q -b main . && echo hello > a.txt && git add . && git commit -qm init)
S=$S PORT=3821 node --experimental-strip-types scripts/live/quota-hold.mts            # cap reached → queue held → refused → lift → runs
```

`usage-resume.mts` fails if the turn after the restart carries the session's running total (the
bug R20 fixed in the Claude driver). `quota-hold.mts` uses a repo of its own, because earlier spend
in the same project counts against the cap.

## R21: delegation fan-out across harnesses

One scratch server (`home1`). Needs every harness it names logged in; it spends one short
orchestrator conversation and two short delegate turns.

```sh
mkdir -p $S/smoke-fanout && (cd $S/smoke-fanout && git init -q -b main . && echo hello > a.txt && git add . && git commit -qm init)
S=$S PORT=3821 node --experimental-strip-types scripts/live/delegate-fanout.mts                          # Claude orchestrator → Codex (with a sub-agent) + Claude
S=$S PORT=3821 ORCH=codex DELEGATES=claude,codex WAIT=1 node --experimental-strip-types scripts/live/delegate-fanout.mts   # Codex orchestrator blocking in tide_delegate
S=$S PORT=3821 NOWAIT=1 node --experimental-strip-types scripts/live/delegate-fanout.mts                 # the Codex delegate does not wait for its sub-agent
```

`delegate-fanout.mts` checks that the two delegates run on the harnesses asked for, that the first
one's sub-agent rows nest under its sub-agent, that the orchestrator's first turn ends before the
delegates do and that it is then woken with both results (or, with `WAIT=1`, that the results
come back through the blocking call and no wake-up follows). It accepts approval cards for
Tide's own tools; `APPROVE_ALL=1` accepts every card, otherwise other cards are printed and left.
With `NOWAIT=1` the first delegate ends its turn while its sub-agent still works; the script checks
that the orchestrator hears of that delegate only after the sub-agent ended. A second run reuses the
project of the first. `DELEGATES=codex,opencode` needs an OpenCode 2.x the driver can find.

## R22: an image handed to a sub-agent and a delegate

One scratch server (`home1`). Needs both harnesses logged in; it spends one short orchestrator turn
with one sub-agent and one short delegate turn.

```sh
mkdir -p $S/smoke-image && (cd $S/smoke-image && git init -q -b main . && echo hello > a.txt && git add . && git commit -qm init)
S=$S PORT=3821 node --experimental-strip-types scripts/live/image-handoff.mts                      # Claude orchestrator → own sub-agent + Codex delegate
S=$S PORT=3821 ORCH=codex DELEGATE=claude node --experimental-strip-types scripts/live/image-handoff.mts
```

`image-handoff.mts` sends the orchestrator a flat green png and forbids it to name the colour to its
workers. It checks that the image got a saved copy in the orchestrator's checkout, that the
sub-agent's own rows open that file, that the delegate's first message carries the image with a copy
in the delegate's checkout, that the delegate's prompt does not contain the colour, and that both
workers answer "green". The "sub-agent opened the file" check only runs for a Claude orchestrator:
Codex records no rows for what its sub-agent opened, so there the sub-agent's answer is the only evidence.

## R23: a model named the way the picker shows it

One scratch server (`home1`, the `smoke-fanout` repo above). Needs both harnesses logged in; it spends
one short orchestrator turn and one one-line delegate turn.

```sh
S=$S PORT=3821 node --experimental-strip-types scripts/live/delegate-model.mts                                    # Codex orchestrator → Claude on "Haiku 5.5"
S=$S PORT=3821 ORCH=claude MODEL=haiku DELEGATE=codex SPELLED="GPT-6 Luna" EXPECT=gpt-6-luna node --experimental-strip-types scripts/live/delegate-model.mts
```

`delegate-model.mts` asks the orchestrator to delegate "on the Haiku 5.5 model" and checks that the
delegate's thread carries the id the target harness lists (`haiku`), that its turn completes and
that the orchestrator reports the reply. It does not tell which layer supplied the id: the
orchestrator may take it from its hint or from `tide_harnesses`, or the server may replace the
spelling at dispatch. `SPELLED` and `EXPECT` depend on what the harness lists that day; the first
check prints the list.
