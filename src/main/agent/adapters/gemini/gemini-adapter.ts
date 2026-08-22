import { GeminiDetector } from './detector';
import { GeminiCommandBuilder } from './command-builder';
import { removeHooks as removeGeminiHooks } from './hook-manager';
import { ensureWorktreeTrust, removeWorktreeTrust } from './trust-manager';
import { GeminiSessionHistoryParser } from './session-history-parser';
import { parseGeminiTranscript, locateGeminiTranscriptFile } from './transcript-parser';
import { migrateGeminiProjectData } from './project-relocation';
import { GeminiStatusParser } from './status-parser';
import { discoverGeminiCapabilities } from './capability-discovery';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions, SettingsChangeSpec, ParsedTranscript } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier, AgentCapabilities } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Gemini CLI adapter - wraps GeminiDetector, GeminiCommandBuilder,
 * GeminiStatusParser, and gemini-hook-manager behind the generic
 * AgentAdapter interface.
 */
export class GeminiAdapter implements AgentAdapter {
  readonly name = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly sessionType = 'gemini_agent';
  readonly supportsCallerSessionId = false;
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only Research)' },
    { mode: 'default', label: 'Default (Confirm Actions)' },
    { mode: 'acceptEdits', label: 'Auto Edit (Auto-Approve Edits)' },
    { mode: 'bypassPermissions', label: 'YOLO (Auto-Approve All)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new GeminiDetector();
  private readonly commandBuilder = new GeminiCommandBuilder();
  // Set of taskIds currently holding hook injections per directory. Gemini
  // has no per-session settings flag, so `.gemini/settings.json` is shared
  // across concurrent sessions in the same project. removeHooks() only
  // actually strips hooks when the last taskId releases; otherwise a first
  // session's suspend/exit would clobber a still-running second session's
  // hooks. A Set (rather than a counter) makes double-releases for the same
  // taskId idempotent, which matters because session-manager's suspend path
  // calls removeHooks once explicitly and again from the PTY onExit handler.
  private readonly hookHolders = new Map<string, Set<string>>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(workingDirectory: string): Promise<void> {
    // Gemini DOES have a folder-trust system (this was previously documented
    // here as a no-op because Gemini had none). An untrusted folder disables
    // every configured MCP server, including ours, so pre-trusting the
    // worktree is what makes the Kangentic MCP entry take effect. See
    // trust-manager.ts.
    await ensureWorktreeTrust(workingDirectory);
  }

  /**
   * When no ancestor is already trusted, `ensureTrust` records one entry per
   * task worktree, so `~/.gemini/trustedFolders.json` needs the same cleanup
   * Codex's `config.toml` does or it grows by a dead entry per task forever.
   */
  async onWorktreeRemoved(worktreePath: string): Promise<void> {
    await removeWorktreeTrust(worktreePath);
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, model, effort, ...rest } = options;
    const command = this.commandBuilder.buildGeminiCommand({
      geminiPath: agentPath,
      model,
      effort,
      ...rest,
    });
    // buildGeminiCommand writes hooks into .gemini/settings.json whenever
    // eventsOutputPath is present. Retain a reference for every such spawn
    // so concurrent sessions in the same cwd serialize their cleanup.
    // An MCP-only spawn (no events pipeline) writes the MCP entry but takes
    // no reference, so it is not protected by the count: if it shared a cwd
    // with a holding session, that session exiting would strip its entry.
    // Every spawn chokepoint supplies eventsOutputPath today, so no such
    // spawn exists in practice. Same gate as the sibling Qwen adapter.
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
   * Runtime strategy: how Gemini exposes activity state and session IDs.
   *
   * - Activity: hook-based primary (Gemini's documented base hook schema
   *   includes activity events), with PTY silence-timer fallback if hooks
   *   fail at runtime. The sessionHistory hook provides the authoritative
   *   model + tokens stream from Gemini's native chat file.
   * - Session ID (fromHook): Gemini's base hook input schema includes
   *   `session_id` (and sometimes camelCase `sessionId`) on every hook stdin.
   * - Session ID (fromOutput): Gemini prints "gemini --resume '<uuid>'" and
   *   "Session ID: <uuid>" in the shutdown summary.
   * - sessionHistory: reads ~/.gemini/tmp/<basename(cwd)>/chats/session-*.json
   *   whole-file on every write to extract model + tokens from the latest
   *   assistant message. See GeminiSessionHistoryParser.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Hook-driven status.json + events.jsonl pipeline. Gemini has no
    // status line (parseStatus returns null), but the event-bridge hook
    // output is parsed via parseEvent so tool_start/idle events drive
    // activity transitions and captureHookSessionIds can fire.
    statusFile: {
      parseStatus: GeminiStatusParser.parseStatus,
      parseEvent: GeminiStatusParser.parseEvent,
      isFullRewrite: false,
    },
    activity: ActivityDetection.hooksAndPty((data: string) => {
      // Patterns derived from real Gemini 0.37 PTY captures (see
      // tests/unit/agent-pty-detection.test.ts and the .bin fixtures).
      // Gemini's TUI paints box-drawing borders (`╰────╯`) around every
      // interactive surface - the trust dialog, the input prompt, and
      // the auth dialog all close with this border. The presence of a
      // closed box border in a chunk's tail means the TUI has finished
      // painting a frame and is waiting for input.
      const clean = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '');
      return /\u2570[\u2500]+\u256F/.test(clean) || /I'm ready\./.test(clean);
    }),
    sessionId: {
      fromHook(hookContext) {
        try {
          const context = JSON.parse(hookContext);
          const sessionId = context.session_id ?? context.sessionId;
          if (typeof sessionId === 'string' && sessionId.length > 0) {
            console.log(`[gemini] Captured session ID from hook: ${sessionId.slice(0, 16)}...`);
            return sessionId;
          }
          console.warn(`[gemini] SessionStart hookContext missing session_id. Keys: ${Object.keys(context).join(', ')}`);
          return null;
        } catch {
          console.warn('[gemini] Failed to parse SessionStart hookContext');
          return null;
        }
      },
      fromOutput(data) {
        const resumeMatch = data.match(/gemini\s+--resume\s+'?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'?/);
        if (resumeMatch) return resumeMatch[1];
        const headerMatch = data.match(/Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        return headerMatch ? headerMatch[1] : null;
      },
      // Gemini 0.37 neither includes session_id reliably in hook stdin
      // nor prints it in PTY output until shutdown. The only source at
      // runtime is the session JSON file Gemini writes synchronously at
      // session start. This scan is the primary capture path.
      fromFilesystem: GeminiSessionHistoryParser.captureSessionIdFromFilesystem,
    },
    sessionHistory: {
      locate: GeminiSessionHistoryParser.locate,
      parse: GeminiSessionHistoryParser.parse,
      isFullRewrite: true,
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
    removeGeminiHooks(directory);
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Gemini's hook-manager wires its `BeforeAgent` event to EventType.Prompt,
    // but coordinating hook-based paste confirmation with command-injection
    // JSONL parsing is complex. Callers fall back to time-based settle (paste)
    // or time-settle (command-injection).
    return null;
  }

  clearSettingsCache(): void {
    this.commandBuilder.clearSettingsCache();
  }

  getExitSequence(): string[] {
    return ['\x03', '/quit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Gemini CLI hides the cursor when its TUI takes over the terminal.
    // Detecting ESC[?25l fires after the shell prompt noise but before
    // the TUI draws the startup banner. This keeps the shell command
    // hidden behind the shimmer overlay.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return GeminiSessionHistoryParser.locate({ agentSessionId, cwd });
  }

  async parseTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
    const filePath = locateGeminiTranscriptFile(agentSessionId, cwd);
    if (!filePath) return { entries: [], sourcePath: null };
    const entries = await parseGeminiTranscript(agentSessionId, filePath);
    return { entries, sourcePath: filePath };
  }

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverGeminiCapabilities(cliPath);
  }

  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    // Gemini supports `/model <model>` slash command for live model switching
    if (spec.modelChanged && spec.model) {
      sequence.push(`/model ${spec.model}`);
    }
    // Gemini has no effort concept, so skip effort handling
    return sequence;
  }

  async summarize(prompt: string, cliPath: string, cwd: string): Promise<string> {
    // Gemini's headless mode triggers automatically in non-TTY environments. We pipe
    // the prompt via stdin and request plain text output.
    return runCliPrintSummarize({
      cliPath,
      args: ['--output-format', 'text'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
    });
  }

  /**
   * Gemini keys per-project data through ~/.gemini/projects.json (path ->
   * slug), with chats/history under ~/.gemini/tmp|history/<slug>/ and trust in
   * ~/.gemini/trustedFolders.json. Rewrite the registry key, markers, and trust
   * entry so sessions stay resumable after a relocation. Best-effort and
   * non-destructive; see migrateGeminiProjectData.
   */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateGeminiProjectData(oldPath, newPath);
  }
}
