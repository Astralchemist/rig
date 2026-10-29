# rig bench, multi-session memory — sessions-confirmation-0.3.0

**Pre-registered bar** (written before any run):

> Memory passes only if the memory-on arm raises multi-session task success by ≥ 15 percentage points over memory-off, while using ≤ 110% of memory-off's median total tokens (both sessions summed). If it doesn't, memory work stops and rig stays a code-map tool.

**Confirmation rule** (pre-registered):

> Confirmation (written 2026-10-29, after the first 10-task run was INCONCLUSIVE and before any further run): 10 new task pairs are added; the verdict is decided once, on all 20 tasks combined (first run's trials for tasks 1–10 plus one new run for tasks 11–20, same model, arms, trials and bar). No further reruns or task changes are made to reach a verdict.

**Verdict: FAIL** — memory-on used 110.2% of memory-off's median total tokens, above the 110.0% cap (success delta 33.3 pp, 95% CI 6.7 pp to 60.0 pp).

- **Provider / model**: openrouter / `anthropic/claude-haiku-5.5`
- **Resolved model**: `anthropic/claude-haiku-5.5`
- **Rig**: 0.3.0 @ `6df21ae`, fingerprint `14b6ca5108774da6`
- **Target**: `~/rig-bench/next-auth` @ `e293b37466` (pinned)
- **Index snapshot** (every trial starts from a copy): 2,949 nodes, 0 waypoints, sha256 `9275ea806c22`
- **Installed instructions quoted**: `generated/installer/claude.instructions.md` (sha256 `16cfd8dec7fd`)
- **Trials**: 3; **total cost**: $0.5765

## Per arm

Pass = session 2 passed its check. Trap avoidance is over trap tasks whose session 2 answered. Tokens and cost: median / mean per trial.

| arm | session-2 pass | trap avoidance | tokens s1 | tokens s2 | tokens total | cost s1 | cost s2 | cost total | errors / turn limits | no ANSWER line |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| memory-off | 4/30 (13%) | 4/21 (19%) | 34,487 / 45,096 | 21,444 / 21,690 | 65,840 / 66,786 | $0.0046 / $0.0053 | $0.0025 / $0.0025 | $0.0077 / $0.0078 | 5 / 0 | 0 |
| memory-on | 14/30 (47%) | 10/21 (48%) | 48,468 / 58,355 | 19,187 / 22,424 | 72,552 / 80,779 | $0.0059 / $0.0068 | $0.0023 / $0.0026 | $0.0088 / $0.0094 | 6 / 0 | 0 |
| oracle | 19/30 (63%) | 11/21 (52%) | – | 10,306 / 16,337 | 10,306 / 16,337 | – | $0.0014 / $0.0020 | $0.0014 / $0.0020 | 1 / 0 | 0 |

oracle runs no session 1, so its totals are session 2 only. It is an upper bound for interpretation, not part of the verdict.

## Waypoints

| arm | session 1 dropped any | waypoints dropped (total / mean) | session 2 called rig_waypoints | session 2 got session 1 waypoints back |
|---|---:|---:|---:|---:|
| memory-off | 0/30 | 0 / 0.00 | – | – |
| memory-on | 23/30 | 24 / 0.80 | 28/30 | 23/30 |

## Paired: memory-on minus memory-off

Over 30 (task, trial) pairs from 10 tasks. 95% CIs from a 10,000-draw two-level bootstrap (tasks, then trials within each task), seed 20261029.

| measure | memory-off | memory-on | delta / ratio | 95% CI | bar |
|---|---:|---:|---:|---:|---:|
| session-2 success | 13% | 47% | 33.3 pp | 6.7 pp to 60.0 pp | ≥ 15.0 pp |
| median total tokens | 65,840 | 72,552 | 110.2% | 85.0% to 166.6% | ≤ 110.0% |

## Sanity: are the answers in the code?

- Code evidence for the trap answers found in the target: 7/7
- Session-1 facts absent from the target's files: 6/6
- memory-off (code only in session 2) failed 21/21 trap-task runs and gave the trap answer in 17: OK, code alone leads into most traps

## Per task

| task | type | trap | memory-off pass · trapped · tokens | memory-on pass · trapped · tokens | oracle pass · trapped · tokens | memory-on dropped |
|---|---|---|---:|---:|---:|---:|
| `base-path` | decision | yes | 0/3 · 2 · 70,725 | 2/3 · 1 · 67,073 | 2/3 · 1 · 8,847 | 2/3 |
| `session-cookie-name` | constraint | yes | 0/3 · 3 · 63,998 | 1/3 · 2 · 77,902 | 1/3 · 2 · 32,070 | 3/3 |
| `email-sender` | decision | yes | 0/3 · 3 · 75,749 | 1/3 · 2 · 80,415 | 2/3 · 1 · 16,460 | 3/3 |
| `sign-in-theme` | decision | yes | 0/3 · 3 · 50,818 | 0/3 · 3 · 83,077 | 0/3 · 3 · 17,406 | 3/3 |
| `secret-env-var` | constraint | yes | 0/3 · 3 · 45,274 | 3/3 · 0 · 67,202 | 3/3 · 0 · 10,319 | 3/3 |
| `iframe-same-site` | dead-end | yes | 0/3 · 3 · 88,454 | 0/3 · 3 · 143,999 | 0/3 · 3 · 24,810 | 3/3 |
| `forwarded-headers` | dead-end | yes | 0/3 · 0 · 49,371 | 2/3 · 0 · 53,385 | 3/3 · 0 · 6,291 | 2/3 |
| `account-linking` | discovery |  | 3/3 · 0 · 122,615 | 3/3 · 0 · 169,406 | 3/3 · 0 · 8,354 | 3/3 |
| `sign-in-return-value` | discovery |  | 1/3 · 0 · 47,914 | 1/3 · 0 · 8,490 | 3/3 · 0 · 5,260 | 0/3 |
| `approved-providers` | constraint |  | 0/3 · 0 · 15,403 | 1/3 · 0 · 2,265 | 2/3 · 0 · 8,557 | 1/3 |

