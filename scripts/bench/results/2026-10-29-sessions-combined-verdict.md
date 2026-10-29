# rig bench, multi-session memory — sessions-0.3.0 + sessions-confirmation-0.3.0

**Pre-registered bar** (written before any run):

> Memory passes only if the memory-on arm raises multi-session task success by ≥ 15 percentage points over memory-off, while using ≤ 110% of memory-off's median total tokens (both sessions summed). If it doesn't, memory work stops and rig stays a code-map tool.

**Confirmation rule** (pre-registered):

> Confirmation (written 2026-10-29, after the first 10-task run was INCONCLUSIVE and before any further run): 10 new task pairs are added; the verdict is decided once, on all 20 tasks combined (first run's trials for tasks 1–10 plus one new run for tasks 11–20, same model, arms, trials and bar). No further reruns or task changes are made to reach a verdict.

**Verdict, combined (2 runs): PASS** — success delta 40.0 pp, 95% CI 20.0 pp to 60.0 pp, all ≥ 15.0 pp; memory-on used 94.2% of memory-off's median total tokens.

- **Provider / model**: openrouter / `anthropic/claude-haiku-5.5`
- **Resolved model**: `anthropic/claude-haiku-5.5`
- **Rig**: 0.3.0 @ `91e9561` (dirty), fingerprint `14b6ca5108774da6`
- **Target**: `~/rig-bench/next-auth` @ `e293b37466` (pinned)
- **Index snapshot** (every trial starts from a copy): 2,949 nodes, 0 waypoints, sha256 `9275ea806c22`
- **Installed instructions quoted**: `generated/installer/claude.instructions.md` (sha256 `16cfd8dec7fd`)
- **Combined runs**: 2
  - `sessions-0.3.0` (2026-10-29): 10 tasks, 90 trials, rig `91e9561` (dirty) fingerprint `14b6ca5108774da6`, snapshot `9275ea806c22`
  - `sessions-confirmation-0.3.0` (2026-10-29): 10 tasks, 90 trials, rig `6df21ae` fingerprint `14b6ca5108774da6`, snapshot `9275ea806c22`
- **Trials**: 3; **total cost**: $1.2090

## Per arm

Pass = session 2 passed its check. Trap avoidance is over trap tasks whose session 2 answered. Tokens and cost: median / mean per trial.

| arm | session-2 pass | trap avoidance | tokens s1 | tokens s2 | tokens total | cost s1 | cost s2 | cost total | errors / turn limits | no ANSWER line |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| memory-off | 18/60 (30%) | 10/33 (30%) | 28,663 / 39,180 | 26,334 / 36,438 | 68,014 / 75,618 | $0.0036 / $0.0047 | $0.0029 / $0.0041 | $0.0080 / $0.0088 | 5 / 0 | 0 |
| memory-on | 42/60 (70%) | 20/33 (61%) | 47,124 / 60,372 | 16,760 / 20,425 | 64,055 / 80,797 | $0.0055 / $0.0070 | $0.0021 / $0.0024 | $0.0078 / $0.0095 | 6 / 0 | 0 |
| oracle | 49/60 (82%) | 23/33 (70%) | – | 10,351 / 14,473 | 10,351 / 14,473 | – | $0.0014 / $0.0018 | $0.0014 / $0.0018 | 1 / 0 | 0 |

oracle runs no session 1, so its totals are session 2 only. It is an upper bound for interpretation, not part of the verdict.

## Waypoints

| arm | session 1 dropped any | waypoints dropped (total / mean) | session 2 called rig_waypoints | session 2 got session 1 waypoints back |
|---|---:|---:|---:|---:|
| memory-off | 0/60 | 0 / 0.00 | – | – |
| memory-on | 53/60 | 57 / 0.95 | 58/60 | 53/60 |

## Paired: memory-on minus memory-off

Over 60 (task, trial) pairs from 20 tasks. 95% CIs from a 10,000-draw two-level bootstrap (tasks, then trials within each task), seed 20261029.

| measure | memory-off | memory-on | delta / ratio | 95% CI | bar |
|---|---:|---:|---:|---:|---:|
| session-2 success | 30% | 70% | 40.0 pp | 20.0 pp to 60.0 pp | ≥ 15.0 pp |
| median total tokens | 68,014 | 64,055 | 94.2% | 72.1% to 133.0% | ≤ 110.0% |

## Sanity: are the answers in the code?

- Code evidence for the trap answers found in the target: 11/11
- Session-1 facts absent from the target's files: 6/6
- memory-off (code only in session 2) failed 27/33 trap-task runs and gave the trap answer in 23: OK, code alone leads into most traps

## Per task

| task | type | trap | memory-off pass · trapped · tokens | memory-on pass · trapped · tokens | oracle pass · trapped · tokens | memory-on dropped |
|---|---|---|---:|---:|---:|---:|
| `jwt-only-with-adapter` | decision | yes | 2/3 · 1 · 44,307 | 3/3 · 0 · 51,000 | 3/3 · 0 · 7,965 | 3/3 |
| `fork-default-max-age` | decision | yes | 0/3 · 3 · 25,802 | 2/3 · 1 · 42,209 | 3/3 · 0 · 4,944 | 3/3 |
| `vendored-cookie` | constraint | yes | 1/3 · 2 · 60,599 | 3/3 · 0 · 62,783 | 3/3 · 0 · 10,383 | 3/3 |
| `cookie-chunk-size` | dead-end | yes | 3/3 · 0 · 112,420 | 2/3 · 1 · 54,473 | 3/3 · 0 · 19,418 | 3/3 |
| `actions-merge-rule` | constraint |  | 0/3 · 0 · 49,255 | 3/3 · 0 · 29,031 | 3/3 · 0 · 6,752 | 3/3 |
| `magic-link-adapter` | dead-end |  | 0/3 · 0 · 70,719 | 3/3 · 0 · 77,085 | 3/3 · 0 · 12,440 | 3/3 |
| `github-org-gate` | decision |  | 0/3 · 0 · 100,260 | 3/3 · 0 · 49,660 | 3/3 · 0 · 25,755 | 3/3 |
| `update-age-jwt` | discovery |  | 3/3 · 0 · 99,293 | 3/3 · 0 · 108,250 | 3/3 · 0 · 9,074 | 3/3 |
| `oauth-check-ttl` | discovery |  | 3/3 · 0 · 150,270 | 3/3 · 0 · 245,740 | 3/3 · 0 · 11,474 | 3/3 |
| `trust-host` | constraint |  | 2/3 · 0 · 29,944 | 3/3 · 0 · 30,408 | 3/3 · 0 · 7,322 | 3/3 |
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

