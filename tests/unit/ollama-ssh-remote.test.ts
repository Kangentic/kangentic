/**
 * An Ollama on a remote host over SSH (#913), built by the real command builder with a `ssh` place from
 * the fake host (tests/unit/helpers/fake-ssh-host.ts). Verified only against that fake: nothing here
 * has met a real Ollama, its daemon or a real host.
 *
 * What a user loses if it breaks: an Ollama run started by a path from this computer, or a model list
 * read from this computer's own Ollama (models the host does not have) for a project on a host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaAdapter } from '../../src/main/agent/adapters/ollama';
import { discoverOllama } from '../../src/main/agent/adapters/ollama/capability-discovery';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';
import { pullHostFilesFor } from '../../src/main/remote/host-file-sync';
import { quoteArg, toForwardSlash } from '../../src/shared/paths';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';

let workspace: FakeSshWorkspace;
let target: CliTarget;

beforeEach(async () => {
  workspace = await makeFakeSshWorkspace();
  target = { ...workspace.place, linuxCliPath: 'ollama' };
});

afterEach(async () => {
  await workspace.dispose();
});

function options(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: 'ollama',
    taskId: 'task-1',
    cwd: workspace.projectFolder,
    permissionMode: 'default',
    shell: 'bash',
    model: 'qwen2.5-coder:7b',
    prompt: '- list the files',
    ptySessionId: 'session-1',
    cliTarget: target,
    ...overrides,
  };
}

describe('an Ollama on a remote host', () => {
  it('runs the host\'s own CLI by name and declares no host files', async () => {
    const adapter = new OllamaAdapter();

    expect(adapter.remoteCliName).toBe('ollama');
    expect(adapter.remoteFiles).toBeUndefined();
    expect(await pullHostFilesFor(adapter, workspace.projectFolder, target)).toBeNull();
    await adapter.ensureTrust(workspace.projectFolder, target);
    expect(workspace.host.writes).toEqual([]);
  });

  it('builds the run with the model and the prompt after the end-of-options marker, nothing of this computer in it', () => {
    const command = new OllamaAdapter().buildCommand(options());

    expect(command).toBe(`ollama run qwen2.5-coder:7b -- ${quoteArg('- list the files', 'bash', { multiline: true })}`);
    expect(command).not.toContain(toForwardSlash(workspace.projectFolder));
  });

  it('lists the host\'s models by running `ollama list` on the host, never on this computer', async () => {
    workspace.host.commandResults.set('ollama', (request) => ({
      code: 0,
      stdout: `NAME                ID              SIZE      MODIFIED\nllama3.2:latest     a80c4f17acd5    2.0 GB    2 days ago\ngemma2:2b           8ccf136fdd52    1.6 GB    1 week ago\n`,
      stderr: '',
      timedOut: false,
      ...(request.args[0] === 'list' ? {} : { code: 1 }),
    }));

    const { capabilities } = await discoverOllama('ollama', target);

    expect(capabilities.models).toEqual(['gemma2:2b', 'llama3.2:latest']);
    // Both reads (the model list and the thinking levels) run on the host.
    expect(workspace.host.commands.map((request) => [request.file, ...request.args])).toEqual([['ollama', 'list'], ['ollama', 'run', '--help']]);
  });

  it('falls back to a free-form model input when the host\'s Ollama cannot be asked', async () => {
    // No answer registered: the fake host reports the program as not installed.
    const { capabilities } = await discoverOllama('ollama', target);

    expect(capabilities.supportsModelOverride).toBe(true);
    expect(capabilities.models).toBeUndefined();
  });
});
