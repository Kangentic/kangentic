import which from 'which';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../shared/paths';
import { EventType } from '../../../shared/types';
import { interpolateTemplate } from '../command-builder';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../agent-adapter';
import type { SessionUsage, SessionEvent, PermissionMode } from '../../../shared/types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Detect whether the Codex CLI is installed and return path + version. */
class CodexDetector {
  private cached: AgentInfo | null = null;
  private inflight: Promise<AgentInfo> | null = null;

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    if (this.cached) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.performDetection(overridePath);
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async performDetection(overridePath?: string | null): Promise<AgentInfo> {
    try {
      const codexPath = overridePath || await which('codex');
      const version = await this.extractVersion(codexPath);
      this.cached = { found: true, path: codexPath, version };
      return this.cached;
    } catch { /* not on PATH */ }

    this.cached = { found: false, path: null, version: null };
    return this.cached;
  }

  /** Run --version and return the version string, or null on failure. */
  private async extractVersion(candidatePath: string): Promise<string | null> {
    try {
      if (!fs.existsSync(candidatePath)) return null;
      const { stdout, stderr } = await execFileAsync(candidatePath, ['--version'], {
        timeout: 5000,
        shell: process.platform === 'win32',
      });
      return stdout.trim() || stderr.trim() || null;
    } catch {
      return null;
    }
  }

  invalidateCache(): void {
    this.cached = null;
    this.inflight = null;
  }
}

// ---------------------------------------------------------------------------
// Permission mode mapping
// ---------------------------------------------------------------------------

/** Map Kangentic's PermissionMode to Codex CLI approval-mode flags. */
function mapPermissionMode(mode: PermissionMode): string[] {
  switch (mode) {
    case 'default':
    case 'plan':
      return ['--approval-mode', 'untrusted'];
    case 'acceptEdits':
      return ['--approval-mode', 'on-request'];
    case 'dontAsk':
      return ['--approval-mode', 'never'];
    case 'bypassPermissions':
      return ['--approval-mode', 'full-auto'];
  }
}

// ---------------------------------------------------------------------------
// Bridge script resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a bridge script path using the standard 3-candidate pattern:
 * 1. Production build (next to main bundle)
 * 2. Dev build (.vite/build/ -> project root)
 * 3. Fallback from CWD
 */
