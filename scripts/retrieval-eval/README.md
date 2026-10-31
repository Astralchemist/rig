# Retrieval evaluation (research roadmap, step 3)

"Where would I make this change?" has a ground truth in git history: a
commit's subject says what was done, and its diff says where. This asks rig
each subject and checks whether the files the commit changed come back in the
top 5. It needs no model API: the hybrid arm uses rig's on-device embedder.

```sh
bun run scripts/retrieval-eval/run.ts      # writes results/<date>-retrieval.{json,md}
```

## Pre-registration

> Retrieval evaluation (written 2026-10-31, before any run; harness at the commit that adds this file): population, arms, metric and bar as below; no changes after seeing results; a revised rule is a new pre-registration and a new run.

**Index.** rig at `fd36ac5`, indexed once with today's rig and its default
on-device embedder.

**Population.** Non-merge commits reachable from `fd36ac5`, newest first,
whose subject does not start with `docs`, `chore`, `test`, `ci`, `release`,
`style` or `Merge`, and which change between 1 and 8 TypeScript files under
`packages/` (tests excluded) that still exist at `fd36ac5`. The first 100
that qualify. The query is the subject with any conventional prefix
(`type(scope): `) removed.

**Arms.**
- *keyword*: `searchNodes` (the name and keyword index).
- *hybrid*: `rig.search` (exact names, keywords and embeddings fused by
  reciprocal rank), after the embedding model has loaded.

Both arms take up to 20 results, keep code results only (functions, methods,
classes, interfaces, type aliases, variables, files), and score the first 5.

**Metric.** acc@5: the share of queries where at least one of the top 5 code
results is in a file the commit changed. Also reported: acc@1 and MRR@10.

**Bar.** hybrid acc@5 at least **5 percentage points** above keyword acc@5.
Absolute values are reported without a bar: this is the baseline for later
step 3 work (personalised PageRank, heat).

**Verdict.** PASS if the bar holds over 100 queries; FAIL if not; INCONCLUSIVE
if fewer than 100 commits qualify.

## Result (2026-10-31): FAIL, by 2 points

`results/2026-10-31-retrieval.md`. 100 commit subjects from `fd36ac5`.

| arm | acc@1 | acc@5 | MRR@10 |
|---|---:|---:|---:|
| keyword | 62.0% | 83.0% | 0.715 |
| hybrid | 64.0% | 86.0% | 0.732 |

Hybrid search finds the changed files in the top 5 for 3 points more queries
than keyword search, short of the 5-point bar. The two arms agree on most
queries: both hit on 80, keyword only on 3, hybrid only on 6.

What it says: on rig's own history, embeddings add little over names and
keywords for "where would I change this". Commit subjects tend to name the
code they touch (`watch lock`, `orphaned memory`, `hubness`), which is the
keyword index's home ground, and rig's own vocabulary is consistent. It
matches the earlier benchmark, where hybrid search helped most on
natural-language questions about an unfamiliar codebase (next-auth). This is
the baseline for step 3's personalised PageRank and heat: they need to beat
86% acc@5 (or 0.732 MRR@10) on this set, under a new pre-registration.

## Pre-registration v2: personalised PageRank (written 2026-10-31, before any PageRank run)

> Retrieval evaluation v2: the same index, population (the same 100 commit subjects) and metric as v1, with a third arm, *hybrid+ppr*: `rig.search(query, { rerank: 'ppr' })`, personalised PageRank from the top 20 hybrid hits over dependency and containment edges, teleport 0.15, 20 iterations, hubs damped by dividing PageRank by degree, final score half the normalised search score and half the normalised PageRank. Those parameters are fixed in `packages/core/src/search/ppr.ts` before running and not tuned on this set. **Bar: hybrid+ppr acc@5 at least 3 percentage points above hybrid.** MRR@10 reported. No changes after seeing results.

## Result v2 (2026-10-31): FAIL — PageRank makes ranking worse

`results/2026-10-31-retrieval-v2.md`. Same 100 queries.

| arm | acc@1 | acc@5 | MRR@10 |
|---|---:|---:|---:|
| keyword | 62.0% | 83.0% | 0.715 |
| hybrid | 64.0% | 86.0% | 0.732 |
| hybrid+ppr | **42.0%** | **82.0%** | **0.588** |

Personalised PageRank lowered acc@5 by 4 points and acc@1 by 22 points
against plain hybrid search. Spreading relevance through the graph lifts the
neighbours of good hits above the hits themselves: a commit's subject usually
names the code it changed, and the search already finds that code first. The
re-ranker stays opt-in (`rerank: 'ppr'`) and off by default; a variant (fewer
seeds, a smaller PageRank share, or PageRank only as a tie-breaker) would be
a new pre-registration, not a tweak of this one.
