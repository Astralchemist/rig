# Impact evaluation (backlog E5)

Does `rig impact` predict what a change can break? This directory replays
rig's own history and compares rig's predicted blast radius with an observed
one, recorded from what actually calls what while the test suite runs.

- `instrument.ts` puts a `__rigCall(file, line)` probe at the start of every
  function body, on the same line (no newlines), so stack traces and the index
  still agree on line numbers.
- `record.ts` is a `bun test` preload: a Bun plugin instruments the repo's
  own TypeScript as it loads, each probe reads its caller from the stack, and
  the run's call edges are written as JSONL.

```sh
RIG_CALLS_OUT=calls.jsonl bun test --preload ./scripts/impact-eval/record.ts
```

On rig at `fbb570a` the whole suite still passes under the recorder (732
tests, 32 s instead of 27 s) and records about 5,700 call edges.

## Why call edges and not coverage

Coverage-based impact sets (code co-executed with the changed code) were
wrong about half the time in both directions in the best published study
(precision 38–50%, recall 50–56%; Cai, SANER 2020). Scoring against them
would mostly measure the oracle's noise. A dynamic call graph measures
dependency rather than co-execution, and one graph for the whole run is
enough, so `bun test` needs no per-test hooks. It is still a lower bound:
it only sees what the tests run.

## Pre-registration

> Impact evaluation (written 2026-10-30, before any scored run; recorder at the commit that adds this file): population, oracle, metrics and bar as below; no changes after seeing results; a revised rule is a new pre-registration and a new run.

**Population.** Non-merge commits reachable from `main` at `fd36ac5`, newest
first, whose diff changes at least one function or method (by its line range
in the index of the commit's parent) in TypeScript under `packages/`, excluding
tests (`__tests__/`, `*.test.ts`), `generated/` and `scripts/`. The first 60
that qualify are taken; at least 50 must be scorable or the result is
INCONCLUSIVE. A commit whose suite cannot run at its parent (install or
compile failure) is skipped and counted.

**Version.** Everything is measured at the commit's parent: the changed
symbols are the parent's symbols that the commit's removed or modified lines
fall in (old-side hunk ranges); the prediction and the oracle both come from
the parent's code. Today's rig indexes every parent (so the tool is fixed and
only the code varies), with the deterministic embedder.

**Line to symbol.** Both sides use the same function (`innermostSymbolAt`
in `packages/core/src/graph/diff-impact.ts`): the innermost function, method,
class or other symbol whose line range contains the line.

**Prediction.** `diffImpact` at depth 2: symbols that depend on the changed
symbols over calls, references, imports, extends and implements, plus accepted
links. Test symbols are removed from the set.

**Oracle (observed).** The parent's suite run under `record.ts`; call edges
mapped to symbols; the symbols that reach a changed symbol in at most 2 call
steps (reverse reachability), test symbols removed. A commit whose changed
symbols are never executed by the suite is reported (with the share of such
commits) and not scored. The share of changed symbols the suite executes is
reported for every commit.

**Primary metric and bar.** Micro-averaged recall of the prediction against
the oracle over all scored commits: **at least 0.80**. Structural-only recall
(without accepted links) is reported apart.

**Baseline.** A file-level import graph: every symbol in a file that imports a
changed symbol's file, directly or through one more importing file. Rig's
prediction must beat the baseline's micro precision by **at least 10
percentage points** at recall at least the baseline's. Precision carries no
bar of its own (the oracle is a lower bound).

**Secondary (reported, with bars).** Share of scored commits with an unflagged
miss (an oracle symbol neither predicted nor in a declared blind spot; blind
spots are not detected yet, so every miss is unflagged in this run): at most
20%. Median length of the expanded `rig impact` text: at most 25 lines.

**Also reported.** Unbounded depth on both sides; per-commit results; skipped
commits and why; run time.

**Verdict.** PASS if the primary bar and the baseline bar both hold and at
least 50 commits were scored; FAIL if either bar fails on at least 50; else
INCONCLUSIVE.
