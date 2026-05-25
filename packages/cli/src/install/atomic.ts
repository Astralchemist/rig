// SPDX-License-Identifier: Apache-2.0
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}
