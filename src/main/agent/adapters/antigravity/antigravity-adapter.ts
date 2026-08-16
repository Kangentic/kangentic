import fs from 'node:fs';
import { AntigravityDetector } from './detector';
import { AntigravityCommandBuilder } from './command-builder';
import { removeHooks as removeAntigravityHooks } from './hook-manager';
import { ensureWorkspaceTrust, removeWorkspaceTrust } from './trust-manager';
import { migrateAntigravityProjectData } from './project-relocation';
import { AntigravityStatusParser } from './status-parser';
import { discoverAntigravityCapabilities } from './capability-discovery';
import {
  createAntigravityInjectionVerifier,
  locateAntigravityTranscriptFile,
  parseAntigravityTranscript,
  parseAntigravityTranscriptFile,
} from './transcript-parser';
import { antigravityTranscriptPath } from './data-paths';
import { runAntigravityPrint } from './print-runner';
import { buildSummarizePrompt, cleanSummarizeOutput } from '../../shared/auto-name';
import type {
  AgentAdapter,
  AgentInfo,
  ParsedTranscript,
  SpawnCommandOptions,
} from '../../agent-adapter';
import type {
  AgentCapabilities,
  AgentLiveTelemetryUnsupported,
  AgentPermissionEntry,
  AdapterRuntimeStrategy,
  PermissionMode,
  PerToolStat,
  SubmissionContextType,
  SubmissionVerifier,
  TranscriptToolCounts,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

const CONVERSATION_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Google Antigravity CLI (`agy`) adapter. Every behavior below was verified
 * against a real agy 1.1.13 install (2026-08-16, the E1/E2/E3 rig runs):
 * hooks, trust, MCP-via-workspace-plugin, `--conversation` resume, the
 * brain-dir transcript, print mode, and the double-Ctrl+C exit. Antigravity
 * shares `~/.gemini` with the Gemini CLI but keeps its own subtree, its own
 * trust store, and a different hook/MCP schema - hence a sibling adapter
 * rather than a Gemini variant.
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly name = 'antigravity';
  readonly displayName = 'Antigravity CLI';
  readonly sessionType = 'antigravity_agent';
  // No flag pre-assigns a NEW conversation id; agy allocates one lazily at
  // the first turn and Kangentic captures it (hooks / PTY scrape).
  readonly supportsCallerSessionId = false;
  // Mapped onto agy's native autonomy flags in the command builder
  // (--mode plan / --mode accept-edits / --dangerously-skip-permissions;
  // no flag = agy's own "request-review" default).
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only Research)' },
    { mode: 'default', label: 'Default (Request Review)' },
    { mode: 'acceptEdits', label: 'Accept Edits (Auto-Approve Edits)' },
    { mode: 'bypassPermissions', label: 'Skip Permissions (Auto-Approve All)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new AntigravityDetector();
  private readonly commandBuilder = new AntigravityCommandBuilder();
  // Set of taskIds currently holding hook injections per directory. agy has
  // no per-spawn settings flag, so `.agents/hooks.json` is shared across
  // concurrent sessions in one cwd; removeHooks() only strips the file when
  // the last taskId releases (the Gemini refcount pattern, same rationale).
  private readonly hookHolders = new Map<string, Set<string>>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async discoverCapabilities(cliPath: string, forceRefresh?: boolean): Promise<AgentCapabilities> {
    return discoverAntigravityCapabilities(cliPath, forceRefresh);
  }

  async ensureTrust(workingDirectory: string): Promise<void> {
    // Pre-seeding `trustedWorkspaces` skips the TUI's first-run workspace
    // trust confirmation, which would otherwise block an automated spawn.
    await ensureWorkspaceTrust(workingDirectory);
  }

  /** Symmetric cleanup so trustedWorkspaces does not grow a dead entry per task. */
  async onWorktreeRemoved(worktreePath: string): Promise<void> {
    await removeWorkspaceTrust(worktreePath);
  }

  /** Trust + `-c` continuity follow a moved project/worktree path. */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateAntigravityProjectData(oldPath, newPath);
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    const command = this.commandBuilder.buildAntigravityCommand({
      agyPath: agentPath,
      ...rest,
    });
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

  removeHooks(directory: string, taskId?: string): void {
    const holders = this.hookHolders.get(directory);
    if (holders && taskId) {
      holders.delete(taskId);
      if (holders.size > 0) return; // another session still needs the hooks
      this.hookHolders.delete(directory);
    }
    removeAntigravityHooks(directory);
  }

  clearSettingsCache(): void {
    // The command builder reads hooks.json fresh on every spawn (no cache),
    // so there is nothing to clear.
  }

  /**
   * Seed the board card's model pill from a `--model <slug>` override before
   * telemetry could report it - which for Antigravity never comes (no usage
   * channel), making this the model pill's ONLY source.
   */
  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    const match = command.match(/--model\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const id = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!id) return null;
    return { id, displayName: antigravityModelDisplayName(id) };
  }

  /**
   * Double Ctrl+C: the first prints "press ctrl+c again to exit" (or cancels
   * a running turn), the second exits gracefully - flushing
   * `last_conversations.json` and printing the shutdown summary whose
   * `agy --conversation=<uuid>` line the fromOutput scraper reads. Verified
   * against 1.1.13; agy has no /quit slash command.
   */
  getExitSequence(): string[] {
    return ['\x03', '\x03'];
  }

  /**
   * The TUI's first paint (logo + "Welcome to the Antigravity CLI") arrives
   * as one burst well under a second after spawn. Any nonempty chunk after
   * the shell handoff means the CLI is drawing.
   */
  detectFirstOutput(data: string): boolean {
    return data.length > 0;
  }

  async locateSessionHistoryFile(agentSessionId: string, _cwd: string): Promise<string | null> {
    // The brain-dir transcript appears when the first turn starts; poll
    // briefly since callers locate right after id capture.
    for (let attempt = 0; attempt < 10; attempt++) {
      const located = locateAntigravityTranscriptFile(agentSessionId);
      if (located) return located;
      await sleep(500);
    }
    return null;
  }

  async parseTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
    return parseAntigravityTranscript(agentSessionId, cwd);
  }

  /**
   * Cumulative tool-call counts read off the brain-dir transcript, so a
   * parked/suspended session's rollup does not report 0. Counts tool_use
   * blocks (each `tool_calls` entry of each PLANNER_RESPONSE step);
   * durations/interruptions are not derivable from the transcript.
   */
  async transcriptToolCounts(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
  }): Promise<TranscriptToolCounts | null> {
    const transcriptPath = input.transcriptPath
      ?? (input.agentSessionId ? antigravityTranscriptPath(input.agentSessionId) : null);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const parsed = parseAntigravityTranscriptFile(transcriptPath);

    const byTool = new Map<string, number>();
    let toolCallCount = 0;
    for (const entry of parsed.entries) {
      if (entry.kind !== 'assistant') continue;
      for (const block of entry.blocks) {
        if (block.type !== 'tool_use') continue;
        toolCallCount += 1;
        byTool.set(block.name, (byTool.get(block.name) ?? 0) + 1);
      }
    }
    if (toolCallCount === 0) return null;

    const toolBreakdown: PerToolStat[] = Array.from(byTool.entries()).map(
      ([toolName, callCount]) => ({ toolName, callCount, totalDurationMs: 0, interruptedCount: 0 }),
    );
    return { toolCallCount, toolBreakdown };
  }

  /**
   * Command-injection verifier over the brain-dir transcript. Gated on the
   * measured submit-time flush (scripts/measure-injection-flush.mjs,
   * 2026-08-16 vs agy 1.1.13: worst observed append latency 84ms across
   * short AND long turns, so the transcript flushes on submit, not turn-end;
   * recorded in docs/command-injection.md). Both `mode`s verify with
   * submitted semantics - the text became a USER_INPUT turn - because this
   * adapter never emits settings slash-commands (`command-match`'s discrete
   * invocation contract has no Antigravity producer).
   */
  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType !== 'command-injection') return null;
    return async (context) => {
      if (context.type !== 'command-injection' || !context.agentSessionId) return false;
      const verifier = createAntigravityInjectionVerifier(
        antigravityTranscriptPath(context.agentSessionId),
      );
      if (!verifier) return false;
      return verifier(context.text, context.sentAt ?? Date.now());
    };
  }

  /**
   * Slash text never reaches the transcript: the TUI rejects an unregistered
   * `/command` client-side ("Unknown command", measured in the slash probe),
   * so absence in history is ambiguous and slash auto_commands are tagged
   * verify: 'none' by prepareInjectionPlan.
   */
  canVerifySlashSubmission(): boolean {
    return false;
  }

  /**
   * Never escalate on a failed verification: escalation restarts the session
   * and destroys live work, and per the interface contract it requires the
   * verifier to have been watched confirming a real submission in a running
   * app - evidence the flush measurement alone does not provide.
   */
  canEscalateOnVerificationFailure(): boolean {
    return false;
  }

  /**
   * Auto-name via a hidden-PTY print run (`agy -p ... --output-format json`).
   * The PTY is load-bearing: `agy -p` hangs when stdio is not a TTY
   * (upstream #318), so the shared child_process summarize runner cannot be
   * used. Runs in a pre-trusted scratch cwd so it neither blocks on the
   * trust prompt nor hijacks the project workspace's `agy -c` mapping.
   */
  async summarize(prompt: string, cliPath: string, _cwd: string): Promise<string> {
    const response = await runAntigravityPrint(cliPath, buildSummarizePrompt(prompt));
    const cleaned = cleanSummarizeOutput(response);
    if (!cleaned) throw new Error('summarize produced empty output');
    return cleaned;
  }

  /**
   * No live token/context channel exists: the interactive transcript and the
   * hook payloads carry no usage (verified 1.1.13), and print-mode usage
   * does not apply to interactive sessions. The model pill is still seeded
   * from a `--model` override via configuredModelFromCommand.
   */
  readonly liveTelemetryUnsupported: AgentLiveTelemetryUnsupported = {
    unavailableLabel: 'Telemetry: TUI only',
    unavailableTitle:
      'Antigravity does not stream live telemetry to Kangentic.\n'
      + 'The agy TUI footer shows the active model and effort; per-thought\n'
      + 'token counts appear inline in its output.',
  };

  /**
   * Runtime strategy - how agy exposes activity and session ids.
   *
   * - statusFile: the hook -> event-bridge -> events.jsonl pipeline
   *   (parseStatus is always null; agy has no usage channel).
   * - Activity: hooks primary (PreInvocation -> prompt starts a turn,
   *   Stop -> idle ends it; Stop's payload carries `fullyIdle: true`), PTY
   *   silence fallback for print-mode spawns where hooks do not fire
   *   (verified) and for the no-space-free-path case where hook wiring is
   *   skipped. detectIdle matches the idle footer's "? for shortcuts",
   *   which never paints while a turn runs (the running footer shows
   *   "esc to cancel" instead).
   * - sessionId.fromHook: every hook payload carries `conversationId`
   *   (camelCase protojson); delivered via the PreInvocation entry's
   *   captureHookContext directive since agy has no once-per-session hook.
   * - sessionId.fromOutput: the graceful-shutdown summary prints
   *   `agy --conversation=<uuid>`, and a print-mode run emits
   *   `"conversation_id":"<uuid>"` in its JSON result. The suspend-time
   *   scrollback scan reads the former even when hooks never fired.
   * - No fromFilesystem: `last_conversations.json` is written only at CLI
   *   exit (verified), after the spawn-time polling window has closed.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    statusFile: {
      parseStatus: AntigravityStatusParser.parseStatus,
      parseEvent: AntigravityStatusParser.parseEvent,
      isFullRewrite: false,
    },
    activity: ActivityDetection.hooksAndPty((data: string) => {
      const clean = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '');
      return /\?\s+for shortcuts/.test(clean);
    }),
    sessionId: {
      fromHook(hookContext) {
        try {
          const context = JSON.parse(hookContext) as { conversationId?: unknown };
          if (typeof context.conversationId === 'string' && context.conversationId.length > 0) {
            console.log(`[antigravity] Captured conversation ID from hook: ${context.conversationId.slice(0, 16)}...`);
            return context.conversationId;
          }
          return null;
        } catch {
          return null;
        }
      },
      fromOutput(data) {
        const shutdownMatch = data.match(new RegExp(`agy\\s+--conversation=(${CONVERSATION_UUID})`));
        if (shutdownMatch) return shutdownMatch[1];
        const printMatch = data.match(new RegExp(`"conversation_id"\\s*:\\s*"(${CONVERSATION_UUID})"`));
        return printMatch ? printMatch[1] : null;
      },
    },
  };
}

/**
 * Friendly display name for an agy model slug, mirroring the CLI's own
 * `agy models` display column: `gemini-3.1-pro-high` -> "Gemini 3.1 Pro
 * (High)", `claude-opus-4-6-thinking` -> "Claude Opus 4.6 Thinking",
 * `gpt-oss-120b-medium` -> "GPT-OSS 120B (Medium)". Heuristic; an
 * unrecognized shape falls back to the raw slug.
 */
