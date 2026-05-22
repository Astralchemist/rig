import { serveMcp } from '@rig/mcp';

export async function runServe(cwd: string): Promise<void> {
  const args = process.argv.slice(3);
  if (!args.includes('--mcp')) {
    process.stderr.write(`rig: 'rig serve' requires --mcp (web mode lands Phase 2)\n`);
    process.exit(2);
  }
  await serveMcp({ projectRoot: cwd });
}
