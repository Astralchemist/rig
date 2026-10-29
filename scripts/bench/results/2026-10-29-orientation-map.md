# rig bench — orientation-map

- **Provider / model**: openrouter / `anthropic/claude-haiku-5.5`
- **Resolved model**: `anthropic/claude-haiku-5.5`
- **Rig**: 0.3.0 @ `640c2a1`, fingerprint `14b6ca5108774da6`
- **Target**: `~/rig-bench/next-auth` @ `e293b37466` (pinned), 2,949 nodes / 692 files
- **Repository overview** (grep+rig+map system prompt): 7,976 chars ≈ 1,994 tokens, budget 2,000, from the index cache
- **Trials**: 3; **total cost**: $0.3911

## Per arm

| arm | correct | tokens median (all / correct) | tokens mean (all / correct) | cost median (all / correct) | cost mean (all / correct) | tool turns (median / mean) | errors / turn limits |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 48/48 (100%) | 11,146 / 11,146 | 19,150 / 19,150 | $0.0015 / $0.0015 | $0.0023 / $0.0023 | 3 / 3.5 | 0 / 0 |
| grep+rig | 48/48 (100%) | 16,818 / 16,818 | 23,510 / 23,510 | $0.0021 / $0.0021 | $0.0027 / $0.0027 | 4 / 3.9 | 0 / 0 |
| grep+rig+map | 48/48 (100%) | 22,587 / 22,587 | 28,333 / 28,333 | $0.0026 / $0.0026 | $0.0032 / $0.0032 | 3 / 3.2 | 0 / 0 |

## Paired against baseline (per query, median over trials)

A query counts as correct for an arm when at least half its trials pass the check.

| arm | queries | median token ratio | ratio, both correct | correct & cheaper | correct but pricier | wrong | baseline wrong |
|---|---:|---:|---:|---:|---:|---:|---:|
| grep+rig | 16 | 133.6% | 133.6% | 5 | 11 | 0 | 0 |
| grep+rig+map | 16 | 187.2% | 187.2% | 2 | 14 | 0 | 0 |

## By query category

| arm | lookup correct | lookup median tokens | natural correct | natural median tokens |
|---|---:|---:|---:|---:|
| baseline | 100% | 6,636 | 100% | 31,292 |
| grep+rig | 100% | 13,287 | 100% | 29,001 |
| grep+rig+map | 100% | 14,571 | 100% | 37,349 |

## Per query (median over trials)

| query | kind | baseline ok · tokens · cost | grep+rig ok · tokens · cost | grep+rig+map ok · tokens · cost |
|---|---|---:|---:|---:|
| `dep-version` | lookup | 3/3 · 5,309 · $0.0008 | 3/3 · 5,777 · $0.0007 | 3/3 · 11,070 · $0.0012 |
| `where-handled` | lookup | 3/3 · 9,305 · $0.0010 | 3/3 · 9,257 · $0.0010 | 3/3 · 11,734 · $0.0013 |
| `callers-of` | lookup | 3/3 · 25,822 · $0.0035 | 3/3 · 17,192 · $0.0023 | 3/3 · 31,135 · $0.0036 |
| `routes` | lookup | 3/3 · 6,758 · $0.0010 | 3/3 · 18,566 · $0.0024 | 3/3 · 13,399 · $0.0017 |
| `file-summary` | lookup | 3/3 · 10,054 · $0.0011 | 3/3 · 11,995 · $0.0014 | 3/3 · 17,705 · $0.0019 |
| `db-init` | lookup | 3/3 · 6,924 · $0.0009 | 3/3 · 13,557 · $0.0015 | 3/3 · 11,455 · $0.0013 |
| `tests-for` | lookup | 3/3 · 5,513 · $0.0009 | 3/3 · 35,507 · $0.0039 | 3/3 · 22,950 · $0.0026 |
| `error-class` | lookup | 3/3 · 5,450 · $0.0007 | 3/3 · 13,277 · $0.0015 | 3/3 · 11,440 · $0.0013 |
| `entry-point` | lookup | 3/3 · 7,456 · $0.0009 | 3/3 · 11,495 · $0.0014 | 3/3 · 17,944 · $0.0020 |
| `type-def` | lookup | 3/3 · 4,169 · $0.0006 | 3/3 · 18,844 · $0.0023 | 3/3 · 29,139 · $0.0032 |
| `nl-session-refresh` | natural | 3/3 · 20,536 · $0.0023 | 3/3 · 30,355 · $0.0034 | 3/3 · 27,054 · $0.0030 |
| `nl-csrf` | natural | 3/3 · 31,340 · $0.0037 | 3/3 · 20,234 · $0.0026 | 3/3 · 99,340 · $0.0107 |
| `nl-magic-link` | natural | 3/3 · 13,154 · $0.0017 | 3/3 · 19,944 · $0.0023 | 3/3 · 65,428 · $0.0071 |
| `nl-cookie-size` | natural | 3/3 · 37,920 · $0.0043 | 3/3 · 21,484 · $0.0025 | 3/3 · 28,966 · $0.0035 |
| `nl-redirect` | natural | 3/3 · 64,319 · $0.0071 | 3/3 · 66,062 · $0.0072 | 3/3 · 26,823 · $0.0031 |
| `nl-oauth-checks` | natural | 3/3 · 44,357 · $0.0050 | 3/3 · 42,516 · $0.0049 | 3/3 · 55,280 · $0.0062 |

