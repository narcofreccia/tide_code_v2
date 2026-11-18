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
