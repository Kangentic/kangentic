/**
 * `registerArtifactDetection` (#1056): the three sources of detected artifacts
 * wired to the one write path. A user loses: an agent's publish that never
 * reaches the task, a message link added as the agent's own instead of
 * detected, the terminal scan running for an agent whose messages already cover
 * it (or in a Command Terminal), or one throwing listener taking down the
 * session manager's emit.
 *
 * `linkArtifacts` and the agent registry are mocked, so this file is about the
 * wiring: event names, the source each one writes under, and the gates.
 *
 * Red-green: register the tracker listener with source `agent` and the
 * detected case fails; drop the `parseTranscript` early return and the
 * transcript-reader case fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  linkArtifacts: vi.fn(),
  getAdapter: vi.fn(),
}));

vi.mock('../../src/main/artifacts/artifact-linking', () => ({
  linkArtifacts: mocks.linkArtifacts,
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: mocks.getAdapter },
}));

import { registerArtifactDetection } from '../../src/main/artifacts/artifact-detection';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { MessageTrailTracker } from '../../src/main/agent/message-trail-tracker';

const FIGMA = 'https://www.figma.com/design/AbC123xyz/My-File';
const MIRO = 'https://miro.com/app/board/uXjVabc123=/';

class FakeSessionManager extends EventEmitter {
  sessions = new Map<string, { transient?: boolean }>();
  agentNames = new Map<string, string>();
  scrollback = vi.fn(async (_sessionId: string): Promise<string> => '');
  getSession(sessionId: string) { return this.sessions.get(sessionId); }
  getSessionAgentName(sessionId: string) { return this.agentNames.get(sessionId); }
  getRawScrollback(sessionId: string) { return this.scrollback(sessionId); }
}

describe('registerArtifactDetection', () => {
  let sessionManager: FakeSessionManager;
  let tracker: EventEmitter;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.linkArtifacts.mockReset();
    mocks.getAdapter.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionManager = new FakeSessionManager();
    tracker = new EventEmitter();
    const context = { sessionManager } as unknown as IpcContext;
    registerArtifactDetection(context, tracker as unknown as MessageTrailTracker);
    sessionManager.sessions.set('session-1', {});
    sessionManager.agentNames.set('session-1', 'scrollback-only');
    mocks.getAdapter.mockReturnValue({});
  });

  afterEach(() => consoleError.mockRestore());

  const turnEnded = { sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1' };

  async function emitTurnEnded(payload: typeof turnEnded = turnEnded): Promise<void> {
    sessionManager.emit('turn-ended', payload);
    // The scan reads the scrollback first: let that promise and its callback settle.
    await new Promise((resolve) => setImmediate(resolve));
  }

  describe('a publish', () => {
    it('writes the recognised links of an artifact-links event as the agent\'s, titled when there is one', () => {
      sessionManager.emit('artifact-links', 'session-1', { urls: [FIGMA, 'https://example.org/x'], title: 'Checkout', source: 'agent' });
      expect(mocks.linkArtifacts).toHaveBeenCalledTimes(1);
      expect(mocks.linkArtifacts.mock.calls[0][1]).toEqual({
        sessionId: 'session-1',
        artifacts: [{ url: FIGMA, name: 'Checkout' }],
        source: 'agent',
      });
    });

    it('does not let a throw escape the emit', () => {
      mocks.linkArtifacts.mockImplementation(() => { throw new Error('database closed'); });
      expect(() => sessionManager.emit('artifact-links', 'session-1', { urls: [FIGMA], title: null, source: 'agent' })).not.toThrow();
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe('the message trail', () => {
    it('writes the links of an agent\'s messages as detected, with the project they were read in', () => {
      tracker.emit('artifact-links', 'session-1', [FIGMA, MIRO], 'project-7');
      expect(mocks.linkArtifacts.mock.calls[0][1]).toEqual({
        sessionId: 'session-1',
        projectId: 'project-7',
        artifacts: [{ url: FIGMA }, { url: MIRO }],
        source: 'detected',
      });
    });

    it('does not let a throw escape the emit', () => {
      mocks.linkArtifacts.mockImplementation(() => { throw new Error('database closed'); });
      expect(() => tracker.emit('artifact-links', 'session-1', [FIGMA], 'project-7')).not.toThrow();
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe('the turn-end terminal scan', () => {
    it('scans the terminal of an agent with no transcript reader and writes the links as detected', async () => {
      sessionManager.scrollback.mockResolvedValue(`done, see ${FIGMA}. And ${MIRO}\n`);
      await emitTurnEnded();
      expect(mocks.getAdapter).toHaveBeenCalledWith('scrollback-only');
      expect(mocks.linkArtifacts).toHaveBeenCalledTimes(1);
      expect(mocks.linkArtifacts.mock.calls[0][1]).toEqual({
        taskId: 'task-1',
        projectId: 'project-1',
        artifacts: [{ url: FIGMA }, { url: MIRO }],
        source: 'detected',
      });
    });

    it('leaves out document platforms, which an agent cites in passing', async () => {
      sessionManager.scrollback.mockResolvedValue('read https://docs.google.com/document/d/1xR4abc/edit');
      await emitTurnEnded();
      expect(mocks.linkArtifacts.mock.calls[0][1]).toMatchObject({ artifacts: [] });
    });

    it('reads only the newest part of a long scrollback', async () => {
      sessionManager.scrollback.mockResolvedValue(`${FIGMA}\n${'x'.repeat(300 * 1024)}\n${MIRO}`);
      await emitTurnEnded();
      expect(mocks.linkArtifacts.mock.calls[0][1]).toMatchObject({ artifacts: [{ url: MIRO }] });
    });

    it.each([
      ['parseTranscript', { parseTranscript: () => [] }],
      ['parseTranscriptWindow', { parseTranscriptWindow: () => [] }],
    ])('does not scan an agent that has %s, whose messages cover it', async (_label, adapter) => {
      mocks.getAdapter.mockReturnValue(adapter);
      sessionManager.scrollback.mockResolvedValue(FIGMA);
      await emitTurnEnded();
      expect(sessionManager.scrollback).not.toHaveBeenCalled();
      expect(mocks.linkArtifacts).not.toHaveBeenCalled();
    });

    it('does not scan a transient (Command Terminal) session', async () => {
      sessionManager.sessions.set('session-1', { transient: true });
      sessionManager.scrollback.mockResolvedValue(FIGMA);
      await emitTurnEnded();
      expect(sessionManager.scrollback).not.toHaveBeenCalled();
      expect(mocks.linkArtifacts).not.toHaveBeenCalled();
    });

    it('does not scan a session the manager no longer has, or whose agent is unknown', async () => {
      sessionManager.scrollback.mockResolvedValue(FIGMA);
      await emitTurnEnded({ ...turnEnded, sessionId: 'gone' });
      mocks.getAdapter.mockReturnValue(undefined);
      await emitTurnEnded();
      expect(sessionManager.scrollback).not.toHaveBeenCalled();
      expect(mocks.linkArtifacts).not.toHaveBeenCalled();
    });

    it('does not let a throw in the write escape, nor an unreadable scrollback', async () => {
      sessionManager.scrollback.mockResolvedValue(FIGMA);
      mocks.linkArtifacts.mockImplementation(() => { throw new Error('database closed'); });
      await expect(emitTurnEnded()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalled();

      mocks.linkArtifacts.mockReset();
      sessionManager.scrollback.mockRejectedValue(new Error('output gone'));
      await expect(emitTurnEnded()).resolves.toBeUndefined();
      expect(mocks.linkArtifacts).not.toHaveBeenCalled();
    });
  });
});
