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

## Result (2026-10-30): PASS, with caveats

`results/2026-10-30-staleness.md`. 80 commits from `fd36ac5`, 1,075 anchors.

| measure | result | bar |
|---|---:|---:|
| stale served (modified reported verified) | 0.0% (0/162) | ≤ 2% |
| false invalidation (unchanged or cosmetic not verified) | 0.0% (0/893) | ≤ 5% |
| deleted flagged | 100% (20/20) | ≥ 95% |
| renames followed | no cases | none |

What it shows: through real `rig sync` updates, anchors keep their identity
and line ranges, and the fingerprints tell modified from unchanged code
without error. What it doesn't:

- **The cosmetic case is barely tested.** Only 2 anchors had a formatting-
  or comment-only change; the claim "reformatting keeps a memory verified"
  rests on the unit tests, not on this run.
- **Renames weren't exercised.** No anchor's function was renamed or moved
  within a qualifying commit's touched files, so the known gap (a rename
  reads as missing) is neither measured nor fixed.
- **Modified vs unchanged is close to definitional.** Both the fingerprint
  and the ground truth react to token changes; the run mainly proves the
  plumbing (sync, ids, line ranges, verification) on real history.
- **25 of the 80 commits were skipped** after a tree-sitter `Aborted()` in
  the harness (a WebAssembly abort while indexing; it repeats once it starts
  in one process). They count toward the 80; the anchor floor (1,000) still
  holds.

A follow-up worth pre-registering: synthetic probes for the two missing
cases (formatter runs and symbol renames replayed on real files), and a
fresh process per commit to remove the skips.
