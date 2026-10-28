// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RIG_DIR_NAME } from './rig-types.ts';

// Where the web server last bound. Ports are per project (.rig/config.json) and
// `rig serve` walks forward past a busy one, so readers such as
// rig_session_token can't assume a fixed port. Kept beside .rig/.runtime rather
// than inside it: that file stays a bare bearer token, which is what
// `cat .rig/.runtime` and older rig versions expect.
export const WEB_ADDRESS_FILE = '.web.json';

export interface WebAddress {
  host: string;
  port: number;
}

const addressPath = (projectRoot: string): string =>
  join(projectRoot, RIG_DIR_NAME, WEB_ADDRESS_FILE);

// Best-effort: failing to record the address must not stop the server.
export const writeWebAddress = (projectRoot: string, address: WebAddress): void => {
  try {
    writeFileSync(addressPath(projectRoot), `${JSON.stringify(address)}\n`);
  } catch {
    // Unwritable .rig/ — readers fall back to their defaults.
  }
};

// null when no server has recorded an address, or the record is unreadable.
export const readWebAddress = (projectRoot: string): WebAddress | null => {
  try {
    const raw = JSON.parse(readFileSync(addressPath(projectRoot), 'utf-8')) as Partial<WebAddress>;
    const { host, port } = raw;
    if (typeof host !== 'string' || !host) return null;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
};
