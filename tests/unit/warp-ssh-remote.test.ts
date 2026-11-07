/**
 * A Warp `oz` on a remote host over SSH (#913), built by the real command builder with a `ssh` place
 * from the fake host (tests/unit/helpers/fake-ssh-host.ts). Verified only against that fake: nothing
 * here has met a real `oz`, its account sign-in or a real host.
 *
 * What a user loses if it breaks: `oz agent run -C` pointed at a folder that exists only on this
 * computer, so the agent starts in the wrong place or not at all on the host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WarpAdapter } from '../../src/main/agent/adapters/warp';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';
import { pullHostFilesFor } from '../../src/main/remote/host-file-sync';
import { quoteArg, toForwardSlash } from '../../src/shared/paths';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';

let workspace: FakeSshWorkspace;
let target: CliTarget;

beforeEach(async () => {
  workspace = await makeFakeSshWorkspace();
  target = { ...workspace.place, linuxCliPath: 'oz' };
});

afterEach(async () => {
  await workspace.dispose();
});

function options(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: 'oz',
    taskId: 'task-1',
    cwd: workspace.projectFolder,
    permissionMode: 'default',
    shell: 'bash',
    prompt: 'fix the bug',
    ptySessionId: 'session-1',
    cliTarget: target,
    ...overrides,
  };
}

describe('a Warp oz on a remote host', () => {
  it('runs the host\'s `oz` by name and declares no host files', async () => {
    const adapter = new WarpAdapter();

    expect(adapter.remoteCliName).toBe('oz');
    expect(adapter.remoteFiles).toBeUndefined();
    expect(await pullHostFilesFor(adapter, workspace.projectFolder, target)).toBeNull();
    await adapter.ensureTrust(workspace.projectFolder, target);
    expect(workspace.host.writes).toEqual([]);
    expect(workspace.host.commands).toEqual([]);
  });

  it('starts in the project\'s folder on the host, never this computer\'s shell folder', () => {
    const command = new WarpAdapter().buildCommand(options());

    expect(command).toBe(`oz agent run -C ${workspace.hostProject} --name task-1 ${quoteArg('--', 'bash')} --prompt ${quoteArg('fix the bug', 'bash', { multiline: true })}`);
    expect(command).not.toContain(toForwardSlash(workspace.projectFolder));
  });
});
