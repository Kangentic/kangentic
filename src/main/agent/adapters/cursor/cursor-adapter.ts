import fs from 'node:fs';
import path from 'node:path';
import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { AgentDetector } from '../../shared/agent-detector';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import { CursorStreamParser } from './stream-parser';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import { runCliPrintAnswer, forwardStreamLines, ANSWER_STREAM_OUTPUT_BUDGET } from '../../shared/cli-answer';
import { SharedFolderHolds } from '../../shared/shared-folder-holds';
import { execCliForTarget, resolveCliTarget, type CliTarget } from '../../shared/cli-target';
import { kangenticMcpServer, mcpBridgeScriptEnv, startRunMcpRelay } from '../../shared/kangentic-mcp-server';
import { withAnswerRunDirectory } from '../../shared/answer-run-directory';
import { discoverCursorCapabilities, resolveCachedCursorModel } from './capability-discovery';
import { createCursorAnswerReducer, cursorInitSessionId, extractCursorAnswer } from './answer-stream';
import {
  CURSOR_KANGENTIC_MCP_ENTRY,
  CURSOR_MCP_TOKEN_ENV,
  CURSOR_MCP_URL_ENV,
  cursorAnswerHome,
  cursorKangenticMcpEntry,
  removeCursorChat,
  writeCursorAnswerWorkspace,
  type CursorKangenticMcpEntry,
} from './answer-workspace';
import { cursorProjectMcpConfigProblem, removeCursorProjectMcpConfig, writeCursorProjectMcpConfig } from './project-mcp-config';
import type { AgentAdapter, AgentInfo, AnswerFromContextOptions, SpawnCommandOptions, SettingsChangeSpec, SummarizeOptions } from '../../agent-adapter';
import type {
  AgentCapabilities,
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SessionUsage,
  SessionContext,
  SessionAttachment,
  SubmissionContextType,
  SubmissionVerifier,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';


/** Kangentic's MCP server is wired when it is on and both its URL and token are known (the server refuses a request without the token). */
function cursorMcpWiringEnabled(
  options: SpawnCommandOptions,
): options is SpawnCommandOptions & { mcpServerUrl: string; mcpServerToken: string } {
  return options.mcpServerEnabled !== false && Boolean(options.mcpServerUrl) && Boolean(options.mcpServerToken);
}

/**
 * The entry a session's folder gets. A Cursor in a WSL distro on NAT
 * networking gets the bridge, prepared in the session's own directory, whose
 * relay the session's spawn attaches. Null when that cannot be written: the
 * session then starts without Kangentic's tools, as one whose server failed
 * to start would.
 */
function cursorSessionMcpEntry(
  options: SpawnCommandOptions & { mcpServerUrl: string; mcpServerToken: string },
): CursorKangenticMcpEntry | null {
  const place = options.cliTarget ?? null;
  if (!place) return CURSOR_KANGENTIC_MCP_ENTRY;
  if (!options.eventsOutputPath) return null;
  try {
    return cursorKangenticMcpEntry(kangenticMcpServer({
      url: options.mcpServerUrl,
      token: options.mcpServerToken,
      place,
      directory: path.dirname(options.eventsOutputPath),
    }));
  } catch (error) {
    console.warn('[cursor] Could not prepare the WSL MCP bridge; the session runs without Kangentic tools:', error);
    return null;
  }
}

/**
 * Run `<cursorPath> <args>` and return stdout. `args` are fixed words, never
 * user text, so the Windows command line joins them as they are.
 *
 * On Windows, npm/installer-generated shims (`agent.cmd`, `agent.bat`)
 * cannot be invoked via `execFile` directly since Node's CVE-2024-27980
 * mitigation refuses to execute .cmd/.bat without a shell. We use `exec`
 * with a quoted command string on Windows (same pattern as
 * `shared/exec-version.ts`) and keep `execFile` on macOS/Linux where
 * the binary is a native ELF/Mach-O. A Cursor installed in a WSL distro
 * (`target`) runs there, through `wsl.exe`, in the distro's view of
 * `workingDirectory`.
 */
async function runCursorCli(
  cursorPath: string,
  args: readonly string[],
  options: { timeoutMs: number; workingDirectory?: string; target?: CliTarget | null },
): Promise<string> {
  if (options.target) {
    const { stdout } = await execCliForTarget(options.target, args, { timeout: options.timeoutMs, cwd: options.workingDirectory });
    return stdout;
  }
  const execOptions = { timeout: options.timeoutMs, windowsHide: true, cwd: options.workingDirectory };
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`${quoteCmdExecutable(cursorPath)} ${args.join(' ')}`, execOptions);
    return stdout;
  }
  const { stdout } = await execFileAsync(cursorPath, args, execOptions);
  return stdout;
}

