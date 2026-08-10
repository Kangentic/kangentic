import { CodexDetector } from './detector';
import { CodexCommandBuilder } from './command-builder';
import { removeHooks as removeCodexHooks } from './hook-manager';
import { CodexSessionHistoryParser } from './session-history-parser';
import { createCodexCommandInjectionVerifier } from './command-injection-verifier';
import { parseCodexTranscript, locateCodexTranscriptFile } from './transcript-parser';
import { migrateCodexProjectData } from './project-relocation';
import { CodexStatusParser } from './status-parser';
import { discoverCodexCapabilities } from './capability-discovery';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions, SettingsChangeSpec, ParsedTranscript } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier, AgentCapabilities, AgentLaunchOptionInfo } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Codex CLI adapter - wraps CodexDetector, CodexCommandBuilder, and
 * codex-hook-manager behind the generic AgentAdapter interface.
 */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex CLI';
  readonly sessionType = 'codex_agent';
  readonly supportsCallerSessionId = false;
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Safe Read-Only Browsing' },
    { mode: 'dontAsk', label: 'Read-Only Non-Interactive (CI)' },
    { mode: 'default', label: 'Automatically Edit, Ask for Untrusted' },
    { mode: 'acceptEdits', label: 'Auto (Preset)' },
    { mode: 'bypassPermissions', label: 'Dangerous Full Access' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  /**
   * Codex boots an optional cloud ChatGPT Apps MCP connector on startup
   * (`apps` feature, stable and on by default per `codex features list`),
   * which can hang the whole session at "Booting MCP server: codex_apps"
   * (openai/codex#20167, #19284, #16550). `--disable apps` skips it for
   * Kangentic-launched sessions only - the user's `~/.codex/config.toml`
   * is never touched. See command-builder.ts for where `disableApps`
   * becomes the CLI flag.
   */
  readonly launchOptions: readonly AgentLaunchOptionInfo[] = [{
    id: 'disableApps',
    label: 'Disable ChatGPT Apps',
    description: "Skips Codex's optional ChatGPT Apps connector, which can hang startup. Doesn't touch your global config.",
    default: false,
  }];

  private readonly detector = new CodexDetector();
  private readonly commandBuilder = new CodexCommandBuilder();
  // Set of taskIds currently active per project root. Originally tracked
  // ownership of a project-shared `.codex/hooks.json` we wrote on spawn.
  // Codex 0.128 redesigned the hook system (hooks now live in
  // `~/.codex/config.toml` or in a Codex plugin folder), so Kangentic no
  // longer writes that file - `buildHooks` only sweeps stale legacy
  // entries from pre-upgrade installs. The refcount is retained because
  // multiple concurrent sessions in the same cwd still race on that
  // legacy cleanup, and serializing via holders keeps removeHooks
  // idempotent. See GeminiAdapter.hookHolders for the same pattern.
  private readonly hookHolders = new Map<string, Set<string>>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // Codex does not have a trust dialog - no pre-approval needed.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, model, effort, ...rest } = options;
    const command = this.commandBuilder.buildCodexCommand({
      codexPath: agentPath,
      model,
      effort,
      ...rest,
    });
    // buildCodexCommand sweeps any stale legacy `.codex/hooks.json` whenever
    // eventsOutputPath is present. Retain a reference keyed by the project
    // root (same key removeHooks uses) so concurrent sessions serialize
    // their cleanup.
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      this.retainHooks(projectRoot, options.taskId);
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
   * Runtime strategy: how Codex exposes activity state and session IDs.
   *
   * - Activity: PTY silence timer as fallback. The sessionHistory hook
   *   below provides authoritative task_started/task_complete events
   *   from the rollout JSONL; the PTY tracker is suppressed once the
   *   first history event arrives.
   * - Session ID (fromHook): reads `thread_id` from the SessionStart
   *   hookContext (openai/codex#10096). Inert today: Codex hook integration
   *   is disabled (see codex/hook-manager.ts), so no SessionStart event is
   *   emitted; fromOutput is the live path. Wired up when hooks return.
   * - Session ID (fromOutput): Codex v0.118+ prints "session id: <uuid>" in
   *   the startup header; older versions printed "codex resume thr_..." at exit.
   *   This UUID is used to locate the rollout file on disk.
   * - sessionHistory: tails ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*-<id>.jsonl
   *   for real-time model, context window, and token counts. See CodexSessionHistoryParser.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Codex has no status line (parseStatus returns null). The
    // hook-driven events.jsonl pipeline is currently dormant: 0.118
    // ignored the project-local `.codex/hooks.json` we used to write,
    // and 0.128 redesigned hooks entirely (TOML in ~/.codex/config.toml
    // or plugin manifests). parseEvent is wired up so the pipeline
    // re-activates automatically once we adopt the new hook format,
    // but no events flow through it today.
    statusFile: {
      parseStatus: CodexStatusParser.parseStatus,
      parseEvent: CodexStatusParser.parseEvent,
      isFullRewrite: false,
    },
    // Codex idle detection: silence timer only (no detectIdle callback).
    //
    // The `›` (U+203A) guillemet is NOT idle-specific - it's always visible
    // in the Codex Ink TUI's prompt area, even during active tool execution.
    // Using it for detectIdle causes false idle transitions during active
    // work (state oscillates thinking↔idle on every frame). Empirically
    // verified: Codex goes completely SILENT when idle (no TUI redraws),
    // so the 10-second silence timer in PtyActivityTracker fires reliably.
    //
    // Content deduplication in SessionManager provides an agent-agnostic
    // safety net: if any TUI agent does continuously redraw, repeated
    // frames with identical stripped text are filtered automatically.
    activity: ActivityDetection.pty(),
    sessionId: {
      fromHook(hookContext) {
        try {
          const context = JSON.parse(hookContext);
          const threadId = context.thread_id ?? context.threadId;
          if (typeof threadId === 'string') {
            console.log(`[codex] Captured thread ID from hook: ${threadId.slice(0, 16)}...`);
            return threadId;
          }
          console.warn(`[codex] SessionStart hookContext missing thread_id. Keys: ${Object.keys(context).join(', ')}`);
          return null;
        } catch {
          console.warn('[codex] Failed to parse SessionStart hookContext');
          return null;
        }
      },
      fromOutput(data) {
        const headerMatch = data.match(/session id:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (headerMatch) return headerMatch[1];
        const resumeMatch = data.match(/codex\s+resume\s+(thr_\S+)/);
        return resumeMatch ? resumeMatch[1] : null;
      },
      // Codex 0.118 neither prints the session UUID in PTY output nor
      // fires hooks (both verified empirically - see the fixtures in
      // tests/fixtures/agent-pty/codex.txt). 0.128 added a `session id:`
      // line to the startup banner (caught by fromOutput above), but the
      // rollout-file scan remains the authoritative fallback for older
      // versions and for cases where the banner scrolls before we can
      // capture it.
      fromFilesystem: CodexSessionHistoryParser.captureSessionIdFromFilesystem,
    },
    sessionHistory: {
      locate: CodexSessionHistoryParser.locate,
      parse: CodexSessionHistoryParser.parse,
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
    removeCodexHooks(directory);
  }

  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType === 'command-injection') {
      // Codex writes the user turn to its rollout JSONL on SUBMIT, measured at
      // 61-108ms and flat against a 4.6s turn (see command-injection-verifier.ts
      // for the numbers and scripts/measure-injection-flush.mjs for the rig).
      return createCodexCommandInjectionVerifier();
    }
    // 'paste': Codex's hook pipeline is currently dormant for Kangentic (see
    // the runtime comment above): 0.118 ignored the legacy hooks.json, and
    // 0.128 redesigned hooks into a format we don't write yet. The paste engine
    // falls back to its activity-event and data-floor backstops.
    return null;
  }

  /**
   * Codex handles slash input in the TUI and never writes it to the rollout
   * file. Measured: an unrecognized `/...` produced "Unrecognized command" and
   * no record at all. Absence therefore cannot distinguish "rejected" from
   * "ran client-side", so slash auto_commands are left unverified rather than
   * risking an escalation that restarts a working session.
   */
  canVerifySlashSubmission(): boolean {
    return false;
  }

  clearSettingsCache(): void {
    // No settings cache to clear - Codex uses config.toml, not merged
    // settings files.
  }

  getExitSequence(): string[] {
    // Codex sessions are API-backed (server-side threads) - no local
    // conversation state to flush. Ctrl+C is sufficient.
    return ['\x03'];
  }

  detectFirstOutput(data: string): boolean {
    // Codex CLI hides the cursor when its TUI takes over the terminal.
    // Detecting ESC[?25l fires after the shell prompt noise but before
    // the TUI draws the startup banner. This keeps the shell command
    // hidden behind the shimmer overlay.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return CodexSessionHistoryParser.locate({ agentSessionId, cwd });
  }

  async parseTranscript(agentSessionId: string, _cwd: string): Promise<ParsedTranscript> {
    const filePath = locateCodexTranscriptFile(agentSessionId);
    if (!filePath) return { entries: [], sourcePath: null };
    const entries = await parseCodexTranscript(filePath);
    return { entries, sourcePath: filePath };
  }

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverCodexCapabilities(cliPath);
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // Codex does not support live `/model` or `/reasoning-effort` slash commands.
    // Model/effort changes require respawn (handled by task-move.ts fallback).
    return [];
  }

  async summarize(prompt: string, cliPath: string, cwd: string): Promise<string> {
    // `codex exec` runs non-interactively. The `--skip-git-repo-check` flag avoids
    // failing in non-git working directories. Prompt is delivered via stdin.
    return runCliPrintSummarize({
      cliPath,
      args: ['exec', '--skip-git-repo-check'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
    });
  }

  /**
   * Codex resolves resume by session id, so its rollout JSONLs survive a move
   * untouched. The one path-keyed store that breaks is the per-project trust
   * header in ~/.codex/config.toml; rewrite it so the relocated project stays
   * trusted. Best-effort and non-destructive; see migrateCodexProjectData.
   */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateCodexProjectData(oldPath, newPath);
  }
}
