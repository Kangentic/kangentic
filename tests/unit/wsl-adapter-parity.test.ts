/**
 * Every agent that declares it runs from a WSL distro (`supportsWslCli`) holds
 * the same contract (#286), checked over the REAL registry, so flipping the
 * flag on a new adapter is the gate: its command is built for a distro on NAT
 * networking and must
 *
 * - run the CLI by the path the distro sees, never the `\\wsl.localhost` share;
 * - carry no Windows drive path a Linux CLI cannot open;
 * - keep the MCP token out of argv, as on this machine;
 * - prepare the WSL hook transport in the session's folder whenever anything it
 *   wrote names the transport's script: the stdio MCP bridge and the hooks both
 *   publish there, and without its signal file every `kangentic_*` call waits
 *   out the CLI's own timeout;
 * - never hand the CLI the loopback MCP URL except as the bridge's argument:
 *   the distro's 127.0.0.1 is its own on NAT networking.
 *
 * What it wrote is the command plus every file under the fixture's folder,
 * which is also the distro home the fixture names, so a config written to the
 * CLI's home is read too. Paths are built from the OS temp folder, so the
 * checks hold on Linux CI too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';

const TOKEN = 'kangentic-parity-token-0123456789abcdef';
const MCP_URL = 'http://127.0.0.1:4100/mcp/project-1/parity-session';
const temporaryDirectories: string[] = [];

/** Every text file under `directory`, by path. */
function writtenFiles(directory: string): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    files.push({ path: filePath, text: fs.readFileSync(filePath, 'utf-8') });
  }
  return files;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const WSL_AGENTS = agentRegistry.list()
  .map((name) => agentRegistry.get(name))
  .filter((adapter): adapter is NonNullable<typeof adapter> => adapter?.supportsWslCli === true);

describe('agents that run from a WSL distro', () => {
  it('include Claude and Codex, the reference implementations', () => {
    expect(WSL_AGENTS.map((adapter) => adapter.name)).toEqual(expect.arrayContaining(['claude', 'codex']));
  });

  for (const adapter of WSL_AGENTS) {
    it(`${adapter.name}: runs by the distro path, with no share path, drive path or token in argv, and a relay folder ready`, async () => {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-wsl-parity-${adapter.name}-`));
      temporaryDirectories.push(project);
      const sessionDirectory = path.join(project, '.kangentic', 'sessions', 'parity-session');
      fs.mkdirSync(sessionDirectory, { recursive: true });
      const linuxCliPath = `/home/dev/.local/bin/${adapter.name}`;
      const target: CliTarget = {
        kind: 'wsl',
        distro: 'Ubuntu',
        linuxCliPath,
        facts: {
          distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: project, uncRoot: '\\\\wsl.localhost\\Ubuntu',
          interactivePath: '/usr/bin', env: {}, networkingMode: 'nat',
        },
      };

      const uncCliPath = `\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\${adapter.name}`;
      const command = await adapter.buildCommand({
        agentPath: uncCliPath,
        cliPath: uncCliPath,
        taskId: 'task-parity',
        cwd: project,
        projectRoot: project,
        permissionMode: 'default',
        shell: 'wsl -d Ubuntu',
        statusOutputPath: path.join(sessionDirectory, 'status.json'),
        eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
        mcpServerEnabled: true,
        mcpServerUrl: MCP_URL,
        mcpServerToken: TOKEN,
        ptySessionId: 'parity-session',
        cliTarget: target,
      });

      expect(command.includes(linuxCliPath), command).toBe(true);
      expect(command.indexOf(linuxCliPath)).toBeLessThan(8);
      expect(command).not.toContain('wsl.localhost');
      // A backslash alone is fine: POSIX quoting writes `'\''` for a quote.
      expect(command).not.toMatch(/[A-Za-z]:\\/);
      expect(command).not.toContain(TOKEN);

      const written = [{ path: 'the command', text: command }, ...writtenFiles(project)];
      if (written.some((entry) => entry.text.includes('wsl-hook.sh'))) {
        expect(fs.existsSync(wslHookPaths(sessionDirectory).signal)).toBe(true);
      }
      for (const entry of written) {
        if (!entry.text.includes(MCP_URL)) continue;
        expect(entry.text, `${entry.path} hands over the loopback MCP URL without the bridge`).toContain('wsl-hook.sh');
      }
    });
  }
});
