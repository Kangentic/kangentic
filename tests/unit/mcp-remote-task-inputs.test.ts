/**
 * What an agent on a host hands `create_task` and `update_task`. The branch guard used to test `<shell>/.git` on this
 * disk and skip itself, and an attachment path was read from this disk and its failure went to a console no agent
 * sees. These run the real handlers over a real database and the real git seam, with the host faked at `runCommand`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCreateTask, handleUpdateTask } from '../../src/main/agent/commands/task-commands';
import { handleCreateBacklogTask } from '../../src/main/agent/commands/backlog-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AttachmentRepository } from '../../src/main/db/repositories/attachment-repository';
import { BacklogAttachmentRepository } from '../../src/main/db/repositories/backlog-attachment-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { isGitRepo, isProjectGitRepo } from '../../src/main/git/git-checks';
import { RemoteGitUnavailableError, setRemoteGitResolver, type RemoteGitRunner } from '../../src/main/git/remote-git';
import { agentPathsForProject } from '../../src/main/remote/host-paths';
import type { HostAccess } from '../../src/main/remote/host-transfer';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';

const HOST_PROJECT = '/home/dev/proj';
const HELD_BRANCH = 'feature/held';

let scratch: string;
let shell: string;
let db: Database.Database;
let context: CommandContext;
let worktreeList: () => Promise<string>;
let hostFiles: Map<string, Buffer>;
let linkDown: boolean;
/** Files the fake host reports as past the read script's cap: it names the size and answers `KG:toobig`. */
let reportedSizes: Map<string, number>;

function hostGit(): RemoteGitRunner {
  return {
    run: async () => ({ code: 0, stdout: Buffer.from(await worktreeList()), stderr: '' }),
    readObject: vi.fn(),
    readWorkingFile: vi.fn(),
    countUntracked: vi.fn(),
    fingerprint: vi.fn(),
  } as unknown as RemoteGitRunner;
}

/** The read script's answer for what `hostFiles` holds, as a host would print it. */
async function fakeHostRead(request: HostCommandRequest): Promise<HostCommandResult> {
  if (linkDown) throw new Error('the link is down');
  const [hostPath, offsetText, lengthText] = request.args.slice(3);
  const file = hostFiles.get(hostPath);
  if (!file) return { code: 0, stdout: 'KG:missing\n', stderr: '', timedOut: false };
  const reportedSize = reportedSizes.get(hostPath);
  if (reportedSize !== undefined) return { code: 0, stdout: `KG:size:${reportedSize}\nKG:toobig\n`, stderr: '', timedOut: false };
  const chunk = file.subarray(Number(offsetText), Number(offsetText) + Number(lengthText));
  return { code: 0, stdout: `KG:size:${file.length}\nKG:out:${chunk.toString('base64')}\n`, stderr: '', timedOut: false };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-inputs-'));
  shell = path.join(scratch, 'shell');
  fs.mkdirSync(shell);
  hostFiles = new Map();
  linkDown = false;
  reportedSizes = new Map();
  worktreeList = async () => `worktree ${HOST_PROJECT}\nHEAD 1111\nbranch refs/heads/main\n\nworktree ${HOST_PROJECT}/.kangentic/worktrees/3\nHEAD 2222\nbranch refs/heads/${HELD_BRANCH}\n\n`;
  setRemoteGitResolver((directory) => (directory === shell ? hostGit() : null));

  db = new Database(':memory:');
  runProjectMigrations(db);
  const paths = agentPathsForProject({ path: shell, remote: { hostId: 'host-1', path: HOST_PROJECT } });
  const hostAccess: HostAccess = {
    hostId: 'host-1',
    runCommand: fakeHostRead,
    pathPresence: vi.fn(),
    removeFiles: vi.fn(),
    listeningPorts: vi.fn(),
  };
  context = {
    projectId: 'project-1',
    getProjectDb: () => db,
    getProjectPath: () => shell,
    agentPaths: () => paths,
    hostAccess: () => hostAccess,
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  } as unknown as CommandContext;
});

