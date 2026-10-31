# Impact evaluation — INCONCLUSIVE

Pre-registered in `scripts/impact-eval/README.md`. Commits from `fd36ac5`: 105 examined, 47 scored, 10 with changed symbols the suite never runs, 3 skipped.

| measure | rig (depth 2) | file-level baseline | bar |
|---|---:|---:|---:|
| micro recall | 52.7% | 49.3% | rig ≥ 80% |
| micro precision | 27.3% | 2.1% | rig ≥ baseline + 10 pp |
| commits with an unflagged miss | 46.8% | | ≤ 20% |
| median `rig impact` text lines | 15 | | ≤ 25 |

Unbounded depth: recall 46.3%, precision 27.9%.

| commit | status | changed (executed) | predicted | observed | hit | baseline P / hit | missed |
|---|---|---:|---:|---:|---:|---:|---|
| `da71cf2` feat(web): canvas finish for the constellation, and say when | not-executed (changed symbols never executed) | 7 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `cac7b09` feat(web): rebuild the map around focused views | not-executed (changed symbols never executed) | 33 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `91961a1` feat(web): REST endpoints for the map's focused views | scored | 4 (2) | 6 | 2 | 1 | 71 / 1 | makeRequestGuard |
| `39b624c` feat(cli): rig hook and Claude Code hook install for automat | scored | 11 (6) | 4 | 3 | 2 | 11 / 0 | applyMergeJson |
| `992270b` feat(capture): store settled records as waypoints with redac | scored | 14 (8) | 14 | 12 | 6 | 349 / 8 | deriveEvents, run, attachWs, runTrial, retryWhenBusy |
| `69364b0` feat(mcp): rig_overview tool, rig://overview resource and `r | not-executed (changed symbols never executed) | 1 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `d5b8d33` feat(core): orientation map of the repository, cached and ke | scored | 2 (1) | 0 | 3 | 0 | 256 / 2 | runIndexAll, retryWhenBusy, runSync |
| `caf60a6` feat(mcp): hybrid search in rig_search, rig_context, rig_exp | scored | 8 (6) | 1 | 1 | 0 | 231 / 0 | fitSources |
| `c25b116` feat(search): hybrid search — query embedding, in-memory vec | scored | 9 (3) | 24 | 12 | 4 | 292 / 4 | dropWaypoint, upsertSkill, flush, serveWeb, runExportDocs |
| `31ca103` feat(embed): embed waypoints, skills and markdown excerpts;  | scored | 16 (10) | 38 | 11 | 3 | 175 / 2 | retryWhenBusy, init, open, serveWeb, runExportDocs |
| `d971db3` feat(search): v14 keyword index with identifier words and na | scored | 3 (3) | 2 | 7 | 1 | 87 / 3 | searchNodes, retryWhenBusy, run, run, run |
| `2f0bb5a` feat(cli): add rig export-memory and rig import-memory | scored | 3 (1) | 3 | 3 | 3 | 253 / 1 |  |
| `1c7838a` fix(core): report the real last index and sync time in statu | scored | 7 (4) | 5 | 5 | 2 | 21 / 3 | runIndexAll, retryWhenBusy, runSync |
| `735a6a0` fix(mcp): record the activations each tool's contract promis | scored | 10 (5) | 39 | 1 | 0 | 226 / 0 | fitSources |
| `359a5cf` feat(web): broadcast waypoint:dropped and node:annotated to  | scored | 2 (1) | 2 | 2 | 2 | 39 / 2 |  |
| `1481c28` fix(core): resolve session_id="last" to the latest other ses | scored | 4 (3) | 2 | 1 | 1 | 81 / 0 |  |
| `6ab3075` fix(core): keep a waypoint's rationale and check its referen | scored | 7 (2) | 9 | 1 | 1 | 227 / 0 |  |
| `784ca80` fix(core): give every write a real inverse and never fake an | scored | 6 (5) | 6 | 3 | 2 | 216 / 2 | makeRequestGuard |
| `abd0316` fix(core): step undo back through the session's history | scored | 2 (1) | 4 | 3 | 3 | 51 / 0 |  |
| `59da414` fix(core): count accepted edges as one hop in magnetic pull | scored | 1 (1) | 3 | 3 | 3 | 53 / 2 |  |
| `24eb1e4` fix(core): keep an accepted edge's kind and evidence URLs | scored | 10 (6) | 8 | 9 | 2 | 99 / 6 | registerRoutes, acceptPending, serveWeb, runIndexAll, retryWhenBusy |
| `3279619` fix(core): match a def re-typed from method to function as t | scored | 2 (2) | 2 | 5 | 2 | 22 / 5 | runIndexAll, retryWhenBusy, runSync |
| `204d5b1` fix(core): harden the watch lock and watcher against races a | scored | 8 (7) | 8 | 5 | 3 | 0 / 0 | unwatch, close |
| `8594a72` fix(core): heal a sync whose embedding failed after the grap | scored | 4 (3) | 0 | 2 | 0 | 54 / 2 | runIndexAll, runSync |
| `ef57b1c` fix(core): re-attach memory edges whose other end moved or c | scored | 4 (2) | 2 | 3 | 1 | 21 / 3 | runIndexAll, runSync |
| `025e2e3` fix(core): store extraction artifacts losslessly as JSON | scored | 2 (2) | 3 | 4 | 3 | 23 / 3 | reconcileNodes |
| `86c8ce3` fix(core): collapse duplicate ids within one extraction | scored | 1 (1) | 2 | 2 | 2 | 21 / 2 |  |
| `8fbad32` feat: keep the graph live with one file watcher per project | scored | 18 (7) | 12 | 7 | 1 | 6 / 2 | runIndexAll, runSync, makeRequestGuard, runExportDocs, guardRequests |
| `4789421` feat(core): orphan agent memory of deleted symbols and re-at | scored | 19 (9) | 11 | 2 | 2 | 18 / 1 |  |
| `566590e` fix(core): update re-extracted files in place and skip uncha | scored | 10 (6) | 4 | 1 | 0 | 20 / 1 | runSync |
| `bf6d17f` fix(core): rebuild structural edges from per-file artifacts | scored | 8 (5) | 7 | 1 | 1 | 71 / 0 |  |
| `faa78cf` fix(core): store rig_annotate notes in the annotations table | not-executed (changed symbols never executed) | 3 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `cdc30b3` fix(mcp): drop isMainSession from the uninitialised tool con | not-executed (changed symbols never executed) | 1 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `6aeb79f` fix(cli): compare the home directory by real path | scored | 4 (2) | 4 | 1 | 1 | 50 / 0 |  |
| `4b3aad3` style(cli): format the installer files with the repo's prett | scored | 5 (3) | 6 | 5 | 5 | 50 / 5 |  |
| `cb7a238` feat(cli): point out leftover user-wide wiring after a proje | scored | 4 (2) | 1 | 0 | 0 | 6 / 0 |  |
| `dddd6b4` fix(cli): uninstall finds TOML tables whose header carries a | scored | 3 (3) | 9 | 7 | 6 | 28 / 3 | applyMergeJson |
| `11931a5` fix(cli): rig doctor finds project- and user-level agent wir | not-executed (changed symbols never executed) | 3 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `e9db2a9` feat(cli): add `rig uninstall [target…\|--all] [--global] [- | scored | 1 (1) | 0 | 0 | 0 | 0 / 0 |  |
| `3e04003` fix(cli): rig's policy decides where its own permission entr | scored | 12 (10) | 2 | 2 | 2 | 15 / 1 |  |
| `c0dd0c0` fix(cli): never auto-wire OpenRouter; label its install a re | not-executed (changed symbols never executed) | 1 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `0ee9d45` feat(cli): write rig's tool policy for Codex, opencode and t | scored | 8 (5) | 3 | 2 | 2 | 12 / 1 |  |
| `1ef571e` fix(mcp): serve outside an initialised project instead of fa | scored | 3 (1) | 1 | 0 | 0 | 110 / 0 |  |
| `3341352` fix(cli): honour --path in rig serve; Cursor passes ${worksp | scored | 7 (2) | 7 | 2 | 2 | 17 / 0 |  |
| `90052d5` feat(cli): rig start wires agents at project scope and lists | not-executed (changed symbols never executed) | 2 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `d01f341` feat(cli): wire Claude Code at project scope by default; --g | scored | 13 (2) | 10 | 0 | 0 | 0 / 0 |  |
| `9898f7a` fix(cli): union-merge permission lists on re-install (#8) | scored | 3 (3) | 3 | 1 | 1 | 11 / 1 |  |
| `29d4be0` fix(mcp): cap rig_context and rig_explore responses under th | scored | 3 (3) | 0 | 0 | 0 | 0 / 0 |  |
| `286c3bc` fix(deps): match PyPI distributions to their import names (P | scored | 2 (2) | 0 | 0 | 0 | 42 / 0 |  |
| `1b3f0a5` fix(mcp): let rig_context and rig_explore run over MCP | not-executed (changed symbols never executed) | 4 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `0997737` fix(web): sign in when a pasted token is valid | not-executed (changed symbols never executed) | 1 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `2240892` fix(deps): never report Python standard-library imports as p | scored | 1 (1) | 0 | 0 | 0 | 42 / 0 |  |
| `42b426b` fix(mcp): build rig_session_token's login URL from the bound | scored | 2 (1) | 3 | 3 | 0 | 0 / 0 | makeRequestGuard, guardRequests, upgradeStatus |
| `4a5c78a` fix(web): require the session token on loopback and on /ws | scored | 10 (5) | 3 | 3 | 1 | 0 / 0 | makeRequestGuard, guardRequests |
| `f7888fa` fix(extract): capture top-level arrow and function-expressio | scored | 3 (3) | 3 | 3 | 3 | 21 / 3 |  |
| `cec4098` fix(web): refuse foreign Host and Origin on HTTP and /ws (DN | scored | 2 (2) | 3 | 0 | 0 | 0 / 0 |  |
| `bc32f9f` fix(extract): keep doc comments that sit above an export sta | scored | 1 (1) | 3 | 3 | 3 | 21 / 3 |  |
| `af95850`  | skipped (RuntimeError: Aborted(). Build with -sASSERTIONS for more info.) | 0 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `0be0cf3`  | skipped (RuntimeError: Aborted(). Build with -sASSERTIONS for more info.) | 0 (0) | 0 | 0 | 0 | 0 / 0 |  |
| `6dce84d`  | skipped (RuntimeError: Aborted(). Build with -sASSERTIONS for more info.) | 0 (0) | 0 | 0 | 0 | 0 / 0 |  |
