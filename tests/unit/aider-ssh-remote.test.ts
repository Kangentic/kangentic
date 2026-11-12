/**
 * An Aider on a remote host over SSH (#913), built by the real command builder with a `ssh` place from
 * the fake host (tests/unit/helpers/fake-ssh-host.ts). Verified only against that fake: nothing here
 * has met a real Aider or a real host.
 *
 * What a user loses if it breaks: an Aider started with this computer's paths in its idle
 * notification (so the host's script is never found and the card never shows idle from a hook), or one
 * that reads chat history from this computer's empty shell folder and reports a wrong cost.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';
import type { AgentAdapter, SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import { toStoredCliTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import { pullHostFilesFor } from '../../src/main/remote/host-file-sync';
import { HostWorktrees } from '../../src/main/remote/remote-worktrees';
import { quoteArg, toForwardSlash } from '../../src/shared/paths';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';

const SHELL = 'bash';
let workspace: FakeSshWorkspace;
let target: CliTarget;

beforeEach(async () => {
  workspace = await makeFakeSshWorkspace();
  target = { ...workspace.place, linuxCliPath: 'aider' };
});

afterEach(async () => {
  await workspace.dispose();
});

function sessionDirectory(): string {
  return path.join(workspace.projectFolder, '.kangentic', 'sessions', 'session-1');
}

function build(adapter: AgentAdapter, overrides: Partial<SpawnCommandOptions> = {}): string {
  const directory = sessionDirectory();
  fs.mkdirSync(directory, { recursive: true });
  return adapter.buildCommand({
    agentPath: 'aider',
    taskId: 'task-1',
    cwd: workspace.projectFolder,
    permissionMode: 'default',
    shell: SHELL,
    prompt: 'fix the bug',
    statusOutputPath: path.join(directory, 'status.json'),
    eventsOutputPath: path.join(directory, 'events.jsonl'),
    ptySessionId: 'session-1',
    cliTarget: target,
    ...overrides,
  });
}

describe('an Aider on a remote host', () => {
  it('runs the host\'s own CLI by name and declares no host files', async () => {
    const adapter = new AiderAdapter();

    expect(adapter.remoteCliName).toBe('aider');
    expect(adapter.remoteFiles).toBeUndefined();
    expect(await pullHostFilesFor(adapter, workspace.projectFolder, target)).toBeNull();
    await adapter.ensureTrust(workspace.projectFolder, target);
    expect(workspace.host.writes).toEqual([]);
    expect(workspace.host.commands).toEqual([]);
  });

  it('sends the idle notification through the transport script by its host path, with stdin closed', () => {
    const adapter = new AiderAdapter();
    const command = build(adapter);
    const hostScript = `${workspace.hostProject}/.kangentic/sessions/session-1/wsl-hooks/wsl-hook.sh`;

    expect(command.startsWith('aider ')).toBe(true);
    expect(command).toContain(`--notifications-command ${quoteArg(`sh "${hostScript}" event idle </dev/null`, SHELL)}`);
    expect(command).not.toContain('event-bridge.js');
    expect(command).not.toContain('node ');
    expect(command).not.toContain(toForwardSlash(workspace.projectFolder));
    expect(command).not.toContain(toForwardSlash(os.tmpdir()));
    // The script and its folders exist on this computer for the relay to push.
    expect(fs.existsSync(wslHookPaths(sessionDirectory()).script)).toBe(true);
  });

  it('keeps the conversation in a history file named by the session, by its path on the host, and restores it when resumed', () => {
    const adapter = new AiderAdapter();
    const historyOnHost = `${workspace.hostProject}/.aider.chat.history.aider-session-7.md`;

    expect(adapter.supportsCallerSessionId).toBe(true);
    const resumed = build(adapter, { resume: true, sessionId: 'aider-session-7', prompt: undefined });
    expect(resumed).toContain(`--chat-history-file ${quoteArg(historyOnHost, SHELL)}`);
    expect(resumed).toContain('--restore-chat-history');
    expect(resumed).not.toContain(toForwardSlash(workspace.projectFolder));
    expect(build(adapter, { sessionId: 'aider-session-7', prompt: undefined })).not.toContain('--restore-chat-history');
  });

  it('leaves the worktree stand-in removable with a history copy in it, so a Done move takes both', async () => {
    const standIn = path.join(workspace.projectFolder, '.kangentic', 'worktrees', '7');
    fs.mkdirSync(standIn, { recursive: true });
    const adapter = new AiderAdapter();
    const [copy] = adapter.remoteTranscriptFiles({ agentSessionId: 'aider-session-7', cwd: standIn, cliTarget: toStoredCliTarget(target)! });
    fs.writeFileSync(copy, '#### a question\n');
    const worktrees = new HostWorktrees({
      hostRepoPath: workspace.hostProject,
      shellFolder: workspace.projectFolder,
      runCommand: async () => ({ code: 0, stdout: 'KG:removed\n', stderr: '', timedOut: false }),
      pathPresence: async () => [],
    });

    await expect(worktrees.removeWorktree(standIn)).resolves.toBe(true);

    expect(fs.existsSync(standIn)).toBe(false);
  });

  it('finds no chat history in this computer\'s shell folder, and the verifier answers no without throwing', async () => {
    const adapter = new AiderAdapter();

    expect(await adapter.locateSessionHistoryFile('', workspace.projectFolder)).toBeNull();
    const verifier = adapter.getSubmissionVerifier('command-injection');
    expect(verifier).not.toBeNull();
    await expect(verifier?.({ type: 'command-injection', text: '/add file.ts', cwd: workspace.projectFolder, sentAt: Date.now() })).resolves.toBe(false);
  });
});