afterEach(() => {
  setRemoteGitResolver(null);
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function tasks(): TaskRepository {
  return new TaskRepository(db);
}

async function createdTaskId(): Promise<string> {
  const result = await handleCreateTask({ title: 'Remote task', column: 'Planning' }, context);
  if (!result.success) throw new Error(result.error);
  return (result.data as { taskId: string }).taskId;
}

describe('the branch guard on a remote project', () => {
  it('has git though the stand-in has none', () => {
    expect(isGitRepo(shell)).toBe(false);
    expect(isProjectGitRepo(shell)).toBe(true);
  });

  it('refuses a branch the host has checked out, naming where on the host, and creates nothing', async () => {
    const result = await handleCreateTask({ title: 'Clash', column: 'Planning', branchName: HELD_BRANCH }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain(`${HOST_PROJECT}/.kangentic/worktrees/3`);
    expect(tasks().list().filter((task) => task.title === 'Clash')).toEqual([]);
  });

  it('creates the task and says so when the host could not be asked', async () => {
    worktreeList = async () => { throw new RemoteGitUnavailableError('the link is down'); };

    const result = await handleCreateTask({ title: 'Unchecked', column: 'Planning', branchName: 'feature/free' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('not checked against the host');
    expect(result.message).toContain('the link is down');
  });

  it('says nothing about a branch the host holds free', async () => {
    const result = await handleCreateTask({ title: 'Free', column: 'Planning', branchName: 'feature/free' }, context);

    expect(result.success).toBe(true);
    expect(result.message).not.toContain('host');
  });
});

describe('an attachment an agent on a host names', () => {
  it('is fetched from the host, binary and whole', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);
    hostFiles.set('/home/dev/proj/shot.png', bytes);

    const result = await handleCreateTask({ title: 'With a file', column: 'Planning', attachments: [{ filePath: '/home/dev/proj/shot.png' }] }, context);

    const taskId = (result.data as { taskId: string }).taskId;
    const [stored] = new AttachmentRepository(db).list(taskId);
    expect(stored.filename).toBe('shot.png');
    expect(stored.media_type).toBe('image/png');
    expect(fs.readFileSync(stored.file_path).equals(bytes)).toBe(true);
    expect(result.message).not.toContain('not attached');
  });

  it('never reads a file of the same path on this computer', async () => {
    const localTwin = path.join(scratch, 'secret.txt');
    fs.writeFileSync(localTwin, 'this computer\'s file');

    const result = await handleCreateTask({ title: 'Twin', column: 'Planning', attachments: [{ filePath: localTwin }] }, context);

    expect(new AttachmentRepository(db).list((result.data as { taskId: string }).taskId)).toEqual([]);
    expect(result.message).toContain('no such file on the host');
  });

  it('reports a link that dropped, and still creates the task', async () => {
    linkDown = true;

    const result = await handleCreateTask({ title: 'Dropped', column: 'Planning', attachments: [{ filePath: '/home/dev/proj/a.png' }] }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('One file was not attached');
    expect(result.message).toContain('the link is down');
  });

  it('adds to an existing task, and reports the one that failed beside the one that landed', async () => {
    const taskId = await createdTaskId();
    hostFiles.set('/home/dev/proj/ok.txt', Buffer.from('fine'));

    const result = await handleUpdateTask({ taskId, attachments: [{ filePath: '/home/dev/proj/ok.txt' }, { filePath: '/home/dev/proj/gone.txt' }] }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('/home/dev/proj/gone.txt: no such file on the host');
    expect(new AttachmentRepository(db).list(taskId).map((attachment) => attachment.filename)).toEqual(['ok.txt']);
  });

  it('fails an update that has nothing else in it, naming why', async () => {
    const taskId = await createdTaskId();

    const result = await handleUpdateTask({ taskId, attachments: [{ filePath: '/home/dev/proj/gone.txt' }] }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('no such file on the host');
  });

  it('reaches a backlog item too', async () => {
    const result = await handleCreateBacklogTask({ title: 'Later', attachments: [{ filePath: '/home/dev/proj/gone.txt' }] }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('no such file on the host');
  });
});

describe('an attachment past the size cap', () => {
  const HUGE = '/home/dev/proj/huge.bin';

  beforeEach(() => {
    hostFiles.set(HUGE, Buffer.from([1]));
    reportedSizes.set(HUGE, 60 * 1024 * 1024);
  });

  it('is reported by create_task, which still creates the task with no attachment row', async () => {
    const result = await handleCreateTask({ title: 'Too big', column: 'Planning', attachments: [{ filePath: HUGE }] }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('File too large');
    expect(new AttachmentRepository(db).list((result.data as { taskId: string }).taskId)).toEqual([]);
  });

  it('is reported by update_task, which still applies the other change', async () => {
    const taskId = await createdTaskId();

    const result = await handleUpdateTask({ taskId, title: 'Renamed', attachments: [{ filePath: HUGE }] }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('File too large');
    expect(tasks().getById(taskId)?.title).toBe('Renamed');
    expect(new AttachmentRepository(db).list(taskId)).toEqual([]);
  });

  it('is reported by the backlog create, which still creates the item with no attachment row', async () => {
    const result = await handleCreateBacklogTask({ title: 'Later', attachments: [{ filePath: HUGE }] }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('File too large');
    expect(new BacklogAttachmentRepository(db).list((result.data as { id: string }).id)).toEqual([]);
  });
});

describe('a host that is not available', () => {
  it('is reported by create_task as the reason the file is not attached, and the task is still created', async () => {
    const unavailable = { ...context, hostAccess: () => null } as unknown as CommandContext;

    const result = await handleCreateTask({ title: 'No host', column: 'Planning', attachments: [{ filePath: '/home/dev/proj/a.png' }] }, unavailable);

    expect(result.success).toBe(true);
    expect(result.message).toContain('One file was not attached');
    expect(result.message).toContain('host is not available');
    expect(tasks().list().some((task) => task.title === 'No host')).toBe(true);
  });
});

describe('a project on this computer', () => {
  it('reports an attachment it could not read too, which used to reach only a console', async () => {
    const local = { ...context, agentPaths: undefined, hostAccess: undefined } as unknown as CommandContext;
    setRemoteGitResolver(null);

    const result = await handleCreateTask({ title: 'Local', column: 'Planning', attachments: [{ filePath: path.join(scratch, 'gone.txt') }] }, local);

    expect(result.success).toBe(true);
    expect(result.message).toContain('One file was not attached');
    expect(result.message).toContain('gone.txt');
  });
});
