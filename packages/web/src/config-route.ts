import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// UI preferences that follow the project. Stored alongside the index so opening
// the same .rig/ anywhere restores the chosen theme. Kept permissive — unknown
// keys are preserved on write so future prefs don't clobber each other.
type Config = Record<string, unknown> & { theme?: string };

const read = (file: string): Config => {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Config;
  } catch {
    return {};
  }
};

export const registerConfigRoutes = (app: FastifyInstance, projectRoot: string): void => {
  const file = join(projectRoot, '.rig', 'config.json');

  app.get('/api/config', async () => read(file));

  app.put<{ Body: Partial<Config> }>('/api/config', async (req) => {
    const next = { ...read(file), ...(req.body ?? {}) };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
};
