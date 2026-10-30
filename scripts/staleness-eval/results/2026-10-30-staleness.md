# Staleness evaluation — PASS

Pre-registered in `scripts/staleness-eval/README.md`. 80 commits from `fd36ac5`, 1075 anchors, 25 commits skipped.

| measure | result | bar |
|---|---:|---:|
| stale served (modified reported verified) | 0.0% (0/162) | ≤ 2% |
| false invalidation (unchanged or cosmetic not verified) | 0.0% (0/893) | ≤ 5% |
| deleted flagged (missing or changed) | 100.0% (20/20) | ≥ 95% |
| renames followed (reported verified) | – | none (known gap) |

| truth | statuses |
|---|---|
| unchanged | verified 891 |
| cosmetic | verified 2 |
| modified | changed 162 |
| renamed | – |
| deleted | missing 20 |
