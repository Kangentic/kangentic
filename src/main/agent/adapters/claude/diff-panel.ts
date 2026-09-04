import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withClaudeJsonLock } from './trust-manager';
import { atomicWriteFileWithBackup } from '../../shared/relocation-utils';

const LOG_TAG = '[CLAUDE_DIFF_PANEL]';

/**
 * Keep Claude Code's fullscreen diff panel closed at launch for Kangentic-spawned sessions.
 *
 * Claude Code 2.1.260 opens a diff panel beside the conversation in the fullscreen renderer,
 * taking the right `min(floor(columns * 0.45), 90, columns - 70)` columns. The two panes share
 * physical rows, so every line-oriented scrollback parse (activity detection, TUI anchors,
 * repaint signatures) reads transcript bytes and diff bytes spliced into one line, and the panel
 * duplicates the task window's own Changes tab.
 *
 * Read out of the 2.1.260 binary: the auto-open gate is `columns >= (diffSidebarOpen === true
 * ? 110 : 144)` plus the fullscreen renderer, a git cwd, and the conversation tab focused;
 * `diffSidebarOpen === false` never auto-opens. The key lives ONLY in the global `~/.claude.json`
 * (the same key list as `theme`, `diffTool`, `verbose`). It is not in the settings.json schema,
 * so the per-session `--settings` file cannot carry it, and there is no CLI flag or env var for
 * it. The per-spawn levers that do exist (`tui: "default"`, CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN)
 * all work by turning fullscreen off, which brings back the scrollback duplication fullscreen was
 * adopted to fix, and CLAUDE_CONFIG_DIR relocates auth and transcripts. So the write lands in the
 * same global file trust-manager already read-modify-writes before every spawn, under its lock.
 *
 * Why before EVERY spawn rather than once: the key is remembered-last-state in one global slot.
 * Opening the panel anywhere (`/diff`) writes `true`, so with several task windows running, one
 * window's `/diff` would auto-open the panel in every later spawn. Writing `false` per spawn makes
 * every Kangentic session start closed. `/diff` inside a session still opens it (that path checks
 * only the git cwd and `columns >= 110`), so it stays the per-session opt-in. Idempotent: an
 * already-`false` key costs one read and no write.
 */
export async function ensureDiffPanelClosed(): Promise<void> {
  return withClaudeJsonLock(() => ensureDiffPanelClosedSync());
}

function ensureDiffPanelClosedSync(): void {
  // Never let this block a spawn: the panel opening once is cosmetic.
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');

    let raw: string | null;
    try {
      raw = fs.readFileSync(claudeJsonPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`${LOG_TAG} Could not read ${claudeJsonPath}; leaving it untouched:`, error);
        return;
      }
      raw = null;
    }

    let data: Record<string, unknown>;
    if (raw === null) {
      // A missing file cannot be wiped, so create it the way trust-manager does.
      data = {};
    } else {
      // Unlike trust-manager's `catch { data = {} }`, an unreadable file is left alone rather
      // than replaced. ~/.claude.json holds the user's auth and MCP state, and a torn read (the
      // CLI mid-write) must never be overwritten with `{ diffSidebarOpen: false }`.
      //
      // Scope of that guard: it stops THIS write from compounding the damage. It is not a
      // property of `ensureTrust()` as a whole. `ensureWorktreeTrust` and `ensureMcpServerTrust`
      // run first in `ClaudeAdapter.ensureTrust`, and both still fall back to `data = {}` on a
      // parse failure and write that back, so on a torn file the other keys are already gone by
      // the time this runs. Giving those two the same policy is a change to trust-manager.ts.
      const parsed = parseObject(raw);
      if (parsed === null) {
        console.warn(`${LOG_TAG} ${claudeJsonPath} is not a JSON object; leaving it untouched`);
        return;
      }
      data = parsed;
    }

    if (data.diffSidebarOpen === false) return;

    data.diffSidebarOpen = false;
    // Temp file + rename, so the CLI never sees a torn file. No `.kangentic-backup`
    // copy: this runs after every `/diff` anywhere, the file is over a megabyte, and
    // a backup taken from the same read cannot recover anything the rename loses.
    atomicWriteFileWithBackup(claudeJsonPath, JSON.stringify(data, null, 2), {
      backup: false,
      logTag: LOG_TAG,
    });
  } catch (error) {
    console.warn(`${LOG_TAG} Failed to close the diff panel preference:`, error);
  }
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
