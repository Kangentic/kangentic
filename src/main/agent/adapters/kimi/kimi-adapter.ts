import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';
import { SharedFolderHolds } from '../../shared/shared-folder-holds';
import type { RemoteFileDeclaration } from '../../shared/remote-files';
import { WSL_MCP_TOKEN_ENV } from '../../shared/wsl-hook-transport';
import { resolveCliTarget, type CliPlace } from '../../shared/cli-target';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import { KimiCommandBuilder, kimiMcpWiringEnabled } from './command-builder';
import { KimiSessionHistoryParser, locateKimiWireFile } from './session-history-parser';
import { parseKimiTranscript, parseKimiTranscriptWindow, readKimiTranscriptPage } from './transcript-parser';
import { kimiTranscriptToolCounts, kimiTranscriptUsage } from './transcript-usage';
import { discoverKimiCapabilities } from './capability-discovery';
import { kimiProjectMcpConfigProblem, removeKimiProjectMcpConfig } from './mcp-config';
import { findKimiSessionDir, kimiSessionDeleted } from './session-index';
import { kimiCredentialsDir, kimiMainWirePath } from './kimi-home';
import { KIMI_SUBAGENT_TOOL, parseKimiSubagentUsage, statKimiSubagentTranscripts } from './subagent-transcripts';
import { kimiModelByAlias, readKimiCodeConfig } from './config-toml';
import { contentPartsText } from './wire-parser';
import type {
  AgentAdapter,
  AgentInfo,
  SpawnCommandOptions,
  SettingsChangeSpec,
  ParsedSubagentUsage,
  ParsedTranscript,
  ParsedTranscriptWindow,
  SubagentTranscriptSignature,
  SummarizeOptions,
  TranscriptPageReadRequest,
  TranscriptPageReadResult,
} from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SubmissionContextType,
  SubmissionVerifier,
  AgentCapabilities,
  ExitSequenceStep,
  TranscriptToolCounts,
  TranscriptUsage,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/** A folder no project holds, so the CLI finds no 1.x data to offer to migrate. See `buildEnv`. */
const KIMI_MIGRATION_OFF_SOURCE = '.kangentic-no-kimi-cli-data';

/**
 * A Kimi Code session id: `session_<uuid>` in the 2.4.1 source
 * (`sessionLifecycleService.ts`); the docs show a ULID, so both are read.
 */
const SESSION_ID_SOURCE = '(session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-Za-z]))';

/**
 * Kimi Code CLI adapter (Moonshot AI, npm `@moonshot-ai/kimi-code`, binary
 * `kimi`, github.com/MoonshotAI/kimi-code).
 *
 * Built for Kimi Code CLI 2.4.1 (npm `latest`, published 2026-10-30) from its
 * documentation and source, read 2026-11-03; none of it has been checked
 * against a real run yet. The concept doc (`docs/integrations/agents/
 * kimi-code.md`) lists what needs a live probe. The Python `kimi-cli` 1.x this
 * adapter drove before is archived, and its last release (1.52.0) runs no
 * agent, so a 1.x install reads as not installed (`parseKimiVersion`).
 *
 * - Interactive session: `kimi [--session <id>] [--model <alias>]
 *   [--plan | --yolo | --auto]`, in the PTY's cwd. It takes no starting prompt,
 *   so the engine types the first prompt and every resume prompt in
 *   (`freshPromptDelivery`, `resumePromptDelivery`).
 * - Session ids are the CLI's own (`--session` only resumes), captured from
 *   the welcome box on a resume, the exit hint, or `session_index.jsonl`.
 * - Activity, usage, the live model and the transcript come from the main
 *   agent's `wire.jsonl` (protocol 1.5).
 * - Kangentic's MCP server goes into the folder's `.kimi-code/mcp.json`.
 */
