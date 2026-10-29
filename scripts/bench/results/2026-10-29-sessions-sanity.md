# rig bench, multi-session memory — sessions-sanity

**Pre-registered bar** (written before any run):

> Memory passes only if the memory-on arm raises multi-session task success by ≥ 15 percentage points over memory-off, while using ≤ 110% of memory-off's median total tokens (both sessions summed). If it doesn't, memory work stops and rig stays a code-map tool.

**Verdict: not computed** — needs both memory-on and memory-off runs.

- **Provider / model**: openrouter / `anthropic/claude-haiku-5.5`
- **Resolved model**: `anthropic/claude-haiku-5.5`
- **Rig**: 0.3.0 @ `91e9561`, fingerprint `14b6ca5108774da6`
- **Target**: `~/rig-bench/next-auth` @ `e293b37466` (pinned)
- **Index snapshot** (every trial starts from a copy): 2,949 nodes, 0 waypoints, sha256 `9275ea806c22`
- **Installed instructions quoted**: `generated/installer/claude.instructions.md` (sha256 `16cfd8dec7fd`)
- **Trials**: 1; **total cost**: $0.0378

## Per arm

Pass = session 2 passed its check. Trap avoidance is over trap tasks whose session 2 answered. Tokens and cost: median / mean per trial.

| arm | session-2 pass | trap avoidance | tokens s1 | tokens s2 | tokens total | cost s1 | cost s2 | cost total | errors / turn limits | no ANSWER line |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep-only | 5/10 (50%) | 2/4 (50%) | – | 26,062 / 30,938 | 26,062 / 30,938 | – | $0.0034 / $0.0038 | $0.0034 / $0.0038 | 0 / 0 | 0 |

## Sanity: are the answers in the code?

- Code evidence for the trap answers found in the target: 4/4
- grep-only (code only in session 2) failed 2/4 trap-task runs and gave the trap answer in 2: **WARNING: code alone avoids most traps; the delta says little about memory**

## Per task

| task | type | trap | grep-only pass · trapped · tokens | memory-on dropped |
|---|---|---|---:|---:|
| `jwt-only-with-adapter` | decision | yes | 1/1 · 0 · 35,578 | – |
| `fork-default-max-age` | decision | yes | 0/1 · 1 · 5,093 | – |
| `vendored-cookie` | constraint | yes | 0/1 · 1 · 26,881 | – |
| `cookie-chunk-size` | dead-end | yes | 1/1 · 0 · 26,277 | – |
| `actions-merge-rule` | constraint |  | 0/1 · 0 · 53,236 | – |
| `magic-link-adapter` | dead-end |  | 0/1 · 0 · 16,561 | – |
| `github-org-gate` | decision |  | 0/1 · 0 · 96,283 | – |
| `update-age-jwt` | discovery |  | 1/1 · 0 · 13,781 | – |
| `oauth-check-ttl` | discovery |  | 1/1 · 0 · 25,847 | – |
| `trust-host` | constraint |  | 1/1 · 0 · 9,842 | – |

