# Dependency-report evaluation (research step 2)

How often is `rig_unused_deps` wrong? Step 2 of the research roadmap measures
mapping by "false positives in the dependency report". This evaluation labels
by hand every dependency the report flags as unused, on five pinned public
repos.

```sh
bun run scripts/deps-eval/flag.ts    # index each repo, write results/flags.json with grep evidence
# label every flag in results/labels.json, by the rules below
bun run scripts/deps-eval/score.ts   # write results/<date>-deps.{json,md}
```

## Pre-registration

> Dependency-report evaluation (written 2026-10-31, before any harness or run; harness at the next commit): rig at f12631f (#73), the report unchanged since A2 except that #73 counts literal `import()`/`require()`; no changes after seeing results; a revised rule is a new pre-registration and a new run.

**Corpus.** These five repos at these commits, each indexed fresh by rig (deterministic embedder):

| repo | commit |
|---|---|
| Astralchemist/rig | f12631f |
| nextauthjs/next-auth | e293b3746616660f0844347a68d09eac54b95c6f |
| honojs/hono | 17ad0e21f5a91c939eeafa3df05793a8ea60f016 |
| fastapi/fastapi | 79cab5bed28b24d92c185d236feb33f5783dfeb3 |
| encode/httpx | b5addb64f0161ff6bfe94c124ef76f6a1fba5254 |

**Sample.** Every dependency `rig_unused_deps` flags. If a repo has more than
40 flags, a seeded sample of 40 is taken (seed 20261031).

**Labels.** Each flag is labelled **used** (a false positive), **unused** (a
true positive) or **unclear**. The evidence is the harness's grep of every
tracked file except lockfiles, changelogs and the declaring manifest's
dependency lists, plus the package's own `bin` names where it has any. A flag
is **used** when any of these holds:
1. It is imported, required or loaded in a source file. That covers dynamic or
   string-based loading, type-only imports and `/// <reference types>`.
2. It is run as a command (its package name or a `bin` it ships) in
   package.json scripts, a Makefile, CI workflows or shell scripts.
3. A config file names it: tsconfig `types`, `extends` or plugins; a
   babel, eslint, prettier, vite, vitest, jest, postcss or tailwind config;
   pyproject `[tool.*]` sections; setup.cfg or tox.ini.
4. It is `@types/X` and X is used, or it holds runtime globals
   (`@types/node`, `@types/bun`) in a project with TypeScript source.
5. It is a plugin or peer that a used tool loads implicitly (an eslint
   config preset's plugins, pytest plugins found through entry points).
6. It is a library package's `peerDependencies` entry, which is the
   package's contract with its users.

When none holds, the flag is **unused**. When the evidence can't settle it,
the flag is **unclear**.

**Bar.** Precision of the report, pooled over all labelled flags:
unused / (used + unused + unclear) **≥ 80%**. An unclear flag counts against
the report.

**Reported, no bar:** precision per repo, and the false positives counted by
which rule made them used.

**Verdict.** PASS when the bar holds, otherwise FAIL.

**Disclosed:** the labeller (Claude) also wrote the report under test.
Each label is committed with its evidence, so it can be checked.
