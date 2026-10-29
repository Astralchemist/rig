# Rig token-cost benchmark

An end-to-end comparison of tool surfaces. Each run gives the same question to the same model,
with the same system prompt and a fresh context. Only the tools differ, except in `grep+rig+map`,
whose system prompt also carries rig's repository overview. The harness records the
tokens and dollars each run spends, checks the answer automatically, and the report compares
every rig arm with plain grep-and-read.

## Arms

Choose arms with `--arms baseline,rig,rig-search,grep+rig,grep+rig+map`. All five run by
default.

| Arm            | Tools                                                                                                | What it measures                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseline`     | `rg`, `read_file`, `list_dir`                                                                        | An agent finding its way around a fresh repo, without artificial limits.                                                                                           |
| `rig`          | `rig_search`, `rig_node`, `rig_callers`, `rig_neighbors`, `rig_deps`, `rig_unused_deps`, `rig_files` | The original light-tier slice (`tools-rig.ts`). It calls `Rig` methods directly and uses its own descriptions.                                                     |
| `rig-search`   | `rig_search`, `rig_context`, `rig_explore`, `rig_node`, `rig_callers`, `rig_neighbors`, `rig_files`  | Rig's search-facing MCP tools as an MCP client sees them: the generated handlers with contract validation, plus the manifest's descriptions and input schemas.     |
| `grep+rig`     | the `baseline` tools plus the `rig-search` tools                                                     | What an agent has in real use: it can locate code with rig and read it with `read_file` or `rg`. Rig tools run through the same real-handler path as `rig-search`. |
| `grep+rig+map` | the `grep+rig` tools                                                                                 | `grep+rig` plus rig's repository overview in the system prompt: what an agent has when it calls `rig_overview` first, as the installed instructions say.           |

`rig-search` exists to measure search changes. It copies no tool code, so a change to search, a
tool implementation or a contract shows up in the next bench run with no change to the harness.
The harness doesn't record activations, so earlier runs can't affect later ones.

`grep+rig+map` measures the orientation map (`rig_overview`, `rig://overview`). The harness
generates the map of the target from its index with this checkout's rig, then appends it to the
shared system prompt, unchanged, as a delimited block:

```
<shared system prompt>

Repository overview, generated from an index of this repository:
<repository-overview>
# Repository overview: next-auth
…
</repository-overview>
```

Everything else matches `grep+rig`: the same tools, descriptions and routing. The map's budget is
2,000 tokens (about 8,000 characters); `--map-budget` changes it. The results file records the
map's size in characters and estimated tokens under `overview`, and the report prints it. The
bench enables no prompt caching, so the map is billed again on every model call: about 2,000
tokens × model calls per run. The arm pays off only if it saves more turns than that.

`grep+rig` exists because the rig-only arms can't read source code. In a run they sometimes stop
at a location and a docstring where the question needs the code. It uses the same system prompt
as every other arm and gives no hint about which tools to use.

The `baseline`, `grep+rig` and `grep+rig+map` arms need ripgrep: run `brew install ripgrep`, or point `BENCH_RG` at an `rg`
binary. `--dry-run` reports whether it found one. ripgrep output is cut at 200 lines, and both
`rg` and `read_file` output at 60,000 characters. That 60,000 is the same budget rig's heavy
tools use.

## Providers

| Provider               | Selected by                                                                                | Endpoint                                        | Default model                |
| ---------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------- |
| `openrouter` (default) | `--provider openrouter`, `BENCH_PROVIDER=openrouter`, or `OPENROUTER_API_KEY` in the env   | `https://openrouter.ai/api/v1/chat/completions` | `anthropic/claude-haiku-5.5` |
| `anthropic`            | `--provider anthropic`, `BENCH_PROVIDER=anthropic`, or only `ANTHROPIC_API_KEY` in the env | `https://api.anthropic.com/v1/messages`         | `claude-sonnet-5`            |

`--model` (or `BENCH_MODEL`) overrides the model.

**OpenRouter** uses OpenAI-style tool calling. The harness converts each tool to a `function`
definition, executes the `tool_calls` that come back, and returns the results as `tool`
messages. Each request sends `usage: {include: true}`. The harness records OpenRouter's reported
`cost`, along with prompt and completion tokens, for every call.

Non-Anthropic upstreams bend the OpenAI shape in a few ways, and the provider normalises each
before the agent loop sees it:

- **Tool call ids.** A missing or empty id, or one already used earlier in the conversation
  (Gemini and Qwen reuse `tool_0`- or `call_0`-style ids across turns), is replaced with a fresh
  `call_rig_<n>`. The history keeps the new id, so each tool result answers exactly one call.
- **Arguments.** A JSON string, an already-parsed object or nothing are all accepted; an empty
  string means no arguments. JSON that `max_tokens` cut off goes back to the model as an
  error, and no tool runs.
- **Parallel calls.** Every call in a reply runs, in order, and each gets its own `tool`
  message. A legacy `function_call` becomes one tool call.
