# rig bench — hybrid-search

- **Provider / model**: openrouter / `anthropic/claude-haiku-5.5`
- **Resolved model**: `anthropic/claude-haiku-5.5`
- **Rig**: 0.2.0 @ `a0a5dba`, fingerprint `f0e6da8652a16429`
- **Target**: `~/rig-bench/next-auth` @ `e293b37466` (pinned), 2,948 nodes / 692 files
- **Trials**: 3; **total cost**: $0.5077

## Per arm

| arm | correct | tokens median (all / correct) | tokens mean (all / correct) | cost median (all / correct) | cost mean (all / correct) | tool turns (median / mean) | errors / turn limits |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 48/48 (100%) | 11,789 / 11,789 | 17,499 / 17,499 | $0.0016 / $0.0016 | $0.0021 / $0.0021 | 3 / 3.5 | 0 / 0 |
| rig | 44/48 (92%) | 36,380 / 39,412 | 45,179 / 46,250 | $0.0040 / $0.0044 | $0.0050 / $0.0051 | 5.5 / 6.4 | 0 / 0 |
| rig-search | 46/48 (96%) | 17,275 / 17,092 | 30,709 / 28,290 | $0.0021 / $0.0021 | $0.0035 / $0.0032 | 4.5 / 5.5 | 0 / 1 |

## Paired against baseline (per query, median over trials)

A query counts as correct for an arm when at least half its trials pass the check.

| arm | queries | median token ratio | ratio, both correct | correct & cheaper | correct but pricier | wrong | baseline wrong |
|---|---:|---:|---:|---:|---:|---:|---:|
| rig | 16 | 268.4% | 266.3% | 3 | 12 | 1 | 0 |
| rig-search | 16 | 131.5% | 131.5% | 8 | 8 | 0 | 0 |

## By query category

| arm | lookup correct | lookup median tokens | natural correct | natural median tokens |
|---|---:|---:|---:|---:|
| baseline | 100% | 7,067 | 100% | 22,294 |
| rig | 90% | 19,436 | 94% | 75,779 |
| rig-search | 97% | 14,742 | 94% | 29,404 |

## Per query (median over trials)

| query | kind | baseline ok · tokens · cost | rig ok · tokens · cost | rig-search ok · tokens · cost |
|---|---|---:|---:|---:|
| `dep-version` | lookup | 3/3 · 4,572 · $0.0006 | 3/3 · 10,270 · $0.0012 | 3/3 · 8,592 · $0.0010 |
| `where-handled` | lookup | 3/3 · 9,144 · $0.0010 | 3/3 · 15,612 · $0.0016 | 3/3 · 3,769 · $0.0004 |
| `callers-of` | lookup | 3/3 · 16,599 · $0.0023 | 3/3 · 11,147 · $0.0015 | 3/3 · 9,534 · $0.0013 |
| `routes` | lookup | 3/3 · 6,637 · $0.0010 | 3/3 · 71,523 · $0.0078 | 3/3 · 21,706 · $0.0026 |
| `file-summary` | lookup | 3/3 · 10,061 · $0.0011 | 3/3 · 26,794 · $0.0030 | 3/3 · 16,909 · $0.0021 |
| `db-init` | lookup | 3/3 · 13,290 · $0.0015 | 3/3 · 19,447 · $0.0021 | 3/3 · 4,805 · $0.0006 |
| `tests-for` | lookup | 3/3 · 5,846 · $0.0010 | 3/3 · 39,182 · $0.0042 | 3/3 · 22,203 · $0.0026 |
| `error-class` | lookup | 3/3 · 4,334 · $0.0006 | 3/3 · 31,736 · $0.0035 | 3/3 · 26,120 · $0.0031 |
| `entry-point` | lookup | 3/3 · 11,270 · $0.0014 | 3/3 · 9,192 · $0.0011 | 3/3 · 9,058 · $0.0011 |
| `type-def` | lookup | 3/3 · 3,866 · $0.0006 | 0/3 · 19,174 · $0.0023 | 2/3 · 47,260 · $0.0054 |
| `nl-session-refresh` | natural | 3/3 · 21,417 · $0.0025 | 3/3 · 96,370 · $0.0101 | 2/3 · 120,607 · $0.0134 |
| `nl-csrf` | natural | 3/3 · 16,737 · $0.0024 | 3/3 · 53,246 · $0.0058 | 3/3 · 29,859 · $0.0035 |
| `nl-magic-link` | natural | 3/3 · 13,809 · $0.0018 | 2/3 · 93,347 · $0.0100 | 3/3 · 10,194 · $0.0013 |
| `nl-cookie-size` | natural | 3/3 · 26,844 · $0.0032 | 3/3 · 72,588 · $0.0079 | 3/3 · 7,195 · $0.0010 |
| `nl-redirect` | natural | 3/3 · 71,796 · $0.0082 | 3/3 · 58,518 · $0.0065 | 3/3 · 28,949 · $0.0035 |
| `nl-oauth-checks` | natural | 3/3 · 47,178 · $0.0052 | 3/3 · 88,250 · $0.0096 | 3/3 · 44,829 · $0.0050 |

## Failed checks

- `type-def` / rig: 3/3 failed — missing `DefaultSession`
  > The most likely match is the core Auth.js type, an interface in `packages/core/src/types.ts` at line 250, documented as "The active session of the logged in user." Its declaration is a single line, so the full signature is not shown in the index. I can't read file contents with these tools, so I can…
- `type-def` / rig-search: 1/3 failed — missing `types.ts`, `DefaultSession`
  > The `Session` class is defined in `packages/adapter-mikro-orm/src/lib/entities.ts`. It's an ORM entity class, and it implements the `AdapterSession` interface from `packages/core/src/adapters.ts`. I couldn't retrieve its exact signature line. The index returned the class node without its source, and…
- `nl-session-refresh` / rig-search: 1/3 failed — missing `/actions\/session/`; turn_limit
  > (empty)
- `nl-magic-link` / rig: 1/3 failed — missing `createVerificationToken`
  > The one-time link is created in `sendToken`, in `packages/core/src/lib/actions/signin/send-token.ts`. It's called from `signIn` in `packages/core/src/lib/actions/signin/index.ts`, which runs when someone signs in with an email address. The token storage is only partly confirmed: - **Generation:** `s…

