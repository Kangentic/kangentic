import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentDetector } from '../../shared/agent-detector';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { CursorStreamParser } from './stream-parser';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SessionUsage,
  SessionContext,
  SessionAttachment,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Run `<cursorPath> about --format json` and return stdout.
 *
 * On Windows, npm/installer-generated shims (`agent.cmd`, `agent.bat`)
 * cannot be invoked via `execFile` directly since Node's CVE-2024-27980
 * mitigation refuses to execute .cmd/.bat without a shell. We use `exec`
 * with a quoted command string on Windows (same pattern as
 * `shared/exec-version.ts`) and keep `execFile` on macOS/Linux where
 * the binary is a native ELF/Mach-O.
 */
async function runAgentAbout(cursorPath: string): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`"${cursorPath}" about --format json`, {
      timeout: 5000,
      windowsHide: true,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cursorPath, ['about', '--format', 'json'], {
    timeout: 5000,
    windowsHide: true,
  });
  return stdout;
}

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
 * caller-owned IDs, no structured hooks, no trust mechanism, and
 * no settings merging. Permissions are config-file based only
 * (~/.cursor/cli-config.json), with no CLI flags to control them.
 *
 * Two modes:
 *   - Interactive: `agent "prompt"` - user confirms changes in PTY
 *   - Non-interactive: `agent -p "prompt" --output-format stream-json`
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
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'default', label: 'Interactive (Confirm Changes)' },
    { mode: 'bypassPermissions', label: 'Non-Interactive (Full Access)' },
  ];
  // Default to non-interactive (`--output-format stream-json`). The init
  // event on the first NDJSON line is the only place Cursor exposes the
  // model + session ID together over a documented public schema, so this
  // mode is what lets ContextBar resolve the model pill and what lets
  // `--resume=<id>` work reliably. Interactive mode is still selectable
  // by the user but produces no machine-readable telemetry.
  readonly defaultPermission: PermissionMode = 'bypassPermissions';

  // Cursor CLI uses the shared AgentDetector via composition.
  // The binary is called `agent` - a generic name that may collide
  // with other tools, so parseVersion validates the output.
  private readonly detector = new AgentDetector({
    binaryName: 'agent',
    parseVersion: (raw) => {
      // `agent --version` output format is not yet confirmed.
      // Accept common patterns: "1.0.0", "agent 1.0.0", "Cursor Agent 1.0.0"
      const cleaned = raw
        .replace(/^(?:cursor\s+)?agent\s*/i, '')
        .trim();
      // Return null if the output doesn't look like a version
      return /^\d/.test(cleaned) ? cleaned : null;
    },
  });

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  // Cursor CLI has no trust mechanism - permissions are config-file based
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;
    const parts: string[] = [quoteArg(options.agentPath, shell)];

    if (options.resume && options.sessionId) {
      // Resume an existing session: agent --resume="<chat-id>"
      // The = sits outside the quote boundary (--resume='id' on unix,
      // --resume="id" on Windows) which is standard --flag=value convention.
      parts.push(`--resume=${quoteArg(options.sessionId, shell)}`);
      return parts.join(' ');
    }

    // Shell-safe prompt: PowerShell/cmd interpret \" differently from bash,
    // so replace double quotes with single quotes before quoteArg wrapping.
    const quotedPrompt = options.prompt
      ? quoteArg(
          (shell ? !isUnixLikeShell(shell) : process.platform === 'win32')
            ? options.prompt.replace(/"/g, "'")
            : options.prompt,
          shell,
        )
      : null;

    // Cursor CLI only natively distinguishes two permission modes:
    //   default           → interactive TUI, user confirms changes
    //   bypassPermissions → non-interactive, full access, stream-json
    //
    // Upstream may pass Kangentic-level modes (`project-settings`,
    // `acceptEdits`, `plan`, etc.) that Cursor does not recognize. If we
    // treated every unknown value as interactive, those spawns would
    // silently drop `--output-format stream-json`, the init event would
    // never arrive, and ContextBar would be stuck on "Starting agent...".
    // Treat anything other than an explicit interactive `default` as
    // bypassPermissions so stream-json is always emitted when reasonable.
    const interactive = options.permissionMode === 'default' && !options.nonInteractive;

    if (!interactive) {
      // Non-interactive mode: agent -p "prompt" --output-format stream-json
      // Has full write access. Uses stream-json (NDJSON) so the runtime
      // sessionId.fromOutput parser can capture the session_id from the
      // init event: {"type":"system","subtype":"init","session_id":"<uuid>",...}
      if (quotedPrompt) parts.push('-p', quotedPrompt);
      parts.push('--output-format', 'stream-json');
    } else {
      // Interactive mode: agent "prompt"
      // User confirms changes in the PTY.
      if (quotedPrompt) parts.push(quotedPrompt);
    }

    return parts.join(' ');
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
   *   ContextBar can lift its "Starting agent..." spinner.
   */
  readonly runtime: AdapterRuntimeStrategy = {
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
   * interactive TUI spawns (permissionMode === 'default') emit no
   * NDJSON init event and the ContextBar spinner would otherwise hang
   * forever. `agent about --format json` is a documented, stable CLI
   * command that returns `{ "model": "<name>", ... }` in under a
   * second and works in every permission mode.
   *
   * The fetch is fire-and-forget. `dispose()` sets a cancel flag so a
   * late-arriving result does not push usage into a torn-down session.
   */
  attachSession(context: SessionContext): SessionAttachment {
    let disposed = false;
    this.fetchAboutUsage()
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
      dispose: () => { disposed = true; },
    };
  }

  private async fetchAboutUsage(): Promise<Partial<SessionUsage> | null> {
    const detection = await this.detector.detect();
    if (!detection.found || !detection.path) return null;
    const stdout = await runAgentAbout(detection.path);
    const payload: unknown = JSON.parse(stdout);
    if (!isAboutPayload(payload)) return null;
    return { model: { id: payload.model.toLowerCase(), displayName: payload.model } };
  }

  // Cursor CLI does not use hooks - no-op
  removeHooks(_directory: string): void {}

  // Cursor CLI has no merged settings - no-op
  clearSettingsCache(): void {}

  getExitSequence(): string[] {
    return ['\x03'];
  }

  detectFirstOutput(data: string): boolean {
    // Cursor CLI writes output immediately (no alternate screen buffer).
    // Any non-empty data means the agent is ready.
    return data.length > 0;
  }

  async locateSessionHistoryFile(_agentSessionId: string, _cwd: string): Promise<string | null> {
    // Cursor CLI session history location is not yet known.
    return null;
  }
}