export class KimiAdapter implements AgentAdapter {
  readonly name = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly sessionType = 'kimi_agent';
  /** `--session <id>` resumes and never creates (`kimi-command.md`). */
  readonly supportsCallerSessionId = false;
  /** From the welcome box, the exit hint, or the session index (`runtime.sessionId`). */
  readonly capturesInteractiveSessionId = true;
  /**
   * The interactive session takes no prompt on its command line: a positional
   * argument fails with "unknown command", and `-p` runs one prompt and exits
   * (`apps/kimi-code/src/cli/commands.ts`). A resume's message is typed in.
   */
  readonly resumePromptDelivery = 'typed' as const;
  /** The same for a fresh session's first prompt. */
  readonly freshPromptDelivery = 'typed' as const;
  /** The literal URL goes into the folder's `.kimi-code/mcp.json`; the token stays in the environment. */
  readonly kangenticMcp = 'shared-folder' as const;
  /** A Kimi Code installed in a WSL distro runs there (#286). */
  readonly supportsWslCli = true;
  /**
   * On a remote host over SSH the CLI is `kimi` from the host's own login PATH (#913). Its sessions,
   * wire file and index stay on the host, so the transcript and the id pass read nothing there: the id
   * comes from the welcome box or the exit hint, and activity from the terminal.
   */
  readonly remoteCliName = 'kimi';

