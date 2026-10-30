import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface State {
  url: string;
  loginUrl: string;
  token: string;
  projectRoot: string;
  srcId: string;
  dstId: string;
  pendingId: number;
  pendingId2: number;
  pendingId3: number;
  waypointId: string;
  logoutId: string;
}

export const readState = (): State => {
  const raw = readFileSync(resolve(HERE, '.state.json'), 'utf-8');
  return JSON.parse(raw) as State;
};
