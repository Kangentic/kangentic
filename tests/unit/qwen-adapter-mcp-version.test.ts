/**
 * How `QwenAdapter.buildCommand` hands Qwen Code Kangentic's MCP server, picked by
 * the DETECTED Qwen version.
 *
 * `--mcp-config` first shipped in Qwen Code 0.16.0: it is absent from 0.15.3's
 * option list, and Qwen's top-level yargs is strict, so an older CLI exits on the
 * unknown flag. So:
 *   - Qwen before 0.16: no `--mcp-config`. The server goes into the folder's
 *     `.qwen/settings.json` as an `mcpServers.kangentic` entry, and the session
 *     takes a hold on that shared file, so the entry is stripped only when the
 *     folder's last session releases.
 *   - Qwen 0.16 and later: `--mcp-config <session dir>/mcp.json`, and the folder's
 *     settings file is not written.
 *   - A version that was never detected takes the flag too.
 *
 * The decision itself (`supportsMcpConfigFlag`) is pure and has its own cases.
 * What only the ADAPTER can break is the wiring: it has to hand the builder the
 * detector's cached version (`cliVersion: this.detector.getCachedVersion()`).
 * Drop that and every Qwen is treated as an unknown version, which takes the
 * flag, which an old CLI rejects. The version is stubbed on the detector the
 * adapter really owns, so no CLI is spawned.
 *
 * `cliVersion` is never passed in the spawn options here: the adapter spreads the
 * caller's options AFTER its own `cliVersion`, so passing one would test the
 * spread and not the detector.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QwenAdapter } from '../../src/main/agent/adapters/qwen-code';
import { AgentDetector } from '../../src/main/agent/shared/agent-detector';

const MCP_URL = 'http://127.0.0.1:51234/mcp/proj-1';
const MCP_TOKEN = 'test-token-mcp-version';

describe('QwenAdapter MCP delivery by detected version', () => {
  let sandbox: string;
  let adapter: QwenAdapter;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-qwen-mcp-version-'));
    adapter = new QwenAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** The detector cache as it reads once `qwen --version` has been seen. */
  function detectedVersion(version: string | null): void {
    vi.spyOn(AgentDetector.prototype, 'getCachedVersion').mockReturnValue(version);
  }

  /** MCP wiring and no events pipeline, so the only reason to write the folder's settings is the server. */
  const mcpOptions = (ptySessionId: string) => ({
    agentPath: 'qwen',
    taskId: `task-of-${ptySessionId}`,
    ptySessionId,
    cwd: sandbox,
    permissionMode: 'default' as const,
    statusOutputPath: path.join(sandbox, '.kangentic', 'sessions', ptySessionId, 'status.json'),
    mcpServerEnabled: true as const,
    mcpServerUrl: MCP_URL,
    mcpServerToken: MCP_TOKEN,
  });

  const settingsPath = () => path.join(sandbox, '.qwen', 'settings.json');
  const sessionMcpConfigPath = (ptySessionId: string) => path.join(sandbox, '.kangentic', 'sessions', ptySessionId, 'mcp.json');

  function readKangenticEntry(): { httpUrl: string; headers: Record<string, string> } | undefined {
    if (!fs.existsSync(settingsPath())) return undefined;
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as {
      mcpServers?: Record<string, { httpUrl: string; headers: Record<string, string> }>;
    };
    return settings.mcpServers?.kangentic;
  }

  it.each([
    ['0.15.3, the release that has no flag', '0.15.3'],
    ['0.15.99, the last before the flag', '0.15.99'],
    ['0.9.0, much older', '0.9.0'],
    ['a v-prefixed 0.15.3', 'v0.15.3'],
  ])('Qwen %s gets no --mcp-config and a settings entry instead', (_label, version) => {
    detectedVersion(version);

    const command = adapter.buildCommand(mcpOptions('session-a'));

    expect(command).not.toContain('--mcp-config');
    expect(fs.existsSync(sessionMcpConfigPath('session-a'))).toBe(false);
    expect(readKangenticEntry()).toEqual({
      httpUrl: MCP_URL,
      headers: { 'X-Kangentic-Token': MCP_TOKEN },
    });
  });

  it.each([
    ['0.16.0, the first with the flag', '0.16.0'],
    ['0.24.0', '0.24.0'],
    ['1.0.0', '1.0.0'],
  ])('Qwen %s gets --mcp-config and leaves the folder\'s settings alone', (_label, version) => {
    detectedVersion(version);

    const command = adapter.buildCommand(mcpOptions('session-a'));

    expect(command).toContain('--mcp-config');
    expect(command).toContain('session-a/mcp.json');
    expect(command).not.toContain(MCP_TOKEN);
    expect(fs.existsSync(sessionMcpConfigPath('session-a'))).toBe(true);
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('takes the flag when the version was never detected', () => {
    detectedVersion(null);

    const command = adapter.buildCommand(mcpOptions('session-a'));

    expect(command).toContain('--mcp-config');
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('follows the adapter\'s detector cache from one spawn to the next', () => {
    const spy = vi.spyOn(AgentDetector.prototype, 'getCachedVersion').mockReturnValue('0.15.3');

    adapter.buildCommand(mcpOptions('session-a'));
    expect(spy).toHaveBeenCalled();
    expect(readKangenticEntry()).toBeDefined();

    // The same adapter, now seeing a newer CLI: the next spawn follows it.
    spy.mockReturnValue('0.24.0');
    const nextCommand = adapter.buildCommand(mcpOptions('session-b'));
    expect(nextCommand).toContain('--mcp-config');
  });

  it('holds the folder\'s settings for a settings-delivered session until the last one releases', () => {
    detectedVersion('0.15.3');
    adapter.buildCommand(mcpOptions('session-a'));
    adapter.buildCommand(mcpOptions('session-b'));
    expect(readKangenticEntry()).toBeDefined();

    // The plaintext token must stay while another session in the folder runs.
    adapter.removeHooks(sandbox, 'session-a');
    expect(readKangenticEntry()).toBeDefined();

    // And be gone once the folder's last session releases.
    adapter.removeHooks(sandbox, 'session-b');
    expect(readKangenticEntry()).toBeUndefined();
  });
});
