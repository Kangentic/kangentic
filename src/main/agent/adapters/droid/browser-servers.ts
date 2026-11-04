import fs from 'node:fs';
import path from 'node:path';
import { isBrowserAutomationServer, type McpServerDescription } from '../../shared/browser-policy-hook';
import { cliHomeDir, type CliPlace } from '../../shared/cli-target';

/** The servers a `.factory/mcp.json` declares, or none when it is missing or not that shape. */
function readMcpServers(filePath: string): McpServerDescription[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const block = (parsed as { mcpServers?: unknown }).mcpServers;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return [];
  return Object.entries(block as Record<string, unknown>).flatMap(([name, entry]) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const fields = entry as Record<string, unknown>;
    return [{ name, command: fields.command, args: fields.args, url: fields.url }];
  });
}

export interface DroidBrowserServerSources {
  /** The session's working directory, where Droid reads `.factory/mcp.json`. */
  cwd: string;
  /** A Droid installed in a WSL distro: its home holds the user file. */
  place: CliPlace | null;
}

/**
 * The browser-automation MCP servers a Droid session will load, by the name
 * its tools carry, so the browser policy hook denies them whatever the user
 * named them.
 *
 * Droid reads MCP servers from the user's `~/.factory/mcp.json`, a
 * `.factory/mcp.json` in an ancestor folder, and the project's own
 * `.factory/mcp.json` (Factory's MCP docs, https://docs.factory.com/harness/mcp.md,
 * read 2026-11-03). The user file and the working directory's file are read
 * here. Ancestor, plugin and org-managed servers are not, and the hook's name
 * fragments cover the common ones. The files are only read, never written:
 * Kangentic's own entry in the project file is `kangentic`, which the policy
 * never denies.
 */
export function droidBrowserServerNames(sources: DroidBrowserServerSources): string[] {
  const servers = [
    ...readMcpServers(path.join(sources.cwd, '.factory', 'mcp.json')),
    ...readMcpServers(path.join(cliHomeDir(sources.place), '.factory', 'mcp.json')),
  ];
  return [...new Set(servers.filter((server) => isBrowserAutomationServer(server)).map((server) => server.name))];
}
