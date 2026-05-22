import { Rig } from '@rig/core';

const flag = (name: string): boolean => process.argv.includes(name);
const optionValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

export async function runFiles(cwd: string): Promise<void> {
  const filter = optionValue('--filter');
  const rig = await Rig.open(cwd);
  try {
    const files = rig.getFiles(filter);
    if (flag('--json')) {
      process.stdout.write(JSON.stringify(files, null, 2) + '\n');
    } else {
      for (const f of files) {
        process.stdout.write(`${String(f.node_count).padStart(5)}  ${f.path}\n`);
      }
      process.stderr.write(`${files.length} file(s)\n`);
    }
  } finally {
    rig.close();
  }
}
