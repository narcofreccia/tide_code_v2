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
local commit) but uses the text model for the squash subject when one is available.
