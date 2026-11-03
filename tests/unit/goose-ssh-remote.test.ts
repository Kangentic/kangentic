/**
 * A Goose on a remote host over SSH (#913), built by the real command builder with a `ssh` place from
 * the fake host (tests/unit/helpers/fake-ssh-host.ts). Verified only against that fake: nothing here
 * has met a real Goose or a real host.
 *
 * What a user loses if it breaks: a Goose started by a path from this computer, or without the
 * approval mode the column asked for (Goose reads it only from `GOOSE_MODE`, which then runs
 * unattended by its own default).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GooseAdapter } from '../../src/main/agent/adapters/goose';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';
import { pullHostFilesFor } from '../../src/main/remote/host-file-sync';
import { quoteArg, toForwardSlash } from '../../src/shared/paths';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';

let workspace: FakeSshWorkspace;
let target: CliTarget;

beforeEach(async () => {
  workspace = await makeFakeSshWorkspace();
  target = { ...workspace.place, linuxCliPath: 'goose' };
});

afterEach(async () => {
  await workspace.dispose();
});

function options(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: 'goose',
    taskId: 'task-1',
    cwd: workspace.projectFolder,
    permissionMode: 'default',
    shell: 'bash',
    sessionId: 'session-abc',
    prompt: 'fix the bug',
    ptySessionId: 'session-1',
    cliTarget: target,
    ...overrides,
  };
}

describe('a Goose on a remote host', () => {
  it('runs the host\'s own CLI by name and declares no host files', async () => {
    const adapter = new GooseAdapter();

    expect(adapter.remoteCliName).toBe('goose');
    expect(adapter.remoteFiles).toBeUndefined();
    expect(await pullHostFilesFor(adapter, workspace.projectFolder, target)).toBeNull();
    await adapter.ensureTrust(workspace.projectFolder, target);
    expect(workspace.host.writes).toEqual([]);
  });

  it('builds the run and resume forms with nothing of this computer in them', () => {
    const adapter = new GooseAdapter();
    const fresh = adapter.buildCommand(options());
    const resumed = adapter.buildCommand(options({ resume: true }));

    const quotedPrompt = quoteArg('fix the bug', 'bash', { multiline: true });
    expect(fresh).toBe(`goose run -n session-abc -t ${quotedPrompt} -s`);
    expect(resumed).toBe(`goose run -r -n session-abc -t ${quotedPrompt} -s`);
    expect(adapter.buildCommand(options({ prompt: undefined, resume: true }))).toBe('goose session -r -n session-abc');
    for (const command of [fresh, resumed]) {
      expect(command).not.toContain(toForwardSlash(workspace.projectFolder));
    }
  });

  it('hands the approval mode to the host as the spawn\'s own environment, never a path', () => {
    const adapter = new GooseAdapter();

    expect(adapter.buildEnv?.(options({ permissionMode: 'bypassPermissions' }))).toEqual({ GOOSE_MODE: 'auto' });
    expect(adapter.buildEnv?.(options({ permissionMode: 'plan' }))).toEqual({ GOOSE_MODE: 'chat' });
  });
});
