import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import type { PermissionMode } from '../../../../shared/types';

/**
 * Factory Droid CLI command builder.
 *
 * Empirically validated against Droid 0.109.1 (see `scripts/probe-droid.js`):
 *   New session:    droid --cwd <cwd> "<prompt>"
 *   Resume session: droid --cwd <cwd> --resume <uuid> "<prompt>"
 *
 * Design note (2026-04-26): this adapter intentionally does not write
 * a per-spawn `--settings <path>` file. Droid's interactive TUI
 * already exposes everything Kangentic users need:
 *   - Model selection: `/model` picker, with Ctrl+D to pin a default
 *     (persists in `~/.factory/settings.json`)
 *   - Autonomy mode: shift+tab cycles low/medium/high
 *   - BYOK: configured once via `customModels[]` in
 *     `~/.factory/settings.json`
 *
 * Trying to shadow these with Kangentic-managed overrides was rejected
 * by user feedback as unnecessary custom layering. The bare command
 * with cwd + resume + prompt is the production path.
 *
 * MCP used to be manual here, on the grounds that Droid exposes no
 * `--mcp-config` flag and the alternatives were all stateful. That is no
 * longer the whole picture: Droid expands `${NAME}` against the process
 * environment inside `headers` values at connect time, and never rewrites
 * the file with the expanded value. So Kangentic writes a project-scoped
 * `<cwd>/.factory/mcp.json` containing only the env var NAME, and supplies
 * the value through `buildEnv`. No secret reaches disk, and
 * `~/.factory/mcp.json` is never touched.
 *
 * Verified against droid 0.189.0: `droid mcp list` in a directory carrying
 * the file below reports `kangentic  http  connected  [project]`.
 *
 * Other notes:
 * - Resume uses `droid --resume <uuid>`, NOT the exec-only `-s` flag.
 * - The session UUID is captured post-spawn from
 *   `~/.factory/sessions/<cwd-slug>/<uuid>.jsonl`. See
 *   `DroidAdapter.runtime.sessionId.fromFilesystem`.
 */
export interface DroidCommandOptions {
  droidPath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  /**
   * Accepted for parity with the AgentAdapter interface but ignored:
   * Droid's TUI handles permission decisions in-band (shift+tab to
   * cycle autonomy modes). Kangentic does not translate this into a
   * flag override -- the user controls autonomy in the TUI directly.
   */
  permissionMode: PermissionMode;
  projectRoot?: string;
  sessionId?: string;
  resume?: boolean;
  /** Accepted for parity; the adapter spawns the interactive TUI. */
  nonInteractive?: boolean;
  /** Accepted for parity; no statusFile pipeline today. */
  statusOutputPath?: string;
  /** Accepted for parity; no events.jsonl pipeline today. */
  eventsOutputPath?: string;
  shell?: string;
  /**
   * Whether to attach Kangentic's in-process MCP HTTP server. Default-on:
   * only an explicit `false` suppresses it.
   */
  mcpServerEnabled?: boolean;
  mcpServerUrl?: string;
  /** Delivered via `buildEnv`; the config file holds only the var NAME. */
  mcpServerToken?: string;
}

/** Env var Droid expands inside the mcp.json header value at connect time. */
export const KANGENTIC_MCP_TOKEN_ENV = 'KANGENTIC_MCP_TOKEN';

/** Shared gate for the config write and `buildEnv`, so they cannot drift. */
export function droidMcpWiringEnabled(
  options: DroidCommandOptions,
): options is DroidCommandOptions & { mcpServerUrl: string; mcpServerToken: string } {
  return (
    options.mcpServerEnabled !== false
    && Boolean(options.mcpServerUrl)
    && Boolean(options.mcpServerToken)
  );
}

