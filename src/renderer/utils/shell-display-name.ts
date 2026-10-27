import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';

/**
 * Converts a shell path (e.g. `C:\...\powershell.exe`) or WSL command
 * (`wsl -d Ubuntu`) into a friendly display name that mirrors the
 * conventions from ShellResolver.getAvailableShells(). Shell names stay as
 * written; only "Unknown" and Windows' "Command Prompt" translate.
 */
export function shellDisplayName(shellPath: string | undefined | null): string {
  if (!shellPath) return i18n._(msg`Unknown`);

  // WSL distributions: "wsl -d <distro>"
  const wslMatch = shellPath.match(/^wsl\s+-d\s+(.+)/i);
  if (wslMatch) return `WSL: ${wslMatch[1].trim()}`;

  // Extract basename and strip .exe
  const basename = shellPath.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? '';

  // navigator.platform is deprecated in browsers but reliable in Electron
  // (always reflects the host OS, not spoofed by user-agent overrides).
  const isWindows = navigator.platform.startsWith('Win');

  const nameMap: Record<string, string> = {
    pwsh: 'PowerShell 7',
    powershell: 'PowerShell 5',
    cmd: i18n._(msg`Command Prompt`),
    bash: isWindows ? 'Git Bash' : 'bash',
    zsh: 'zsh',
    fish: 'fish',
    nu: 'nushell',
    dash: 'dash',
    ksh: 'ksh',
    sh: 'sh',
  };

  return nameMap[basename] ?? (basename || i18n._(msg`Unknown`));
}
