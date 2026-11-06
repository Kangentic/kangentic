/**
 * What a remote agent's opening prompt names. Before this, a task's attachments, {{worktreePath}} and {{projectPath}}
 * reached it as this computer's paths, and attachments were never on the host at all, so an agent could not read a
 * screenshot the user attached. A handoff pointed the next agent at a Windows path.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliPathForTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { resolveTaskTemplateVars, type TaskTemplateContext } from '../../src/main/agent/shared/task-template-resolvers';
import { copyAttachmentsToHost, withAttachmentsOnHost, withFailedAttachmentsNoted } from '../../src/main/remote/host-attachments';
import { setRemoteProjectLookup } from '../../src/main/remote/host-paths';
import { setHostAccessLookup, type HostAccess } from '../../src/main/remote/host-transfer';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';
import type { Task } from '../../src/shared/types';

const HOST_PROJECT = '/home/dev/proj';

let scratch: string;
let shell: string;
let attachment: string;
let hostAttachment: string;
let hostHolds: Map<string, Buffer>;
let writes: string[];
let linkDown: boolean;
/** Runs when a write script is asked, before the host answers, so a test can hold a write open. */
let onWrite: ((step: string) => Promise<void>) | null;

function answer(stdout: string): HostCommandResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

/** A host that keeps what it is sent, speaking the transfer scripts' lines. */
async function fakeHost(request: HostCommandRequest): Promise<HostCommandResult> {
  if (linkDown) throw new Error('the link is down');
  const [, script, , ...args] = request.args;
  if (script.includes('position=0')) {
    return answer(args.map((hostPath, index) => `KG:size:${index + 1}:${hostHolds.get(hostPath)?.length ?? '-'}`).join('\n'));
  }
  const [hostPath, , step] = args;
  if (onWrite) await onWrite(step);
  if (step === 'first') {
    hostHolds.set(hostPath, Buffer.from(request.stdin ?? '', 'base64'));
    writes.push(hostPath);
  }
  return answer('KG:ok\n');
}

const access: HostAccess = { hostId: 'host-1', runCommand: fakeHost, pathPresence: vi.fn(), removeFiles: vi.fn(), listeningPorts: vi.fn() };

function context(task: Partial<Task>, attachmentPaths: string[]): TaskTemplateContext {
  return {
    task: { id: 't', display_id: 12, title: 'Task', description: '', labels: [], worktree_path: null, ...task } as Task,
    defaultBaseBranch: 'main',
    attachmentPaths,
    devPort: null,
    projectPath: shell,
    projectName: 'Remote',
    move: null,
    workflow: null,
  };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-prompt-paths-'));
  shell = path.join(scratch, 'shell');
  fs.mkdirSync(path.join(shell, '.kangentic', 'tasks', 't', 'attachments'), { recursive: true });
  attachment = path.join(shell, '.kangentic', 'tasks', 't', 'attachments', 'shot.png');
  fs.writeFileSync(attachment, Buffer.from([1, 2, 3, 0, 255]));
  hostAttachment = `${HOST_PROJECT}/.kangentic/tasks/t/attachments/shot.png`;
  hostHolds = new Map();
  writes = [];
  linkDown = false;
  onWrite = null;
  setRemoteProjectLookup((projectPath) => (projectPath === shell ? { hostId: 'host-1', path: HOST_PROJECT } : null));
  setHostAccessLookup(() => access);
});

afterEach(() => {
  setRemoteProjectLookup(null);
  setHostAccessLookup(null);
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the variables a prompt and a script read', () => {
  it('name the host for a remote project', () => {
    const vars = resolveTaskTemplateVars(context({ worktree_path: path.join(shell, '.kangentic', 'worktrees', '12') }, [attachment]));

    expect(vars.projectPath).toBe(HOST_PROJECT);
    expect(vars.worktreePath).toBe(`${HOST_PROJECT}/.kangentic/worktrees/12`);
    expect(vars.attachments).toBe(`\n${hostAttachment}`);
    expect(Object.values(vars).join('\n')).not.toContain(shell);
  });

  it('keep {{worktreePath}} empty for a task with no worktree', () => {
    expect(resolveTaskTemplateVars(context({}, [])).worktreePath).toBe('');
  });

  it('are untouched for a project on this computer', () => {
    setRemoteProjectLookup(() => null);
    const worktree = path.join(shell, '.kangentic', 'worktrees', '12');

    const vars = resolveTaskTemplateVars(context({ worktree_path: worktree }, [attachment]));

    expect(vars).toMatchObject({ projectPath: shell, worktreePath: worktree, attachments: `\n${attachment}` });
  });
});