export function antigravityModelDisplayName(slug: string): string {
  const rawParts = slug.split('-').filter((part) => part.length > 0);
  if (rawParts.length === 0) return slug;

  // Version numbers hyphenate in slugs (`claude-opus-4-6`) but render dotted
  // (`Opus 4.6`): merge runs of purely numeric tokens with dots.
  const parts: string[] = [];
  for (const part of rawParts) {
    const previous = parts[parts.length - 1];
    if (/^\d+$/.test(part) && previous !== undefined && /^\d+(\.\d+)*$/.test(previous)) {
      parts[parts.length - 1] = `${previous}.${part}`;
    } else {
      parts.push(part);
    }
  }

  let effortSuffix = '';
  const lastPart = parts[parts.length - 1];
  if (['high', 'medium', 'low'].includes(lastPart)) {
    parts.pop();
    effortSuffix = ` (${lastPart[0].toUpperCase()}${lastPart.slice(1)})`;
  }

  const words = parts.map((part) => {
    if (part === 'gpt') return 'GPT';
    if (part === 'oss') return 'OSS';
    if (/^\d/.test(part)) return part.toUpperCase() === part ? part : part.replace(/b$/, 'B');
    return part[0].toUpperCase() + part.slice(1);
  });

  // The GPT-OSS family hyphenates its first two tokens in agy's own display.
  if (words[0] === 'GPT' && words[1] === 'OSS') {
    return ['GPT-OSS', ...words.slice(2)].join(' ') + effortSuffix;
  }
  return words.join(' ') + effortSuffix;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