- **Finish reasons.** `tool_calls`, `function_call` and `tool_use` count as tool calls;
  `stop`, `STOP` and `end_turn` as a stop; `length` and `MAX_TOKENS` as a cut-off;
  `content_filter` and `SAFETY` as a filter. The loop keys on whether calls are present, not on
  the reason, because Gemini reports `STOP` on replies that do call tools. Each run records
  its calls per reason under `finish_reasons`, so a reasoning model that spends `max_tokens`
  thinking shows up as `length`.
- **Reasoning state.** `reasoning_details` on an assistant reply goes back unchanged on the
  next request, which Gemini's thought signatures need for multi-turn tool use.
- **Cost.** A reply with token counts but no `cost` is priced from the catalogue's list price. A
  reply with no `usage` block leaves the run's cost unknown.

**Anthropic** uses the Messages API with `tool_use` and `tool_result` blocks. That API doesn't
report a price, so the harness computes cost from list prices. It takes them from OpenRouter's
public model catalogue, mapping for example `claude-haiku-4-5-20251001` to
`anthropic/claude-haiku-4.5`.

Both providers retry network errors, 408, 429, 5xx and 529, and also errors OpenRouter reports
inside a 200 reply. Retries use exponential backoff with jitter: 5 attempts, starting at 1 s and
capped at 60 s. A server `Retry-After` header takes precedence. Other 4xx errors fail the run
immediately.

A credits or billing error stops the whole bench at once: HTTP 402, or any error whose
message talks about credits, an insufficient balance or payment. It is never retried and
never recorded as the model failing, because every later call would fail the same way and
score 0%. The trials that completed are kept in the results file, marked
`"aborted": "insufficient_credits"` (with the error under `aborted_reason`); a run that
completed none leaves no file. `bench:run` then exits with code 3. `bench:report` refuses a
file marked aborted, and the charts and the by-model view leave it out and show "aborted".
Runs from before this rule could record a 402 as a failed trial; the manifest counts those
under `credit_error_trials`, and `bench:report` warns about them.

Each results file records the provider, the requested model, every resolved model id the API
reported (such as `anthropic/claude-haiku-5.5-20261007`), and for OpenRouter the upstream
provider that served each call.

## Target

