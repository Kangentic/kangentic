import fs from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GrokDetector } from './detector';
import { GrokCommandBuilder, grokMcpWiringEnabled } from './command-builder';
import { removeHooksFile } from './hook-manager';
import { removeMcpConfig } from './mcp-config';
import { GrokStatusParser } from './status-parser';
import { GrokSessionHistoryParser, grokModelDisplayName } from './session-history-parser';
import { parseGrokTranscript, grokTranscriptUsage, grokTranscriptToolCounts } from './transcript-parser';
import { createGrokCommandInjectionVerifier } from './command-injection-verifier';
import { discoverGrokCapabilities } from './capability-discovery';
import { ensureWorktreeTrust, removeWorktreeTrust } from './trust-manager';
import { migrateGrokProjectData } from './project-relocation';
import { grokUpdatesJsonlPath } from './session-paths';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions, SettingsChangeSpec, ParsedTranscript } from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SubmissionContextType,
  SubmissionVerifier,
  AgentCapabilities,
  TranscriptUsage,
  TranscriptToolCounts,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Grok Build (xAI) adapter - the full Claude-class harness.
 *
 * Everything empirical in this adapter was verified against grok 1.0.0
 * (3cd0d0cbce) on Windows: flags via `grok --help`, the session store and
 * event formats from real on-disk sessions, hook delivery (all events,
 * including headless mode) via a live probe, and the TUI's first-output /
 * exit behavior via node-pty captures. Grok deliberately clones Claude
 * Code's surface - Claude-compatible hooks (10-hooks.md), the same
 * `--session-id` / `--resume` split, the same `--permission-mode`
 * vocabulary - which is what makes full parity reachable. The one
 * structural divergence: no statusline, so usage telemetry tails the
 * native `updates.jsonl` (Codex pattern) instead of a status bridge.
 */
export class GrokAdapter implements AgentAdapter {
  readonly name = 'grok';
  readonly displayName = 'Grok Build';
  readonly sessionType = 'grok_agent';
  readonly supportsCallerSessionId = true;
  /**
   * `--permission-mode` accepts Kangentic's exact PermissionMode names
   * (verified in `grok --help`), so all six pass through 1:1. Internally
   * grok normalizes `acceptEdits`/`dontAsk` onto its own ladder
   * (`default | auto | plan | bypassPermissions`, per 10-hooks.md), with
   * `auto` as the nearest neighbor - the labels below describe grok's
   * behavior, not Claude's.
   */
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan Mode (read-only)' },
    { mode: 'default', label: 'Default (ask for approval)' },
    { mode: 'acceptEdits', label: 'Accept Edits' },
    { mode: 'auto', label: 'Auto (model decides when to ask)' },
    { mode: 'dontAsk', label: 'Never Ask (auto-deny)' },
    { mode: 'bypassPermissions', label: 'Dangerous Full Access' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new GrokDetector();
  private readonly commandBuilder = new GrokCommandBuilder();
  // Set of taskIds currently relying on the per-cwd `.grok/` wiring
  // (hooks file + MCP config block), keyed by cwd. Both files are static
  // and idempotently rewritten on every spawn; the refcount only guards
  // REMOVAL, so concurrent sessions in one cwd do not strip each other's
  // wiring (the Droid mcpHolders pattern).
  private readonly wiringHolders = new Map<string, Set<string>>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  /**
   * Pre-approve folder trust for Kangentic worktrees so project hooks and
   * the MCP block load without the user re-answering per task. Grok trust
   * cascades from the project root, so this is a no-op in the common
   * steady state; see trust-manager.ts for the full policy.
   */
  async ensureTrust(workingDirectory: string): Promise<void> {
    await ensureWorktreeTrust(workingDirectory);
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    const grokOptions = { grokPath: agentPath, ...rest };
    const command = this.commandBuilder.buildGrokCommand(grokOptions);
    if (options.eventsOutputPath || grokMcpWiringEnabled(grokOptions)) {
      this.retainWiring(options.cwd, options.taskId);
    }
    return command;
  }

  /**
   * Per-session values delivered through the PTY environment so the two
   * per-cwd files stay static: the events.jsonl path for the hook bridge's
   * `env:` sentinel, and the MCP URL + token that grok's documented
   * `${VAR}` expansion dereferences inside the config block. The token and
   * the caller-session URL never touch argv or disk.
   */
  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildGrokEnv({ grokPath: agentPath, ...rest });
  }