export class DroidCommandBuilder {
  buildDroidCommand(options: DroidCommandOptions): string {
    const { shell } = options;
    const parts: string[] = [quoteArg(options.droidPath, shell)];

    // Seed .git/info/exclude BEFORE the write so the mcp.json pre-existence
    // check reflects the user's file, not ours: the config otherwise sits
    // untracked in the worktree for the whole session, polluting git status
    // and riding along with any `git add -A` an agent runs.
    this.seedGitExcludes(options);
    this.writeMcpConfig(options);

    parts.push('--cwd', quoteArg(toForwardSlash(options.cwd), shell));

    if (options.resume && options.sessionId) {
      // `--resume <uuid>` accepts the agent's own session UUID. The
      // captured ID lives in ~/.factory/sessions/<cwd-slug>/<uuid>.jsonl.
      parts.push('--resume', quoteArg(options.sessionId, shell));
    }

    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push(quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  /**
   * Hide the Kangentic-written runtime files from git for the untracked
   * case. `<cwd>/.factory/mcp.json` gets the created-by-us carve-out: a
   * file already present may be the user's own project MCP config, possibly
   * destined for a commit. The file holds no secret (the token is a
   * `${KANGENTIC_MCP_TOKEN}` env reference), so this is purely about
   * untracked-file noise in the task worktree.
   */
  private seedGitExcludes(options: DroidCommandOptions): void {
    if (!droidMcpWiringEnabled(options)) return;
    const patterns = ['.kangentic/'];
    if (!fs.existsSync(path.join(options.cwd, '.factory', 'mcp.json'))) {
      patterns.push('.factory/mcp.json');
    }
    ensureLocalGitExcludes(options.cwd, patterns);
  }

  /**
   * Write the project-scoped `<cwd>/.factory/mcp.json` entry for Kangentic's
   * MCP server, preserving any servers the user configured there.
   *
   * The header value is the literal `${KANGENTIC_MCP_TOKEN}`, which Droid
   * expands against the process environment when it opens the connection.
   * Factory documents that the file is never rewritten with the expanded
   * value, so the token stays out of version control even though this path
   * is inside the user's repo. `removeMcpConfig` strips the entry on session
   * exit so a stale URL does not linger.
   */
  writeMcpConfig(options: DroidCommandOptions): void {
    if (!droidMcpWiringEnabled(options)) return;

    const factoryDir = path.join(options.cwd, '.factory');
    const configPath = path.join(factoryDir, 'mcp.json');

    let existing: { mcpServers?: Record<string, unknown> } = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch {
      // No existing config - start fresh.
    }

    const merged = {
      ...existing,
      mcpServers: {
        ...(existing.mcpServers ?? {}),
        kangentic: {
          type: 'http',
          url: options.mcpServerUrl,
          headers: { 'X-Kangentic-Token': `\${${KANGENTIC_MCP_TOKEN_ENV}}` },
        },
      },
    };

    try {
      fs.mkdirSync(factoryDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
    } catch (error) {
      console.error(`[droid] Failed to write MCP config: ${configPath}`, error);
    }
  }

  /**
   * Environment injected into the Droid PTY, holding the value that the
   * `${KANGENTIC_MCP_TOKEN}` reference in mcp.json resolves to. Shares
   * `droidMcpWiringEnabled` with the config write.
   */
  buildDroidEnv(options: DroidCommandOptions): Record<string, string> | null {
    if (!droidMcpWiringEnabled(options)) return null;
    return { [KANGENTIC_MCP_TOKEN_ENV]: options.mcpServerToken };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}

/**
 * Remove Kangentic's entry from `<directory>/.factory/mcp.json`, leaving any
 * user-defined servers intact and deleting the file when nothing remains.
 */
export function removeMcpConfig(directory: string): void {
  const configPath = path.join(directory, '.factory', 'mcp.json');

  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    parsed = raw;
  } catch {
    return;
  }

  if (!parsed.mcpServers || !('kangentic' in parsed.mcpServers)) return;

  delete parsed.mcpServers.kangentic;
  if (Object.keys(parsed.mcpServers).length === 0) delete parsed.mcpServers;

  try {
    if (Object.keys(parsed).length === 0) {
      fs.rmSync(configPath, { force: true });
      return;
    }
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2));
  } catch (error) {
    console.error(`[droid] Failed to clean up MCP config: ${configPath}`, error);
  }
}