describe('a task\'s attachments', () => {
  it('reach the host at the path the prompt names, byte for byte', async () => {
    expect(await copyAttachmentsToHost(shell, [attachment])).toEqual([]);
    expect(hostHolds.get(hostAttachment)).toEqual(Buffer.from([1, 2, 3, 0, 255]));
  });

  it('are not sent again once the host holds them', async () => {
    await copyAttachmentsToHost(shell, [attachment]);
    writes.length = 0;

    await copyAttachmentsToHost(shell, [attachment]);

    expect(writes).toEqual([]);
  });

  it('ask nothing of a host for a project on this computer, or for a task with none', async () => {
    setHostAccessLookup(() => { throw new Error('asked'); });
    expect(await copyAttachmentsToHost(path.join(scratch, 'local'), [attachment])).toEqual([]);
    expect(await copyAttachmentsToHost(shell, [])).toEqual([]);
  });

  it('report a host that cannot be reached, and a prompt then says so instead of naming the file', async () => {
    linkDown = true;

    const failures = await copyAttachmentsToHost(shell, [attachment]);
    const text = withFailedAttachmentsNoted(`\n${hostAttachment}\n${HOST_PROJECT}/other.png`, failures);

    expect(failures[0].reason).toContain('the link is down');
    expect(text.split('\n')).not.toContain(hostAttachment);
    expect(text).toContain(`${HOST_PROJECT}/other.png`);
    expect(text).toContain('Not copied to this host');
    expect(text).toContain('shot.png');
  });

  it('leave the text alone when everything arrived', () => {
    expect(withFailedAttachmentsNoted(`\n${hostAttachment}`, [])).toBe(`\n${hostAttachment}`);
  });
});

/** Attachment files on this computer, each long enough to cross the link in two chunks. */
function attachmentFiles(count: number, bytes: number): string[] {
  return Array.from({ length: count }, (_unused, index) => {
    const localPath = path.join(shell, '.kangentic', 'tasks', 't', 'attachments', `file-${index}.bin`);
    fs.writeFileSync(localPath, Buffer.alloc(bytes, index + 1));
    return localPath;
  });
}

describe('a copy that runs out of time', () => {
  it('turns a caller\'s aborted signal into a failure for the file, rather than a throw', async () => {
    const controller = new AbortController();
    controller.abort();

    const failures = await copyAttachmentsToHost(shell, [attachment], controller.signal);

    expect(failures).toHaveLength(1);
    expect(failures[0].hostPath).toBe(hostAttachment);
    expect(failures[0].reason).toMatch(/ran out of time/);
    expect(writes).toEqual([]);
  });

  it('turns a spent budget on a slow host into a failure naming each file left', async () => {
    onWrite = () => new Promise((resolve) => setTimeout(resolve, 40));
    const localPaths = attachmentFiles(5, 160 * 1024);

    const failures = await copyAttachmentsToHost(shell, localPaths, undefined, 1);

    // Each file is two chunks, so each is stopped between them or before its first, whichever the budget reaches.
    expect(failures.map((failure) => failure.hostPath).sort()).toEqual(
      localPaths.map((localPath) => `${HOST_PROJECT}/.kangentic/tasks/t/attachments/${path.basename(localPath)}`).sort(),
    );
    for (const failure of failures) expect(failure.reason).toContain(`Copying ${failure.hostPath} ran out of time`);
  });

  it('copies files side by side, three writes in flight at once and no more', async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    onWrite = async (step) => {
      if (step !== 'first') return;
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await held;
      inFlight -= 1;
    };
    const localPaths = attachmentFiles(6, 10);

    const copying = copyAttachmentsToHost(shell, localPaths);
    await vi.waitFor(() => expect(inFlight).toBe(3));
    release();
    const failures = await copying;

    expect(failures).toEqual([]);
    expect(mostInFlight).toBe(3);
    expect(writes).toHaveLength(6);
  });
});

describe('the variables once the attachments are on the host', () => {
  it('are the same object when nothing failed', async () => {
    const vars = { attachments: `\n${hostAttachment}`, title: 'Task' };

    const resolved = await withAttachmentsOnHost(shell, [attachment], vars);

    expect(resolved).toBe(vars);
  });

  it('are a copy whose attachments carry the note when a file did not arrive', async () => {
    linkDown = true;
    const vars = { attachments: `\n${hostAttachment}`, title: 'Task' };

    const resolved = await withAttachmentsOnHost(shell, [attachment], vars);

    expect(resolved).not.toBe(vars);
    expect(resolved.title).toBe('Task');
    expect(resolved.attachments).toContain('Not copied to this host');
    expect(resolved.attachments.split('\n')).not.toContain(hostAttachment);
    expect(vars.attachments).toBe(`\n${hostAttachment}`);
  });
});

describe('a handoff\'s history file', () => {
  it('reaches the next agent as the host names it, not as this computer\'s mirror path', () => {
    const mirror = path.join(scratch, 'mirror');
    const place: SshCliPlace = { kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'bash', localHome: mirror, roots: [{ local: shell, host: HOST_PROJECT }] };

    expect(cliPathForTarget(path.join(mirror, '.claude', 'projects', 'proj', 'a.jsonl'), place)).toBe('/home/dev/.claude/projects/proj/a.jsonl');
    expect(cliPathForTarget(path.join(shell, 'src', 'a.ts'), place)).toBe(`${HOST_PROJECT}/src/a.ts`);
  });
});
