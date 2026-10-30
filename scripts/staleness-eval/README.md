# Staleness evaluation (research roadmap, step 1)

Does verify-on-read tell the truth about memory after the code moves on? This
replays rig's own history: at each commit's parent it plants a memory on the
functions the commit is about to touch, advances to the commit the way a user
would (`rig sync`), reads the memories back, and compares what verify-on-read
says with what actually happened to each function.

```sh
bun run scripts/staleness-eval/replay.ts      # writes results/<date>-staleness.{json,md}
```

## Ground truth (independent of rig's fingerprint)

Rig's fingerprint strips comments and whitespace with regular expressions.
The ground truth uses something else: the tree-sitter token stream of the
symbol (leaf tokens, comments excluded). For each anchored symbol, between
the parent and the commit:

- **unchanged**: identical text;
- **cosmetic**: different text, same token stream (formatting, comments);
- **modified**: a symbol with the same qualified name in the same file
  remains, with a different token stream;
- **renamed or moved**: no symbol of that name in that file, but a symbol
  elsewhere in the commit has the same token stream apart from its name;
- **deleted**: neither.

## Pre-registration

> Staleness evaluation (written 2026-10-30, before any run; verify-on-read at `6a89493`): population, ground truth, metrics and bars as below; no changes after seeing results; a revised rule is a new pre-registration and a new run.

**Population.** Non-merge commits reachable from `main` at `fd36ac5`, newest
first, that change TypeScript under `packages/` outside tests; the first 80
that qualify. In each, the anchors are the parent's functions and methods in
the touched files, at most 40 per commit (the first 40 by file and line).
At least 1,000 anchors in total, else INCONCLUSIVE.

**Procedure.** Index the parent with today's rig (deterministic embedder),
drop one waypoint per anchor through `rig.writes.dropWaypoint`, check out the
commit in the same working tree, `rig.sync()`, then `rig.verifyWaypoints`.

**Metrics** (micro, over anchors):
- **Stale served**: modified anchors reported `verified`, over all modified.
  **Bar: at most 2%.** (Serving a changed memory as current is the failure
  that matters most.)
- **False invalidation**: unchanged or cosmetic anchors reported anything but
  `verified`, over all unchanged or cosmetic. **Bar: at most 5%.**
- **Deleted flagged**: deleted anchors reported `missing` or `changed`, over
  all deleted. **Bar: at least 95%.**
- **Renames followed**: renamed or moved anchors reported `verified` (memory
  still attached to the same code), over all renamed. Reported; known gap,
  **no bar**: rig re-attaches only when the same qualified name returns.

**Verdict.** PASS if the three bars hold with at least 1,000 anchors; FAIL if
any fails; else INCONCLUSIVE.
