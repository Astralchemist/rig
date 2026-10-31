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

`replay.ts` runs the pre-registered evaluation below: per commit, it checks
out the parent in a worktree, indexes it with today's rig, predicts with
`diffImpact`, runs the parent's suite under the recorder, and compares.

```sh
bun run scripts/impact-eval/replay.ts            # writes results/<date>-impact-eval.{json,md}
```

Mechanics, checked on a commit outside the population (`2ba7f56`): about 38 s
per commit; of the calls from product code to product code, 89% map to a
symbol at both ends (2,033 of 2,276). Nearly all unmapped edges start in test
files (anonymous `test()` callbacks are not symbols), which both sides
exclude anyway.

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

## Result (2026-10-30): INCONCLUSIVE, recall far below the bar

`results/2026-10-30-impact-eval.md`. 105 commits examined, 60 qualifying:
47 scored, 10 whose changed symbols the suite never executes, 3 skipped (a
tree-sitter abort). 47 is under the pre-registered 50, so the verdict is
INCONCLUSIVE by the rule, but no plausible 3 more commits move recall from
53% to 80%:

| measure | rig (depth 2) | file-level baseline | bar | |
|---|---:|---:|---:|---|
| micro recall | 52.7% | 49.3% | ≥ 80% | fails |
| micro precision | 27.3% | 2.1% | ≥ baseline + 10 pp, at recall ≥ baseline's | holds (+25 pp) |
| commits with an unflagged miss | 46.8% | | ≤ 20% | fails |
| median `rig impact` text lines | 15 | | ≤ 25 | holds |

What it says: rig's static graph is far more precise than file-level
imports at about the same recall, and it misses roughly half of what the
tests show calling into a change. The misses are the blind spots the
research named: functions passed as callbacks (`retryWhenBusy(fn)` wrappers),
tool handlers reached through the generated dispatch table (`run`), and
request guards registered as middleware. So the E5 comment needs its
blind-spots line, and the static graph needs callback and dispatch-table
edges, before the blast radius can be trusted; both are a new
pre-registration and a new run.

**Disclosure.** A first run on 2026-10-30 was invalid: it loaded the recorder
from a checkout that was switched to another branch mid-run, so every later
commit failed instantly (18 scored before that, recall 43.9%; set aside, not
reported as a result). This rerun ran from its own worktree with the rules
unchanged; the only harness change, generating the embedded grammars in each
replayed parent (`e307872`), turned out to be a no-op safeguard.

## Pre-registration v2 (written 2026-10-31, before any v2 run)

> Impact evaluation v2: the same oracle, metrics and bars as above, for the tool at `461ba8e` (extractor v3: functions used as values, such as callbacks and dispatch-table entries, get `references` edges; `rig impact` declares blind spots). Two changes, both fixed before running: the population is the first **80** qualifying commits (v1 scored 47 of 60, under the floor of 50); and a miss counts as **flagged** when the commit's `rig impact` declared at least one blind spot, so the unflagged-miss share is computed over commits with a miss and no blind spot declared. No changes after seeing results.

## Result v2 (2026-10-31): INCONCLUSIVE, recall unchanged

`results/2026-10-31-impact-eval-v2.md`. 147 commits examined: 47 scored (the same 47 as v1), 10 whose changed symbols the suite never runs, 23 skipped by a tree-sitter WebAssembly `Aborted()` in the harness, which repeats once it starts in a process and used up most of the extra 20 commits. 47 is under the floor of 50.

| measure | v1 | v2 | bar |
|---|---:|---:|---:|
| micro recall | 52.7% | 52.7% | ≥ 80% |
| micro precision | 27.3% | 26.7% | ≥ baseline (2.1%) + 10 pp |
| commits with an unflagged miss | 46.8% | 38.3% | ≤ 20% |
| median text lines | 15 | 15 | ≤ 25 |

**Value references didn't raise recall.** They link the code that *passes* a function along; the dependents rig misses are the code that *receives and calls* it. The top misses are unchanged: `retryWhenBusy` (calls the callback it's given), the generated tool dispatch (`run`), and `runSync` / `runIndexAll`, reached through the CLI's lazy `(await import('./x.ts')).runX` command table. Blind spots were declared on 5 of 47 commits, which is all that moved the unflagged-miss share.

**Next, each needing its own pre-registration:** a "may call" edge from a function to the callback passed into it (`retry(save)` → retry may call save), and resolving members of dynamic `import()` results. Separately, a fresh process per commit in the harness to remove the WebAssembly skips.
