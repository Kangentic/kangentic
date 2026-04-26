import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import type { PermissionMode } from '../../../../shared/types';

/**
 * Factory Droid CLI command builder.
 *
 * Empirically validated against Droid 0.109.1 (see `scripts/probe-droid.js`):
 *   New session:    droid --cwd <cwd> "<prompt>"
 *   Resume session: droid --cwd <cwd> --resume <uuid> "<prompt>"
 *
 * Design note (2026-04-26): this adapter intentionally does not write
 * a per-spawn `--settings <path>` file. Droid's interactive TUI
 * already exposes everything Kangentic users need:
 *   - Model selection: `/model` picker, with Ctrl+D to pin a default
 *     (persists in `~/.factory/settings.json`)
 *   - Autonomy mode: shift+tab cycles low/medium/high
 *   - BYOK: configured once via `customModels[]` in
 *     `~/.factory/settings.json`
 *
 * Trying to shadow these with Kangentic-managed overrides was rejected
 * by user feedback as unnecessary custom layering. The bare command
 * with cwd + resume + prompt is the production path.
 *
 * Other notes:
 * - Resume uses `droid --resume <uuid>`, NOT the exec-only `-s` flag.
 * - The session UUID is captured post-spawn from
 *   `~/.factory/sessions/<cwd-slug>/<uuid>.jsonl`. See
 *   `DroidAdapter.runtime.sessionId.fromFilesystem`.
 */
export interface DroidCommandOptions {
  droidPath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  /**
   * Accepted for parity with the AgentAdapter interface but ignored:
   * Droid's TUI handles permission decisions in-band (shift+tab to
   * cycle autonomy modes). Kangentic does not translate this into a
   * flag override -- the user controls autonomy in the TUI directly.
   */
  permissionMode: PermissionMode;
  projectRoot?: string;
  sessionId?: string;
  resume?: boolean;
  /** Accepted for parity; the adapter spawns the interactive TUI. */
  nonInteractive?: boolean;
  /** Accepted for parity; no statusFile pipeline today. */
  statusOutputPath?: string;
  /** Accepted for parity; no events.jsonl pipeline today. */
  eventsOutputPath?: string;
  shell?: string;
  mcpServerEnabled?: boolean;
  mcpServerUrl?: string;
  mcpServerToken?: string;
}

export class DroidCommandBuilder {
  buildDroidCommand(options: DroidCommandOptions): string {
    const { shell } = options;
    const parts: string[] = [quoteArg(options.droidPath, shell)];

    parts.push('--cwd', quoteArg(toForwardSlash(options.cwd), shell));

    if (options.resume && options.sessionId) {
      // `--resume <uuid>` accepts the agent's own session UUID. The
      // captured ID lives in ~/.factory/sessions/<cwd-slug>/<uuid>.jsonl.
      parts.push('--resume', quoteArg(options.sessionId, shell));
    }

    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push(quoteArg(safePrompt, shell));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
