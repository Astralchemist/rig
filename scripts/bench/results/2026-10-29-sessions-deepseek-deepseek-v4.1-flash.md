# rig bench, multi-session memory — sessions-deepseek-deepseek-v4.1-flash

**Pre-registered bar** (written before any run):

> Memory passes only if the memory-on arm raises multi-session task success by ≥ 15 percentage points over memory-off, while using ≤ 110% of memory-off's median total tokens (both sessions summed). If it doesn't, memory work stops and rig stays a code-map tool.

**Confirmation rule** (pre-registered):

> Confirmation (written 2026-10-29, after the first 10-task run was INCONCLUSIVE and before any further run): 10 new task pairs are added; the verdict is decided once, on all 20 tasks combined (first run's trials for tasks 1–10 plus one new run for tasks 11–20, same model, arms, trials and bar). No further reruns or task changes are made to reach a verdict.

**Verdict: FAIL** — memory-on used 110.6% of memory-off's median total tokens, above the 110.0% cap (success delta 60.0 pp, 95% CI 40.0 pp to 78.3 pp).

- **Provider / model**: openrouter / `deepseek/deepseek-v4.1-flash`
- **Resolved model**: `deepseek/deepseek-v4.1-flash`
- **Rig**: 0.3.0 @ `08c328e`, fingerprint `14b6ca5108774da6`
- **Target**: `/Users/bob/Development/rig-bench/next-auth` @ `e293b37466` (pinned)
- **Index snapshot** (every trial starts from a copy): 2,949 nodes, 0 waypoints, sha256 `715c8c23636a`
- **Installed instructions quoted**: `generated/installer/claude.instructions.md` (sha256 `16cfd8dec7fd`)
- **Trials**: 3; **total cost**: $1.0278

## Per arm

Pass = session 2 passed its check. Trap avoidance is over trap tasks whose session 2 answered. Tokens and cost: median / mean per trial.

| arm | session-2 pass | trap avoidance | tokens s1 | tokens s2 | tokens total | cost s1 | cost s2 | cost total | errors / turn limits | no ANSWER line |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| memory-off | 12/60 (20%) | 6/28 (21%) | 37,380 / 67,805 | 46,504 / 91,272 | 124,421 / 159,077 | $0.0027 / $0.0039 | $0.0025 / $0.0045 | $0.0072 / $0.0084 | 0 / 16 | 0 |
| memory-on | 48/60 (80%) | 22/30 (73%) | 65,087 / 98,356 | 15,335 / 45,379 | 137,617 / 143,735 | $0.0036 / $0.0047 | $0.0010 / $0.0022 | $0.0064 / $0.0068 | 0 / 3 | 0 |
| oracle | 48/60 (80%) | 22/32 (69%) | – | 15,654 / 32,031 | 15,654 / 32,031 | – | $0.0013 / $0.0019 | $0.0013 / $0.0019 | 0 / 0 | 1 |

oracle runs no session 1, so its totals are session 2 only. It is an upper bound for interpretation, not part of the verdict.

## Waypoints

| arm | session 1 dropped any | waypoints dropped (total / mean) | session 2 called rig_waypoints | session 2 got session 1 waypoints back |
|---|---:|---:|---:|---:|
| memory-off | 0/60 | 0 / 0.00 | – | – |
| memory-on | 57/60 | 61 / 1.02 | 60/60 | 57/60 |

## Paired: memory-on minus memory-off

Over 60 (task, trial) pairs from 20 tasks. 95% CIs from a 10,000-draw two-level bootstrap (tasks, then trials within each task), seed 20261029.

| measure | memory-off | memory-on | delta / ratio | 95% CI | bar |
|---|---:|---:|---:|---:|---:|
| session-2 success | 20% | 80% | 60.0 pp | 40.0 pp to 78.3 pp | ≥ 15.0 pp |
| median total tokens | 124,421 | 137,617 | 110.6% | 56.7% to 193.2% | ≤ 110.0% |

## Sanity: are the answers in the code?

- Code evidence for the trap answers found in the target: 11/11
- Session-1 facts absent from the target's files: 6/6
- memory-off (code only in session 2) failed 31/33 trap-task runs and gave the trap answer in 22: OK, code alone leads into most traps

## Per task

| task | type | trap | memory-off pass · trapped · tokens | memory-on pass · trapped · tokens | oracle pass · trapped · tokens | memory-on dropped |
|---|---|---|---:|---:|---:|---:|
| `jwt-only-with-adapter` | decision | yes | 2/3 · 1 · 61,021 | 2/3 · 0 · 55,394 | 3/3 · 0 · 8,225 | 3/3 |
| `fork-default-max-age` | decision | yes | 0/3 · 3 · 66,074 | 2/3 · 1 · 134,916 | 1/3 · 1 · 21,505 | 3/3 |
| `vendored-cookie` | constraint | yes | 0/3 · 0 · 123,996 | 1/3 · 0 · 209,614 | 3/3 · 0 · 47,621 | 3/3 |
| `cookie-chunk-size` | dead-end | yes | 0/3 · 0 · 69,227 | 2/3 · 1 · 175,187 | 2/3 · 1 · 43,441 | 3/3 |
| `actions-merge-rule` | constraint |  | 0/3 · 0 · 267,151 | 3/3 · 0 · 24,624 | 3/3 · 0 · 3,217 | 3/3 |
| `magic-link-adapter` | dead-end |  | 0/3 · 0 · 202,528 | 3/3 · 0 · 63,309 | 3/3 · 0 · 25,608 | 3/3 |
| `github-org-gate` | decision |  | 0/3 · 0 · 210,392 | 3/3 · 0 · 139,541 | 3/3 · 0 · 18,622 | 3/3 |
| `update-age-jwt` | discovery |  | 3/3 · 0 · 52,626 | 3/3 · 0 · 147,910 | 3/3 · 0 · 5,303 | 3/3 |
| `oauth-check-ttl` | discovery |  | 2/3 · 0 · 240,857 | 3/3 · 0 · 267,954 | 3/3 · 0 · 13,154 | 3/3 |
| `trust-host` | constraint |  | 1/3 · 0 · 49,625 | 3/3 · 0 · 60,669 | 3/3 · 0 · 14,079 | 3/3 |
| `base-path` | decision | yes | 0/3 · 2 · 133,989 | 3/3 · 0 · 108,305 | 3/3 · 0 · 17,981 | 3/3 |
| `session-cookie-name` | constraint | yes | 0/3 · 3 · 132,360 | 1/3 · 2 · 190,636 | 3/3 · 0 · 61,929 | 3/3 |
| `email-sender` | decision | yes | 0/3 · 3 · 79,669 | 2/3 · 0 · 134,032 | 0/3 · 2 · 75,511 | 3/3 |
| `sign-in-theme` | decision | yes | 0/3 · 3 · 41,927 | 0/3 · 3 · 94,868 | 0/3 · 3 · 27,498 | 3/3 |
| `secret-env-var` | constraint | yes | 0/3 · 3 · 55,581 | 3/3 · 0 · 216,098 | 3/3 · 0 · 10,550 | 3/3 |
| `iframe-same-site` | dead-end | yes | 0/3 · 3 · 114,025 | 2/3 · 1 · 207,284 | 0/3 · 3 · 51,799 | 3/3 |
| `forwarded-headers` | dead-end | yes | 0/3 · 1 · 137,003 | 3/3 · 0 · 52,564 | 3/3 · 0 · 5,828 | 3/3 |
| `account-linking` | discovery |  | 3/3 · 0 · 100,525 | 3/3 · 0 · 154,912 | 3/3 · 0 · 6,681 | 3/3 |
| `sign-in-return-value` | discovery |  | 1/3 · 0 · 264,949 | 3/3 · 0 · 290,181 | 3/3 · 0 · 15,516 | 0/3 |
| `approved-providers` | constraint |  | 0/3 · 0 · 235,788 | 3/3 · 0 · 48,975 | 3/3 · 0 · 8,419 | 3/3 |

