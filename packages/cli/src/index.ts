#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import pkg from '../../../package.json' with { type: 'json' };
import { suggestCommand } from './suggest.ts';

type Command = (cwd: string) => void | Promise<void>;

// Commands load on use: `rig hook` runs on every prompt and tool call, and
// must not pay for the graph, the parsers and the servers on each start.
const COMMANDS: Record<string, () => Promise<Command>> = {
  start: async () => (await import('./start.ts')).runStart,
  init: async () => (await import('./init.ts')).runInit,
  status: async () => (await import('./status.ts')).runStatus,
  index: async () => (await import('./index-cmd.ts')).runIndex,
  sync: async () => (await import('./sync-cmd.ts')).runSync,
  query: async () => (await import('./query-cmd.ts')).runQuery,
  impact: async () => (await import('./impact-cmd.ts')).runImpact,
  files: async () => (await import('./files-cmd.ts')).runFiles,
  overview: async () => (await import('./overview-cmd.ts')).runOverview,
  install: async () => (await import('./install-cmd.ts')).runInstall,
  uninstall: async () => (await import('./uninstall-cmd.ts')).runUninstall,
  serve: async () => (await import('./serve-cmd.ts')).runServe,
  doctor: async () => (await import('./doctor.ts')).runDoctor,
  bench: async () => (await import('./bench-cmd.ts')).runBenchCmd,
  'export-docs': async () => (await import('./export-docs-cmd.ts')).runExportDocs,
  'export-memory': async () => (await import('./memory-cmd.ts')).runExportMemory,
  'import-memory': async () => (await import('./memory-cmd.ts')).runImportMemory,
  update: async () => (await import('./update-cmd.ts')).runUpdate,
  hook: async () => (await import('./hook-cmd.ts')).runHook,
};

const HELP = `rig — local-first semantic knowledge graph

usage: rig <command>

commands:
  start       one-shot: init + index + wire your agent + open the live map (--no-watch,
              --no-hooks)
  init        create .rig/ in the current directory
  status      report index health
  index       extract + write nodes to .rig/rig.db; skips unchanged files
              (--include / --exclude <glob>, repeatable; --force re-extracts all)
  sync        incremental update
  query       CLI search
  impact      what a change can break, and which recorded decisions it may invalidate:
              <symbol|id> or --diff [<base>[...<head>]] (default: working tree vs HEAD)
              [--depth <n>, default 2] [--format text|json|mermaid|comment] [--max-nodes <n>]
              [--no-sync]
  files       list indexed files
  overview    print the orientation map your agent gets from rig_overview
              (--budget <tokens>, default 2000; --json)
  install     wire Rig into Claude Code / Cursor / Codex / opencode — writes into this
              project by default; --global writes your user-level config; for Claude
              Code also the automatic-capture hooks (--no-hooks to leave them out)
              (openrouter: writes a reference config only — it isn't an MCP host)
  uninstall   remove exactly what install added: <target…> | --all  [--global] [--dry-run]
  serve       start MCP and/or web server (--mcp / --web / --all [--no-auth] [--no-watch])
  doctor      diagnose environment, db, model cache, agent configs
  bench       benchmark SQL + analytical surfaces (--fixture <N> for synthetic stress test, --json for raw)
  export-docs render waypoints as a markdown doc tree (--out <dir>, default ./docs)
  export-memory
              save agent memory (aliases, notes, proposed and accepted links, promotions,
              waypoints, sessions, orphans) as JSONL that survives losing .rig/
              (--out <file>, default .rig/exports/memory-<UTC time>.jsonl). It can contain
              conversation-derived text (waypoint summaries and payloads): you decide
              whether to commit it
  import-memory <file>
              merge an export back in, e.g. after a fresh clone + \`rig index\`. Adds what is
              missing, never overwrites what is there; memory of symbols not found waits in
              orphans until they are indexed
  update      update rig to the latest npm release (--check to only report)
  hook        <event> [--client claude] — run by your agent's hooks: captures what a
              conversation settled (decisions, constraints, dead ends) into .rig/ and
              briefs the next session. Installed by \`rig install claude\` (--no-hooks to skip)
`;

// `--no-watch` on any long-running command (serve, start) disables the live
// file watcher; watch-policy.ts reads it from the environment.
if (process.argv.includes('--no-watch')) process.env.RIG_NO_WATCH = '1';

const [, , cmd] = process.argv;
if (cmd === '-v' || cmd === '--version' || cmd === 'version') {
  console.log((pkg as { version: string }).version);
  process.exit(0);
}
if (cmd === '-h' || cmd === '--help') {
  console.log(HELP);
  process.exit(0);
}
// Bare `rig` / `bunx rig`: on a fresh project, run the one-shot onboarding;
// on an already-set-up project, show help rather than silently re-indexing.
if (!cmd) {
  const { Rig } = await import('@rig/core');
  if (Rig.isInitialized(process.cwd())) {
    console.log(HELP);
    process.exit(0);
  }
  await (
    await COMMANDS.start!()
  )(process.cwd());
  process.exit(0);
}

const handler = COMMANDS[cmd];
if (!handler) {
  const hint = suggestCommand(cmd, Object.keys(COMMANDS));
  console.error(
    `rig: unknown command '${cmd}'.${hint ? ` Did you mean \`rig ${hint}\`?` : ''} Try \`rig --help\`.`,
  );
  process.exit(2);
}
await (
  await handler()
)(process.cwd());
