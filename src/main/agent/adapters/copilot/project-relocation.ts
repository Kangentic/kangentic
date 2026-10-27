import * as fs from 'node:fs';
import * as path from 'node:path';
import { replacePathPrefix } from '../../../../shared/paths';
import { atomicWriteFileWithBackup } from '../../shared/relocation-utils';
import { copilotHomeDir } from './copilot-home';

/**
 * Migrate GitHub Copilot CLI's per-session working directory when a Kangentic
 * project is relocated.
 *
 * Copilot persists each session under `~/.copilot/session-state/<uuid>/` with a
 * `workspace.yaml` recording `cwd` and `git_root`. `copilot --session-id <id>`
 * (and `--resume <id>`) still attaches by id after a move, but v1.0.52+ restores the session in its
 * SAVED working directory, so a stale `cwd` makes resume reopen a dead path.
 * Rewriting the `cwd` / `git_root` lines in each affected `workspace.yaml`
 * points resume back at the moved project. One prefix pass over every session
 * file covers the project root and every worktree.
 *
 * Best-effort and version-fragile (the YAML schema is undocumented and the
 * `~/.copilot/session-store.db` cache that also feeds session pickers cannot be
 * safely edited, so picker/search residue is accepted). Per-session files are
 * written atomically (temp + rename) with no backup; every file is independently
 * guarded so a partial failure never blocks relocation.
 */
export async function migrateCopilotProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  const oldResolved = path.resolve(oldProjectPath);
  const newResolved = path.resolve(newProjectPath);

  const sessionStateRoot = path.join(copilotHomeDir(), 'session-state');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionStateRoot, { withFileTypes: true });
  } catch {
    return; // No session-state directory: nothing to migrate.
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceYaml = path.join(sessionStateRoot, entry.name, 'workspace.yaml');
    try {
      rewriteWorkspaceYaml(workspaceYaml, oldResolved, newResolved);
    } catch (err) {
      console.warn(`[COPILOT_RELOCATE] Failed to migrate ${workspaceYaml}:`, err);
    }
  }
}

// `cwd: <value>` / `git_root: <value>` scalar lines, capturing indent, key,
// inter-spacing, value, and trailing whitespace / CR so they round-trip exactly.
const PATH_LINE = /^(\s*)(cwd|git_root):(\s*)(.*?)(\s*\r?)$/;

function rewriteWorkspaceYaml(filePath: string, oldResolved: string, newResolved: string): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return; // No workspace.yaml for this session.
  }

  let changed = false;
  const rewrittenLines = content.split('\n').map((line) => {
    const match = PATH_LINE.exec(line);
    if (!match) return line;

    const [, indent, key, gap, rawValue, trailing] = match;
    const { value, quote } = stripQuotes(rawValue);
    if (value === '') return line;

    const rewritten = replacePathPrefix(value, oldResolved, newResolved);
    if (!rewritten || rewritten === value) return line;

    changed = true;
    return `${indent}${key}:${gap}${quote}${rewritten}${quote}${trailing}`;
  });

  if (!changed) return;

  // No backup by design: per-session files are disposable picker metadata, and a
  // failed write degrades to stale resume cwd (status quo), not data loss.
  atomicWriteFileWithBackup(filePath, rewrittenLines.join('\n'), { backup: false, logTag: '[COPILOT_RELOCATE]' });
}

/** Strip a single matching pair of surrounding quotes, remembering the style. */
function stripQuotes(raw: string): { value: string; quote: string } {
  if (raw.length >= 2) {
    const first = raw[0];
    if ((first === '"' || first === "'") && raw[raw.length - 1] === first) {
      return { value: raw.slice(1, -1), quote: first };
    }
  }
  return { value: raw, quote: '' };
}
