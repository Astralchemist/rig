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
