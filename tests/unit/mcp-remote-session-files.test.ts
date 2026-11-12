/**
 * The session tools on a remote project. A session's folder exists on both machines and they do not hold the same
 * files, and the agent's transcript here is a copy. So these pin that a path handed to an agent names the host, that
 * only the host says whether a file is there, and that a copy says it is one.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { AgentPaths } from '../../src/main/remote/host-paths';
import type { HostAccess } from '../../src/main/remote/host-transfer';

const { locateHistory } = vi.hoisted(() => ({ locateHistory: vi.fn<() => Promise<string | null>>() }));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getBySessionType: () => ({ name: 'claude', displayName: 'Claude Code', locateSessionHistoryFile: locateHistory }),
  },
}));

import { handleGetSessionEvents, handleGetSessionFiles } from '../../src/main/agent/commands/session-files-commands';
import { handleGetSessionHistory, handleListSessions } from '../../src/main/agent/commands/analytics-commands';
import { handleGetHandoffContext } from '../../src/main/agent/commands/handoff-commands';
import { agentPathsForProject } from '../../src/main/remote/host-paths';
import { serializeCliTarget } from '../../src/main/agent/shared/cli-target';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { HandoffRepository } from '../../src/main/db/repositories/handoff-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';

const HOST_PROJECT = '/home/dev/proj';
const SESSION_ID = 'session-1';

let scratch: string;
let shell: string;
let mirror: string;
let db: Database.Database;
let taskId: string;
let paths: AgentPaths;
let presence: HostAccess['pathPresence'];
let context: CommandContext;

function hostAccess(): HostAccess {
  return {
    hostId: 'host-1',
    runCommand: vi.fn(),
    pathPresence: (asked) => presence(asked),
    removeFiles: vi.fn(),
    listeningPorts: vi.fn(),
  };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-session-'));
  shell = path.join(scratch, 'shell');
  mirror = path.join(scratch, 'mirror');
  fs.mkdirSync(path.join(shell, '.kangentic', 'sessions', SESSION_ID), { recursive: true });
  paths = agentPathsForProject({ path: shell, remote: { hostId: 'host-1', path: HOST_PROJECT } });
  presence = async (asked) => asked.map((candidate) => (candidate.endsWith('settings.json') || candidate.endsWith('.jsonl') ? 'present' : 'absent'));

  db = new Database(':memory:');
  runProjectMigrations(db);
  const lane = new SwimlaneRepository(db).list()[0];
  const task = new TaskRepository(db).create({ title: 'Remote task', description: '', swimlane_id: lane.id });
  taskId = task.id;
  const cliTarget = serializeCliTarget({ kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'bash', localHome: mirror, roots: paths.roots });
  db.prepare(`INSERT INTO sessions (id, task_id, session_type, agent_session_id, cwd, status, started_at, cli_target, permission_mode, command, prompt)
    VALUES (?, ?, 'claude_code', 'agent-1', ?, 'running', '2026-01-01T00:00:00Z', ?, 'default', 'claude', NULL)`).run(SESSION_ID, taskId, path.join(shell, '.kangentic', 'worktrees', '12'), cliTarget);

  context = {
    projectId: 'project-1',
    getProjectDb: () => db,
    getProjectPath: () => shell,
    agentPaths: () => paths,
    hostAccess,
  } as unknown as CommandContext;
  locateHistory.mockResolvedValue(path.join(mirror, '.claude', 'projects', 'proj', 'agent-1.jsonl'));
});

afterEach(() => {
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

interface FileEntry { path: string; exists: boolean | null; location: string; localPath?: string; localExists?: boolean }

describe('kangentic_get_session_files', () => {
  it('names each file on the host and lets only the host say it is there', async () => {
    const localEvents = path.join(shell, '.kangentic', 'sessions', SESSION_ID, 'events.jsonl');
    fs.writeFileSync(localEvents, '{}\n');

    const result = await handleGetSessionFiles({ sessionId: SESSION_ID }, context);
    const data = result.data as { files: Record<string, FileEntry>; sessionDir: string; cwd: string; location: string };

    expect(data.sessionDir).toBe(`${HOST_PROJECT}/.kangentic/sessions/${SESSION_ID}`);
    expect(data.cwd).toBe(`${HOST_PROJECT}/.kangentic/worktrees/12`);
    expect(data.location).toBe('host');
    expect(data.files.settingsJson).toMatchObject({ path: `${HOST_PROJECT}/.kangentic/sessions/${SESSION_ID}/settings.json`, exists: true, location: 'host', localExists: false });
    expect(data.files.statusJson).toMatchObject({ exists: false, location: 'host' });
    expect(result.message).toContain(HOST_PROJECT);
    expect(result.message).not.toContain(shell);
  });

  it('reads a file built here from what the host relayed as absent there, and present here', async () => {
    const localEvents = path.join(shell, '.kangentic', 'sessions', SESSION_ID, 'events.jsonl');
    fs.writeFileSync(localEvents, '{}\n');
    presence = async (asked) => asked.map(() => 'absent');

    const result = await handleGetSessionFiles({ sessionId: SESSION_ID }, context);
    const data = result.data as { files: Record<string, FileEntry> };

    expect(data.files.eventsJsonl).toMatchObject({ exists: false, localPath: localEvents, localExists: true });
  });

  it('names the original of a mirror copy', async () => {
    const result = await handleGetSessionFiles({ sessionId: SESSION_ID }, context);
    const data = result.data as { nativeSessionFile: FileEntry };

    expect(data.nativeSessionFile).toMatchObject({ path: '/home/dev/.claude/projects/proj/agent-1.jsonl', exists: true, location: 'host' });
    expect(data.nativeSessionFile.localPath).toContain('mirror');
  });

  it('leaves exists unknown when the host cannot be asked, and never reads that as absent', async () => {
    presence = async () => { throw new Error('the link is down'); };

    const result = await handleGetSessionFiles({ sessionId: SESSION_ID }, context);
    const data = result.data as { files: Record<string, FileEntry>; nativeSessionFile: FileEntry; hostError: string };

    expect(data.files.settingsJson.exists).toBeNull();
    expect(data.nativeSessionFile.exists).toBeNull();
    expect(data.hostError).toContain('the link is down');
  });
});

describe('kangentic_get_session_events', () => {
  it('says the record is this computer\'s and is not a path the agent can open', async () => {
    fs.writeFileSync(path.join(shell, '.kangentic', 'sessions', SESSION_ID, 'events.jsonl'), '{"type":"Stop","ts":1}\n');

    const result = await handleGetSessionEvents({ sessionId: SESSION_ID }, context);

    expect(result.message).toContain('this computer\'s record');
    expect(result.message).not.toContain(shell);
    expect(result.data).toMatchObject({ location: 'local', copy: true, returned: 1 });
  });
});

describe('kangentic_list_sessions', () => {
  it('reports the cwd as the host names it, and labels the events file as this computer\'s', () => {
    const result = handleListSessions({ taskId }, context) as { data: Array<Record<string, unknown>> };

    expect(result.data[0]).toMatchObject({ cwd: `${HOST_PROJECT}/.kangentic/worktrees/12`, location: 'host', eventsLocation: 'local' });
    expect(result.data[0].localCwd).toBe(path.join(shell, '.kangentic', 'worktrees', '12'));
  });

  it('reports a local project\'s cwd as it is, labeled local, with no localCwd', () => {
    const localContext = { ...context, agentPaths: () => agentPathsForProject({ path: shell, remote: null }) } as unknown as CommandContext;

    const result = handleListSessions({ taskId }, localContext) as { data: Array<Record<string, unknown>> };

    expect(result.data[0]).toMatchObject({ cwd: path.join(shell, '.kangentic', 'worktrees', '12'), location: 'local' });
    expect(result.data[0]).not.toHaveProperty('localCwd');
  });
});

describe('kangentic_get_session_history', () => {
  it('says the content is a copy and names the original', async () => {
    const copy = path.join(mirror, '.claude', 'projects', 'proj', 'agent-1.jsonl');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, 'transcript text\n');

    const result = await handleGetSessionHistory({ taskId }, context);

    expect(result.message).toContain('/home/dev/.claude/projects/proj/agent-1.jsonl');
    expect(result.message).toContain('as far as it has arrived');
    expect(result.message).toContain('transcript text');
    expect(result.data).toMatchObject({ filePath: '/home/dev/.claude/projects/proj/agent-1.jsonl', localFilePath: copy, location: 'host', copy: true });
  });

  it('names the host file, never this computer\'s path, when the copy has not arrived', async () => {
    const result = await handleGetSessionHistory({ taskId }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('/home/dev/.claude/projects/proj/agent-1.jsonl');
    expect(result.error).not.toContain('Failed to read session file at');
  });
});

describe('kangentic_get_handoff_context', () => {
  it('maps the mirror path the row holds to the host, from the session that wrote it', () => {
    const copy = path.join(mirror, '.claude', 'projects', 'proj', 'agent-1.jsonl');
    new HandoffRepository(db).insert({
      task_id: taskId, from_session_id: SESSION_ID, to_session_id: null, from_agent: 'claude', to_agent: 'codex', trigger: 'column_transition', session_history_path: copy,
    });

    const result = handleGetHandoffContext({ taskId }, context);

    expect(result.message).toContain('Session history file: /home/dev/.claude/projects/proj/agent-1.jsonl (on the host)');
    expect(result.message).not.toContain('mirror');
    expect(result.data).toMatchObject({ sessionHistoryPath: '/home/dev/.claude/projects/proj/agent-1.jsonl', localSessionHistoryPath: copy, location: 'host' });
  });
});

describe('a project on this computer', () => {
  it('keeps every path and asks no host', async () => {
    const localContext = { projectId: 'project-1', getProjectDb: () => db, getProjectPath: () => shell } as unknown as CommandContext;
    db.prepare('UPDATE sessions SET cli_target = NULL').run();
    const local = path.join(scratch, 'agent-1.jsonl');
    locateHistory.mockResolvedValue(local);

    const result = await handleGetSessionFiles({ sessionId: SESSION_ID }, localContext);
    const data = result.data as { files: Record<string, FileEntry>; nativeSessionFile: FileEntry; sessionDir: string };

    expect(data.sessionDir).toBe(path.join(shell, '.kangentic', 'sessions', SESSION_ID));
    expect(data.files.settingsJson).toEqual({ path: path.join(data.sessionDir, 'settings.json'), exists: false, location: 'local' });
    expect(data.nativeSessionFile).toEqual({ path: local, exists: false, location: 'local' });
    expect(result.message).toBe(`Session ${SESSION_ID} (running) at ${data.sessionDir}`);
  });
});
