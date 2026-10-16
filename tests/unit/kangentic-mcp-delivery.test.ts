/**
 * Every adapter's `kangenticMcp` declaration matches what its real builder does
 * (`AgentAdapter.kangenticMcp`, src/main/agent/agent-adapter.ts).
 *
 * The declaration decides two things a wrong value breaks silently: which
 * agents Settings > Workflows offers as the Workflow agent, and whether that
 * agent's caller-scoped server URL can be trusted. So this drives each
 * registered adapter's `buildCommand` (and `buildEnv`) with a marked URL, on a
 * fresh start and on a resume, and looks for the URL where it lands:
 *
 * - declared `'per-session'`: the URL reaches the session (its command, its env,
 *   or a file in its own session directory) and is never written literally into
 *   a file in the working folder, which other sessions there share;
 * - declared `'shared-folder'`: the URL is written into a file in the working
 *   folder (that is what the value admits to);
 * - not declared: the URL reaches nothing.
 *
 * Runtime checks over the real registry, since `tests/unit/` is not typechecked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import type { AgentAdapter, SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const MARKER_URL = 'http://127.0.0.1:65531/mcp/delivery-test-project/delivery-test-session-7f3a';
const MARKER_TOKEN = 'delivery-test-token-91c2';
const SESSION_ID = '0f9c7d42-5b1e-4c3a-9a77-2d1f8e6b4c10';

let workingFolder: string;
let sessionFolder: string;

beforeEach(() => {
  workingFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-mcp-delivery-cwd-'));
  sessionFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-mcp-delivery-session-'));
});

afterEach(() => {
  fs.rmSync(workingFolder, { recursive: true, force: true });
  fs.rmSync(sessionFolder, { recursive: true, force: true });
});

function spawnOptions(resume: boolean): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/agent-under-test',
    taskId: 'delivery-test-task',
    cwd: workingFolder,
    projectRoot: workingFolder,
    permissionMode: 'default',
    sessionId: SESSION_ID,
    resume,
    prompt: resume ? undefined : 'Plan the work.',
    statusOutputPath: path.join(sessionFolder, 'status.json'),
    eventsOutputPath: path.join(sessionFolder, 'events.jsonl'),
    shell: 'bash',
    mcpServerEnabled: true,
    mcpServerUrl: MARKER_URL,
    mcpServerToken: MARKER_TOKEN,
  };
}

/** Every file under `folder` whose text holds the marker URL, as paths relative to it. */
function filesHoldingMarker(folder: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (fs.readFileSync(entryPath, 'utf-8').includes(MARKER_URL)) {
        found.push(path.relative(folder, entryPath));
      }
    }
  };
  visit(folder);
  return found;
}

interface Delivery {
  inCommand: boolean;
  inEnv: boolean;
  inSessionFolder: string[];
  inWorkingFolder: string[];
}

function deliver(adapter: AgentAdapter, resume: boolean): Delivery {
  const options = spawnOptions(resume);
  const command = adapter.buildCommand(options);
  const env = adapter.buildEnv?.(options) ?? {};
  return {
    inCommand: command.includes(MARKER_URL),
    inEnv: Object.values(env).some((value) => value.includes(MARKER_URL)),
    inSessionFolder: filesHoldingMarker(sessionFolder),
    inWorkingFolder: filesHoldingMarker(workingFolder),
  };
}

const adapterNames = agentRegistry.list();

describe('kangenticMcp declarations match the real builders', () => {
  it('covers the registry', () => {
    // A registry that failed to load would pass every case below vacuously.
    expect(adapterNames.length).toBeGreaterThan(10);
    const declared = adapterNames.filter((name) => agentRegistry.getOrThrow(name).kangenticMcp !== undefined);
    expect(declared.length).toBeGreaterThan(0);
  });

  describe.each(adapterNames)('%s', (adapterName) => {
    const adapter = agentRegistry.getOrThrow(adapterName);

    it.each([false, true])('resume=%s: the URL lands where the declaration says', (resume) => {
      const delivery = deliver(adapter, resume);
      const reachesSession = delivery.inCommand || delivery.inEnv
        || delivery.inSessionFolder.length > 0 || delivery.inWorkingFolder.length > 0;

      if (adapter.kangenticMcp === 'per-session') {
        expect(reachesSession, `${adapterName} declares per-session MCP but its builder delivers no URL`).toBe(true);
        expect(
          delivery.inWorkingFolder,
          `${adapterName} declares per-session MCP but writes the session's URL into a file the working folder shares`,
        ).toEqual([]);
      } else if (adapter.kangenticMcp === 'shared-folder') {
        expect(
          delivery.inWorkingFolder.length,
          `${adapterName} declares shared-folder MCP but writes no URL into the working folder`,
        ).toBeGreaterThan(0);
      } else {
        expect(reachesSession, `${adapterName} delivers Kangentic's MCP URL but declares no kangenticMcp`).toBe(false);
      }
    });
  });
});