The target is [`nextauthjs/next-auth`](https://github.com/nextauthjs/next-auth), pinned at
`e293b3746616660f0844347a68d09eac54b95c6f` (tag `next-auth@5.0.0-beta.32`). The pinned commit is
also recorded in `queries.json`. All expected answers were checked by hand at this commit. The run
refuses a target checked out at a different commit unless you pass `--allow-commit-mismatch`.

Setup, once:

```sh
git clone https://github.com/nextauthjs/next-auth ~/Development/rig-bench/next-auth
git -C ~/Development/rig-bench/next-auth checkout e293b3746616660f0844347a68d09eac54b95c6f
```

The default `--repo` is `~/Development/rig-bench/next-auth`. `BENCH_REPO` overrides it. The
target doesn't need `bun install`.

The harness builds the index itself, using the rig code of the current checkout through the
workspace import. It does not use an installed `rig` CLI. It stamps `.rig/bench-stamp.json` with
a fingerprint of `packages/{core,mcp,contracts}/src`, `.contracts` and `generated/mcp`. When the
fingerprint changes, for example on another branch or after an uncommitted search change, the
next run rebuilds the index, so each rig version is measured against its own graph. It takes
about 90 s on an M-series laptop, using the local embedder. The harness never deletes a `.rig`
that it didn't build unless you pass `--fresh-index`. To prebuild the index without calling a
model, run `bun run bench:run --index-only`.

## Correctness

Each query in `queries.json` has `expected` criteria that the harness checks against the final
answer:

```json
"expected": { "all": ["checks.ts"], "any": ["/\\bstate\\b/i", "/pkce|code.?verifier/i", "nonce"], "any_min": 2 }
```

- A plain string matches as a case-insensitive substring. A string written `"/source/flags"` is a
  regular expression.
- Every pattern in `all` must match.
- At least `any_min` patterns (default 1) in `any` must match.
- No pattern in `none` may match.

The criteria are necessary conditions, such as the right file and the right symbol. They don't
grade prose. Every query also has a `reference` answer. A test checks that each reference passes
its own criteria. A run that hits the turn limit or fails with an error counts as wrong.

Queries come in two categories:

- **`lookup`** (10): the question names the symbol, file or package. Most can also be answered by
  grep.
- **`natural`** (6): the question is phrased the way a user asks, with no identifiers. For
  example: "Where do we push back a session's expiry date when the user keeps using the app?"
  The next search improvement should show up on these. A test enforces that they contain no
  backticks, paths or camelCase.

| id                   | kind    | Expected (summary)                                                                                           |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `dep-version`        | lookup  | `6.0.6` (`jose` in `packages/core/package.json`)                                                             |
| `where-handled`      | lookup  | `providers/github.ts`                                                                                        |
| `callers-of`         | lookup  | `sealCookie`, plus one of `webauthnChallenge`, `state.create`, `actions/session`, `callback/index`           |
| `routes`             | lookup  | signin, signout, callback, session, csrf, providers, plus `verify-request` or `webauthn-options`             |
| `file-summary`       | lookup  | `Auth` (not `Auth.js`), `Request`, `Response`, plus `AuthConfig` or "config"                                 |
| `db-init`            | lookup  | `adapters.ts`, `Adapter`                                                                                     |
| `tests-for`          | lookup  | `jwt.test.ts`                                                                                                |
| `error-class`        | lookup  | `MissingCSRF`, `errors.ts`                                                                                   |
| `entry-point`        | lookup  | `index.js` or `index.ts`                                                                                     |
| `type-def`           | lookup  | `types.ts`, `DefaultSession`                                                                                 |
| `nl-session-refresh` | natural | `actions/session`, plus one of `updateSession`, `updateAge`, `jwt.encode`, `fromDate`, re-encode/re-sign     |
| `nl-csrf`            | natural | "csrf", plus one of `csrf-token.ts`, `createCSRFToken`, `validateCSRF`                                       |
| `nl-magic-link`      | natural | `send-token`, `createVerificationToken`, "hash"                                                              |
| `nl-cookie-size`     | natural | `cookie.ts`, "chunk", plus one of `SessionStore`, `CHUNK_SIZE`, `4096`                                       |
| `nl-redirect`        | natural | "redirect", `baseUrl`/origin, plus one of `init.ts`, `callback-url`, `defaultCallbacks`, `createCallbackUrl` |
| `nl-oauth-checks`    | natural | `checks.ts`, plus two of state, PKCE/code_verifier, nonce                                                    |

`--judge <model>` adds an LLM judge as a second opinion. It is off by default. The judge uses
the same provider and sees the question, the reference answer and the agent's answer. Its verdict
is stored next to the pattern check and never replaces it. The report shows how often the two
agree. When you tighten the criteria later, run `bench:report <file> --recheck` to re-grade the
stored answers against the current `queries.json`.

## Running

Keys come from the environment. Load them without printing them:

```sh
set -a; . ~/.config/rig-bench/openrouter.env; set +a   # exports OPENROUTER_API_KEY
bun run bench:run --dry-run                             # plan + cost estimate, no model call
bun run bench:run --label baseline-0.2.0                # full run: 16 queries × 3 trials × 5 arms
bun run bench:report scripts/bench/results/<date>-baseline-0.2.0.json
```

Useful flags:

| Flag                                 | Effect                                                          |
| ------------------------------------ | --------------------------------------------------------------- |
| `--queries nl-csrf,routes`           | Run a subset of query ids.                                      |
| `--trials N`                         | Trials per (query, arm). Default 3.                             |
| `--arms grep+rig,baseline`           | Run a subset of arms.                                           |
| `--map-budget N`                     | Token budget of `grep+rig+map`'s overview. Default 2000.        |
| `--max-turns N`                      | Model calls per run before giving up. Default 12.               |
| `--judge anthropic/claude-haiku-5.5` | Add the LLM judge.                                              |
| `--label NAME` / `--out PATH`        | Results go to `scripts/bench/results/<UTC date>-<label>.json`.  |
| `--estimate-from FILE`               | Base the dry-run estimate on an earlier run's per-arm means.    |
| `--max-spend-usd X`                  | Stop (exit 1) once the run has spent X; `bench:matrix` sets it. |
| `--index-only` / `--fresh-index`     | Build the index and stop / force a rebuild.                     |

The harness writes the results file after every run, so an interrupted bench keeps every run it
paid for. `bench:report` prints markdown. Add `--out report.md` to write it to a file instead.

To compare two rig versions, run the bench on each branch with a distinct `--label` and read the
two reports side by side. The `rig.fingerprint` in each file shows which sources produced it.

## Cost estimates

These are `--dry-run` figures for the default plan: 16 queries × 3 trials × 5 arms = 240 runs.
They use OpenRouter list prices as of 2026-10-29 and assumed token profiles per run: baseline
~60k in / 1.5k out, `rig` ~20k / 1k, `rig-search` ~30k / 1k, `grep+rig` ~60k / 1.5k,
`grep+rig+map` ~72k / 1.5k (`grep+rig` plus the 2k-token map on each of ~6 calls). After the
first real run, pass `--estimate-from` to replace the assumed profiles with measured ones.

| Model (OpenRouter id)         | $ / M in · out | Default plan |
| ----------------------------- | -------------- | -----------: |
| `anthropic/claude-haiku-5.5`  | 0.10 · 0.50    |      ≈ $1.32 |
| `anthropic/claude-haiku-4.5`  | 1.00 · 5.00    |     ≈ $13.18 |
| `anthropic/claude-sonnet-5`   | 2.00 · 10.00   |     ≈ $26.35 |
| `anthropic/claude-sonnet-5.5` | 2.00 · 10.00   |     ≈ $26.35 |
| `anthropic/claude-opus-5.5`   | 4.00 · 20.00   |     ≈ $52.70 |

For prompts over 100k tokens in a single call, Haiku 5.5 bills at its long-context tier
($0.50 / $2.50). Calls in this bench should stay below that, and both OpenRouter's reported cost
and the computed Anthropic-path cost apply the higher tier if a call crosses it. A Haiku 5.5 judge adds about $0.04 per
240 runs. The Anthropic-direct path costs the same per token as the matching OpenRouter id.

## Report

For each arm, the report shows:

- **Correctness rate:** runs whose answer passed the check.
- **Tokens and cost per query:** median and mean, over all runs and over correct runs only.
  Tokens are prompt plus completion, summed across every model call in the run. Prompt tokens
  include the history resent on each call.
- **Tool turns:** median and mean tool calls per run, plus the number of errors and turn-limit
  stops.
- **Paired against baseline:** one point per query, taking the median over trials.
  - The median token ratio (arm ÷ baseline), over all queries and over queries both arms got
    right.
  - Counts of queries the arm got right and cheaper, got right but at equal or higher cost, or
    got wrong, plus how many the baseline got wrong.
  - An arm gets a query right when at least half its trials pass.
- **By category:** correctness and median tokens for `lookup` and `natural` queries.
- **Per query:** correct/total, median tokens and median cost for each arm.
- **Failed checks:** the patterns each failed run missed, and a sample answer.

## Hypotheses (not results)

The earlier README treated these thresholds as decision rules. Until a run with checked
correctness exists, they are only hypotheses:

- On `lookup` queries, rig arms should answer correctly at ≤ 30% of baseline tokens (median
  paired ratio). The original pitch was ≤ 15%.
- On `natural` queries, today's FTS-only `rig_search` is expected to miss, because multi-word
  questions return no anchors. That should push `rig-search` toward `rig_files` or extra turns.
  The search upgrade should raise `rig-search` correctness on this category without raising its
  tokens.
- `grep+rig` should be at least as correct as baseline. Rig pays off only if `grep+rig` also
  uses fewer tokens than baseline.
- A rig arm that is cheaper but wrong more often than baseline isn't a win. Read the correct &
  cheaper column first.

## Multi-session memory

The single-shot results in `results/` show rig doesn't beat grep on one-off questions. Rig's
real bet is memory across sessions, anchored to the code: decisions, constraints, rejected
approaches and expensive findings that the code alone doesn't reveal. Published work points
both ways. Memory of earlier decisions that can't be inferred from the code raised
multi-session pass rates from about 12% to about 50% (DreamBench-SWE, 2026), while generic
memory systems mostly failed to beat memory-off (VibeMemBench, 2026). `--mode sessions`
measures rig's memory as it ships today: manual waypoints, no hooks.

### Pre-registered bar

Written before any run, and copied verbatim into every results file before its first model
call and into every report:

> Memory passes only if the memory-on arm raises multi-session task success by ≥ 15 percentage points over memory-off, while using ≤ 110% of memory-off's median total tokens (both sessions summed). If it doesn't, memory work stops and rig stays a code-map tool.

The verdict line in the report applies it like this:

- **Success** is the share of (task, trial) pairs whose session 2 passed its check. The delta is
  memory-on minus memory-off over the same pairs. Its 95% CI comes from a two-level bootstrap:
  tasks are resampled with replacement, then trials within each drawn task, with 10,000 draws
  and a fixed seed. Trials of one task aren't independent, so a flat resample would make the
  interval too narrow.
- **Tokens** are prompt plus completion, session 1 plus session 2, per trial. The clause
  compares the medians as a point estimate, as the bar states it. The report also prints a
  bootstrap CI for the ratio.
- **PASS:** the whole CI is at or above +15 pp, and the token ratio is ≤ 110%.
- **FAIL:** the whole CI is below +15 pp, or the token ratio is above 110%.
- **INCONCLUSIVE:** the CI straddles +15 pp, and the token clause holds.

### Confirmation rule

The first run on tasks 1–10 (`results/2026-10-29-sessions-0.3.0.md`) came out INCONCLUSIVE:
+46.7 pp, 95% CI 13.3 to 76.7 pp, at 74% of memory-off's tokens. Its sanity check also warned
that memory-off avoided 6 of 12 trap runs. This rule was written and committed before tasks
11–20 existed and before any further run. Every later results file carries it verbatim, and
the report prints it:

> Confirmation (written 2026-10-29, after the first 10-task run was INCONCLUSIVE and before any further run): 10 new task pairs are added; the verdict is decided once, on all 20 tasks combined (first run's trials for tasks 1–10 plus one new run for tasks 11–20, same model, arms, trials and bar). No further reruns or task changes are made to reach a verdict.

### Design

`sessions.json` holds 20 task pairs in two sets: tasks 1–10 (`first`, the first run's tasks,
unchanged since) and tasks 11–20 (`confirmation`, added under the confirmation rule). All of
them run on the pinned next-auth commit. The pin comes from `queries.json`; `sessions.json` has
none of its own. Each pair has two sessions:

- **Session 1** is a scripted conversation: 2–4 fixed user messages, each followed by real
  model turns with tools. In it the user states, or the agent finds by investigating,
  something the code doesn't say.
- **Session 2** is a fresh context with no transcript. It is one follow-up task whose correct
  answer depends on session 1. It ends by asking for one line,
  `ANSWER: key=value; …`. The criteria check only the text after the last `ANSWER:`, so an
  answer can name a trap in its reasoning in order to reject it.

The criteria are those of the single-shot bench (`all`, `any` with `any_min`, `none`), plus
`must_not`. `must_not` holds the trap answer, meaning what the code alone points to. A
`must_not` match fails the check and counts as a trap hit. Only trap tasks have `must_not`;
other wrong answers go in `none`. Each trap task also lists `code_evidence`: the file and
pattern where the code points to the trap answer. The dry run and every results file check
that evidence against the target.

Tasks 1–10, set `first`:

| task                    | type       | trap | session 1 establishes                                                                       | trap answer (code alone)                                              |
| ----------------------- | ---------- | ---- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `jwt-only-with-adapter` | decision   | yes  | Sessions stay JWT with the Prisma adapter; database sessions rejected (Edge latency).       | `strategy=database`: `init.ts` defaults to it with an adapter         |
| `fork-default-max-age`  | decision   | yes  | The fork's default session maxAge becomes 8 h (28800 s), on an unmerged branch.             | `2592000`: `init.ts` says 30 days                                     |
| `vendored-cookie`       | constraint | yes  | Never edit `lib/vendored/`; a sync script overwrites it. Fix the callers.                   | edit `vendored/cookie.ts`, where `option domain is invalid` is thrown |
| `cookie-chunk-size`     | dead-end   | yes  | Lowering `CHUNK_SIZE` was tried and reverted; trim the token in the `jwt` callback instead. | lower `CHUNK_SIZE` in `lib/utils/cookie.ts`                           |
| `actions-merge-rule`    | constraint |      | Changes under `lib/actions/` need a `[core-actions]` title and @mfrost's review.            | –                                                                     |
| `magic-link-adapter`    | dead-end   |      | Verification tokens in Upstash Redis failed (eviction); tokens go through `adapter-pg`.     | –                                                                     |
| `github-org-gate`       | decision   |      | Sign-in is gated on the `acme-corp` org; scope is the defaults plus `read:org`.             | –                                                                     |
| `update-age-jwt`        | discovery  |      | The agent traces that `updateAge` only throttles database sessions, not JWT.                | –                                                                     |
| `oauth-check-ttl`       | discovery  |      | The agent finds that state/PKCE/nonce cookies live 900 s (`COOKIE_TTL` in `checks.ts`).     | –                                                                     |
| `trust-host`            | constraint |      | `trustHost` stays on behind the Host-rewriting proxy; turning it off caused INC-2291.       | –                                                                     |

Tasks 11–20, set `confirmation`, written after the first run's sanity warning that memory-off
avoided half the trap runs. Seven of the ten are traps, and each trap's code carries an obvious,
greppable default that a careful reader would take as the answer. The fact that overrides it
is stated only in session 1. Six of the seven name that fact as a `secret`; the seventh,
`iframe-same-site`, has none, because its answer, `none`, is an ordinary word. Validation checks
that session 1 states each secret and session 2 doesn't, and the dry run and every results file
check that it appears nowhere in the target checkout (`secret_check`).

| task                   | type       | trap | session 1 establishes                                                                                 | trap answer (code alone) and its evidence                                                       |
| ---------------------- | ---------- | ---- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `base-path`            | decision   | yes  | The app mounts Auth.js at `/auth/v2`; the gateway owns `/api/`.                                       | `…/api/auth/callback/github`: `config.basePath \|\|= "/api/auth"` in `next-auth/src/lib/env.ts` |
| `session-cookie-name`  | constraint | yes  | The CDN allowlists exactly `acme_sid`, set via `cookies.sessionToken.name`.                           | `authjs.session-token`: `defaultCookies` in `lib/utils/cookie.ts`                               |
| `email-sender`         | decision   | yes  | Magic links come from `login@acme.dev`; the default sender failed DMARC.                              | `no-reply@authjs.dev`: `from:` in `providers/resend.ts`                                         |
| `sign-in-theme`        | decision   | yes  | The sign-in page is `colorScheme: 'dark'`, `brandColor: #0F766E`.                                     | `colorScheme: "auto"` in `lib/init.ts`                                                          |
| `secret-env-var`       | constraint | yes  | Secrets must be `ACME_`-prefixed: the secret is `ACME_AUTH_SECRET`.                                   | `AUTH_SECRET`: `envObject.AUTH_SECRET` in `lib/utils/env.ts`                                    |
| `iframe-same-site`     | dead-end   | yes  | The default cookie broke the cross-site iframe; the session cookie uses `sameSite: 'none'`.           | `lax`: `sameSite: "lax"` in `lib/utils/cookie.ts`                                               |
| `forwarded-headers`    | dead-end   | yes  | The ingress strips forwarded headers; the fix is `AUTH_URL=https://app.acme.dev`.                     | forward `X-Forwarded-Host`: `headers.get("x-forwarded-host")` in `lib/utils/env.ts`             |
| `account-linking`      | discovery  |      | The agent finds `OAuthAccountNotLinked` in `handle-login.ts` and `allowDangerousEmailAccountLinking`. | –                                                                                               |
| `sign-in-return-value` | discovery  |      | The agent traces that a string from `signIn` redirects, in `handleAuthorized`.                        | –                                                                                               |
| `approved-providers`   | constraint |      | Legal approves only GitHub, Google and Okta; Discord was rejected.                                    | –                                                                                               |

The two discovery tasks can be recovered from the code by reading carefully, so they measure
whether memory saves the re-derivation more than whether it changes the answer. The other non-trap tasks
depend on facts that exist nowhere in the code. A test checks that every `reference` answer
passes its own criteria and that a code-only answer to each trap task fails as a trap hit.

### Arms

| Arm          | Session 1                                                                                                | Session 2                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory-off` | `grep+rig` tools                                                                                         | `grep+rig` tools, on a fresh copy of the index, so no waypoint carries over                                                                |
| `memory-on`  | `grep+rig` plus `rig_drop_waypoint` and `rig_waypoints`; the prompt adds the installed waypoint guidance | `grep+rig` plus `rig_waypoints` (with `query`), on the same database; the prompt adds the installed session-bootstrap instruction          |
| `oracle`     | not run                                                                                                  | `grep+rig`, with a hand-written summary of session 1's key facts in the prompt: an upper bound for interpretation, not part of the verdict |
| `grep-only`  | not run                                                                                                  | `rg`, `read_file` and `list_dir` only: the sanity check that the answers aren't in the code                                                |

`--arms` defaults to `memory-off,memory-on,oracle`. Add `grep-only` for the sanity check; it
runs session 2 only and is cheap. The report says whether code-only answers (`grep-only`, and
`memory-off`'s session 2) fail most trap-task runs. If they don't, the traps can be recovered
from the code and the delta says little about memory.

Every session shares one system prompt. memory-on appends the paragraphs of the installed
instructions verbatim, taken at run time from `generated/installer/claude.instructions.md`
(the "Session bootstrap" section `bun run gen` writes for every target). Session 1 gets the
paragraph that starts "Drop a waypoint via `rig_drop_waypoint` when:". Session 2 gets the one
that starts "Before responding to the user in a new conversation, call `rig_waypoints` with
`session_id="last"`". The results file records that file's hash. Tool descriptions and schemas
come from the MCP manifest, and every rig tool, the waypoint tools included, runs through the
generated handlers with contract validation, on one MCP session per agent session. The
provenance is `ai:rig-bench`. As in the other modes, the harness records no activations.

### Isolation

- The run never builds, opens or writes the shared index. It must already be current
  (`bun run bench:run --index-only`). At the start the run copies `.rig/rig.db`, and its WAL
  if one exists, into a work directory and checkpoints the copy. That copy is the snapshot. Its
  hash, node count and waypoint count go into the results file.
- Every trial opens a private copy of the snapshot. The Rig instance reads source from the
  target checkout but keeps its graph in that copy, and the copy is deleted when the trial ends.
- memory-on runs both sessions on one copy. memory-off throws session 1's copy away and gives
  session 2 a new one. oracle and grep-only run session 2 alone on a new copy.
- Session 1 and session 2 get distinct random session ids. `rig_waypoints session_id="last"`
  never resolves to the caller's own session, so with one shared id it would return nothing.
- Tests cover all of this: copies are private, the snapshot and the source don't change, no
  trial starts with an earlier trial's waypoints, memory-off opens two copies per trial, and
  session ids are distinct.

### Running

```sh
set -a; . ~/.config/rig-bench/openrouter.env; set +a
bun run bench:run --index-only                            # once, if the index isn't current
bun run bench:run --mode sessions --dry-run               # plan + cost estimate, no model call
bun run bench:run --mode sessions --arms grep-only --trials 1 --label sessions-sanity
bun run bench:run --mode sessions --task-set first --label sessions-haiku-5.5
bun run bench:report scripts/bench/results/<date>-sessions-haiku-5.5.json
```

The confirmation run covers tasks 11–20 only, with the first run's model, arms and trials (the
defaults), and is then reported together with the first run:

```sh
bun run bench:run --mode sessions --task-set confirmation --dry-run
bun run bench:run --mode sessions --task-set confirmation --label sessions-confirmation-0.3.0
bun run bench:report --in scripts/bench/results/2026-10-29-sessions-0.3.0.json \
  --in scripts/bench/results/<date>-sessions-confirmation-0.3.0.json
```

Without `--task-set` or `--tasks`, a run covers all 20 tasks.

`--tasks a,b` runs a subset. `--task-set <name>` runs only the tasks of one set: `first`
(tasks 1–10, whose entries in `sessions.json` have no `set`) or `confirmation` (tasks 11–20).
The default label then names the set. `--max-turns` counts model calls per user message, default 12.
`--work-dir` keeps the snapshot and copies in a directory you choose; by default they go to a
temporary directory that is deleted at the end. `--estimate-from` takes an earlier sessions
results file. `bench:report --recheck` re-grades stored answers against the current
`sessions.json`.

The dry-run estimate for one set (10 pairs × 3 arms × 3 trials = 90 trials, 150 sessions) on
`anthropic/claude-haiku-5.5` at $0.10 / $0.50 per M tokens is about $0.80 (~7.0M tokens) with
the assumed profiles. With `--estimate-from` the first run's per-arm means give about $0.63
(~5.3M tokens), which is what the first run cost. It assumes about 30k prompt tokens per session-1 user message and 25k
per session 2. memory-on adds its tool definitions and prompt paragraphs to every call and one
extra call per session; oracle adds its summary to every call. The grep-only sanity arm costs
about $0.03 for one trial of every task (`--trials 1`).

### Report

Per arm:

- session-2 pass rate, and trap avoidance on trap tasks;
- tokens and cost for session 1, session 2 and the total, as median and mean;
- whether session 1 dropped waypoints and how many, and whether session 2 called
  `rig_waypoints` and got session 1's waypoints back;
- errors, turn limits, and answers missing the `ANSWER:` line.

Then come the paired memory-on minus memory-off table with the bootstrap CIs, the sanity
section, a per-task table, and the verdict line against the bar at the top.

### Combined runs

`bench:report` takes several sessions results files and reports them as one:

```sh
bun run bench:report --in scripts/bench/results/2026-10-29-sessions-0.3.0.json \
  --in scripts/bench/results/<date>-sessions-confirmation-haiku-5.5.json
```

The merged report has one per-arm table, one bootstrap over every task of every run, and one
verdict line that reads "Verdict, combined (2 runs): …". The header lists each run's label,
tasks, trials, rig build and index snapshot, and flags runs whose rig fingerprints differ.
The report refuses to merge runs that differ in model, arms, trials, the bar, the target
commit, the turn limit or the answer marker, or that share a task, since a shared task's
trials would count twice. `--recheck` re-grades every run against the current
`sessions.json`.

### What it does not measure

- **Hooks or automatic memory.** Rig ships manual waypoints, so the model decides whether to
  drop one. If session 1 drops none, memory-on has nothing to load. The report shows how often
  that happens.
- **Edits.** Session 2 answers in text. It is graded on a decision, a value or a file, not on a
  patch.
- **Longer gaps.** There is one hop from session 1 to session 2, with no intervening sessions
  whose waypoints compete with it.

## Charts

`bun run bench:chart` writes three SVGs to `docs/bench/` from the results files. It makes no
network call and reads no clock, so the same results give the same bytes, and a test fails when
a committed chart is out of date (`bun run bench:chart --check` does the same). Never edit the
SVGs by hand.

| File              | What it shows                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.svg`      | Session-2 success per arm with 95% CIs, then each memory arm's paired gain over memory-off against the pre-registered +15 pp bar, and the verdict. Default model only; its sessions runs are combined as in the report.       |
| `qa-tokens.svg`   | Single-shot tokens relative to grep-only (the report's paired median ratio), per rig build and arm, for all questions and for lookup and natural-language questions apart, with each arm's correct count next to grep-only's. |
| `cross-model.svg` | Per model in `lineup.json` and the results: the memory gain with its CI, and `grep+rig` tokens relative to grep-only, grouped by price tier. A model without results shows "not run yet".                                     |

The memory CIs come from the report's two-level bootstrap (tasks, then trials; 10,000 draws,
seed 20261029); the per-arm intervals use the same procedure on one arm's pass rate. Arms and
models are read from the data, so an arm added to sessions mode gets its own rows without a
chart change, and an arm that didn't run has none. Builds in `qa-tokens.svg` are named by source
fingerprint in `charts.ts`; an unnamed build shows its version and fingerprint. Each SVG carries
a `<title>` and a `<desc>` that state every plotted number, and a
`prefers-color-scheme: dark` palette for README rendering in both themes.

## Across models

`bun run bench:matrix` runs the bench once per model, with the same flags for every model, and
labels each run `<mode>-<model-slug>`. The results file is then
`results/<date>-<mode>-<model-slug>.json`, for example
`2026-10-30-sessions-openai-gpt-6-luna.json`.

```sh
set -a; . ~/.config/rig-bench/openrouter.env; set +a
bun run bench:matrix --models lineup --mode sessions --dry-run \
  --estimate-from scripts/bench/results/2026-10-29-sessions-0.3.0.json,scripts/bench/results/2026-10-29-sessions-confirmation-0.3.0.json
bun run bench:matrix --models lineup --mode qa --arms baseline,grep+rig --budget-usd 25
bun run bench:report --by-model
bun run bench:chart
```

| Flag                                                                                | Effect                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--models a,b` / `--models lineup`                                                  | OpenRouter ids, or the eight in `lineup.json`.                                                         |
| `--mode qa\|sessions`                                                               | Single-shot queries (`bench:run`'s default mode) or the multi-session task pairs.                      |
| `--arms`, `--trials`, `--max-turns`, `--task-set`, `--tasks`, `--queries`, `--repo` | Passed to every `bench:run` unchanged. qa defaults to `baseline,grep+rig`.                             |
| `--budget-usd X`                                                                    | Required for a real run. See below.                                                                    |
| `--estimate-from FILES`                                                             | Comma-separated, or repeat the flag: earlier results whose per-arm means replace the assumed profiles. |
| `--dry-run`                                                                         | Print the per-model and total estimate, and how many models fit the budget. Runs nothing.              |
| `--reindex`                                                                         | Rebuild `results/index.json` from the results files and stop.                                          |

**Budget.** Before each model, the runner prices that model's run from OpenRouter's public
catalogue. It doesn't start the model if the actual spend so far plus that estimate would exceed
`--budget-usd`. Each child run also gets the budget that remains as `--max-spend-usd`, so a
model that costs more than its estimate stops mid-run. The runner also stops once the budget is
spent. The dry run prints a second figure, the ceiling: the same plan with every call's
completion at `max_tokens` (2,048). Reasoning models bill their thinking as completion tokens,
so the measured Haiku profiles understate them, and the truth for those models lies between the
two figures.

**Credits.** Before a real run starts, the runner reads the key's balance from
`GET https://openrouter.ai/api/v1/credits` (`total_credits` minus `total_usage`). It refuses to
start when the balance is negative or below what the run needs: the plan's total estimate, or
the budget when that is lower. The message says how much to add. The dry run prints the same
check when `OPENROUTER_API_KEY` is set. Before each model the runner reads the balance again
and stops if it no longer covers that model's estimate. If a model's run still hits a credits
error, the runner stops there, and its summary lists the models that finished, the one that
stopped and those that never ran.

**Compatibility.** A model that isn't in the catalogue, or whose catalogue entry doesn't list
`tools` among its supported parameters, stops a real run before it starts. The dry run lists
each model's tool support and reasoning default.

**Fairness.** Every model gets the same system prompt, tools, tool descriptions, arms,
queries or tasks, trials, turn limit and `max_tokens`. The harness sends no temperature,
`top_p` or reasoning setting, so each model runs at its provider's defaults. Some upstreams
don't accept a temperature at all, and reasoning is always on for some models. The manifest
writes these terms out under `fairness`. Each run records the snapshots the API resolved the
model to (`resolved_models`), and the manifest records the catalogue's dated snapshot
(`canonical_slug`).

**Manifest.** `results/index.json` lists every results file, with its mode, model, vendor,
price tier, arms, trials, resolved snapshots, rig build and spend. Its `models` list holds each
model's list prices, tier, catalogue snapshot, tool support and reasoning default. The tier
depends on the input list price: below $1.00 per million tokens is low-cost, $1.00 or more is
frontier. The runner rewrites the manifest after every model. Offline, a rebuild keeps the
prices it had.

**By model.** `bun run bench:report --by-model` prints one row per model: memory-off and
memory-on success, the delta with its CI, the token ratio, the reading against the bar, and the
single-shot `grep+rig` ratio and correctness. A model's sessions runs combine as `bench:report`
combines them: newest first, keeping each run that merges cleanly with those already kept. A
full 20-task run therefore replaces older partial runs. The bar was pre-registered for
`anthropic/claude-haiku-5.5`, so for other models the report gives a reading, not a
pre-registered verdict. For Q&A it takes the newest run with both `baseline` and `grep+rig`.

## What this benchmark does not measure

- **Latency.** Rig arms make more, smaller round trips. Wall-clock time is recorded per run
  (`elapsed_ms`) but not reported.
- **Cold start.** The time to index the target is excluded from per-query cost. The results file
  records it under `target.index`.
- **Multi-step work.** Single questions understate what waypoints and cross-session memory add
  over a long session. `--mode sessions` (above) measures the cross-session part.
- **Prompt caching.** The harness enables no caching. Every call is billed at the uncached input
  price.

## Files

- `queries.json`: the pinned target, then 16 queries with `reference` answers and `expected`
  criteria.
- `run.ts`: the CLI. It handles the plan and dry run, indexing, and the (query × trial × arm)
  loop, and writes results.
- `report.ts`: `aggregate` (pure) and `renderMarkdown`, plus the CLI.
- `providers.ts`: OpenRouter and Anthropic conversations, retry and backoff, and provider
  selection.
- `agent.ts`: the tool loop, with usage and cost summed over calls.
- `arms.ts`, `tools-baseline.ts`, `tools-rig.ts`, `tools-rig-search.ts`: the tool surfaces
  (`grep+rig` combines baseline and rig-search in `arms.ts`, and `grep+rig+map` adds the overview
  to its system prompt there).
- `criteria.ts`: expected-criteria matching. `judge.ts`: the optional LLM judge.
- `pricing.ts`, `plan.ts`: the OpenRouter catalogue and the dry-run estimate.
- `target.ts`: the rig version fingerprint and index preparation.
- `sessions.json`: the 10 task pairs of `--mode sessions`, with `oracle` summaries, `reference`
  answers, criteria with `must_not` traps, and `code_evidence`.
- `sessions.ts`: the memory arms, the installed-instruction quotes, snapshot and per-trial
  copies, and the trial loop. `sessions-run.ts`: its plan, dry run and CLI.
  `report-sessions.ts`: its aggregation, bootstrap, verdict and markdown.
- `matrix.ts`: `bench:matrix`, the per-model plan, budget guard and runs. `lineup.json`: the
  models it runs with `--models lineup`.
- `models.ts`: the results manifest, vendors and price tiers. `report-models.ts`: the by-model
  view.
- `charts.ts`, `chart-svg.ts`, `chart.ts`: `bench:chart`, the chart data, the SVG building blocks
  and the CLI.
- `results/`: one JSON file per run (`<UTC date>-<label>.json`), plus `index.json`, the
  manifest.
