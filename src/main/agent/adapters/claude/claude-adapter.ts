import { ClaudeDetector } from './detector';
import { CommandBuilder } from './command-builder';
import { ClaudeStatusParser } from './status-parser';
import { ClaudeSessionHistoryParser } from './session-history-parser';
import { ensureWorktreeTrust, ensureMcpServerTrust } from './trust-manager';
import { stripKangenticHooks } from './hook-manager';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { SessionUsage, SessionEvent, AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy } from '../../../../shared/types';
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

  parseStatus(raw: string): SessionUsage | null {
    return ClaudeStatusParser.parseStatus(raw);
  }

  parseEvent(line: string): SessionEvent | null {
    return ClaudeStatusParser.parseEvent(line);
  }

  // Claude uses caller-owned session IDs via --session-id, so no capture needed.
  // The native session log at ~/.claude/projects/<slug>/<sessionId>.jsonl runs
  // alongside the hook-based status.json/events.jsonl pipeline. Both feed
  // UsageTracker.setSessionUsage, which merges partial updates safely.
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.hooks(),
    sessionHistory: {
      locate: ClaudeSessionHistoryParser.locate,
      parse: ClaudeSessionHistoryParser.parse,
      isFullRewrite: false,
    },
  };

  stripHooks(directory: string): void {
    stripKangenticHooks(directory);
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

  transformHandoffPrompt(prompt: string, _contextFilePath: string): string {
    return prompt + '\n\nYou can also use the `kangentic_get_handoff_context` MCP tool for structured access to the prior work context.';
  }
}
