import fs from 'node:fs';
import { ClaudeDetector } from './detector';
import { CommandBuilder } from './command-builder';
import { ClaudeStatusParser } from './status-parser';
import { locateClaudeTranscriptFile, parseClaudeTranscript } from './transcript-parser';
import { resolveBackgroundTaskOutputFile } from './background-task-output';
import { ensureWorktreeTrust, ensureMcpServerTrust } from './trust-manager';
import { migrateClaudeProjectData } from './project-relocation';
import { removeHooks as removeClaudeHooks } from './hook-manager';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import { discoverClaudeStaticCapabilities, rescanClaudeModels } from './capability-discovery';
import { createSlashCommandVerifier } from './slash-command-verifier';
import type {
  AgentAdapter,
  AgentInfo,
  SpawnCommandOptions,
  SettingsChangeSpec,
  ParsedTranscript,
} from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  AgentCapabilities,
  SubmissionContextType,
  SubmissionVerifier,
  SubmissionContext,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Claude Code adapter - wraps ClaudeDetector, CommandBuilder,
 * ClaudeStatusParser, trust-manager, and hook-manager behind
 * the generic AgentAdapter interface.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly sessionType = 'claude_agent';
  readonly supportsCallerSessionId = true;
  // Claude streams account-wide rate-limit windows in its status line, so the
  // ContextBar shows the rate-limit pill for any Claude session using the shared
  // global snapshot - even a freshly spawned one that has not reported its own yet.
  readonly reportsRateLimits = true;
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only)' },
    { mode: 'dontAsk', label: "Don't Ask (Deny Unless Allowed)" },
    { mode: 'default', label: 'Default (Allowlist)' },
    { mode: 'acceptEdits', label: 'Accept Edits' },
    { mode: 'auto', label: 'Auto (Classifier)' },
    { mode: 'bypassPermissions', label: 'Bypass (Unsafe)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new ClaudeDetector();
  private readonly commandBuilder = new CommandBuilder();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
    this.staticCapabilitiesCache = null;
  }

  // Cache only the static, --help-derived bits (effortLevels, supportsModelOverride
  // flag). They never change between dialog opens for a given binary, so we
  // avoid re-spawning `claude --help` every time the picker mounts. The model
  // list is rescanned on every call so newly-used models appear without
  // restarting Kangentic.
  private staticCapabilitiesCache: { cliPath: string; capabilities: AgentCapabilities } | null = null;

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    let staticCapabilities: AgentCapabilities;
    if (this.staticCapabilitiesCache && this.staticCapabilitiesCache.cliPath === cliPath) {
      staticCapabilities = this.staticCapabilitiesCache.capabilities;
    } else {
      staticCapabilities = await discoverClaudeStaticCapabilities(cliPath);
      this.staticCapabilitiesCache = { cliPath, capabilities: staticCapabilities };
    }

    if (!staticCapabilities.supportsModelOverride) {
      return staticCapabilities;
    }
    const models = await rescanClaudeModels(cliPath);
    return models ? { ...staticCapabilities, models } : staticCapabilities;
  }

  async ensureTrust(workingDirectory: string): Promise<void> {
    await ensureWorktreeTrust(workingDirectory);
    await ensureMcpServerTrust(workingDirectory);
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildClaudeCommand({ cliPath: agentPath, ...rest });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  // Claude uses caller-owned session IDs via --session-id, so no capture
  // needed. Telemetry comes exclusively from the hook-driven statusFile
  // pipeline (status.json + events.jsonl, written by Kangentic's injected
  // event-bridge.js / status-bridge.js into .kangentic/sessions/<sessionId>/
  // and watched by StatusFileReader). Claude Code's native session log at
  // ~/.claude/projects/<slug>/<sessionId>.jsonl is read on demand by
  // transcript-parser.ts for the renderer's Transcript tab, but is not
  // wired into the live telemetry pipeline - the hook output is richer
  // (display_name, real context window, cost) and a second source would
  // race against it.
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.hooks(),
    statusFile: {
      parseStatus: ClaudeStatusParser.parseStatus,
      parseEvent: ClaudeStatusParser.parseEvent,
      isFullRewrite: true,
    },
    // The bg-shell watcher stats this file for liveness when a named shell
    // has no captured OS PID (Incident B). Wrapped in an arrow so the optional
    // baseTmpDir parameter stays internal to the resolver.
    backgroundShells: {
      resolveOutputFile: (options) => resolveBackgroundTaskOutputFile(options),
    },
  };

  removeHooks(directory: string): void {
    removeClaudeHooks(directory);
  }

  clearSettingsCache(): void {
    this.commandBuilder.clearSettingsCache();
  }

  getExitSequence(): string[] {
    return ['\x03', '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Claude Code hides the cursor when its TUI takes over the terminal.
    // Detecting ESC[?25l fires after the shell prompt noise but before
    // the TUI draws the startup banner, keeping the shell command hidden
    // behind the shimmer overlay.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    const filePath = locateClaudeTranscriptFile(agentSessionId, cwd);
    // locateClaudeTranscriptFile returns the computed path without checking existence.
    // Verify the file actually exists before returning it.
    try {
      fs.accessSync(filePath);
      return filePath;
    } catch {
      return null;
    }
  }

  async parseTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
    const filePath = locateClaudeTranscriptFile(agentSessionId, cwd);
    const entries = await parseClaudeTranscript(filePath);
    return { entries, sourcePath: filePath };
  }

  async summarize(prompt: string, cliPath: string, cwd: string): Promise<string> {
    return runCliPrintSummarize({
      cliPath,
      args: ['--print', '--permission-mode', 'plan'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
    });
  }

  /**
   * Claude provides context-specific submission verifiers.
   *
   * - paste context: Claude emits EventType.Prompt via the UserPromptSubmit
   *   hook the moment the agent receives our submitted prompt. That same
   *   transition flips the session's activity to `thinking`, which the
   *   paste-engine's `'activity'` listener already resolves on. Returning
   *   null here keeps the fast path on the activity backstop rather than
   *   re-implementing event subscription inside a one-shot Promise.
   *
   * - command-injection context: Claude writes every slash invocation as
   *   a `local_command` entry in the session JSONL with `<command-name>`
   *   and `<command-args>` tags. The verifier polls that file for an entry
   *   matching exactly what we sent, so combined-args concatenation bugs
   *   (overlay-eaten Enter merging `/effort` into the previous `/model`
   *   invocation) are detected and retried. Requires agentSessionId, cwd,
   *   and sentAt in the context to bound the scan window.
   */
  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType === 'command-injection') {
      return async (context: SubmissionContext) => {
        if (context.type !== 'command-injection' || !context.agentSessionId || !context.cwd) {
          return false;
        }
        const filePath = locateClaudeTranscriptFile(context.agentSessionId, context.cwd);
        const verifier = createSlashCommandVerifier(filePath);
        if (!verifier) return false;
        // sentAt comes from TerminalSubmit.submitKeystrokes's most-recent
        // Enter timestamp, re-advanced on each retry-Enter. Falling back to
        // Date.now() preserves single-call use (e.g. ad-hoc verifier
        // invocation in tests) but the production path always supplies it.
        return verifier(context.text, context.sentAt ?? Date.now());
      };
    }
    return null;
  }

  /**
   * Claude accepts the slash forms `/model <id>` and `/effort <level>` as
   * valued commands that bypass the interactive picker - confirmed
   * empirically (scripts/probe-claude-model-forms.js for the CLI flag form,
   * and live-tested for the slash form). Order is /model before /effort
   * because /effort xhigh is Opus-only; setting the model first ensures
   * /effort lands on a model that accepts the requested level.
   */
  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    if (spec.modelChanged && spec.model) sequence.push(`/model ${spec.model}`);
    if (spec.effortChanged && spec.effort) sequence.push(`/effort ${spec.effort}`);
    return sequence;
  }

  /**
   * Claude keys its session transcripts (~/.claude/projects/<slug>/) and its
   * per-project state (~/.claude.json projects keys) to the absolute project
   * path, both outside the project folder. Migrate them so sessions stay
   * resumable after a relocation. Best-effort and non-destructive; see
   * migrateClaudeProjectData. Also invoked with a single worktree's old/new path
   * on the first resume after a worktree rename (resume-cwd-migration.ts), which
   * migrates only that worktree's slug.
   */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateClaudeProjectData(oldPath, newPath);
  }
}