  /**
   * The one file a Kimi on a remote host has edited on the host (#913): the project's
   * `.kimi-code/mcp.json`, where Kangentic's stdio bridge entry is merged beside the user's servers. The
   * token stays in the session's environment, so the file holds no secret.
   */
  remoteFiles(): RemoteFileDeclaration {
    return { home: [], project: ['.kimi-code/mcp.json'] };
  }
  /**
   * Kimi Code's three permission modes plus Plan mode
   * (`en/guides/interaction.md`): Always Ask (`manual`, the default),
   * Ask When Needed (`--yolo`), Never Ask (`--auto`). It has no accept-edits or
   * deny-unless-allowed mode.
   */
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only)' },
    { mode: 'default', label: 'Always Ask' },
    { mode: 'auto', label: 'Ask When Needed (YOLO)' },
    { mode: 'bypassPermissions', label: 'Never Ask (Auto)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';
  /** Every resume appends to one `wire.jsonl`, and each record has its time. */
  readonly scopesTranscriptReadsByTime = true;
  /** The `Agent` tool starts a subagent (`en/reference/tools.md`). */
  readonly subagentSpawnToolName = KIMI_SUBAGENT_TOOL;
  /** `Write` and `Edit` name their file by `path` (`en/reference/tools.md`). */
  readonly fileChangeTools = [
    { tool: 'Write', pathField: 'path' },
    { tool: 'Edit', pathField: 'path' },
  ] as const;

  private readonly detector = new AgentDetector({
    binaryName: 'kimi',
    fallbackPaths: kimiFallbackPaths(),
    parseVersion: parseKimiVersion,
    supportsWslCli: true,
  });

  private readonly commandBuilder = new KimiCommandBuilder();
  /** Sessions relying on a folder's `.kimi-code/mcp.json`. See SharedFolderHolds. */
  private readonly mcpHolds = new SharedFolderHolds();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // Kimi Code asks whether to trust every untrusted folder, and a declined
    // prompt exits. `KIMI_CODE_TRUST_WORKSPACE=1` in the session's environment
    // answers it for that process alone and writes no trust record
    // (`en/configuration/env-vars.md`), so nothing is written here.
  }

  /**
   * Whether Kimi Code can reach a model: a `/login` credential in
   * `credentials/<name>.json`, or a model the user configured in
   * `config.toml` (`en/configuration/data-locations.md`,
   * `config-files.md`). A WSL install is read in its distro's home.
   */
  async probeAuth(cliPath: string): Promise<boolean | null> {
    let place: CliPlace | null;
    try {
      place = await resolveCliTarget(cliPath, true);
    } catch {
      return null;
    }
    try {
      const credentials = fs.readdirSync(kimiCredentialsDir(place)).filter((entry) => entry.endsWith('.json'));
      if (credentials.length > 0) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    return readKimiCodeConfig(place).models.length > 0;
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    const kimiOptions = { kimiPath: agentPath, ...rest };
    const command = this.commandBuilder.buildKimiCommand(kimiOptions);
    // The folder's mcp.json is shared, so it is stripped only when its last
    // session releases it.
    if (kimiMcpWiringEnabled(kimiOptions)) this.mcpHolds.retain(options.ptySessionId, options.cwd);
    return command;
  }

  /**
   * The session's environment (`en/configuration/env-vars.md`):
   * - `KIMI_CODE_TRUST_WORKSPACE=1` answers the folder trust prompt for this
   *   process, and loads the project `.kimi-code/mcp.json` Kangentic writes.
   * - `KIMI_CODE_NO_AUTO_UPDATE=1` turns off the update preflight, whose
   *   prompt would take the typed first prompt as its answer.
   * - `KIMI_MODEL_THINKING_EFFORT` carries a column's effort; the CLI has no
   *   effort flag. The docs say it applies to the `kimi` provider only.
   * - `KIMI_SHARE_DIR` names a folder that does not exist, which turns off the
   *   first-launch migration screen shown when `~/.kimi` holds 1.x data. That
   *   screen's default is "Migrate now", so the typed first prompt's Enter
   *   would start a migration and the prompt would be lost. No doc lists this:
   *   the source does (`apps/kimi-code/src/migration/legacy-source.ts` reads
   *   the variable, `detect-pending.ts` stops at a missing folder), and only
   *   the migration code reads it. It is relative so a WSL distro needs no path
   *   translation. `kimi migrate` run from the user's own shell still works.
   */
  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    const env: Record<string, string> = {
      KIMI_CODE_TRUST_WORKSPACE: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_SHARE_DIR: KIMI_MIGRATION_OFF_SOURCE,
    };
    // The folder's mcp.json names this variable and never holds the token.
    if (kimiMcpWiringEnabled(options)) env[WSL_MCP_TOKEN_ENV] = options.mcpServerToken;
    if (options.effort && options.effort.trim().length > 0) env.KIMI_MODEL_THINKING_EFFORT = options.effort.trim();
    return env;
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  kangenticMcpBlockedReason(workingDirectory: string): string | null {
    return kimiProjectMcpConfigProblem(workingDirectory);
  }

  readonly runtime: AdapterRuntimeStrategy = {
    // Its wire `turn.ended` record reaches the engine as an Idle event.
    reportsTurnEnd: true,
    activity: ActivityDetection.hooksAndPty((data: string) => {
      // Until the first wire record (a new session has none until its first
      // message) the PTY covers the gap: an input prompt glyph alone on the
      // cursor row. Not measured against the 2.x TUI.
      const stripped = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      return /(?:^|\n)\s*[>❯]\s*$/.test(stripped);
    }),
    sessionId: {
      fromOutput(data: string): string | null {
        // Welcome box on a resume: "Session:   <id>" (`welcome.ts`).
        const banner = data.match(new RegExp(`Session:\\s+${SESSION_ID_SOURCE}`));
        if (banner) return banner[1];
        // Exit hint: "To resume this session: kimi -r <id>" (`run-shell.ts`).
        const resume = data.match(new RegExp(`kimi\\s+-r\\s+${SESSION_ID_SOURCE}`));
        return resume ? resume[1] : null;
      },
      fromFilesystem: KimiSessionHistoryParser.captureSessionIdFromFilesystem,
    },
    sessionHistory: {
      locate: KimiSessionHistoryParser.locate,
      parse: KimiSessionHistoryParser.parse,
      createParse: KimiSessionHistoryParser.createParse,
      // Records are appended through the CLI's persist queue
      // (`packages/agent-core-v2/src/wire`); not yet measured across a resume.
      isFullRewrite: false,
    },
  };

  removeHooks(directory: string, sessionId?: string): void {
    // No hooks are written (Kimi Code reads them only from the user's own
    // config.toml), but the folder's .kimi-code/mcp.json entry is. Strip it
    // once the folder's last session releases it; a call with no session id
    // (the project-delete sweep) strips it whoever holds it.
    const folder = this.mcpHolds.release(sessionId, directory);
    if (folder) removeKimiProjectMcpConfig(folder);
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // A verifier is added only for a history measured to flush on submit, and
    // the 2.x wire has not been measured. The paste engine's activity and
    // data-floor backstops cover both contexts.
    return null;
  }

  /**
   * Esc, a pause, then `/exit` (`en/reference/slash-commands.md`). Esc
   * interrupts a streaming turn (`en/guides/interaction.md`), and avoids
   * Ctrl+C, whose first press on an idle prompt only arms a status-bar exit
   * that any other key cancels. Not probed against a live session.
   */
  getExitSequence(): ExitSequenceStep[] {
    return ['\x1b', { delayMs: 400 }, '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Full-screen TUI: the cursor hides when it starts drawing.
    return data.includes('\x1b[?25l');
  }

  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    // The builder never puts a prompt on the command line, so every --model
    // in it is the flag. quoteArg emits single quotes on POSIX shells and
    // double quotes elsewhere.
    const match = command.match(/(?:^|\s)--model\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const id = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
    if (!id) return null;
    return { id, displayName: this.modelDisplayName(id) ?? id };
  }

  /** A model alias's `display_name` from `config.toml`, when it sets one. */
  modelDisplayName(modelId: string): string | null {
    return kimiModelByAlias(modelId)?.displayName ?? null;
  }

  async locateSessionHistoryFile(agentSessionId: string, _cwd: string, place?: CliPlace | null): Promise<string | null> {
    return locateKimiWireFile(agentSessionId, place ?? null);
  }

  async parseTranscript(agentSessionId: string, _cwd: string, place?: CliPlace | null): Promise<ParsedTranscript> {
    const filePath = locateKimiWireFile(agentSessionId, place ?? null);
    if (!filePath) return { entries: [], sourcePath: null };
    return { entries: await parseKimiTranscript(agentSessionId, filePath), sourcePath: filePath };
  }

  async parseTranscriptWindow(
    agentSessionId: string,
    _cwd: string,
    startByte: number,
    maxBytes: number,
    _attributedMessageIds?: Set<string>,
    place?: CliPlace | null,
  ): Promise<ParsedTranscriptWindow> {
    const filePath = locateKimiWireFile(agentSessionId, place ?? null);
    if (!filePath) return { entries: [], sourcePath: null, nextByteOffset: startByte, totalBytes: 0, firstByteOffset: startByte, endByte: startByte };
    const window = await parseKimiTranscriptWindow(agentSessionId, filePath, startByte, maxBytes);
    return { ...window, sourcePath: filePath };
  }

  /**
   * One page of the history for the Conversation viewer. A text run a page
   * edge cuts comes back as two rows (see `parseKimiLines`).
   */
  async readTranscriptPage(
    agentSessionId: string,
    _cwd: string,
    request: TranscriptPageReadRequest,
    place?: CliPlace | null,
  ): Promise<TranscriptPageReadResult> {
    const filePath = locateKimiWireFile(agentSessionId, place ?? null);
    if (!filePath) return { status: 'unavailable', reason: 'file_missing' };
    return readKimiTranscriptPage(agentSessionId, filePath, request);
  }

  async transcriptUsage(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
    place?: CliPlace | null;
  }): Promise<TranscriptUsage | null> {
    const filePath = this.transcriptPathOf(input);
    return filePath ? kimiTranscriptUsage(filePath) : null;
  }

  async transcriptToolCounts(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
    sinceMs?: number | null;
    untilMs?: number | null;
    place?: CliPlace | null;
  }): Promise<TranscriptToolCounts | null> {
    const filePath = this.transcriptPathOf(input);
    return filePath ? kimiTranscriptToolCounts(filePath, { sinceMs: input.sinceMs, untilMs: input.untilMs }) : null;
  }

  statSubagentTranscripts(agentSessionId: string, _cwd: string, place?: CliPlace | null): SubagentTranscriptSignature | null {
    const sessionDir = findKimiSessionDir(agentSessionId, place ?? null);
    return sessionDir ? statKimiSubagentTranscripts(sessionDir) : null;
  }

  async parseSubagentUsage(agentSessionId: string, _cwd: string, place?: CliPlace | null): Promise<ParsedSubagentUsage> {
    const sessionDir = findKimiSessionDir(agentSessionId, place ?? null);
    if (!sessionDir) return { directoryPresent: false, complete: true, sourcePath: '', turns: [], spawnLinks: [] };
    return parseKimiSubagentUsage(sessionDir, kimiMainWirePath(sessionDir));
  }

  /**
   * True only on proof: `session_index.jsonl` records the session as deleted
   * (`{sessionId, deleted: true}`). A resume of a session the CLI cannot find
   * fails with `Session "<id>" not found.` (`apps/kimi-code/src/cli`).
   */
  async proveConversationGone(params: { agentSessionId: string; place?: CliPlace | null }): Promise<boolean> {
    return kimiSessionDeleted(params.agentSessionId, params.place ?? null);
  }

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverKimiCapabilities(cliPath);
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // `/model <alias>` checks the alias, then opens the picker preselected
    // rather than switching (`apps/kimi-code/src/tui/commands/config.ts`), and
    // there is no effort command. So a live swap has nothing to type.
    return [];
  }

  /**
   * A task title from Kimi Code's one-prompt run, `-p <prompt>`
   * (`apps/kimi-code/src/cli/v2/run-v2-print.ts`). The prompt can only be an
   * argument, which a title fits. It goes on one line: an npm install runs
   * through a `.cmd` shim, and cmd.exe ends a command at the first line break.
   * `--output-format stream-json` prints one JSON message per line, and the
   * title is the last assistant line's text.
   *
   * `-p` runs in Never Ask mode and cannot be combined with `--plan`, so the
   * run takes the answer home as its cwd, never the project. It also saves a
   * session there; the CLI has no command that deletes one.
   */
  async summarize(prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions): Promise<string> {
    return runCliPrintSummarize({
      cliPath,
      args: [...(options?.model ? ['--model', options.model] : []), '--output-format', 'stream-json', '-p'],
      prompt: buildSummarizePrompt(prompt).replace(/\s*\r?\n\s*/g, ' '),
      promptVia: 'arg',
      cwd,
      extractRaw: lastAssistantText,
      // A Kimi Code installed in a WSL distro runs there.
      cliTarget: await resolveCliTarget(cliPath, true),
    });
  }

  private transcriptPathOf(input: { transcriptPath?: string | null; agentSessionId?: string | null; place?: CliPlace | null }): string | null {
    if (input.agentSessionId) {
      const located = locateKimiWireFile(input.agentSessionId, input.place ?? null);
      if (located) return located;
    }
    return input.transcriptPath ?? null;
  }
}

