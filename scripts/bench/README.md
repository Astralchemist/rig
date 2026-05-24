# Rig vs baseline — token-cost benchmark

End-to-end comparison: same query, same model, two tool surfaces.
- **Baseline**: `rg`, `read_file`, `list_dir`. The agent grep-and-reads its way to an answer.
- **Rig**: `rig_search`, `rig_node`, `rig_callers`, `rig_neighbors`, `rig_deps`, `rig_unused_deps`, `rig_files`. Indexed graph navigation.

Both paths use the same model, same system prompt, same temperature defaults, fresh context per query.
Total = `input_tokens + output_tokens` across all turns of the agent loop, including tool result echoes.

## Methodology

1. **Target**: a real codebase in the 20–50k node range. Default suggestion: `nextauthjs/next-auth` (Auth.js v5).
2. **Setup** (once):
   ```
   git clone https://github.com/nextauthjs/next-auth ~/code/next-auth
   cd ~/code/next-auth && bun install
   rig init && rig index
   ```
3. **Run**:
   ```
   export ANTHROPIC_API_KEY=sk-ant-…
   bun scripts/bench/run.ts --repo ~/code/next-auth --trials 3
   bun scripts/bench/report.ts --in scripts/bench/results.json
   ```
4. **Judge**: the report ends with the agent's final answer per query × path. Read both, decide whether they answered correctly. The token table is only meaningful for queries both paths answered correctly.

## Tools given to each side (fair comparison)

The baseline gets the tools a real agent would use to navigate a fresh repo —
ripgrep, read, list. No artificial crippling. The Rig path gets the 7 light-tier
tools that map to the question shapes in `queries.json`; we don't load all 25+ Rig
tools to avoid bloating the system prompt with options the agent wouldn't reach for.

## Cost estimate

10 queries × 3 trials × 2 paths = 60 agent runs. Median run ≈ 50k tokens at the
baseline path (file content dumps), maybe 5k at the Rig path. Total ≈ 1–2M input
tokens. At Sonnet 4.6 pricing that's roughly $5–10.

## What the numbers mean

| Median ratio (rig / baseline) | Read |
|---|---|
| ≤ 15% | Cost claim is real. F1 (HNSW) becomes the next priority; build a public benchmark page. |
| 30–60% | Interesting but not headline. Pivot Rig to the audit-workspace product; cost is one feature among many. |
| > 60% or wildly inconsistent | The value isn't where the marketing has been pointing. Reset the pitch. |

## What this benchmark does NOT measure

- **Correctness quality.** A 5×-cheaper answer that's wrong is worse, not better.
  Judging is left to the reader for that reason.
- **Latency.** The Rig path makes ~5–10x more round-trips through smaller tools.
  Wall-clock could be slower even at lower tokens.
- **Cold-start cost.** Initial `rig index` of NextAuth takes a few seconds —
  excluded from the per-query measure on purpose, but real when amortized across
  the first query.
- **Multi-step task value.** Single-shot Q&A understates how much waypoints +
  cross-session retrieval help over a long session.

## Reproducibility

- The model defaults to `claude-sonnet-4-5-20250929`. Override with
  `BENCH_MODEL=claude-opus-4-5-20250929`.
- Run on the same commit of the target repo. Different commits change indexed nodes.
- Trials run sequentially; no parallelism, no caching tricks.

## Files

- `queries.json` — 10 user-shaped queries plus per-query expected-winner hypotheses (mine; check them).
- `tools-baseline.ts` — fair tools for the grep-and-read path.
- `tools-rig.ts` — the 7 Rig tools the queries plausibly need.
- `run.ts` — orchestrator + agent loop.
- `report.ts` — markdown table + answer listing.
