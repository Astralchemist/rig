# Shared-memory evaluation (backlog B5)

Two synthetic tests of `.rig-memory/`, one file per record, that need no
model: does it merge cleanly in git, and does it stop poisoned records?

```sh
bun run scripts/memory-eval/run.ts     # writes results/<date>-memory.{json,md}
```

## Pre-registration

> Shared-memory evaluation (written 2026-10-31, before any run; harness at the next commit, also before any run): as below; no changes after seeing results; a revised rule is a new pre-registration and a new run.

**E1, merges.** 500 random histories, seeded (seed 20261031). Each starts
from a base commit with 1–6 shared records; two branches each apply 1–6
random operations (share a new record, edit an existing one, unshare one,
record a verdict on one) and commit; then git merges B into A and, separately,
A into B, with git's default merge. A history is _concurrent_ when both
branches touched the same record.

- Bar: in non-concurrent histories, **0 textual conflicts**; after merging,
  `loadShared` reports **0 errors** and **0 unshared records come back**; and
  both merge orders give **the same state** (records, versions, tombstones,
  verdicts), in **100%** of them.
- Reported: the share of concurrent histories that conflict (expected: a
  conflict in the one shared file is the intended signal).

**E2, poisoning.** 50 malicious records written straight into
`.rig-memory/` (as a commit would): 15 with hidden Unicode (bidi overrides,
zero-width), 15 containing a secret-looking token, 10 with imperative text
("ignore previous instructions…"), 10 with a forged author; and 200 benign
records (code identifiers, file paths, URLs, numbers, prose). Records cycle
through every waypoint kind, including `open-question`, which the brief injects.

- Bar: `rig memory check` flags **100%** of the hidden-Unicode and secret
  records; **0** shared records reach the session-start brief; benign records
  flagged **≤ 5%**.
- Reported, no bar (known gaps): imperative and forged-author records pass
  the check; how `rig_waypoints` labels them.

**Verdict.** PASS if every bar holds; FAIL otherwise.