/**
 * The text of the last `{"role":"assistant"}` line of a `-p --output-format
 * stream-json` run (`apps/kimi-code/src/cli/v2/prompt-render.ts`). Its
 * `content` is a string or content parts; other lines (`role: "tool"`,
 * `role: "meta"`) are skipped.
 */
export function lastAssistantText(stdout: string): string {
  let last = '';
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.role !== 'assistant') continue;
    const text = contentPartsText(record.content);
    if (text && text.trim().length > 0) last = text;
  }
  return last;
}

/**
 * A `kimi --version` line from Kimi Code CLI, which prints the bare version
 * (commander's `.version()`). npm has its 0.x and 2.x releases and no 1.x, and
 * 2.0.0 changed no format (`apps/kimi-code/CHANGELOG.md`), so the output's
 * shape decides this, not the number. The archived Python kimi-cli prints
 * `kimi, version 1.x` and, from 1.52.0, runs no agent; it is not this CLI, so
 * it reads as not installed.
 */
export function parseKimiVersion(raw: string): string | null {
  const text = raw.trim();
  if (/^kimi(?:-cli)?,\s*version\b/i.test(text)) return null;
  const match = text.match(/^(?:kimi(?:-code)?\s+)?v?(\d+\.\d+\.\d+\S*)/i);
  return match ? match[1] : null;
}

/**
 * Where the install script puts the binary when it is not on PATH
 * (`en/guides/getting-started.md`): `~/.kimi-code/bin/kimi`, or
 * `%USERPROFILE%\.kimi-code\bin\kimi.exe`. An npm global install is on PATH.
 */
function kimiFallbackPaths(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') return [path.join(home, '.kimi-code', 'bin', 'kimi.exe')];
  return [path.join(home, '.kimi-code', 'bin', 'kimi'), ...standardUnixFallbackPaths('kimi')];
}
