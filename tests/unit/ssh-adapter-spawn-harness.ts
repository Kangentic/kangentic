/**
 * What the `<adapter>-ssh-remote.test.ts` files share (#913): one spawn on a fake host, run through the
 * adapter's real trust and command code and the real file sync, and a check that nothing of this
 * computer's paths reached what the host was sent. Every SSH adapter test (Antigravity, Codex, Copilot,
 * Cursor, Droid, Gemini, Goose, Grok, Kimi, OpenCode, Qwen Code) uses it. What differs per adapter goes in
 * the `overrides` argument of `spawnOnHost` / `spawnOptions`, such as OpenCode's `mcpServerEnabled` and
 * `acceptEdits` permission mode. It is a helper, not a test: vitest only runs `*.test.ts`.
 */
import { expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import { pullHostFilesFor, rememberHostFileSync } from '../../src/main/remote/host-file-sync';
import type { FakeSshWorkspace } from './helpers/fake-ssh-host';

export const SESSION_ID = 'session-1';
export const MCP_TOKEN = 'ssh-adapter-token-0123456789';
export const MCP_URL = 'http://127.0.0.1:47123/mcp/project-1/session-1';

/** The folder the session's own files are in, on this computer and on the host. */
export function sessionFolders(workspace: FakeSshWorkspace): { local: string; host: string } {
  return {
    local: path.join(workspace.projectFolder, '.kangentic', 'sessions', SESSION_ID),
    host: `${workspace.hostProject}/.kangentic/sessions/${SESSION_ID}`,
  };
}

export function spawnOptions(workspace: FakeSshWorkspace, cliName: string, overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  const sessionDirectory = sessionFolders(workspace).local;
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return {
    agentPath: cliName,
    taskId: 'task-1',
    cwd: workspace.projectFolder,
    projectRoot: workspace.projectFolder,
    permissionMode: 'default',
    // The host's login shell, as a remote spawn names it: quoting follows it, not this computer.
    shell: workspace.place.shellName,
    prompt: 'fix the bug',
    statusOutputPath: path.join(sessionDirectory, 'status.json'),
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerUrl: MCP_URL,
    mcpServerToken: MCP_TOKEN,
    ptySessionId: SESSION_ID,
    cliTarget: { ...workspace.place, linuxCliPath: cliName },
    ...overrides,
  };
}

export interface HostSpawn {
  command: string;
  env: Record<string, string> | null;
  options: SpawnCommandOptions;
}

/**
 * One spawn as the chokepoints run it: pull the declared files, trust, build the command and its
 * environment, push what changed, and remember the sync for the release.
 */
export async function spawnOnHost(
  adapter: AgentAdapter,
  workspace: FakeSshWorkspace,
  cliName: string,
  overrides: Partial<SpawnCommandOptions> = {},
): Promise<HostSpawn> {
  const cwd = overrides.cwd ?? workspace.projectFolder;
  const sync = await pullHostFilesFor(adapter, cwd, workspace.place);
  if (!sync) throw new Error('the adapter declared no host files');
  await adapter.ensureTrust(cwd, workspace.place);
  const options = spawnOptions(workspace, cliName, overrides);
  const command = adapter.buildCommand(options);
  const env = adapter.buildEnv ? adapter.buildEnv(options) : null;
  await sync.push();
  rememberHostFileSync(SESSION_ID, sync);
  return { command, env, options };
}

/** Every spelling of this computer's folders that could be mistaken for a host path. */
function localSpellings(workspace: FakeSshWorkspace): string[] {
  const spellings = new Set<string>();
  for (const local of [workspace.projectFolder, workspace.mirrorHome, os.tmpdir()]) {
    spellings.add(local);
    spellings.add(local.replace(/\\/g, '/'));
    spellings.add(local.replace(/\\/g, '\\\\'));
  }
  return [...spellings];
}

/** Fails when any file written to the host, the command or the environment names a folder of this computer. */
export function expectNoLocalPaths(workspace: FakeSshWorkspace, spawn: HostSpawn): void {
  const texts: Array<[string, string]> = [
    ['the command', spawn.command],
    ...Object.entries(spawn.env ?? {}).map(([name, value]): [string, string] => [`env ${name}`, value]),
    ...[...workspace.host.files].map(([hostPath, content]): [string, string] => [hostPath, content]),
  ];
  for (const [label, text] of texts) {
    for (const local of localSpellings(workspace)) {
      expect(text, `${label} names ${local}`).not.toContain(local);
    }
  }
}

/** The host's file parsed as JSON. */
export function hostJson(workspace: FakeSshWorkspace, hostPath: string): Record<string, unknown> {
  const content = workspace.host.files.get(hostPath);
  if (content === undefined) throw new Error(`${hostPath} is not on the host`);
  return JSON.parse(content) as Record<string, unknown>;
}
