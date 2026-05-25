// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Best-effort "open this URL in the default browser" across macOS, Windows,
// Linux, and WSL. Always non-fatal — the caller still prints the URL, so a
// headless box or a missing opener just means the user clicks the link.
export const openUrl = (url: string): void => {
  const launch = (cmd: string, args: string[]): boolean => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  };

  if (process.platform === 'darwin') return void launch('open', [url]);
  if (process.platform === 'win32') return void launch('cmd', ['/c', 'start', '', url]);
  // WSL: no display, but the Windows host can open it.
  if (existsSync('/proc/sys/kernel/osrelease') && process.env.WSL_DISTRO_NAME) {
    if (launch('wslview', [url])) return;
    return void launch('cmd.exe', ['/c', 'start', '', url]);
  }
  void launch('xdg-open', [url]);
};
