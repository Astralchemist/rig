#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import { Rig } from '@rig/core';
import pkg from '../../../package.json' with { type: 'json' };
import { runBenchCmd } from './bench-cmd.ts';
import { runDoctor } from './doctor.ts';
import { runExportDocs } from './export-docs-cmd.ts';
import { runFiles } from './files-cmd.ts';
import { runIndex } from './index-cmd.ts';
import { runInit } from './init.ts';
import { runInstall } from './install-cmd.ts';
import { runQuery } from './query-cmd.ts';
import { runServe } from './serve-cmd.ts';
import { runStart } from './start.ts';
import { runStatus } from './status.ts';
import { runSync } from './sync-cmd.ts';
import { runUninstall } from './uninstall-cmd.ts';
import { runUpdate } from './update-cmd.ts';
import { suggestCommand } from './suggest.ts';

const COMMANDS: Record<string, (cwd: string) => void | Promise<void>> = {
  start: runStart,
  init: runInit,
  status: runStatus,
  index: runIndex,
  sync: runSync,
  query: runQuery,
  files: runFiles,
  install: runInstall,
  uninstall: runUninstall,
  serve: runServe,
  doctor: runDoctor,
  bench: runBenchCmd,
  'export-docs': runExportDocs,
  update: runUpdate,
};

const HELP = `rig — local-first semantic knowledge graph

usage: rig <command>

commands:
  start       one-shot: init + index + wire your agent + open the live map
  init        create .rig/ in the current directory
  status      report index health
  index       extract + write nodes to .rig/rig.db; skips unchanged files
              (--include / --exclude <glob>, repeatable; --force re-extracts all)
  sync        incremental update
  query       CLI search
  files       list indexed files
  install     wire Rig into Claude Code / Cursor / Codex / opencode — writes into this
              project by default; --global writes your user-level config
              (openrouter: writes a reference config only — it isn't an MCP host)
  uninstall   remove exactly what install added: <target…> | --all  [--global] [--dry-run]
  serve       start MCP and/or web server (--mcp / --web / --all [--no-auth])
  doctor      diagnose environment, db, model cache, agent configs
  bench       benchmark SQL + analytical surfaces (--fixture <N> for synthetic stress test, --json for raw)
  export-docs render waypoints as a markdown doc tree (--out <dir>, default ./docs)
  update      update rig to the latest npm release (--check to only report)
`;

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
  if (Rig.isInitialized(process.cwd())) {
    console.log(HELP);
    process.exit(0);
  }
  await runStart(process.cwd());
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
await handler(process.cwd());
