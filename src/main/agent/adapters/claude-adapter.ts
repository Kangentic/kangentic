import { ClaudeDetector } from '../claude-detector';
import { CommandBuilder } from '../command-builder';
import { ClaudeStatusParser } from '../claude-status-parser';
import { ensureWorktreeTrust, ensureMcpServerTrust } from '../trust-manager';
import { stripKangenticHooks } from '../hook-manager';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../agent-adapter';
import type { SessionUsage, SessionEvent } from '../../../shared/types';

/**
 * Claude Code adapter - wraps ClaudeDetector, CommandBuilder,
 * ClaudeStatusParser, trust-manager, and hook-manager behind
 * the generic AgentAdapter interface.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';
  readonly sessionType = 'claude_agent';

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
    return this.commandBuilder.buildClaudeCommand({ claudePath: agentPath, ...rest });
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

  stripHooks(directory: string): void {
    stripKangenticHooks(directory);
  }

  clearSettingsCache(): void {
    this.commandBuilder.clearSettingsCache();
  }
}