function resolveBridgeScript(name: string): string {
  const candidates = [
    path.join(__dirname, `${name}.js`),
    path.resolve(__dirname, '..', '..', 'src', 'main', 'agent', `${name}.js`),
    path.resolve(process.cwd(), 'src', 'main', 'agent', `${name}.js`),
  ];
  const resolved = candidates.find(filePath => fs.existsSync(filePath)) || candidates[0];
  if (resolved.includes('app.asar')) {
    return resolved.replace('app.asar', 'app.asar.unpacked');
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Hook management
// ---------------------------------------------------------------------------

/** A single entry in Codex's .codex/hooks.json array. */
interface CodexHookEntry {
  event: string;
  command: string;
  timeout_secs?: number;
}

/** True if this hook entry was injected by Kangentic. */
function isKangenticCodexHook(entry: CodexHookEntry): boolean {
  const command = entry.command || '';
  return command.includes('.kangentic') && (
    command.includes('activity-bridge') || command.includes('event-bridge')
  );
}

/** Path to .codex/hooks.json for a given project directory. */
function codexHooksPath(directory: string): string {
  return path.join(directory, '.codex', 'hooks.json');
}

/**
 * Codex hook event names mapped to the event-bridge event types
 * that our agent-agnostic event-bridge.js understands.
 */
const CODEX_HOOK_EVENTS: Array<{ event: string; bridgeEventType: EventType }> = [
  { event: 'SessionStart', bridgeEventType: EventType.SessionStart },
  { event: 'UserPromptSubmit', bridgeEventType: EventType.Prompt },
  { event: 'PreToolUse', bridgeEventType: EventType.ToolStart },
  { event: 'PostToolUse', bridgeEventType: EventType.ToolEnd },
  { event: 'Stop', bridgeEventType: EventType.Idle },
];

/**
 * Write Kangentic event-bridge hooks into .codex/hooks.json at the project
 * root. Merges with any existing user-defined hooks (our entries are filtered
 * out first to avoid duplicates).
 */
function writeCodexHooks(projectRoot: string, eventsOutputPath: string): void {
  const hooksFile = codexHooksPath(projectRoot);
  const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
  const eventsPath = toForwardSlash(eventsOutputPath);

  // Read existing hooks and filter out stale Kangentic entries
  let existingHooks: CodexHookEntry[] = [];
  try {
    const raw = fs.readFileSync(hooksFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      existingHooks = (parsed as CodexHookEntry[]).filter(
        entry => !isKangenticCodexHook(entry),
      );
    }
  } catch {
    // No existing hooks file or invalid JSON - start fresh
  }

  // Build our hook entries
  const kangenticHooks: CodexHookEntry[] = CODEX_HOOK_EVENTS.map(({ event, bridgeEventType }) => ({
    event,
    command: `node "${eventBridge}" "${eventsPath}" ${bridgeEventType}`,
    timeout_secs: 10,
  }));

  const merged = [...existingHooks, ...kangenticHooks];

  // Ensure .codex/ directory exists
  const codexDir = path.dirname(hooksFile);
  fs.mkdirSync(codexDir, { recursive: true });

  fs.writeFileSync(hooksFile, JSON.stringify(merged, null, 2));
}

/**
 * Strip ALL Kangentic hook entries from .codex/hooks.json at the given
 * directory. Preserves all other user hooks.
 *
 * Safety: backs up before write, validates JSON round-trip, restores on error.
 */
function stripCodexHooks(directory: string): void {
  const hooksFile = codexHooksPath(directory);
  if (!fs.existsSync(hooksFile)) return;

  const backupPath = hooksFile + '.kangentic-bak';
  let backedUp = false;

  try {
    const raw = fs.readFileSync(hooksFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    const hooks = parsed as CodexHookEntry[];
    const filtered = hooks.filter(entry => !isKangenticCodexHook(entry));

    if (filtered.length === hooks.length) return; // nothing changed

    // Back up original before writing
    fs.copyFileSync(hooksFile, backupPath);
    backedUp = true;

    if (filtered.length === 0) {
      // No hooks left - remove the file
      fs.unlinkSync(hooksFile);
      try { fs.rmdirSync(path.dirname(hooksFile)); } catch { /* not empty or already gone */ }
    } else {
      const output = JSON.stringify(filtered, null, 2);
      JSON.parse(output); // verify round-trip integrity
      fs.writeFileSync(hooksFile, output);
    }

    // Success - remove backup
    try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
  } catch (error) {
    if (backedUp) {
      try { fs.copyFileSync(backupPath, hooksFile); } catch { /* can't recover */ }
      try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    }
    console.error(`[stripCodexHooks] Failed to clean hooks at ${hooksFile}:`, error);
  }
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

/** Build the shell command string to spawn the Codex CLI. */
function buildCodexCommand(options: SpawnCommandOptions): string {
  const { shell } = options;
  const parts: string[] = [];

  // Resume is a subcommand: codex resume <sessionId> -C <cwd>
  if (options.resume && options.sessionId) {
    parts.push(quoteArg(options.agentPath, shell));
    parts.push('resume', quoteArg(options.sessionId, shell));
    parts.push('-C', quoteArg(toForwardSlash(options.cwd), shell));
    return parts.join(' ');
  }

  parts.push(quoteArg(options.agentPath, shell));

  // Non-interactive: codex -q --json ...
  if (options.nonInteractive) {
    parts.push('-q', '--json');
  }

  // Working directory
  parts.push('-C', quoteArg(toForwardSlash(options.cwd), shell));

  // Approval mode
  parts.push(...mapPermissionMode(options.permissionMode));

  // Prompt as positional argument
  if (options.prompt) {
    const needsDoubleQuoteReplacement = shell
      ? !isUnixLikeShell(shell)
      : process.platform === 'win32';
    const safePrompt = needsDoubleQuoteReplacement
      ? options.prompt.replace(/"/g, "'")
      : options.prompt;
    parts.push(quoteArg(safePrompt, shell));
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Codex CLI adapter - wraps CodexDetector and Codex-specific command
 * building, hook management, and event parsing behind the generic
 * AgentAdapter interface.
 */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly sessionType = 'codex_agent';

  private readonly detector = new CodexDetector();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // Codex does not have a trust dialog - no pre-approval needed.
  }

  buildCommand(options: SpawnCommandOptions): string {
    // Inject event-bridge hooks before building the command (analogous to
    // Claude's createMergedSettings side effect in buildClaudeCommand)
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      writeCodexHooks(projectRoot, options.eventsOutputPath);
    }

    return buildCodexCommand(options);
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  parseStatus(_raw: string): SessionUsage | null {
    // Codex CLI does not expose real-time token usage or cost data
    // via a statusLine mechanism. Return null until a future version
    // adds equivalent support.
    return null;
  }

  parseEvent(line: string): SessionEvent | null {
    try {
      return JSON.parse(line) as SessionEvent;
    } catch {
      return null;
    }
  }

  stripHooks(directory: string): void {
    stripCodexHooks(directory);
  }

  clearSettingsCache(): void {
    // No settings cache to clear - Codex uses config.toml, not merged
    // settings files.
  }
}