  private retainWiring(directory: string, taskId: string): void {
    let holders = this.wiringHolders.get(directory);
    if (!holders) {
      holders = new Set<string>();
      this.wiringHolders.set(directory, holders);
    }
    holders.add(taskId);
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy.
   *
   * - Activity: hooks are the primary source (verified live: grok fires the
   *   full Claude-compatible event set, headless included), with the PTY
   *   silence timer as fallback for the cases where project hooks silently
   *   do not load (an undecided/untrusted project root). No `detectIdle`
   *   regex: grok's TUI keeps its `❯` prompt visible during active work,
   *   the same always-visible-prompt trap that made Codex's `›` oscillate.
   * - statusFile: no statusline (`parseStatus` -> null); `parseEvent`
   *   decodes the live hook-driven events.jsonl.
   * - sessionHistory: tails `updates.jsonl` for usage telemetry (model,
   *   running context total, cumulative cost) plus idempotent activity
   *   hints as a hook backstop. It deliberately emits NO tool events -
   *   hooks own those, and a second emitter would double-count
   *   ToolStart/ToolEnd pairs in the engine.
   * - sessionId: omitted entirely - the UUID is caller-owned (`-s` at
   *   spawn), so there is nothing to capture.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.hooksAndPty(),
    statusFile: {
      parseStatus: GrokStatusParser.parseStatus,
      parseEvent: GrokStatusParser.parseEvent,
      isFullRewrite: false,
    },
    sessionHistory: {
      locate: GrokSessionHistoryParser.locate,
      parse: GrokSessionHistoryParser.parse,
      isFullRewrite: false,
    },
  };

  removeHooks(directory: string, taskId?: string): void {
    const holders = this.wiringHolders.get(directory);
    if (holders && taskId) {
      holders.delete(taskId);
      if (holders.size > 0) {
        // Another session in this cwd still needs the wiring.
        return;
      }
      this.wiringHolders.delete(directory);
    }
    removeHooksFile(directory);
    removeMcpConfig(directory);
  }

  clearSettingsCache(): void {
    // No settings cache: the hook file and MCP block are static content
    // rewritten on every spawn.
  }

  detectFirstOutput(data: string): boolean {
    // Grok hides the cursor in its very first output chunk (verified via
    // node-pty: ESC[?25l arrives before the alt-screen switch and the
    // banner), the same signature Codex and Droid key on.
    return data.includes('\x1b[?25l');
  }

  getExitSequence(): string[] {
    // Ctrl+C interrupts in-flight work; `/quit` exits cleanly (verified:
    // exit code 0) and prints the conversation dump that transcript
    // cleanup anchors on. Session state is flushed continuously to
    // updates.jsonl either way.
    return ['\x03', '/quit\r'];
  }

