# Dependency-report evaluation — FAIL

Pre-registered in `scripts/deps-eval/README.md`. Labels and evidence: `results/heldout-labels.json`, `results/heldout-flags.json`.

Pooled precision of `rig_unused_deps`: **42.3%** (22 unused of 52 labelled; bar ≥ 80%).

| repo | declared | flagged | labelled | unused | used | unclear | precision |
|---|---:|---:|---:|---:|---:|---:|---:|
| zustand | 69 | 4 | 4 | 2 | 2 | 0 | 50.0% |
| trpc | 837 | 35 | 35 | 20 | 14 | 1 | 57.1% |
| flask | 34 | 13 | 13 | 0 | 13 | 0 | 0.0% |
| starlette | 9 | 0 | 0 | 0 | 0 | 0 | – |

False positives by the rule that made them used:

| rule | count |
|---|---:|
| 5. plugin or peer loaded by a used tool | 20 |
| 3. named in a config file | 4 |
| 2. run as a command | 3 |
| 1. imported or loaded in source | 2 |
