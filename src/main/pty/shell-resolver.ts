import which from 'which';
import { execSync } from 'node:child_process';

export interface ShellInfo {
  name: string;
  path: string;
}

export class ShellResolver {
  async getAvailableShells(): Promise<ShellInfo[]> {
    const shells: ShellInfo[] = [];
    const platform = process.platform;

    if (platform === 'win32') {
      // Native Windows shells
      const candidates = [
        { name: 'PowerShell 7', cmd: 'pwsh' },
        { name: 'PowerShell 5', cmd: 'powershell' },
        { name: 'Git Bash', cmd: 'bash' },
        { name: 'Command Prompt', cmd: 'cmd' },
      ];
      for (const c of candidates) {
        try {
          const resolved = await which(c.cmd);
          shells.push({ name: c.name, path: resolved });
        } catch { /* not found */ }
      }

      // WSL distributions (skip Docker-internal distros)
      try {
        const wslOutput = execSync('wsl --list --quiet', {
          encoding: 'utf-8',
          timeout: 5000,
        });
        const distros = wslOutput
          .split('\n')
          .map((l) => l.replace(/\0/g, '').trim())
          .filter((d) => d && !d.toLowerCase().startsWith('docker-'));
        for (const distro of distros) {
          shells.push({ name: `WSL: ${distro}`, path: `wsl -d ${distro}` });
        }
      } catch { /* WSL not available */ }
    } else if (platform === 'darwin') {
      // macOS
      const candidates = [
        { name: 'zsh', cmd: 'zsh' },
        { name: 'bash', cmd: 'bash' },
        { name: 'fish', cmd: 'fish' },
        { name: 'nushell', cmd: 'nu' },
        { name: 'sh', cmd: 'sh' },
      ];
      for (const c of candidates) {
        try {
          const resolved = await which(c.cmd);
          shells.push({ name: c.name, path: resolved });
        } catch { /* not found */ }
      }
    } else {
      // Linux
      const candidates = [
        { name: 'bash', cmd: 'bash' },
        { name: 'zsh', cmd: 'zsh' },
        { name: 'fish', cmd: 'fish' },
        { name: 'dash', cmd: 'dash' },
        { name: 'nushell', cmd: 'nu' },
        { name: 'ksh', cmd: 'ksh' },
        { name: 'sh', cmd: 'sh' },
      ];
      for (const c of candidates) {
        try {
          const resolved = await which(c.cmd);
          shells.push({ name: c.name, path: resolved });
        } catch { /* not found */ }
      }
    }

    return shells;
  }

  async getDefaultShell(): Promise<string> {
    const platform = process.platform;

    if (platform === 'win32') {
      // Prefer pwsh > powershell > bash > cmd
      for (const cmd of ['pwsh', 'powershell', 'bash', 'cmd']) {
        try {
          return await which(cmd);
        } catch { /* not found */ }
      }
      return 'cmd.exe';
    }

    // Unix/macOS: use $SHELL
    const envShell = process.env.SHELL;
    if (envShell) return envShell;

    // macOS defaults to zsh, Linux to bash
    const fallback = platform === 'darwin' ? 'zsh' : 'bash';
    try {
      return await which(fallback);
    } catch {
      return '/bin/sh';
    }
  }
}
