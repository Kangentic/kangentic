import { GeminiDetector } from '../gemini-detector';
import { GeminiCommandBuilder } from '../gemini-command-builder';
import { GeminiStatusParser } from '../gemini-status-parser';
import { stripGeminiKangenticHooks } from '../gemini-hook-manager';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../agent-adapter';
import type { SessionUsage, SessionEvent } from '../../../shared/types';

/**
 * Gemini CLI adapter - wraps GeminiDetector, GeminiCommandBuilder,
 * GeminiStatusParser, and gemini-hook-manager behind the generic
 * AgentAdapter interface.
 */
export class GeminiAdapter implements AgentAdapter {
  readonly name = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly sessionType = 'gemini_agent';

  private readonly detector = new GeminiDetector();
  private readonly commandBuilder = new GeminiCommandBuilder();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // No-op: Gemini CLI does not have a trust/directory-approval system.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildGeminiCommand({ geminiPath: agentPath, ...rest });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  parseStatus(raw: string): SessionUsage | null {
    return GeminiStatusParser.parseStatus(raw);
  }

  parseEvent(line: string): SessionEvent | null {
    return GeminiStatusParser.parseEvent(line);
  }

  stripHooks(directory: string): void {
    stripGeminiKangenticHooks(directory);
  }

  clearSettingsCache(): void {
    this.commandBuilder.clearSettingsCache();
  }
}
