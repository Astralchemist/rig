# rig bench — hybrid-grep-rig

- **Provider / model**: openrouter / `anthropic/claude-haiku-5.5`
- **Resolved model**: `anthropic/claude-haiku-5.5`
- **Rig**: 0.2.0 @ `ab8634a` (dirty), fingerprint `f0e6da8652a16429`
- **Target**: `~/rig-bench/next-auth` @ `e293b37466` (pinned), 2,948 nodes / 692 files
- **Trials**: 3; **total cost**: $0.2199

## Per arm

| arm | correct | tokens median (all / correct) | tokens mean (all / correct) | cost median (all / correct) | cost mean (all / correct) | tool turns (median / mean) | errors / turn limits |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 48/48 (100%) | 12,313 / 12,313 | 17,368 / 17,368 | $0.0016 / $0.0016 | $0.0021 / $0.0021 | 3 / 3.4 | 0 / 0 |
| grep+rig | 47/48 (98%) | 14,347 / 13,918 | 21,528 / 21,650 | $0.0019 / $0.0019 | $0.0025 / $0.0025 | 3 / 3.6 | 0 / 0 |

## Paired against baseline (per query, median over trials)

A query counts as correct for an arm when at least half its trials pass the check.

| arm | queries | median token ratio | ratio, both correct | correct & cheaper | correct but pricier | wrong | baseline wrong |
|---|---:|---:|---:|---:|---:|---:|---:|
| grep+rig | 16 | 125.8% | 125.8% | 5 | 11 | 0 | 0 |

## By query category

| arm | lookup correct | lookup median tokens | natural correct | natural median tokens |
|---|---:|---:|---:|---:|
| baseline | 100% | 6,395 | 100% | 30,355 |
| grep+rig | 97% | 12,627 | 100% | 27,219 |

## Per query (median over trials)

| query | kind | baseline ok · tokens · cost | grep+rig ok · tokens · cost |
|---|---|---:|---:|
| `dep-version` | lookup | 3/3 · 4,613 · $0.0006 | 3/3 · 7,925 · $0.0010 |
| `where-handled` | lookup | 3/3 · 14,087 · $0.0015 | 3/3 · 9,033 · $0.0010 |
| `callers-of` | lookup | 3/3 · 13,701 · $0.0019 | 3/3 · 15,977 · $0.0021 |
| `routes` | lookup | 3/3 · 10,820 · $0.0015 | 3/3 · 10,294 · $0.0014 |
| `file-summary` | lookup | 3/3 · 10,119 · $0.0012 | 3/3 · 12,002 · $0.0014 |
| `db-init` | lookup | 3/3 · 6,023 · $0.0008 | 3/3 · 7,542 · $0.0009 |
| `tests-for` | lookup | 3/3 · 5,212 · $0.0009 | 3/3 · 22,885 · $0.0027 |
| `error-class` | lookup | 3/3 · 4,253 · $0.0006 | 3/3 · 13,258 · $0.0015 |
| `entry-point` | lookup | 3/3 · 8,790 · $0.0011 | 3/3 · 18,539 · $0.0021 |
| `type-def` | lookup | 3/3 · 6,299 · $0.0009 | 2/3 · 18,453 · $0.0022 |
| `nl-session-refresh` | natural | 3/3 · 33,616 · $0.0037 | 3/3 · 29,551 · $0.0033 |
| `nl-csrf` | natural | 3/3 · 24,403 · $0.0031 | 3/3 · 14,776 · $0.0019 |
| `nl-magic-link` | natural | 3/3 · 12,972 · $0.0017 | 3/3 · 17,816 · $0.0021 |
| `nl-cookie-size` | natural | 3/3 · 35,440 · $0.0040 | 3/3 · 13,918 · $0.0018 |
| `nl-redirect` | natural | 3/3 · 53,385 · $0.0060 | 3/3 · 67,500 · $0.0075 |
| `nl-oauth-checks` | natural | 3/3 · 23,872 · $0.0029 | 3/3 · 68,188 · $0.0075 |

## Failed checks

- `type-def` / grep+rig: 1/3 failed — missing `types.ts`, `DefaultSession`
  > `Session` is defined in `packages/adapter-mikro-orm/src/lib/entities.ts` at line 60: ```ts @Entity() export class Session implements AdapterSession { ``` It's a MikroORM entity that implements the `AdapterSession` interface from `@auth/core/adapters`. Its fields include `id`, `user`, `userId`, and `…

