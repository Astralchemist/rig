#!/usr/bin/env bun
import { runIndex } from './index-cmd.ts';
import { runInit } from './init.ts';
import { runInstall } from './install-cmd.ts';
import { runServe } from './serve-cmd.ts';
import { runStatus } from './status.ts';

const NOT_YET = (phase: string) => (): void => {
  console.error(`rig: this command is not implemented yet (lands in Phase ${phase})`);
  process.exit(2);
};

const COMMANDS: Record<string, (cwd: string) => void | Promise<void>> = {
  init: runInit,
  status: runStatus,
  index: runIndex,
  sync: NOT_YET('1'),
  query: NOT_YET('1'),
  files: NOT_YET('1'),
  install: runInstall,
  serve: runServe,
};

const HELP = `rig — local-first semantic knowledge graph

usage: rig <command>

commands:
  init        create .rig/ in the current directory
  status      report index health
  index       extract + write nodes to .rig/rig.db
  sync        (Phase 1) incremental update
  query       (Phase 1) CLI search
  files       (Phase 1) list indexed files
  install     (Phase 1) wire Rig into Claude Code / Cursor / Codex / opencode
  serve       (Phase 1/2) start MCP and/or web server
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
