import fs from 'node:fs';
import path from 'node:path';

/**
 * Kangentic MCP server wiring for Grok Build.
 *
 * Grok reads project-scoped MCP servers from `<cwd>/.grok/config.toml`
 * (walked up to the git root; trust-gated by the folder-trust store, which
 * a Kangentic worktree inherits from its trusted project root - see
 * trust-manager.ts). There is no per-invocation config flag, so a file
 * write is the delivery mechanism - the Droid `.factory/mcp.json`
 * precedent.
 *
 * NO SECRET AND NO SESSION STATE EVER REACHES DISK. The shipped grok 1.0.0
 * user guide (07-mcp-servers.md) documents that grok expands `${VAR}`
 * references against the process environment in every string field of
 * `[mcp_servers.*]` - `url`, `command`, `args`, and the values of `env` and
 * `headers` - at load time, without rewriting the file. So the block below
 * is fully STATIC: the per-session URL (which carries the caller-session
 * id) and the per-launch token both arrive through the PTY environment via
 * `buildEnv`. That also makes one file correct for CONCURRENT sessions in
 * the same cwd - each grok process expands its own environment - which the
 * Droid design (literal URL in the file, last-writer-wins) cannot do. A
 * grok session without these env vars (the user's own manual run while a
 * Kangentic session is live) merely shows a `kangentic` server that fails
 * to connect; the block is removed when the last Kangentic session in the
 * cwd releases it.
 *
 * `.grok/config.toml` is a USER-OWNED file that may carry their own
 * project-scoped servers and settings, so edits are surgical: Kangentic
 * only ever appends/removes its own sentinel-delimited block and never
 * reserializes the user's TOML.
 */

export const KANGENTIC_MCP_URL_ENV = 'KANGENTIC_MCP_URL';
export const KANGENTIC_MCP_TOKEN_ENV = 'KANGENTIC_MCP_TOKEN';
export const KANGENTIC_MCP_TOKEN_HEADER = 'X-Kangentic-Token';

const BLOCK_BEGIN = '# BEGIN KANGENTIC MANAGED BLOCK (written by Kangentic; removed automatically)';
const BLOCK_END = '# END KANGENTIC MANAGED BLOCK';

const MANAGED_BLOCK = [
  BLOCK_BEGIN,
  '[mcp_servers.kangentic]',
  `url = "\${${KANGENTIC_MCP_URL_ENV}}"`,
  `headers = { "${KANGENTIC_MCP_TOKEN_HEADER}" = "\${${KANGENTIC_MCP_TOKEN_ENV}}" }`,
  BLOCK_END,
  '',
].join('\n');

function configTomlPath(directory: string): string {
  return path.join(directory, '.grok', 'config.toml');
}

/** Strip our sentinel-delimited block from the file content, if present. */
function stripManagedBlock(content: string): string {
  const beginIndex = content.indexOf(BLOCK_BEGIN);
  if (beginIndex === -1) return content;
  const endIndex = content.indexOf(BLOCK_END, beginIndex);
  if (endIndex === -1) {
    // A truncated block (crash mid-write). Drop from BEGIN to end of file -
    // everything after our sentinel is ours by construction (we only ever
    // append the block at the tail).
    return content.slice(0, beginIndex);
  }
  const afterEnd = endIndex + BLOCK_END.length;
  // Swallow the newline(s) that terminated our block.
  const tail = content.slice(afterEnd).replace(/^\r?\n/, '');
  return content.slice(0, beginIndex) + tail;
}

/**
 * Ensure `<cwd>/.grok/config.toml` carries the Kangentic MCP block.
 * Idempotent (any previous copy is replaced) and preserving: user content
 * is untouched. Best-effort - a failure only costs MCP tools in the
 * session, never the spawn.
 */
export function writeMcpConfig(directory: string): void {
  const filePath = configTomlPath(directory);
  try {
    let existing = '';
    try {
      existing = fs.readFileSync(filePath, 'utf-8');
    } catch {
      // No existing config - start fresh.
    }
    const base = stripManagedBlock(existing);
    const separator = base.length === 0 || base.endsWith('\n') ? '' : '\n';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${base}${separator}${MANAGED_BLOCK}`);
  } catch (error) {
    console.error(`[grok] Failed to write MCP config: ${filePath}`, error);
  }
}

/**
 * Remove Kangentic's managed block, deleting the file when nothing else
 * remains and pruning an empty `.grok/` directory - so a repo the user
 * never configured grok in is left exactly as found.
 */
export function removeMcpConfig(directory: string): void {
  const filePath = configTomlPath(directory);

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }
  if (!content.includes(BLOCK_BEGIN)) return;

  const remaining = stripManagedBlock(content);
  try {
    if (remaining.trim().length === 0) {
      fs.rmSync(filePath, { force: true });
      try { fs.rmdirSync(path.dirname(filePath)); } catch { /* not empty or already gone */ }
    } else {
      fs.writeFileSync(filePath, remaining);
    }
  } catch (error) {
    console.error(`[grok] Failed to clean up MCP config: ${filePath}`, error);
  }
}