/** `about --format json`, which answers from the local install in under a second. */
function runAgentAbout(cursorPath: string, target: CliTarget | null): Promise<string> {
  return runCursorCli(cursorPath, ['about', '--format', 'json'], { timeoutMs: 5000, target });
}

/** The CLI a session was started with, kept for its out-of-band `about` call. */
interface CursorSessionLaunch {
  cliPath: string;
  target: CliTarget | null;
}

/** A whole line that is a chat id, as `create-chat` prints it (measured: the bare UUID). */
const CHAT_ID_LINE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/im;

/**
 * Confirm-changes and skip-approvals keep the session screen. Anything else,
 * and an explicit non-interactive flag, is one print turn. The screen prints
 * no conversation id. The print path does, on the stream-json init line.
 */
function cursorKeepsSessionScreen(permissionMode: PermissionMode, nonInteractive: boolean | undefined): boolean {
  const interactive = permissionMode === 'default' || permissionMode === 'acceptEdits';
  return interactive && !nonInteractive;
}

/**
 * `create-chat` reaches Cursor's servers (a probe left nothing on disk), so it
 * gets longer than `about`; a start waits on it, and past this it goes ahead
 * without an id.
 */
const CREATE_CHAT_TIMEOUT_MS = 20_000;

/**
 * Narrow an unknown `JSON.parse(...)` result to the subset of the
 * `agent about --format json` payload we actually consume: a record
 * with a non-empty string `model` field. Other fields (cliVersion,
 * subscriptionTier, osPlatform, ...) exist but we ignore them.
 */
function isAboutPayload(value: unknown): value is { model: string } {
  return (
    typeof value === 'object'
    && value !== null
    && 'model' in value
    && typeof (value as { model: unknown }).model === 'string'
    && (value as { model: string }).model.length > 0
  );
}

/**
 * Cursor CLI adapter - integrates the Cursor terminal agent
 * (https://cursor.com/cli) behind the generic AgentAdapter interface.
 *
 * Cursor CLI is simpler than Claude Code: no session resume via
 * caller-owned IDs, no structured hooks, and no settings merging.
 * Permissions are config-file based only (~/.cursor/cli-config.json).
 * A directory Cursor has not seen prints "Workspace Trust Required" and
 * exits, so every spawn except confirm-changes passes `--trust` (the same
 * flag summarize and answerFromContext already pass). Confirm-changes leaves
 * the prompt so the user can decide in the PTY.
 *
 * Three modes:
 *   - Confirm changes: `agent "prompt"` - user confirms each change in the PTY
 *   - Skip approvals: `agent --trust --force "prompt"` - the same screen,
 *     commands run unless one is explicitly denied
 *   - Non-interactive: `agent --trust -p "prompt" --output-format stream-json`
 *     - Full write access, emits NDJSON events with session_id on each line
 *     - Enables session ID capture via the init event
 *
 * CLI reference: https://cursor.com/docs/cli/reference
 * Auth: browser-based (`agent login`) or env var (`CURSOR_API_KEY`)
 * Rules: `.cursor/rules/` auto-loaded from CWD (same as editor)
 * Config: `~/.cursor/cli-config.json` (global), `<project>/.cursor/cli.json` (project)
 * Sessions: `agent ls` lists past chats, `agent --resume="<id>"` resumes
 */
