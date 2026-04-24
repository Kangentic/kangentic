import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Well-known install locations for agent CLIs on macOS/Linux, used when
 * `which(<name>)` fails because Electron inherited a minimal PATH from
 * launchd/GNOME/KDE (the GUI launch case).
 *
 * The order matters: first match wins in AgentDetector. We put the
 * most common/standard locations first so detection is fast.
 *
 * Windows does not need these fallbacks - Windows inherits the user
 * PATH from the registry regardless of launch context.
 *
 * This is defense-in-depth: the primary fix is restoreShellEnv() which
 * restores the user's full shell PATH at app startup. These fallbacks
 * only matter if that fails (shell rc hung, user set
 * KANGENTIC_SHELL_ENV=off, or binary is in a location the user didn't
 * export in their rc).
 */
export function standardUnixFallbackPaths(binaryName: string): string[] {
  if (process.platform === 'win32') return [];

  const home = os.homedir();
  const candidates: string[] = [
    // Homebrew (most common macOS install target for CLIs)
    path.join('/opt/homebrew/bin', binaryName),            // Apple Silicon
    path.join('/usr/local/bin', binaryName),               // Intel Mac / manual installs / default npm -g prefix
    path.join('/home/linuxbrew/.linuxbrew/bin', binaryName), // Linuxbrew

    // Node version managers / alternative package managers
    path.join(home, '.npm-global', 'bin', binaryName),     // Custom npm prefix (~/.npmrc: prefix=~/.npm-global)
    path.join(home, '.volta', 'bin', binaryName),          // Volta (modern Node version manager)
    path.join(home, '.bun', 'bin', binaryName),            // Bun

    // Python-based agents (Aider)
    path.join(home, '.local', 'bin', binaryName),          // pip --user, pipx

    // Language toolchain bin dirs
    path.join(home, '.cargo', 'bin', binaryName),          // Rust (cargo install)

    // Legacy user bin
    path.join(home, 'bin', binaryName),
  ];

  // nvm installs Node per-version at ~/.nvm/versions/node/<version>/bin/.
  // Enumerate whatever versions exist at startup and add the binary path
  // for each. If the user installs a new Node version after app start,
  // a restart picks it up; that is acceptable (and the primary shell-env
  // path would catch the nvm-activated version anyway).
  candidates.push(...enumerateNvmPaths(home, binaryName));

  return candidates;
}

function enumerateNvmPaths(home: string, binaryName: string): string[] {
  const nvmNodeDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    if (!fs.existsSync(nvmNodeDir)) return [];
    const versions = fs.readdirSync(nvmNodeDir);
    return versions.map((version) => path.join(nvmNodeDir, version, 'bin', binaryName));
  } catch {
    return [];
  }
}
