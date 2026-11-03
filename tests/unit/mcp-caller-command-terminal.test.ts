/**
 * A Command Terminal agent's MCP connection names its session, and that
 * session resolves to the terminal's SLOT, never to its registry row's task id.
 *
 * The row's task id is synthetic (the terminal's process tag, a uuid with no
 * task row). Handed out as the caller's task, every task-keyed consumer would
 * read it as a board task: the workflow lock, the dev-port defaults, the
 * steering self-send check and its provenance, the automation tools, and the
 * browser tools, whose open_pane would answer task-not-found. These pin the one
 * resolver all of them read, and the owner key and jar the browser keys by.
 */
import { describe, it, expect } from 'vitest';
import { resolveMcpCaller, resolveCallerTaskId, callerBrowserOwner } from '../../src/main/agent/mcp-http/caller-task';
import {
  commandTerminalBrowserOwner,
  isCommandTerminalBrowserOwner,
  parseCommandTerminalBrowserOwner,
  browserOwnerKind,
} from '../../src/shared/browser-owner';
import {
  browserPartitionForOwner,
  browserPartitionForTask,
  parseKngPartitionDir,
  partitionDirName,
} from '../../src/shared/browser-partition';
import { popOutInstanceKey, parsePopOutInstanceKey } from '../../src/shared/pop-out';

const PROJECT = '0b5d3c6e-1111-4222-8333-944455556666';
const TASK = '7d1e2f30-aaaa-4bbb-8ccc-ddddeeeeffff';
const SYNTHETIC_TASK_ID = '9f9f9f9f-0000-4000-8000-000000000001';

/** A session lookup over two live sessions: a task's agent and a Command Terminal. */
const sessions = {
  getSessionTaskId: (sessionId: string) =>
    sessionId === 'task-session' ? TASK : sessionId === 'terminal-session' ? SYNTHETIC_TASK_ID : undefined,
  getCommandTerminalSlot: (sessionId: string) => (sessionId === 'terminal-session' ? 'slot-2' : undefined),
};

describe('resolveMcpCaller', () => {
  it('resolves a Command Terminal to its slot and to no task', () => {
    const caller = { projectId: PROJECT, callerSessionId: 'terminal-session', sessions };
    expect(resolveMcpCaller(caller)).toEqual({ commandTerminalSlot: 'slot-2' });
    expect(resolveCallerTaskId(caller)).toBeUndefined();
  });

  it("resolves a task's agent to its task", () => {
    const caller = { projectId: PROJECT, callerSessionId: 'task-session', sessions };
    expect(resolveMcpCaller(caller)).toEqual({ taskId: TASK });
    expect(resolveCallerTaskId(caller)).toBe(TASK);
  });

  it('resolves nothing for an unknown session or a connection with none', () => {
    expect(resolveMcpCaller({ projectId: PROJECT, callerSessionId: 'nobody', sessions })).toEqual({});
    expect(resolveMcpCaller({ projectId: PROJECT, sessions })).toEqual({});
    expect(resolveMcpCaller({ projectId: PROJECT, callerSessionId: 'task-session', sessions: null })).toEqual({});
  });

  it('keys the browser by the slot owner for a terminal and by the task for a task', () => {
    expect(callerBrowserOwner(PROJECT, { commandTerminalSlot: 'slot-2' })).toBe(commandTerminalBrowserOwner(PROJECT, 'slot-2'));
    expect(callerBrowserOwner(PROJECT, { taskId: TASK })).toBe(TASK);
    expect(callerBrowserOwner(PROJECT, {})).toBeUndefined();
  });
});

describe('the Command Terminal owner key', () => {
  it('round-trips its project and slot, and is never read as a task', () => {
    const owner = commandTerminalBrowserOwner(PROJECT, 'slot-3');
    expect(isCommandTerminalBrowserOwner(owner)).toBe(true);
    expect(browserOwnerKind(owner)).toBe('command-terminal');
    expect(parseCommandTerminalBrowserOwner(owner)).toEqual({ projectId: PROJECT, slot: 'slot-3' });
    expect(isCommandTerminalBrowserOwner(TASK)).toBe(false);
    expect(parseCommandTerminalBrowserOwner(TASK)).toBeNull();
  });

  it('names the project, so slot-1 of two projects are two owners', () => {
    expect(commandTerminalBrowserOwner(PROJECT, 'slot-1')).not.toBe(commandTerminalBrowserOwner(TASK, 'slot-1'));
  });

  it("survives a Browser window's instance key, whose separator it contains", () => {
    const owner = commandTerminalBrowserOwner(PROJECT, 'slot-1');
    const key = popOutInstanceKey('browser', { projectId: PROJECT, taskId: owner });
    expect(parsePopOutInstanceKey(key)).toEqual({ kind: 'browser', projectId: PROJECT, taskId: owner });
  });
});

describe('the Command Terminal cookie jar', () => {
  it("is one per project, shared by its terminals, and parses back to the project", () => {
    const first = browserPartitionForOwner(PROJECT, commandTerminalBrowserOwner(PROJECT, 'slot-1'));
    const second = browserPartitionForOwner(PROJECT, commandTerminalBrowserOwner(PROJECT, 'slot-2'));
    expect(first).toBe(second);
    expect(first).toMatch(/-terminals$/);
    expect(parseKngPartitionDir(partitionDirName(first))).toEqual({ kind: 'terminals', projectId: PROJECT.replace(/-/g, '') });
  });

  it("leaves a task's jar keyed by the task", () => {
    expect(browserPartitionForOwner(PROJECT, TASK)).toBe(browserPartitionForTask(PROJECT, TASK));
  });
});
