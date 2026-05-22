import { serveMcp } from '@rig/mcp';
import { serveWeb } from '@rig/web';

const flag = (name: string): boolean => process.argv.includes(name);
const optionValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

export async function runServe(cwd: string): Promise<void> {
  const wantAll = flag('--all');
  const wantMcp = flag('--mcp') || wantAll;
  const wantWeb = flag('--web') || wantAll;

  if (!wantMcp && !wantWeb) {
    process.stderr.write(`rig: 'rig serve' requires --mcp, --web, or --all\n`);
    process.exit(2);
  }

  const portStr = optionValue('--port');
  const port = portStr ? Number.parseInt(portStr, 10) : undefined;
  const host = optionValue('--host');

  let webHandle: { close: () => Promise<void> } | null = null;
  if (wantWeb) {
    const handle = await serveWeb({
      projectRoot: cwd,
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
    });
    webHandle = handle;
    // stderr — stdout may be MCP JSON-RPC when --all is set.
    process.stderr.write(`rig web listening on ${handle.url}\n`);
  }

  const shutdown = async (): Promise<never> => {
    if (webHandle) await webHandle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (wantMcp) {
    // Blocks on stdin. Stays alongside the web server until both close.
    await serveMcp({ projectRoot: cwd });
    return;
  }

  // Web-only: keep the event loop alive explicitly. Bun has been observed to
  // exit when the main promise resolves even with a listening socket, and we
  // also want to swallow stray SIGPIPE from disconnected tail pipes.
  process.on('SIGPIPE', () => {});
  await new Promise<void>(() => {});
}
