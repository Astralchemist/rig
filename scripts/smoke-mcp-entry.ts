import { serveMcp } from '@rig/mcp';

const projectRoot = process.argv[2];
if (!projectRoot) {
  process.stderr.write('usage: smoke-mcp-entry <projectRoot>\n');
  process.exit(2);
}
await serveMcp({ projectRoot });
