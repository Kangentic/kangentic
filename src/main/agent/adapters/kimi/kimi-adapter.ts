import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';
import { KimiCommandBuilder } from './command-builder';
import { KimiSessionHistoryParser } from './session-history-parser';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Kimi CLI adapter - integrates Moonshot AI's Kimi Code coding CLI
 * (https://github.com/MoonshotAI/kimi-cli) behind the generic
 * AgentAdapter interface.
 *
 * Distribution: Python tool installed via `uv tool install kimi-cli`. Both
 * `kimi` and `kimi-cli` are PATH entry points (pyproject.toml
 * [project.scripts] mapping to `src/kimi_cli:__main__`).
 *
 * Capabilities (verified empirically with kimi v1.37.0, wire protocol 1.9):
 *
 * - Caller-owned session IDs via `--session <uuid>`. The
 *   `Session.create(work_dir, session_id="...")` SDK API maps to that
 *   flag; passing a fresh UUID creates a new session with that exact
 *   ID. Resume uses the same flag (or `-r` / `--resume`).
 *
 * - Wire-protocol JSONL emitted to `~/.kimi/sessions/<work_dir_hash>/<id>/wire.jsonl`
 *   on every spawn (interactive or `--print`). Drives ContextBar and the
 *   Activity tab via `runtime.sessionHistory`.
 *
 * - Welcome banner prints "Session: <uuid>" so we can capture the ID
 *   from PTY output without waiting for filesystem polling. Print mode
 *   additionally writes "To resume this session: kimi -r <uuid>" on
 *   stderr at exit. Both regex anchors are wired in
 *   `runtime.sessionId.fromOutput`.
 *
 * - Filesystem fallback for session ID capture (mtime-windowed scan of
 *   `~/.kimi/sessions/*\/<uuid>/`) covers the rare case where PTY
 *   capture misses the banner.
 *
 * - MCP support via `--mcp-config-file <FILE>` (repeatable). The command
 *   builder writes a single fastmcp-compatible config to
 *   `<sessionDir>/mcp.json` containing Kangentic's in-process HTTP MCP
 *   server URL + token header. Inline `--mcp-config <JSON>` is avoided
 *   because PowerShell mangles embedded double quotes.
 *
 * - Plan mode (`--plan`), YOLO (`--yolo`), and the same prompt/work-dir/
 *   model knobs that other agents use.
 */
export class KimiAdapter implements AgentAdapter {
  readonly name = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly sessionType = 'kimi_agent';
  readonly supportsCallerSessionId = true;
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only)' },
    { mode: 'default', label: 'Default (Confirm Actions)' },
    { mode: 'bypassPermissions', label: 'YOLO (Skip Confirmations)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';

  private readonly detector = new AgentDetector({
    binaryName: 'kimi',
    fallbackPaths: kimiFallbackPaths(),
    // Empirically `kimi --version` emits `kimi, version 1.37.0`. Strip
    // the prefix to match Codex / Aider conventions.
    parseVersion: (raw) => {
      const match = raw.match(/^kimi(?:-cli)?,?\s+version\s+(\S+)/i);
      if (match) return match[1];
      // Fallback to permissive prefix strip.
      return raw.replace(/^kimi(-cli)?\s*v?/i, '').trim() || null;
    },
  });

  private readonly commandBuilder = new KimiCommandBuilder();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // Kimi has no global trust dialog. Sessions are stored under
    // ~/.kimi/sessions/<work_dir_hash>/ and the work_dir is added to
    // ~/.kimi/kimi.json automatically on first spawn - no pre-approval
    // step needed. See `probeAuth` for the login-state check, which
    // reads ~/.kimi/credentials/.
  }

  async probeAuth(): Promise<boolean | null> {
    // `kimi login` writes OAuth state to ~/.kimi/credentials/. A
    // missing or empty directory means the user has not authenticated;
    // a fresh spawn would print "LLM not set, send /login to login"
    // and exit. The renderer surfaces this as an amber warning so the
    // user can run `kimi login` before moving a task.
    try {
      const credentialsDir = path.join(os.homedir(), '.kimi', 'credentials');
      const entries = fs.readdirSync(credentialsDir);
      return entries.length > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return null;
    }
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildKimiCommand({ kimiPath: agentPath, ...rest });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: how Kimi exposes activity state and session
   * telemetry.
   *
   * - Activity: PTY silence timer + a permissive prompt regex. The
   *   wire.jsonl `TurnBegin` / `TurnEnd` events provide authoritative
   *   transitions through `runtime.sessionHistory`, but the PTY
   *   tracker covers gaps before the first wire flush.
   *
   * - Session ID (fromOutput): two regex anchors.
   *     1. Welcome banner: "Session: <uuid>" (interactive + print).
   *     2. Print-mode exit: "kimi -r <uuid>" emitted on stderr.
   *
   * - Session ID (fromFilesystem): mtime-windowed scan as a backup
   *   if the PTY scrape misses both banners.
   *
   * - sessionHistory: tails ~/.kimi/sessions/<hash>/<id>/wire.jsonl.
   *   Append-only (resume via `-r` appends new TurnBegin/TurnEnd lines
   *   to the same file).
   */
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.pty((data: string) => {
      // Strip ANSI then look for the stable Kimi input prompt at the
      // bottom of the alt-screen. Kimi's TUI redraws an "input" cell
      // separator with the cursor on the next line - we accept either
      // a bare "> " or a "kimi> " glued to the cursor row.
      const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      return /(?:^|\n)\s*(?:kimi\s*)?>\s*$/.test(stripped);
    }),
    sessionId: {
      fromOutput(data: string): string | null {
        // Welcome-banner anchor: "Session: <uuid>" (interactive).
        const banner = data.match(
          /Session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        );
        if (banner) return banner[1];
        // Print-mode exit anchor: "kimi -r <uuid>".
        const resume = data.match(
          /kimi\s+-r\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        );
        return resume ? resume[1] : null;
      },
      fromFilesystem: KimiSessionHistoryParser.captureSessionIdFromFilesystem,
    },
    sessionHistory: {
      locate: KimiSessionHistoryParser.locate,
      parse: KimiSessionHistoryParser.parse,
      // Empirically wire.jsonl is append-only on resume (verified by
      // running --print, then --resume, then diffing the file - the
      // original lines are preserved and new TurnBegin/TurnEnd are
      // appended). Use byte-cursor tracking, not whole-file rewrite.
      isFullRewrite: false,
    },
  };

  removeHooks(_directory: string): void {
    // Kimi reads ~/.kimi/config.toml's `hooks = []` array but does NOT
    // have a per-project settings file equivalent that we inject into.
    // No hook cleanup needed.
  }

  clearSettingsCache(): void {
    // No cached merged settings.
  }

  getExitSequence(): string[] {
    // Ctrl+C interrupts; "/exit" triggers the conventional Kimi TUI
    // graceful shutdown that flushes context.jsonl and closes the
    // wire.jsonl writer cleanly. Mirrors Claude / Aider.
    return ['\x03', '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Kimi's TUI hides the cursor (\x1b[?25l) when the alternate-screen
    // buffer takes over - same convention as Claude / Codex / Gemini.
    // This anchors the shimmer-overlay lift to "TUI is now drawing"
    // rather than "shell prompt printed something".
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return KimiSessionHistoryParser.locate({ agentSessionId, cwd });
  }
}

/**
 * Well-known install locations for the `kimi` binary. The upstream
 * install script runs `uv tool install kimi-cli`, which symlinks into:
 *
 *   - macOS/Linux: ~/.local/bin/kimi (covered by standardUnixFallbackPaths)
 *   - macOS/Linux uv tool prefix: ~/.local/share/uv/tools/kimi-cli/bin/kimi
 *   - Windows uv tool prefix:     %APPDATA%\uv\tools\kimi-cli\Scripts\kimi.exe
 *                            and  %LOCALAPPDATA%\uv\tools\kimi-cli\Scripts\kimi.exe
 *
 * We layer the uv-specific paths on top of the standard fallback list
 * so detection succeeds even if the symlink step was skipped.
 */
function kimiFallbackPaths(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const candidates: string[] = [];
    if (appData) {
      candidates.push(path.join(appData, 'uv', 'tools', 'kimi-cli', 'Scripts', 'kimi.exe'));
    }
    if (localAppData) {
      candidates.push(path.join(localAppData, 'uv', 'tools', 'kimi-cli', 'Scripts', 'kimi.exe'));
    }
    return candidates;
  }
  return [
    path.join(home, '.local', 'share', 'uv', 'tools', 'kimi-cli', 'bin', 'kimi'),
    ...standardUnixFallbackPaths('kimi'),
  ];
}
