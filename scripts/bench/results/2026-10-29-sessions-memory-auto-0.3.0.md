# rig bench, multi-session memory — sessions-0.3.0 + sessions-confirmation-0.3.0 + sessions-memory-auto-0.3.0

**Pre-registered bar** (written before any run):

> Memory passes only if the memory-on arm raises multi-session task success by ≥ 15 percentage points over memory-off, while using ≤ 110% of memory-off's median total tokens (both sessions summed). If it doesn't, memory work stops and rig stays a code-map tool.

**Confirmation rule** (pre-registered):

> Confirmation (written 2026-10-29, after the first 10-task run was INCONCLUSIVE and before any further run): 10 new task pairs are added; the verdict is decided once, on all 20 tasks combined (first run's trials for tasks 1–10 plus one new run for tasks 11–20, same model, arms, trials and bar). No further reruns or task changes are made to reach a verdict.

**memory-auto** (pre-registered):

> memory-auto (pre-registered 2026-10-29, extractor frozen at 9cb1f2ae28d7d1165b13f0aa76e334e22782da7e): judged against the same bar vs memory-off on all 20 tasks, one run, 3 trials; no extractor changes after seeing results.

**Verdict, combined (3 runs): PASS** — success delta 40.0 pp, 95% CI 20.0 pp to 60.0 pp, all ≥ 15.0 pp; memory-on used 94.2% of memory-off's median total tokens.

**Verdict, memory-auto vs memory-off, combined (3 runs): FAIL** — memory-auto used 115.7% of memory-off's median total tokens, above the 110.0% cap (success delta 20.0 pp, 95% CI 1.7 pp to 40.0 pp).

**memory-auto vs memory-on** (descriptive, no bar): success 50% vs 70%, delta -20.0 pp (95% CI -40.0 pp to -1.7 pp); memory-auto used 122.9% of memory-on's median total tokens.

**New arm against stored baseline arms**: memory-auto from `sessions-memory-auto-0.3.0`, paired with the stored trials of the other arms from `sessions-0.3.0`, `sessions-confirmation-0.3.0`. Same model, trials, bar, target and turn limit; the baseline ran on an earlier rig build (see the runs below).

- **Provider / model**: openrouter / `anthropic/claude-haiku-5.5`
- **Resolved model**: `anthropic/claude-haiku-5.5`
- **Rig**: 0.3.0 @ `91e9561` (dirty), fingerprint `14b6ca5108774da6`
- **Target**: `~/rig-bench/next-auth` @ `e293b37466` (pinned)
- **Index snapshot** (every trial starts from a copy): 2,949 nodes, 0 waypoints, sha256 `9275ea806c22`
- **Installed instructions quoted**: `generated/installer/claude.instructions.md` (sha256 `16cfd8dec7fd`)
- **Combined runs**: 3 — **rig fingerprints differ between runs**
  - `sessions-0.3.0` (2026-10-29): 10 tasks, 90 trials, rig `91e9561` (dirty) fingerprint `14b6ca5108774da6`, snapshot `9275ea806c22`
  - `sessions-confirmation-0.3.0` (2026-10-29): 10 tasks, 90 trials, rig `6df21ae` fingerprint `14b6ca5108774da6`, snapshot `9275ea806c22`
  - `sessions-memory-auto-0.3.0` (2026-10-29): 20 tasks, 60 trials, rig `cc3d007` fingerprint `0213bc39e21aceb3`, snapshot `c05b2cce5e56`
- **Trials**: 3; **total cost**: $1.7669

## Per arm

Pass = session 2 passed its check. Trap avoidance is over trap tasks whose session 2 answered. Tokens and cost: median / mean per trial.

| arm | session-2 pass | trap avoidance | tokens s1 | tokens s2 | tokens total | cost s1 | cost s2 | cost total | errors / turn limits | no ANSWER line |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| memory-off | 18/60 (30%) | 10/33 (30%) | 28,663 / 39,180 | 26,334 / 36,438 | 68,014 / 75,618 | $0.0036 / $0.0047 | $0.0029 / $0.0041 | $0.0080 / $0.0088 | 5 / 0 | 0 |
| memory-on | 42/60 (70%) | 20/33 (61%) | 47,124 / 60,372 | 16,760 / 20,425 | 64,055 / 80,797 | $0.0055 / $0.0070 | $0.0021 / $0.0024 | $0.0078 / $0.0095 | 6 / 0 | 0 |
| oracle | 49/60 (82%) | 23/33 (70%) | – | 10,351 / 14,473 | 10,351 / 14,473 | – | $0.0014 / $0.0018 | $0.0014 / $0.0018 | 1 / 0 | 0 |
| memory-auto | 30/60 (50%) | 14/33 (42%) | 34,409 / 45,337 | 28,174 / 34,072 | 78,694 / 79,409 | $0.0042 / $0.0054 | $0.0033 / $0.0039 | $0.0091 / $0.0093 | 0 / 0 | 0 |

oracle runs no session 1, so its totals are session 2 only. It is an upper bound for interpretation, not part of the verdict.

## Waypoints

| arm | session 1 dropped any | waypoints dropped (total / mean) | session 2 called rig_waypoints | session 2 got session 1 waypoints back |
|---|---:|---:|---:|---:|
| memory-off | 0/60 | 0 / 0.00 | – | – |
| memory-on | 53/60 | 57 / 0.95 | 58/60 | 53/60 |
| memory-auto | 24/60 | 27 / 0.45 | 60/60 | 24/60 |

## Paired: memory-on minus memory-off

Over 60 (task, trial) pairs from 20 tasks. 95% CIs from a 10,000-draw two-level bootstrap (tasks, then trials within each task), seed 20261029.

| measure | memory-off | memory-on | delta / ratio | 95% CI | bar |
|---|---:|---:|---:|---:|---:|
| session-2 success | 30% | 70% | 40.0 pp | 20.0 pp to 60.0 pp | ≥ 15.0 pp |
| median total tokens | 68,014 | 64,055 | 94.2% | 72.1% to 133.0% | ≤ 110.0% |

## Paired: memory-auto minus memory-off

The pre-registered comparison. Over 60 (task, trial) pairs from 20 tasks; same bootstrap as above.

| measure | memory-off | memory-auto | delta / ratio | 95% CI | bar |
|---|---:|---:|---:|---:|---:|
| session-2 success | 30% | 50% | 20.0 pp | 1.7 pp to 40.0 pp | ≥ 15.0 pp |
| median total tokens | 68,014 | 78,694 | 115.7% | 85.5% to 148.4% | ≤ 110.0% |

## Paired: memory-auto minus memory-on

Descriptive. Over 60 (task, trial) pairs from 20 tasks; same bootstrap as above.

| measure | memory-on | memory-auto | delta / ratio | 95% CI | bar |
|---|---:|---:|---:|---:|---:|
| session-2 success | 70% | 50% | -20.0 pp | -40.0 pp to -1.7 pp | – |
| median total tokens | 64,055 | 78,694 | 122.9% | 84.5% to 152.4% | – |

## Automatic capture (memory-auto)

Records the capture pipeline extracted from session 1, per trial (median / mean); stored excludes duplicates; injectable records are the ones the SessionStart brief may show.

| runs | records | stored | injectable | brief chars | capture errors |
|---:|---:|---:|---:|---:|---:|
| 60 | 0.0 / 0.5 | 0.0 / 0.5 | 0.0 / 0.5 | 0 / 194 | 0 |

By kind (all runs): constraint 21, rejected 3, correction 3.

**Capture recall** (computed after the run; it did not feed the arm): the needed fact was in the captured records in 9/57 runs and in the brief in 3/57. The fact is the task's secret, or else the literal strings and `key = value` values of its answer criteria — a coarse proxy, since those are written against the ANSWER line. Tasks with no usable fact are marked n/a.

| task | fact checked | runs | captured | in brief |
|---|---|---:|---:|---:|
| `jwt-only-with-adapter` | `/jwt/i`, `/.*\bjwt\b/i` | 3 | 0 | 0 |
| `fork-default-max-age` | `/28,?800\b/i` | 3 | 0 | 0 |
| `vendored-cookie` | n/a | 3 | – | – |
| `cookie-chunk-size` | `/.*\bjwt\b/i` | 3 | 0 | 0 |
| `actions-merge-rule` | `[core-actions]`, `mfrost` | 3 | 0 | 0 |
| `magic-link-adapter` | `adapter-pg`, `pg-adapter` | 3 | 0 | 0 |
| `github-org-gate` | `read:org`, `read:user`, `user:email`, `acme-corp` | 3 | 3 | 0 |
| `update-age-jwt` | `actions/session` | 3 | 0 | 0 |
| `oauth-check-ttl` | `checks.ts`, `/900\b/i` | 3 | 0 | 0 |
| `trust-host` | `/true/i` | 3 | 3 | 3 |
| `base-path` | `/auth/v2` | 3 | 0 | 0 |
| `session-cookie-name` | `acme_sid` | 3 | 0 | 0 |
| `email-sender` | `login@acme.dev` | 3 | 0 | 0 |
| `sign-in-theme` | `0F766E` | 3 | 0 | 0 |
| `secret-env-var` | `ACME_AUTH_SECRET` | 3 | 3 | 0 |
| `iframe-same-site` | `/none\b/i` | 3 | 0 | 0 |
| `forwarded-headers` | `https://app.acme.dev` | 3 | 0 | 0 |
| `account-linking` | `allowDangerousEmailAccountLinking`, `handle-login.ts` | 3 | 0 | 0 |
| `sign-in-return-value` | `/.*redirect/i`, `handleAuthorized` | 3 | 0 | 0 |
| `approved-providers` | `github`, `google`, `okta` | 3 | 0 | 0 |

## Sanity: are the answers in the code?

- Code evidence for the trap answers found in the target: 11/11
- Session-1 facts absent from the target's files: 6/6
- memory-off (code only in session 2) failed 27/33 trap-task runs and gave the trap answer in 23: OK, code alone leads into most traps

## Per task

| task | type | trap | memory-off pass · trapped · tokens | memory-on pass · trapped · tokens | oracle pass · trapped · tokens | memory-auto pass · trapped · tokens | memory-on dropped |
|---|---|---|---:|---:|---:|---:|---:|
| `jwt-only-with-adapter` | decision | yes | 2/3 · 1 · 44,307 | 3/3 · 0 · 51,000 | 3/3 · 0 · 7,965 | 0/3 · 3 · 61,421 | 3/3 |
| `fork-default-max-age` | decision | yes | 0/3 · 3 · 25,802 | 2/3 · 1 · 42,209 | 3/3 · 0 · 4,944 | 0/3 · 3 · 25,169 | 3/3 |
| `vendored-cookie` | constraint | yes | 1/3 · 2 · 60,599 | 3/3 · 0 · 62,783 | 3/3 · 0 · 10,383 | 3/3 · 0 · 79,023 | 3/3 |
| `cookie-chunk-size` | dead-end | yes | 3/3 · 0 · 112,420 | 2/3 · 1 · 54,473 | 3/3 · 0 · 19,418 | 3/3 · 0 · 59,742 | 3/3 |
| `actions-merge-rule` | constraint |  | 0/3 · 0 · 49,255 | 3/3 · 0 · 29,031 | 3/3 · 0 · 6,752 | 0/3 · 0 · 40,926 | 3/3 |
| `magic-link-adapter` | dead-end |  | 0/3 · 0 · 70,719 | 3/3 · 0 · 77,085 | 3/3 · 0 · 12,440 | 3/3 · 0 · 83,539 | 3/3 |
| `github-org-gate` | decision |  | 0/3 · 0 · 100,260 | 3/3 · 0 · 49,660 | 3/3 · 0 · 25,755 | 3/3 · 0 · 72,746 | 3/3 |
| `update-age-jwt` | discovery |  | 3/3 · 0 · 99,293 | 3/3 · 0 · 108,250 | 3/3 · 0 · 9,074 | 3/3 · 0 · 147,141 | 3/3 |
| `oauth-check-ttl` | discovery |  | 3/3 · 0 · 150,270 | 3/3 · 0 · 245,740 | 3/3 · 0 · 11,474 | 3/3 · 0 · 111,159 | 3/3 |
| `trust-host` | constraint |  | 2/3 · 0 · 29,944 | 3/3 · 0 · 30,408 | 3/3 · 0 · 7,322 | 3/3 · 0 · 24,676 | 3/3 |
| `base-path` | decision | yes | 0/3 · 2 · 70,725 | 2/3 · 1 · 67,073 | 2/3 · 1 · 8,847 | 0/3 · 3 · 78,365 | 2/3 |
| `session-cookie-name` | constraint | yes | 0/3 · 3 · 63,998 | 1/3 · 2 · 77,902 | 1/3 · 2 · 32,070 | 0/3 · 3 · 92,631 | 3/3 |
| `email-sender` | decision | yes | 0/3 · 3 · 75,749 | 1/3 · 2 · 80,415 | 2/3 · 1 · 16,460 | 0/3 · 3 · 95,478 | 3/3 |
| `sign-in-theme` | decision | yes | 0/3 · 3 · 50,818 | 0/3 · 3 · 83,077 | 0/3 · 3 · 17,406 | 0/3 · 3 · 59,126 | 3/3 |
| `secret-env-var` | constraint | yes | 0/3 · 3 · 45,274 | 3/3 · 0 · 67,202 | 3/3 · 0 · 10,319 | 3/3 · 0 · 56,578 | 3/3 |
| `iframe-same-site` | dead-end | yes | 0/3 · 3 · 88,454 | 0/3 · 3 · 143,999 | 0/3 · 3 · 24,810 | 0/3 · 1 · 124,188 | 3/3 |
| `forwarded-headers` | dead-end | yes | 0/3 · 0 · 49,371 | 2/3 · 0 · 53,385 | 3/3 · 0 · 6,291 | 0/3 · 0 · 41,862 | 2/3 |
| `account-linking` | discovery |  | 3/3 · 0 · 122,615 | 3/3 · 0 · 169,406 | 3/3 · 0 · 8,354 | 3/3 · 0 · 94,550 | 3/3 |
| `sign-in-return-value` | discovery |  | 1/3 · 0 · 47,914 | 1/3 · 0 · 8,490 | 3/3 · 0 · 5,260 | 3/3 · 0 · 150,900 | 0/3 |
| `approved-providers` | constraint |  | 0/3 · 0 · 15,403 | 1/3 · 0 · 2,265 | 2/3 · 0 · 8,557 | 0/3 · 0 · 41,810 | 1/3 |

