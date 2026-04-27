import { QwenDetector } from './detector';
import { QwenCommandBuilder } from './command-builder';
import { removeHooks as removeQwenHooks } from './hook-manager';
import { QwenSessionHistoryParser } from './session-history-parser';
import { QwenStatusParser } from './status-parser';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Qwen Code CLI adapter - wraps QwenDetector, QwenCommandBuilder,
 * QwenStatusParser, and qwen-hook-manager behind the generic
 * AgentAdapter interface.
 *
 * Qwen Code (https://github.com/QwenLM/qwen-code) is a soft fork of
 * Google's gemini-cli, so this adapter mirrors GeminiAdapter almost
 * verbatim. The deltas are: binary name (`qwen`), config directory
 * (`.qwen/`), and the `auto-edit` approval-mode flag (vs Gemini's
 * `auto_edit`). Hook event schema, session JSON layout, and TUI
 * behavior are inherited unchanged.
 */
export class QwenAdapter implements AgentAdapter {
  readonly name = 'qwen';
  readonly displayName = 'Qwen Code';
  readonly sessionType = 'qwen_agent';
  readonly supportsCallerSessionId = true;
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only Research)' },
    { mode: 'default', label: 'Default (Confirm Actions)' },
    { mode: 'acceptEdits', label: 'Auto Edit (Auto-Approve Edits)' },
    { mode: 'bypassPermissions', label: 'YOLO (Auto-Approve All)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new QwenDetector();
  private readonly commandBuilder = new QwenCommandBuilder();
  // Set of taskIds currently holding hook injections per directory. Qwen
  // (inheriting from gemini-cli) has no per-session settings flag, so
  // `.qwen/settings.json` is shared across concurrent sessions in the
  // same project. removeHooks() only actually strips hooks when the last
  // taskId releases; otherwise a first session's suspend/exit would
  // clobber a still-running second session's hooks. A Set (rather than
  // a counter) makes double-releases for the same taskId idempotent,
  // which matters because session-manager's suspend path calls
  // removeHooks once explicitly and again from the PTY onExit handler.
  private readonly hookHolders = new Map<string, Set<string>>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // No-op: Qwen Code does not have a trust/directory-approval system.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    const command = this.commandBuilder.buildQwenCommand({ qwenPath: agentPath, ...rest });
    // buildQwenCommand writes hooks into .qwen/settings.json whenever
    // eventsOutputPath is present. Retain a reference for every such
    // spawn so concurrent sessions in the same cwd serialize cleanup.
    if (options.eventsOutputPath) {
      this.retainHooks(options.cwd, options.taskId);
    }
    return command;
  }

  private retainHooks(directory: string, taskId: string): void {
    let holders = this.hookHolders.get(directory);
    if (!holders) {
      holders = new Set<string>();
      this.hookHolders.set(directory, holders);
    }
    holders.add(taskId);
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: how Qwen Code exposes activity state and session IDs.
   *
   * - Activity: hook-based primary (Qwen inherits Gemini's hook schema
   *   including activity events), with PTY silence-timer fallback if
   *   hooks fail at runtime. The sessionHistory hook provides the
   *   authoritative model + tokens stream from Qwen's native chat file.
   * - Session ID: caller-owned via `--session-id <uuid>` (Qwen 0.15.3+
   *   accepts a UUID as caller-owned, mutex with --continue / --resume).
   *   The fromHook and fromOutput captures stay as belt-and-suspenders
   *   in case some forks emit a different ID; they should be no-ops
   *   when the caller-supplied UUID matches. fromOutput accepts either
   *   `qwen` or `gemini` as the binary name in the resume regex - some
   *   fork builds still print the upstream string.
   * - sessionHistory: tails ~/.qwen/projects/<sanitizeCwd(cwd)>/chats/<sessionId>.jsonl
   *   (append-only JSONL, one event per line) and walks lines backwards
   *   to extract model + tokens + contextWindowSize from the most recent
   *   assistant event. See QwenSessionHistoryParser.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    statusFile: {
      parseStatus: QwenStatusParser.parseStatus,
      parseEvent: QwenStatusParser.parseEvent,
      isFullRewrite: false,
    },
    activity: ActivityDetection.hooksAndPty((data: string) => {
      // Qwen Code shares Gemini's TUI rendering: box-drawing borders
      // (U+2570 ... U+2500 ... U+256F) close every interactive surface
      // (trust, prompt, auth dialogs). A closed box border in a chunk's
      // tail means the TUI has finished painting a frame and is waiting
      // for input. Use unicode escapes (not literal chars) to match the
      // Gemini adapter's convention and avoid editor / codepage display
      // ambiguity.
      const clean = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '');
      return /\u2570[\u2500]+\u256F/.test(clean) || /I'm ready\./.test(clean);
    }),
    sessionId: {
      fromHook(hookContext) {
        try {
          const context: unknown = JSON.parse(hookContext);
          // Guard against non-object values (e.g. hookContext === "null"
          // or "42" parses to a primitive). Object.keys() on a non-object
          // would throw; the typeof check below would still work but the
          // warn-log path needs a valid object.
          if (typeof context !== 'object' || context === null || Array.isArray(context)) {
            console.warn('[qwen] SessionStart hookContext was not a JSON object');
            return null;
          }
          const record = context as Record<string, unknown>;
          const sessionId = record.session_id ?? record.sessionId;
          if (typeof sessionId === 'string' && sessionId.length > 0) {
            console.log(`[qwen] Captured session ID from hook: ${sessionId.slice(0, 16)}...`);
            return sessionId;
          }
          console.warn(`[qwen] SessionStart hookContext missing session_id. Keys: ${Object.keys(record).join(', ')}`);
          return null;
        } catch {
          console.warn('[qwen] Failed to parse SessionStart hookContext');
          return null;
        }
      },
      fromOutput(data) {
        // Accept either `qwen --resume '<uuid>'` (rebranded build) or
        // `gemini --resume '<uuid>'` (some forks still emit the
        // upstream literal in the shutdown summary).
        const resumeMatch = data.match(/(?:qwen|gemini)\s+--resume\s+'?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'?/);
        if (resumeMatch) return resumeMatch[1];
        const headerMatch = data.match(/Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        return headerMatch ? headerMatch[1] : null;
      },
    },
    sessionHistory: {
      locate: QwenSessionHistoryParser.locate,
      parse: QwenSessionHistoryParser.parse,
      // Real Qwen 0.15.3 writes JSONL append-only (one event per line),
      // not whole-file JSON. The watcher should track a byte cursor and
      // only feed new bytes to parse(), not the full file every time.
      isFullRewrite: false,
    },
  };

  removeHooks(directory: string, taskId?: string): void {
    const holders = this.hookHolders.get(directory);
    if (holders && taskId) {
      holders.delete(taskId);
      if (holders.size > 0) {
        // Another session in this directory still needs the hooks.
        return;
      }
      this.hookHolders.delete(directory);
    }
    removeQwenHooks(directory);
  }

  clearSettingsCache(): void {
    this.commandBuilder.clearSettingsCache();
  }

  getExitSequence(): string[] {
    return ['\x03', '/quit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Qwen Code (like Gemini) hides the cursor when its TUI takes over
    // the terminal. Detecting ESC[?25l fires after the shell prompt
    // noise but before the TUI draws the startup banner, which keeps
    // the shell command hidden behind the shimmer overlay.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return QwenSessionHistoryParser.locate({ agentSessionId, cwd });
  }
}
