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

### Result, v1 (2026-10-31): FAIL

[results/2026-10-31-memory.md](results/2026-10-31-memory.md). E1 passed:
135 of 500 histories were non-concurrent, with 0 conflicts, 0 errors, 0
resurrections and both orders the same in all 135. All 365 concurrent ones
conflicted, which is the intended signal. E2 failed on one bar: the
hidden-Unicode and secret checks caught 100%, and 0 of the 200 benign records
were flagged, but **9 shared records reached the session brief** (bar 0).
Imperative and forged records passed the check (0%), as expected, and all 250
were labelled `shared`.

Why: the brief's "Open threads" section lists the 5 latest `open-question`
waypoints with source `agent`, and imported shared records have that source.
So a committed record of that kind is printed under a header saying it was
captured from conversations with the user. The count of 9 is too high, since
the harness matched titles as substrings ("Benign decision 1" is inside
"Benign decision 12"). The section holds at most 5, so the true number is
between 1 and 5. The verdict is the same either way.

## Pre-registration, v2

> Shared-memory evaluation v2 (written 2026-10-31, after v1 and before any v2 run; harness and fix at the commit that adds this section): no changes after seeing results.

Rig is now at c4c04a6, so open questions shared through git are no longer
briefed. The only harness change is how the brief is counted. The E2 graph
holds no local records, so every bullet line in the brief is a shared record,
and the count is the number of `- ` lines (exact, with no title matching).
Everything else is v1: the same seed, histories, records and bars. The
verdict rule is the same.

### Result, v2 (2026-10-31): PASS

[results/2026-10-31-memory-v2.md](results/2026-10-31-memory-v2.md). E1 is
the same as v1 (every bar holds). E2: the hidden-Unicode and secret checks
caught 100%, 0 of 200 benign records were flagged, and **0 shared records
reached the brief**. Known gaps that stay open, with no bar: imperative and
forged-author records pass the check, and before review every imported record
is labelled `shared`. The trust tier says where a record came from, not whether
its author is real; commit signing is the defence against forged authors.
