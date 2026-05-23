#!/usr/bin/env bun
import { runDoctor } from './doctor.ts';
import { runFiles } from './files-cmd.ts';
import { runIndex } from './index-cmd.ts';
import { runInit } from './init.ts';
import { runInstall } from './install-cmd.ts';
import { runQuery } from './query-cmd.ts';
import { runServe } from './serve-cmd.ts';
import { runStatus } from './status.ts';
import { runSync } from './sync-cmd.ts';

const COMMANDS: Record<string, (cwd: string) => void | Promise<void>> = {
  init: runInit,
  status: runStatus,
  index: runIndex,
  sync: runSync,
  query: runQuery,
  files: runFiles,
  install: runInstall,
  serve: runServe,
  doctor: runDoctor,
};

const HELP = `rig — local-first semantic knowledge graph

usage: rig <command>

commands:
  init        create .rig/ in the current directory
  status      report index health
  index       extract + write nodes to .rig/rig.db
  sync        incremental update
  query       CLI search
  files       list indexed files
  install     wire Rig into Claude Code / Cursor / Codex / opencode / openrouter
  serve       start MCP and/or web server (--mcp / --web / --all [--auth])
  doctor      diagnose environment, db, model cache, agent configs
`;

const [, , cmd] = process.argv;
if (!cmd || cmd === '-h' || cmd === '--help') {
  console.log(HELP);
  process.exit(0);
}

const handler = COMMANDS[cmd];
if (!handler) {
  console.error(`rig: unknown command '${cmd}'. Try \`rig --help\`.`);
  process.exit(2);
}
await handler(process.cwd());