export class CursorAdapter implements AgentAdapter {
  readonly name = 'cursor';
  readonly displayName = 'Cursor CLI';
  readonly sessionType = 'cursor_agent';
  readonly supportsCallerSessionId = false;
  /**
   * Typed. Nothing documents a prompt riding `--resume=<id>`, so a message is
   * typed in once the resume is ready.
   */
  readonly resumePromptDelivery = 'typed' as const;
  // A static `.cursor/mcp.json` entry whose url and token are `${env:...}`
  // references, filled per session by `buildEnv` (project-mcp-config.ts).
  readonly kangenticMcp = 'per-session' as const;
  /** A Cursor installed in a WSL distro runs there (#286). */
  readonly supportsWslCli = true;
  /** Folders whose `.cursor/mcp.json` carries Kangentic's entry, and the sessions still using each. */
  private readonly mcpHolds = new SharedFolderHolds();
  /** Each live session's CLI, by its PTY session id, until the session ends. */
  private readonly sessionLaunches = new Map<string, CursorSessionLaunch>();
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'default', label: 'Interactive (Confirm Changes)' },
    { mode: 'acceptEdits', label: 'Interactive (Skip Approvals)' },
    { mode: 'bypassPermissions', label: 'Non-Interactive (Full Access)' },
  ];
  // Default to non-interactive (`--output-format stream-json`). The init
  // event on the first NDJSON line is the only place Cursor exposes the
  // model + session ID together over a documented public schema, so this
  // mode is what lets ContextBar resolve the model pill and what lets
  // `--resume=<id>` work reliably. Interactive mode is still selectable.
  // Its TUI status bar (`Composer 2.5 · 7.8%`) is parsed for occupancy
  // and the live model. `agent about` still seeds the pill until that
  // bar paints.
  readonly defaultPermission: PermissionMode = 'bypassPermissions';

  // Cursor CLI uses the shared AgentDetector via composition.
  //
  // Cursor installs TWO shims, `cursor-agent` and `agent`, and `agent` is not
  // its alone: xAI's Grok CLI installs `agent` too. On Windows Grok's
  // `agent.exe` beats Cursor's `agent.cmd` in PATHEXT order, so probing
  // `agent` first made Cursor undetectable on any machine that also had Grok -
  // `agent --version` answered `grok 1.0.0 (...) [stable]`, parseVersion
  // correctly refused it, and detection reported Cursor missing even though it
  // was installed. Probe the unambiguous name first and keep `agent` only as a
  // fallback for installs that predate it.
  private readonly detector = new AgentDetector({
    binaryName: 'cursor-agent',
    binaryAliases: ['agent'],
    parseVersion: (raw) => {
      // Real output, verified against cursor-agent 2026.04.29: a CalVer date
      // plus a short commit hash, e.g. `2026.04.29-c83a488`. Older/other
      // builds may print `1.0.0`, `agent 1.0.0`, or `Cursor Agent 1.0.0`.
      const cleaned = raw
        .replace(/^(?:cursor\s+)?agent\s*/i, '')
        .trim();
      // Requiring a leading DIGIT is what rejects a foreign tool answering on
      // the shared `agent` name: Grok replies `grok 1.0.0 ...`, which survives
      // the prefix strip and then fails here. Keep this guard - without it the
      // alias above would let one vendor's CLI masquerade as another's.
      return /^\d/.test(cleaned) ? cleaned : null;
    },
    supportsWslCli: true,
  });

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  // Cursor records workspace trust on `--trust`, not a file Kangentic writes.
  // That flag rides every spawn except confirm-changes.
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;
    // A Cursor in a WSL distro is started by the path the distro sees; the
    // PTY's cwd reaches it as its `/mnt` path.
    const place = options.cliTarget ?? null;
    const parts: string[] = [quoteArg(place ? place.linuxCliPath : options.agentPath, shell)];
    if (options.ptySessionId) this.sessionLaunches.set(options.ptySessionId, { cliPath: options.agentPath, target: place });

    // Kangentic's MCP server, on every start and resume: the project's
    // `.cursor/mcp.json` entry plus `--approve-mcps`, which loads the project's
    // servers without the per-server approval prompt no Kangentic-driven
    // session can answer (the answer path measured it). It approves the user's
    // own project servers too, as running Cursor there with the flag would, so
    // it rides only a start whose entry is in place: a file Kangentic could not
    // merge into gets neither the entry nor the approval.
    if (cursorMcpWiringEnabled(options)) {
      const entry = cursorSessionMcpEntry(options);
      if (entry && writeCursorProjectMcpConfig(options.cwd, entry)) {
        this.mcpHolds.retain(options.ptySessionId, options.cwd);
        parts.push('--approve-mcps');
      }
    }

    // Three ways a session starts:
    //   default            interactive screen, the user confirms each change
    //   acceptEdits        the same screen, with --force so commands run
    //                      unless one is explicitly denied
    //   anything else      one turn, then exit, as stream-json
    //
    // A mode Cursor's own list does not offer (plan, dontAsk, auto) stays
    // on the print path. Dropping stream-json there would leave the context
    // bar on "Starting agent...", because the init event is the only
    // documented place the model and session id arrive together.
    // An explicit nonInteractive flag wins over both session screens.
    const sessionUi = cursorKeepsSessionScreen(options.permissionMode, options.nonInteractive);
    const confirmSession = sessionUi && options.permissionMode === 'default';
    const forceSession = sessionUi && options.permissionMode === 'acceptEdits';

    if (!confirmSession) {
      // A directory Cursor has not seen prints "Workspace Trust Required"
      // and exits. --trust is the documented skip (cursor-agent --help:
      // "Trust the current workspace without prompting"). summarize and
      // answerFromContext already pass it. Confirm-changes leaves the
      // prompt so the user can decide.
      parts.push('--trust');
    }
    if (forceSession) {
      // --force (alias --yolo) allows commands unless one is explicitly
      // denied, and keeps the session screen. -p would close that screen.
      parts.push('--force');
    }

    if (options.sessionId) {
      // Open a chat by id: agent --resume="<chat-id>". The = sits outside the
      // quote boundary (--resume='id' on unix, --resume="id" on Windows), the
      // standard --flag=value convention.
      parts.push(`--resume=${quoteArg(options.sessionId, shell)}`);
      // A resume carries no prompt. A message for it (a column's, a held one)
      // is typed in once it is ready (`resumePromptDelivery: 'typed'`).
      if (options.resume) return parts.join(' ');
      // A fresh start with an id opens the empty chat `createSessionId` made,
      // and goes on below to send the first message into it. Only a start that
      // created one passes an id here: Cursor takes no id of Kangentic's, so
      // every other fresh spawn passes none.
    }

    // Shell-safe prompt: on PowerShell/cmd, replace double quotes with single
    // quotes. quoteArg does the same for those shells.
    const quotedPrompt = options.prompt
      ? quoteArg(
          (shell ? !isUnixLikeShell(shell) : process.platform === 'win32')
            ? options.prompt.replace(/"/g, "'")
            : options.prompt,
          shell,
        )
      : null;

    if (!sessionUi) {
      // Non-interactive mode: agent --trust -p "prompt" --output-format stream-json
      // Has full write access. Uses stream-json (NDJSON) so the runtime
      // sessionId.fromOutput parser can capture the session_id from the
      // init event: {"type":"system","subtype":"init","session_id":"<uuid>",...}
      if (quotedPrompt) parts.push('-p', quotedPrompt);
      // Per-column model override: apply before output format (flag order doesn't matter)
      if (options.model && options.model.trim().length > 0) {
        parts.push('--model', quoteArg(resolveCachedCursorModel(options.model, options.agentPath), shell));
      }
      parts.push('--output-format', 'stream-json');
    } else {
      // Session screen: agent "prompt", or agent --trust --force "prompt".
      // Confirm-changes asks before each change. Skip-approvals does not.
      if (quotedPrompt) parts.push(quotedPrompt);
      // Per-column model override in interactive mode
      if (options.model && options.model.trim().length > 0) {
        parts.push('--model', quoteArg(resolveCachedCursorModel(options.model, options.agentPath), shell));
      }
    }

    return parts.join(' ');
  }

  /**
   * The print path reports its own id on the stream-json init line. The
   * session screen does not, so those starts create one first.
   */
  reportsLaunchSessionId(options: { permissionMode: PermissionMode; nonInteractive?: boolean }): boolean {
    return !cursorKeepsSessionScreen(options.permissionMode, options.nonInteractive);
  }

  /**
   * A new chat's id, before launch. An interactive session never prints its
   * id (only `--output-format stream-json` does, and it needs `--print`), so
   * a fresh interactive start would otherwise have nothing to resume.
   * `create-chat` makes an empty chat and prints its id; the launch opens it
   * with `--resume=<id>`. Run in the session's own folder, in case Cursor
   * files chats by workspace as the editor does.
   */
  async createSessionId(cliPath: string, workingDirectory: string): Promise<string | null> {
    try {
      // A Cursor in a WSL distro makes the chat there, so the session opens it.
      const target = await resolveCliTarget(cliPath, true);
      const stdout = await runCursorCli(cliPath, ['create-chat'], { timeoutMs: CREATE_CHAT_TIMEOUT_MS, workingDirectory, target });
      const match = stdout.match(CHAT_ID_LINE);
      if (match) return match[0].toLowerCase();
      console.warn(`[cursor] create-chat printed no chat id: ${stdout.trim().slice(0, 200)}`);
    } catch (error) {
      console.warn('[cursor] create-chat failed; the session starts without a known id:', error);
    }
    return null;
  }

  /**
   * A folder whose `.cursor/mcp.json` Kangentic cannot merge its entry into
   * (one with comments, say) is left as it is, so a session there would start
   * without Kangentic's tools.
   */
  kangenticMcpBlockedReason(workingDirectory: string): string | null {
    const problem = cursorProjectMcpConfigProblem(workingDirectory);
    if (!problem) return null;
    return `${this.displayName} cannot load Kangentic's tools here: ${problem}. Fix or remove it, then close Settings to retry.`;
  }

  /**
   * The session's own server URL and token, which the static entry's
   * `${env:...}` references read, and for a Cursor in a WSL distro the bridge
   * entry's script (read on NAT networking, unused on mirrored).
   */
  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    if (!cursorMcpWiringEnabled(options)) return null;
    const place = options.cliTarget ?? null;
    return {
      [CURSOR_MCP_URL_ENV]: options.mcpServerUrl,
      [CURSOR_MCP_TOKEN_ENV]: options.mcpServerToken,
      ...(place && options.eventsOutputPath ? mcpBridgeScriptEnv(path.dirname(options.eventsOutputPath), place) : {}),
    };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: Cursor CLI has no hooks, no caller-owned session
   * IDs, and no native session-history file format we can read. Every
   * runtime signal we get comes from the NDJSON stream emitted by
   * `--output-format stream-json` (active by default - see
   * `defaultPermission`).
   *
   * - Activity: tool_call started/completed events from streamOutput
   *   drive Thinking/Idle through the activity state machine, with PTY
   *   silence-timer fallback for any interactive sessions.
   * - Session ID: parsed from the same NDJSON init event that carries
   *   the model:
   *     {"type":"system","subtype":"init","session_id":"<uuid>",
   *      "model":"<display>",...}
   * - streamOutput: same init event populates SessionUsage.model so
   *   ContextBar can lift its "Starting agent..." spinner. Interactive
   *   TUI status (`Composer 2.5 · 7.8%`) is parsed from the same stream
   *   so the board card does not sit at 0% and the model pill is the
   *   live TUI name, not the spawn-time `about` seed.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Only terminal silence says a turn ended.
    reportsTurnEnd: false,
    activity: ActivityDetection.pty(),
    sessionId: {
      fromOutput(data: string): string | null {
        const initMatch = data.match(/"session_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/);
        if (initMatch) return initMatch[1];
        return null;
      },
    },
    streamOutput: {
      createParser: () => new CursorStreamParser(),
    },
  };

  /**
   * Kick off an out-of-band model bootstrap when a session starts.
   * Cursor's `--output-format stream-json` requires `--print`, so
   * interactive TUI spawns (`default` and `acceptEdits`) emit no
   * NDJSON init event and the ContextBar spinner would otherwise hang
   * forever. `agent about --format json` is a documented, stable CLI
   * command that returns `{ "model": "<name>", ... }` in under a
   * second and works in every permission mode. It is a seed (no
   * `reportedByAgent`): the TUI status bar is what confirms the live
   * model once it paints.
   *
   * The fetch is fire-and-forget. `dispose()` sets a cancel flag so a
   * late-arriving result does not push usage into a torn-down session.
   *
   * It asks the CLI the session was started with (a project's own CLI path,
   * or a Cursor in a WSL distro, through `wsl.exe`), and falls back to the
   * Cursor on PATH for a session whose start it did not see.
   */
  attachSession(context: SessionContext): SessionAttachment {
    let disposed = false;
    this.fetchAboutUsage(this.sessionLaunches.get(context.sessionId) ?? null)
      .then((usage) => {
        if (disposed || !usage) return;
        context.applyUsage(usage);
      })
      .catch(() => {
        // Older Cursor CLI versions may lack `--format json` or the
        // `about` subcommand. Silently skip: the stream-json path
        // still covers `--print` spawns and nothing is worse than
        // the pre-fix behavior.
      });
    return {
      dispose: () => {
        disposed = true;
        this.sessionLaunches.delete(context.sessionId);
      },
    };
  }

  private async fetchAboutUsage(launch: CursorSessionLaunch | null): Promise<Partial<SessionUsage> | null> {
    let cliPath = launch?.cliPath ?? null;
    if (!cliPath) {
      const detection = await this.detector.detect();
      if (!detection.found || !detection.path) return null;
      cliPath = detection.path;
    }
    const stdout = await runAgentAbout(cliPath, launch?.target ?? null);
    const payload: unknown = JSON.parse(stdout);
    if (!isAboutPayload(payload)) return null;
    // `about` reports a display name ("Grok 4.6 High"), not a `--model` id.
    // Using that string as the id taught the picker a value the CLI then
    // rejected. Resolve against `--list-models` when we have it; otherwise
    // keep the display name for the pill and do not invent a lowercase id.
    const displayName = payload.model;
    return { model: { id: resolveCachedCursorModel(displayName, cliPath), displayName } };
  }

  removeHooks(directory: string, sessionId?: string): void {
    // No hooks, but the project's `.cursor/mcp.json` carries Kangentic's entry
    // while a session uses the folder. Strip it only once the last session
    // using the folder releases, so a sibling session keeps its server; a call
    // with no session (the project-delete sweep, after every session is
    // killed) strips it.
    const folder = this.mcpHolds.release(sessionId, directory);
    if (folder) removeCursorProjectMcpConfig(folder);
    if (sessionId) this.sessionLaunches.delete(sessionId);
  }

  getExitSequence(): string[] {
    return ['\x03'];
  }

  detectFirstOutput(data: string): boolean {
    // Cursor CLI writes output immediately (no alternate screen buffer).
    // Any non-empty data means the agent is ready.
    return data.length > 0;
  }

  async locateSessionHistoryFile(_agentSessionId: string, _cwd: string): Promise<string | null> {
    // The location IS known: Cursor writes
    // `~/.cursor/projects/<cwd-slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl`
    // plus a per-session `store.db`. It stays unwired because the records carry
    // NO timestamp and the stored text is WRAPPED (`<user_query>...</user_query>`)
    // rather than the raw submitted text, so neither a staleness bound nor an
    // exact match is possible yet. See docs/architecture/automations/command-injection-support-matrix.md,
    // "Cursor: located, not yet verified".
    return null;
  }

  async discoverCapabilities(cliPath: string, forceRefresh?: boolean): Promise<AgentCapabilities> {
    // discoverCursorCapabilities is best-effort and always returns a result
    return discoverCursorCapabilities(cliPath, forceRefresh);
  }

  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    // Cursor supports `/model <model>` slash command for live model switching
    if (spec.modelChanged && spec.model) {
      sequence.push(`/model ${resolveCachedCursorModel(spec.model)}`);
    }
    // Cursor has no separate effort concept - reasoning is encoded in model names
    // (e.g., "Claude 4.1 Sonnet" vs "Claude 4.1 Sonnet Thinking")
    return sequence;
  }

  getCommandInjectionVerifier() {
    // Cursor's NDJSON stream contains model information in the init event,
    // but verifying mid-session model changes via `/model` requires parsing
    // subsequent NDJSON events for a model-changed signal. This is not yet
    // documented in Cursor's public schema, so return null to fall back to
    // time-based settle. Future versions may expose a model-change event.
    return null;
  }

  async summarize(prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions): Promise<string> {
    // `agent -p "<prompt>"` runs non-interactively. `--output-format text` returns only
    // the final assistant message (no tool-call summaries) per
    // cursor.com/docs/cli/reference/output-format. The prompt is required as a positional
    // arg after `-p`, not via stdin. `--trust` for the same reason as
    // `answerFromContext`: the answer home is a folder Cursor has not seen, and
    // its trust prompt would block a headless run. Not the answer run's
    // read-only `--mode ask` yet, so this run can still write and leaves its
    // chat: no title has been measured in ask mode (the CLI here was logged
    // out), and a mode change is what made Antigravity's answer run come back
    // empty on the title prompt.
    return runCliPrintSummarize({
      cliPath,
      args: ['--trust', '--output-format', 'text', ...(options?.model ? ['--model', resolveCachedCursorModel(options.model, cliPath)] : []), '-p'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
      promptVia: 'arg',
      // A Cursor installed in a WSL distro runs there.
      cliTarget: await resolveCliTarget(cliPath, true),
    });
  }

  readonly answerCapabilities = { streaming: true, search: true, model: true, effort: false };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * Three things the shipped call got wrong, each measured:
   * - Read-only is `--mode ask`. `-p` alone "has access to all tools, including
   *   write and shell" (the CLI's own help); ask mode refused both a file write
   *   and a shell command in the probe.
   * - `--trust`, or a directory Cursor has not seen blocks on a trust prompt no
   *   headless run can answer.
   * - The prompt is PIPED, not positional. An answer prompt runs to about 50k
   *   characters, past the Windows command-line limit, and `-p` reads a piped
   *   prompt (measured: a 61,584-character prompt answered from its middle row).
   *
   * STREAMING is `stream-json` with `--stream-partial-output`, read by
   * `answer-stream.ts` (the answer is the complete final assistant line; the
   * `result` line fuses every turn's text).
   *
   * SEARCH is a workspace `.cursor/mcp.json` in the answer home, STATIC: its
   * url and token header are `${env:...}` references Cursor expands from the
   * process environment (measured: the server connected), so no token is ever
   * on disk. Loading the server takes `--approve-mcps`, but CALLING its tool
   * in ask mode was refused ("User rejected MCP") until the workspace's
   * `.cursor/cli.json` allowed exactly `Mcp(kangentic:kangentic_search)`. That
   * file also denies shell and writes, on top of ask mode. `--force` would
   * also have let the call through, and everything else with it.
   *
   * Each run's chat is removed from `~/.cursor/chats` afterwards: an answer is
   * not a chat to resume.
   *
   * A Cursor installed in a WSL distro runs there, from its own answer home
   * (`cursorAnswerHome`), and on NAT networking reaches the search tool through
   * the bridge entry, whose relay lives as long as this one call.
   *
   * The prompt, its rules and the retrieval budget are all built upstream and
   * handed over whole; this only decides the CLI's flags.
   */
  async answerFromContext(
    prompt: string,
    cliPath: string,
    cwd: string,
    model?: string | null,
    options?: AnswerFromContextOptions,
  ): Promise<string> {
    const retrieval = options?.retrieval;
    const cliTarget = await resolveCliTarget(cliPath, true);
    const answerHome = cursorAnswerHome(cwd, cliTarget);
    if (!retrieval) {
      if (cliTarget) await fs.promises.mkdir(answerHome, { recursive: true });
      return this.runAnswer({ prompt, cliPath, cliTarget, cwd: answerHome, model, onEvent: options?.onEvent, search: null });
    }
    // Only a bridge writes into the directory: a CLI that dials the URL needs
    // none, so a run on this machine without one is not given one.
    const inRunDirectory = <T>(work: (directory: string) => Promise<T>): Promise<T> =>
      options?.runDirectory || !cliTarget ? work(options?.runDirectory ?? answerHome) : withAnswerRunDirectory(work);
    return inRunDirectory(async (runDirectory) => {
      const server = kangenticMcpServer({ url: retrieval.url, token: retrieval.token, place: cliTarget, directory: runDirectory });
      await writeCursorAnswerWorkspace(answerHome, cursorKangenticMcpEntry(server));
      const env = {
        [CURSOR_MCP_URL_ENV]: retrieval.url,
        [CURSOR_MCP_TOKEN_ENV]: retrieval.token,
        ...(server.kind === 'stdio' && cliTarget ? mcpBridgeScriptEnv(runDirectory, cliTarget) : {}),
      };
      const stopRelay = startRunMcpRelay(runDirectory, server);
      try {
        return await this.runAnswer({ prompt, cliPath, cliTarget, cwd: answerHome, model, onEvent: options?.onEvent, search: { env } });
      } finally {
        stopRelay();
      }
    });
  }

  /** One ask-mode answer run, and the removal of the chat it leaves. */
  private async runAnswer(input: {
    prompt: string;
    cliPath: string;
    cliTarget: CliTarget | null;
    cwd: string;
    model: string | null | undefined;
    onEvent: AnswerFromContextOptions['onEvent'];
    /** The search server's variables, or null for a run without search. */
    search: { env: Record<string, string> } | null;
  }): Promise<string> {
    const { cliPath, cliTarget, cwd, model, onEvent, search } = input;
    let sessionId: string | null = null;
    const reduce = createCursorAnswerReducer();
    try {
      return await runCliPrintAnswer({
        cliPath,
        cliTarget,
        // The model flag is OMITTED when none is chosen: passing an
        // empty value is an error.
        args: [
          '--trust',
          '--mode', 'ask',
          '--output-format', 'stream-json',
          ...(onEvent ? ['--stream-partial-output'] : []),
          ...(search ? ['--approve-mcps'] : []),
          ...(model ? ['--model', resolveCachedCursorModel(model, cliPath)] : []),
          '-p',
        ],
        prompt: input.prompt,
        cwd,
        extractRaw: extractCursorAnswer,
        outputBudget: ANSWER_STREAM_OUTPUT_BUDGET,
        onChunk: forwardStreamLines((line) => {
          sessionId ??= cursorInitSessionId(line);
          if (onEvent) for (const event of reduce(line)) onEvent(event);
        }),
        ...(search ? { env: search.env } : {}),
      });
    } finally {
      if (sessionId) await removeCursorChat(sessionId, cliTarget);
    }
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Cursor CLI has no hooks or structured verification signals.
    // Callers fall back to time-based settle (paste) or time-settle (command-injection).
    return null;
  }
}
