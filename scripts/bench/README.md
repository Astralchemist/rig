# Rig token-cost benchmark

An end-to-end comparison of tool surfaces. Each run gives the same question to the same model,
with the same system prompt and a fresh context. Only the tools differ. The harness records the
tokens and dollars each run spends, checks the answer automatically, and the report compares
every rig arm with plain grep-and-read.

## Arms

Choose arms with `--arms baseline,rig,rig-search`. All three run by default.

| Arm          | Tools                                                                                                | What it measures                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline`   | `rg`, `read_file`, `list_dir`                                                                        | An agent finding its way around a fresh repo, without artificial limits.                                                                                       |
| `rig`        | `rig_search`, `rig_node`, `rig_callers`, `rig_neighbors`, `rig_deps`, `rig_unused_deps`, `rig_files` | The original light-tier slice (`tools-rig.ts`). It calls `Rig` methods directly and uses its own descriptions.                                                 |
| `rig-search` | `rig_search`, `rig_context`, `rig_explore`, `rig_node`, `rig_callers`, `rig_neighbors`, `rig_files`  | Rig's search-facing MCP tools as an MCP client sees them: the generated handlers with contract validation, plus the manifest's descriptions and input schemas. |

`rig-search` exists to measure search changes. It copies no tool code, so a change to search, a
tool implementation or a contract shows up in the next bench run with no change to the harness.
The harness doesn't record activations, so earlier runs can't affect later ones.

The baseline arm needs ripgrep: run `brew install ripgrep`, or point `BENCH_RG` at an `rg`
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

**Anthropic** uses the Messages API with `tool_use` and `tool_result` blocks. That API doesn't
report a price, so the harness computes cost from list prices. It takes them from OpenRouter's
public model catalogue, mapping for example `claude-haiku-4-5-20251001` to
`anthropic/claude-haiku-4.5`.

Both providers retry network errors, 408, 429, 5xx and 529, and also errors OpenRouter reports
inside a 200 reply. Retries use exponential backoff with jitter: 5 attempts, starting at 1 s and
capped at 60 s. A server `Retry-After` header takes precedence. Other 4xx errors fail the run
immediately.

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
bun run bench:run --label baseline-0.2.0                # full run: 16 queries × 3 trials × 3 arms
bun run bench:report scripts/bench/results/<date>-baseline-0.2.0.json
```

Useful flags:

| Flag                                 | Effect                                                         |
| ------------------------------------ | -------------------------------------------------------------- |
| `--queries nl-csrf,routes`           | Run a subset of query ids.                                     |
| `--trials N`                         | Trials per (query, arm). Default 3.                            |
| `--arms rig-search,baseline`         | Run a subset of arms.                                          |
| `--max-turns N`                      | Model calls per run before giving up. Default 12.              |
| `--judge anthropic/claude-haiku-5.5` | Add the LLM judge.                                             |
| `--label NAME` / `--out PATH`        | Results go to `scripts/bench/results/<UTC date>-<label>.json`. |
| `--estimate-from FILE`               | Base the dry-run estimate on an earlier run's per-arm means.   |
| `--index-only` / `--fresh-index`     | Build the index and stop / force a rebuild.                    |

The harness writes the results file after every run, so an interrupted bench keeps every run it
paid for. `bench:report` prints markdown. Add `--out report.md` to write it to a file instead.

To compare two rig versions, run the bench on each branch with a distinct `--label` and read the
two reports side by side. The `rig.fingerprint` in each file shows which sources produced it.

## Cost estimates

These are `--dry-run` figures for the default plan: 16 queries × 3 trials × 3 arms = 144 runs.
They use OpenRouter list prices as of 2026-10-29 and assumed token profiles per run: baseline
~60k in / 1.5k out, `rig` ~20k / 1k, `rig-search` ~30k / 1k. After the first real run, pass
`--estimate-from` to replace the assumed profiles with measured ones.

| Model (OpenRouter id)         | $ / M in · out | Default plan |
| ----------------------------- | -------------- | -----------: |
| `anthropic/claude-haiku-5.5`  | 0.10 · 0.50    |      ≈ $0.61 |
| `anthropic/claude-haiku-4.5`  | 1.00 · 5.00    |      ≈ $6.12 |
| `anthropic/claude-sonnet-5`   | 2.00 · 10.00   |     ≈ $12.24 |
| `anthropic/claude-sonnet-5.5` | 2.00 · 10.00   |     ≈ $12.24 |
| `anthropic/claude-opus-5.5`   | 4.00 · 20.00   |     ≈ $24.48 |

For prompts over 100k tokens in a single call, Haiku 5.5 bills at its long-context tier
($0.50 / $2.50). Calls in this bench should stay below that, and both OpenRouter's reported cost
and the computed Anthropic-path cost apply the higher tier if a call crosses it. A Haiku 5.5 judge adds about $0.02 per
144 runs. The Anthropic-direct path costs the same per token as the matching OpenRouter id.

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
- A rig arm that is cheaper but wrong more often than baseline isn't a win. Read the correct &
  cheaper column first.

## What this benchmark does not measure

- **Latency.** Rig arms make more, smaller round trips. Wall-clock time is recorded per run
  (`elapsed_ms`) but not reported.
- **Cold start.** The time to index the target is excluded from per-query cost. The results file
  records it under `target.index`.
- **Multi-step work.** Single questions understate what waypoints and cross-session memory add
  over a long session.
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
- `arms.ts`, `tools-baseline.ts`, `tools-rig.ts`, `tools-rig-search.ts`: the three tool surfaces.
- `criteria.ts`: expected-criteria matching. `judge.ts`: the optional LLM judge.
- `pricing.ts`, `plan.ts`: the OpenRouter catalogue and the dry-run estimate.
- `target.ts`: the rig version fingerprint and index preparation.
- `results/`: one JSON file per run (`<UTC date>-<label>.json`).
