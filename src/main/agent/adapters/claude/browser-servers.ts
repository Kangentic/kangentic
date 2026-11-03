import fs from 'node:fs';
import path from 'node:path';
import { isBrowserAutomationServer, type McpServerDescription } from '../../shared/browser-policy-hook';
import { cliHomeDir, cliPathForTarget, type CliPlace } from '../../shared/cli-target';

/**
 * The browser-automation MCP servers a Claude session will load, by the name
 * its tools carry, so the browser policy hook denies them whatever the user
 * named them (task #977). `playwright` is only one project's name for
 * `@playwright/mcp`.
 *
 * Claude loads servers from three places Kangentic can read: the project's
 * `.mcp.json` in the session's working directory (a worktree's own checkout),
 * and in `~/.claude.json` the user-scope `mcpServers` and the local-scope
 * `projects[<cwd>].mcpServers`. Plugin and managed servers are not read; the
 * hook's name fragments cover the common ones. Read only, never written.
 */

/** Claude's built-in browser server. Never in a config file. */
export const CLAUDE_IN_CHROME_SERVER = 'claude-in-chrome';

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The entries of one `mcpServers` object, each with its name. */
function serversIn(block: unknown): McpServerDescription[] {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return [];
  return Object.entries(block as Record<string, unknown>).flatMap(([name, entry]) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const fields = entry as Record<string, unknown>;
    return [{ name, command: fields.command, args: fields.args, url: fields.url }];
  });
}

/** The servers `~/.claude.json` declares: user scope, and local scope by project key. */
interface ClaudeJsonServers {
  user: McpServerDescription[];
  projects: Array<{ key: string; servers: McpServerDescription[] }>;
}

/**
 * `~/.claude.json` also holds Claude's per-project history and runs to
 * megabytes, and a command is built on the main thread for every spawn. So the
 * server lists are kept per file and read again only when its size or
 * modification time changes.
 */
const claudeJsonCache = new Map<string, { mtimeMs: number; size: number; servers: ClaudeJsonServers | null }>();

function claudeJsonServers(filePath: string): ClaudeJsonServers | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    claudeJsonCache.delete(filePath);
    return null;
  }
  const cached = claudeJsonCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.servers;
  const claudeJson = readJsonObject(filePath);
  let servers: ClaudeJsonServers | null = null;
  if (claudeJson) {
    const projects = claudeJson.projects;
    const projectEntries = typeof projects === 'object' && projects !== null && !Array.isArray(projects)
      ? Object.entries(projects as Record<string, unknown>)
      : [];
    servers = {
      user: serversIn(claudeJson.mcpServers),
      projects: projectEntries.flatMap(([key, project]) => {
        if (typeof project !== 'object' || project === null) return [];
        const projectServers = serversIn((project as Record<string, unknown>).mcpServers);
        return projectServers.length > 0 ? [{ key, servers: projectServers }] : [];
      }),
    };
  }
  claudeJsonCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, servers });
  return servers;
}

export interface BrowserServerSources {
  /** The session's working directory, where Claude reads `.mcp.json`. */
  cwd: string;
  /** A Claude installed in a WSL distro: its home and its own name for `cwd`. */
  place: CliPlace | null;
}

/** Every MCP server a session's config files describe. */
export function configuredMcpServers(sources: BrowserServerSources): McpServerDescription[] {
  const servers: McpServerDescription[] = [];
  servers.push(...serversIn(readJsonObject(path.join(sources.cwd, '.mcp.json'))?.mcpServers));
  const claudeJson = claudeJsonServers(path.join(cliHomeDir(sources.place), '.claude.json'));
  if (claudeJson) {
    servers.push(...claudeJson.user);
    // Claude keys a project by its path as the CLI sees it: forward slashes on
    // Windows, the distro's Linux path in WSL. A Windows path names the same
    // folder in any case, so there the keys are compared without case.
    const projectKey = cliPathForTarget(sources.cwd, sources.place);
    const anyCase = !sources.place && process.platform === 'win32';
    const normalize = (key: string): string => (anyCase ? key.replace(/\\/g, '/').toLowerCase() : key);
    const wanted = normalize(projectKey);
    for (const project of claudeJson.projects) {
      if (normalize(project.key) === wanted) servers.push(...project.servers);
    }
  }
  return servers;
}

/** The names of the browser-automation servers among them, plus Claude in Chrome. */
export function claudeBrowserServerNames(sources: BrowserServerSources): string[] {
  const names = configuredMcpServers(sources)
    .filter((server) => isBrowserAutomationServer(server))
    .map((server) => server.name);
  return [...new Set([CLAUDE_IN_CHROME_SERVER, ...names])];
}
