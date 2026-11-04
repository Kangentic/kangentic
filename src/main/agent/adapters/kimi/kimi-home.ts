import os from 'node:os';
import path from 'node:path';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';

/**
 * Where Kimi Code CLI keeps its data.
 *
 * Source: Kimi Code CLI 2.4.1 docs, `en/configuration/data-locations.md`
 * and `en/configuration/env-vars.md` (github.com/MoonshotAI/kimi-code,
 * read 2026-11-03). The data root is `$KIMI_CODE_HOME`, else `~/.kimi-code`,
 * and it holds `config.toml`, `credentials/`, `session_index.jsonl` and
 * `sessions/<workspaceId>/<sessionId>/`. Built from the docs, not yet checked
 * against a real install.
 *
 * A Kimi Code installed in a WSL distro (`place`) keeps its data in the
 * distro's home, under the `KIMI_CODE_HOME` its own shell sets, reached
 * through the distro's share. Read per call, so a changed variable is not
 * shadowed by a value captured at import.
 */
export function kimiCodeHome(place: CliPlace | null = null): string {
  // A Kimi on an SSH host keeps its data on the host. The copy of its config the adapter edits is in the
  // host's home mirror on this computer (#913).
  if (place?.kind === 'ssh') return path.join(place.localHome, '.kimi-code');
  if (place) {
    const override = place.facts.env.KIMI_CODE_HOME?.trim();
    const linuxPath = override === '~' || override?.startsWith('~/') ? `${place.facts.homeLinux}${override.slice(1)}` : override;
    return linuxPath?.startsWith('/') ? hostPathForTarget(linuxPath, place) : path.join(place.facts.homeUnc, '.kimi-code');
  }
  const override = process.env.KIMI_CODE_HOME?.trim();
  if (override) {
    const expanded = override === '~' || /^~[\\/]/.test(override) ? path.join(os.homedir(), override.slice(1)) : override;
    if (path.isAbsolute(expanded)) return expanded;
  }
  return path.join(os.homedir(), '.kimi-code');
}

/** `<home>/session_index.jsonl`: one `{sessionId, sessionDir, workDir}` line per session. */
export function kimiSessionIndexPath(place: CliPlace | null = null): string {
  return path.join(kimiCodeHome(place), 'session_index.jsonl');
}

/** `<home>/config.toml`, the user configuration (models, providers). */
export function kimiConfigPath(place: CliPlace | null = null): string {
  return path.join(kimiCodeHome(place), 'config.toml');
}

/** `<home>/credentials/`, where `/login` writes `<name>.json`. */
export function kimiCredentialsDir(place: CliPlace | null = null): string {
  return path.join(kimiCodeHome(place), 'credentials');
}

/** The main agent's history inside a session folder (`data-locations.md`). */
export function kimiMainWirePath(sessionDir: string): string {
  return path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

/**
 * A working-directory path as the CLI compares it: forward slashes, no trailing
 * slash, and lower case for a Windows-shaped path (`workspaceRootKey` in
 * `packages/agent-core-v2/src/_base/utils/workdir-slug.ts`, 2.4.1).
 */
export function kimiWorkDirCompareKey(root: string): string {
  const slashed = root.replaceAll('\\', '/');
  const windowsShaped = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(slashed);
  const normalized = slashed.replace(/\/+$/, '');
  return windowsShaped ? normalized.toLowerCase() : normalized;
}