  /**
   * Strictly cwd-scoped fast existence probe (the Claude pattern). This
   * MUST NOT reuse `GrokSessionHistoryParser.locate`: that attach-time
   * locator polls up to ~60s and falls back to a cross-cwd sessions-root
   * scan, and callers of this method depend on both properties being
   * absent - `resume-id-reconcile` documents it as "a fast existence
   * probe", and `resume-cwd-migration` uses it as the "already reachable
   * from the NEW cwd?" gate, where a cross-cwd match on the OLD cwd's
   * store would falsely skip the migration and `--resume` would start
   * empty.
   */
  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    const expectedPath = grokUpdatesJsonlPath(cwd, agentSessionId);
    try {
      fs.accessSync(expectedPath);
      return expectedPath;
    } catch {
      return null;
    }
  }

  async parseTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
    return parseGrokTranscript(agentSessionId, cwd);
  }

  /**
   * Lifetime token totals from the last `turn_completed.usage` in
   * `updates.jsonl` - session-cumulative by measurement, exactly what the
   * lifetime rollup wants (see transcript-parser.ts).
   */
  async transcriptUsage(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
  }): Promise<TranscriptUsage | null> {
    if (!input.agentSessionId || !input.cwd) return null;
    return grokTranscriptUsage(input.agentSessionId, input.cwd);
  }

  async transcriptToolCounts(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
  }): Promise<TranscriptToolCounts | null> {
    if (!input.agentSessionId || !input.cwd) return null;
    return grokTranscriptToolCounts(input.agentSessionId, input.cwd);
  }

  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType === 'command-injection') {
      // chat_history.jsonl flushes the user turn on SUBMIT - measured at
      // 313ms against a 2.1s turn (see command-injection-verifier.ts).
      return createGrokCommandInjectionVerifier();
    }
    // 'paste': the hook pipeline's activity backstop covers it, matching
    // Claude's reasoning.
    return null;
  }

  /**
   * Slash input is handled in the TUI (a `/quit` opens the command palette
   * and never becomes a conversation turn - observed in the PTY capture),
   * so absence from chat_history cannot distinguish "rejected" from "ran
   * client-side". Same verdict as Codex; slash auto_commands stay
   * unverified rather than risking a destructive escalation.
   */
  canVerifySlashSubmission(): boolean {
    return false;
  }

  /**
   * CONFIRM-ONLY: the verifier confirms deliveries and drives
   * retry-on-Enter, but never authorizes a session restart. Escalation
   * needs the mock-CLI end-to-end proof (docs/command-injection.md), and
   * grok's history records carry no timestamps to bound the match window -
   * see command-injection-verifier.ts.
   */
  canEscalateOnVerificationFailure(): boolean {
    return false;
  }

  async discoverCapabilities(cliPath: string, forceRefresh?: boolean): Promise<AgentCapabilities> {
    return discoverGrokCapabilities(cliPath, forceRefresh);
  }

  /**
   * Grok has native `/model <id> [effort]` and `/effort <level>` slash
   * commands, but slash submissions are unverifiable here (see
   * `canVerifySlashSubmission`) - an unconfirmed injection that lands in
   * the prompt box as literal text would pollute the conversation. The
   * suspend + respawn fallback applies `--model` / `--reasoning-effort`
   * deterministically instead.
   */
  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    return [];
  }

  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    const match = command.match(/--model\s+"?([^\s"]+)"?/);
    if (!match) return null;
    const id = match[1];
    return { id, displayName: grokModelDisplayName(id) };
  }

  /**
   * Auth probe via `grok models`, which prints "You are not authenticated."
   * from local state (no network round-trip observed; the model list comes
   * from grok's cache). Note grok currently serves a free tier without
   * login, so `false` here means "not signed in", not "unusable".
   */
  async probeAuth(): Promise<boolean | null> {
    const info = await this.detector.detect();
    if (!info.found || !info.path) return null;
    try {
      const output = process.platform === 'win32'
        ? (await execAsync(`"${info.path}" models`, { timeout: 5000, windowsHide: true })).stdout
        : (await execFileAsync(info.path, ['models'], { timeout: 5000 })).stdout;
      return !/not authenticated/i.test(output);
    } catch {
      return null;
    }
  }

  /** One-shot title generation via the verified headless mode. */
  async summarize(prompt: string, cliPath: string, cwd: string): Promise<string> {
    return runCliPrintSummarize({
      cliPath,
      args: ['--output-format', 'plain', '-p'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
      promptVia: 'arg',
    });
  }

  /** Drop the per-worktree trust entry when Kangentic deletes the worktree. */
  async onWorktreeRemoved(worktreePath: string): Promise<void> {
    await removeWorktreeTrust(worktreePath);
  }

  /** Rename the encoded per-cwd session store and rewrite trust paths. */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateGrokProjectData(oldPath, newPath);
  }
}
