/**
 * The artifact links a session's message trail carries (#1056), read from a
 * temp JSONL with the REAL Claude window parser. A user loses: a design Claude
 * wrote about in its own reply never reaching the task's Artifacts, or the list
 * filling with links the user pasted, a tool printed, or a document the agent
 * merely cited.
 *
 * `readTrail` decides which text counts; `MessageTrailTracker` announces each
 * link once per session so a re-read does not re-announce it.
 *
 * Red-green: let `artifactLinksOf` read user entries and the user-prompt case
 * fails; drop the `announcedArtifactLinks` filter and the once-only case fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTrail } from '../../src/main/agent/message-trail-read';
import { localTrailReader } from '../../src/main/agent/message-trail-read';
import { MessageTrailTracker } from '../../src/main/agent/message-trail-tracker';
import type { Session } from '../../src/shared/types';
import { claudeTranscriptLines, claudeWindowAdapter } from './helpers/claude-transcript-fixture';

const AGENT_SESSION_ID = 'agent-session-1';
const FACTS = { sessionType: 'claude_agent', agentSessionId: AGENT_SESSION_ID, cwd: '/mock/project' };
const FIGMA = 'https://www.figma.com/design/AbC123xyz/My-File';
const MIRO = 'https://miro.com/app/board/uXjVabc123=/';
const GOOGLE_DOC = 'https://docs.google.com/document/d/1xR4abc/edit';

const lines = claudeTranscriptLines({ agentSessionId: AGENT_SESSION_ID, cwd: FACTS.cwd });

describe('readTrail artifactLinks', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-artifact-links-'));
    file = path.join(tmpDir, `${AGENT_SESSION_ID}.jsonl`);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function linksFor(transcript: string): Promise<string[] | undefined> {
    fs.writeFileSync(file, transcript);
    return (await readTrail(claudeWindowAdapter(file), FACTS, null)).artifactLinks;
  }

  it('returns a design link the agent wrote in its own text', async () => {
    expect(await linksFor(lines.assistantText('a1', `The mockup is at ${FIGMA}.`))).toEqual([FIGMA]);
  });

  it('returns a link once and in written order across messages', async () => {
    const transcript = lines.assistantText('a1', `Flow: ${MIRO}`) + lines.assistantText('a2', `Design: ${FIGMA} and again ${MIRO}`);
    expect(await linksFor(transcript)).toEqual([MIRO, FIGMA]);
  });

  it('does not return a link the user typed', async () => {
    expect(await linksFor(lines.humanPrompt('p1', `Build this: ${FIGMA}`) + lines.assistantText('a1', 'On it.'))).toEqual([]);
  });

  it('does not return a link inside a tool result', async () => {
    const transcript = lines.assistantTool('a1', 'toolu_1', 'WebFetch') + lines.toolResult('r1', 'toolu_1', `see ${FIGMA}`);
    expect(await linksFor(transcript)).toEqual([]);
  });

  it('does not return a document link, which agents cite in passing', async () => {
    expect(await linksFor(lines.assistantText('a1', `Per ${GOOGLE_DOC} I changed it.`))).toEqual([]);
  });

  it('does not return a tracker link', async () => {
    expect(await linksFor(lines.assistantText('a1', 'Fixed https://github.com/owner/repo/issues/3'))).toEqual([]);
  });
});

describe('MessageTrailTracker artifact-links', () => {
  class FakeSessionManager extends EventEmitter {
    readonly sessions = new Map<string, Session>();
    getSession(sessionId: string): Session | undefined { return this.sessions.get(sessionId); }
    listSessions(): Session[] { return [...this.sessions.values()]; }
  }

  const MIN_INTERVAL_MS = 30;
  let tmpDir: string;
  let file: string;
  let manager: FakeSessionManager;
  let tracker: MessageTrailTracker;
  let announced: Array<{ sessionId: string; links: string[]; projectId: string }>;
  let trailPushes: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-artifact-tracker-'));
    file = path.join(tmpDir, `${AGENT_SESSION_ID}.jsonl`);
    manager = new FakeSessionManager();
    manager.sessions.set('s1', {
      id: 's1', taskId: 'task-1', projectId: 'proj-1', pid: 1, status: 'running', shell: 'bash', cwd: FACTS.cwd,
      startedAt: '2026-06-01T00:00:00.000Z', exitCode: null, resuming: false, agentSessionId: AGENT_SESSION_ID,
    });
    announced = [];
    trailPushes = 0;
    tracker = new MessageTrailTracker({
      sessionManager: manager,
      resolveSessionFacts: () => FACTS,
      readTrail: localTrailReader(() => claudeWindowAdapter(file)),
      minIntervalMs: MIN_INTERVAL_MS,
      fallbackMinIntervalMs: MIN_INTERVAL_MS,
    });
    tracker.on('artifact-links', (sessionId: string, links: string[], projectId: string) => {
      announced.push({ sessionId, links, projectId });
    });
    tracker.on('trail', () => { trailPushes += 1; });
  });

  afterEach(() => {
    tracker.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('announces a link once for the session and project, however many reads see it', async () => {
    fs.writeFileSync(file, lines.assistantText('a1', `Mockup: ${FIGMA}`));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await waitUntil(() => announced.length === 1);
    expect(announced[0]).toEqual({ sessionId: 's1', links: [FIGMA], projectId: 'proj-1' });

    // A later read sees the same link again, in a new message.
    const pushesBefore = trailPushes;
    fs.appendFileSync(file, lines.assistantText('a2', `Still ${FIGMA}`));
    manager.emit('event', 's1', { ts: 2, type: 'tool_start', tool: 'Bash' });
    await waitUntil(() => trailPushes > pushesBefore);
    expect(announced).toHaveLength(1);
  });

  it('announces only the links it has not announced yet', async () => {
    fs.writeFileSync(file, lines.assistantText('a1', `Mockup: ${FIGMA}`));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await waitUntil(() => announced.length === 1);

    fs.appendFileSync(file, lines.assistantText('a2', `Now ${FIGMA} and ${MIRO}`));
    manager.emit('event', 's1', { ts: 2, type: 'tool_start', tool: 'Bash' });
    await waitUntil(() => announced.length === 2);
    expect(announced[1].links).toEqual([MIRO]);
  });
});
