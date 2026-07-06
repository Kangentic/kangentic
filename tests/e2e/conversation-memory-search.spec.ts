/**
 * E2E coverage for the searchable-conversation-memory pipeline, end to end:
 * an agent session's transcript is indexed by the retrieval engine's backfill
 * sweep and then surfaces through the `search:everything` IPC as a
 * `kind: 'conversation'` hit.
 *
 * Indexing path (the deliberate hybrid of the two the task describes):
 *   1. Drive a REAL mock-claude session to completion of spawn, so the app
 *      creates a genuine `sessions` DB row with a caller-owned
 *      `agent_session_id`, the real `cwd`, and `session_type = 'claude_agent'`.
 *      Everything downstream of the transcript file is thus exercised for real
 *      (adapter lookup, source-signature staleness, chunker, FTS5 upsert,
 *      the search-core conversation scan, and the IPC surface).
 *   2. The mock CLI does NOT write Claude's native session JSONL
 *      (~/.claude/projects/<slug>/<id>.jsonl), so seed a small fixture
 *      transcript at exactly the path the Claude adapter's
 *      locateSessionHistoryFile / parseTranscript read - computed by importing
 *      the production `locateClaudeTranscriptFile` and feeding it the real
 *      session's captured `agentSessionId` + `cwd`, so the path is identical to
 *      the one the indexer resolves.
 *   3. Re-open the project through the PROJECT_OPEN IPC. That handler (unlike
 *      openByPath, the first-open path used by createProject) is the one that
 *      calls `retrievalService.startForProject`, which runs
 *      `ConversationIndexer.sweepProject` over every session with an
 *      agent_session_id - indexing our seeded transcript into memory_chunks +
 *      the FTS5 shadow.
 *
 * The test then polls the search IPC until the conversation hit for our session
 * appears and asserts its snippet carries the distinctive seeded phrase.
 *
 * Cross-platform notes (`.claude/rules/cross-platform-parity.md`):
 *   - The only write outside os.tmpdir() is the seeded transcript, whose path
 *     is DERIVED from os.homedir() via the production path helper (never a
 *     hardcoded literal) - the same pattern the codex/kimi/droid capture specs
 *     use for ~/.codex and ~/.kimi. It is cleaned up with
 *     { force: true, recursive: true }.
 *   - Every wait is a condition poll (expect.poll / helper poll loops); there
 *     is no bare waitForTimeout used as the wait mechanism.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  setProjectDefaultAgent,
  getSwimlaneIds,
  getTaskIdByTitle,
  moveTaskIpc,
  waitForRunningSession,
  waitForScrollback,
  mockAgentPath,
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Session, SearchHit } from '../../src/shared/types';
import { locateClaudeTranscriptFile } from '../../src/main/agent/adapters/claude/transcript-parser';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TEST_NAME = 'conversation-memory-search';
const runId = Date.now();
const PROJECT_NAME = `Memory Search Test ${runId}`;

// A distinctive, single-token search phrase (lowercase letters + digits form
// one unicode61 FTS token) that appears ONLY in the seeded transcript, so the
// resulting hit can only be a conversation hit for our session.
const SEARCH_TOKEN = `memoryquokka${runId}`;

/** The seeded Claude native-transcript slug directory, removed in afterAll. */
let seededTranscriptDir: string | null = null;

test.describe('Conversation memory search', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);

    // Point Claude at the mock CLI and disable worktrees so the session's cwd
    // is the project directory itself (which the transcript slug is derived
    // from). Leaving `memory` unset keeps indexingEnabled at its default (true)
    // and the semantic layer off, so the search runs lexical FTS only - no
    // embedding-model download.
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        claude: {
          cliPath: mockAgentPath('claude'),
          permissionMode: 'default',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
      }),
    );

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    // Pin the default agent to Claude so the spawn is a claude_agent session
    // regardless of any real agent binaries installed on the host machine.
    await setProjectDefaultAgent(page, 'claude');
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
    if (seededTranscriptDir) {
      try { fs.rmSync(seededTranscriptDir, { force: true, recursive: true }); } catch { /* best effort */ }
    }
  });

  test('indexed session transcript is found via search:everything', async () => {
    await waitForBoard(page);

    // 1. Spawn a real Claude session by moving a task into Planning.
    const title = `Memory Search Task ${runId}`;
    await createTask(page, title, 'Seed a conversation transcript for the memory index');
    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);

    // 2. Capture the live session's id + cwd. For a caller-owned agent (Claude),
    //    the DB row carries agent_session_id but the live registry Session does
    //    NOT, so the id is read from the mock's `MOCK_CLAUDE_SESSION:<uuid>`
    //    scrollback marker - which is the exact caller-owned UUID Kangentic
    //    generated, passed via --session-id, and persisted as agent_session_id
    //    (the same value the indexer resolves the transcript path from).
    let session: { id: string; cwd: string } | null = null;
    await expect
      .poll(
        async () => {
          session = await page.evaluate(async (id) => {
            const sessions: Session[] = await window.electronAPI.sessions.list();
            const found = sessions.find((candidate) => candidate.taskId === id);
            return found ? { id: found.id, cwd: found.cwd } : null;
          }, taskId);
          return session !== null;
        },
        { timeout: 15000, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    expect(session).not.toBeNull();
    const liveSession = session!;

    const scrollback = await waitForScrollback(page, 'MOCK_CLAUDE_SESSION:');
    const sessionIdMatch = scrollback.match(
      /MOCK_CLAUDE_SESSION:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    expect(sessionIdMatch).not.toBeNull();
    const agentSessionId = sessionIdMatch![1];

    // 3. Seed a fixture transcript at the exact path the Claude adapter reads.
    //    The path is computed by the production helper from the SAME
    //    agentSessionId + cwd the indexer will use, so it matches byte-for-byte.
    const transcriptPath = locateClaudeTranscriptFile(agentSessionId, liveSession.cwd);
    seededTranscriptDir = path.dirname(transcriptPath);
    const nowIso = new Date().toISOString();
    const transcriptLines = [
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: nowIso,
        message: {
          role: 'user',
          content: `Investigate the ${SEARCH_TOKEN} retrieval pipeline and explain how conversation memory search is wired end to end.`,
        },
      },
      {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: nowIso,
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [
            {
              type: 'text',
              text: `The ${SEARCH_TOKEN} pipeline indexes each session transcript into the FTS5 memory tables so it becomes searchable from the palette.`,
            },
          ],
        },
      },
    ];
    fs.mkdirSync(seededTranscriptDir, { recursive: true });
    fs.writeFileSync(
      transcriptPath,
      transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    );

    // 4. Re-open the project via PROJECT_OPEN to trigger the backfill sweep.
    //    (openByPath, used on first open, does not start the retrieval service.)
    const projectId = await page.evaluate(async () => {
      const current = await window.electronAPI.projects.getCurrent();
      return current?.id ?? null;
    });
    expect(projectId).toBeTruthy();
    await page.evaluate((id) => window.electronAPI.projects.open(id), projectId!);

    // 5. Poll the search IPC until the conversation hit for our session appears.
    //    The sweep is deferred (setImmediate + serial job chain); a tiny
    //    transcript indexes quickly, but poll on the real condition.
    let conversationHit: Extract<SearchHit, { kind: 'conversation' }> | null = null;
    await expect
      .poll(
        async () => {
          conversationHit = await page.evaluate(
            async ({ query, currentProjectId, sessionId }) => {
              const hits: SearchHit[] = await window.electronAPI.search.everything({
                query,
                scope: 'current',
                currentProjectId,
                mode: 'keyword',
              });
              const match = hits.find(
                (hit): hit is Extract<SearchHit, { kind: 'conversation' }> =>
                  hit.kind === 'conversation' && hit.sessionId === sessionId,
              );
              return match ?? null;
            },
            { query: SEARCH_TOKEN, currentProjectId: projectId!, sessionId: liveSession.id },
          );
          return conversationHit !== null;
        },
        { timeout: 25000, intervals: [500, 1000, 1000] },
      )
      .toBe(true);

    // 6. Assert the hit ties back to our session and carries the seeded phrase.
    expect(conversationHit).not.toBeNull();
    const hit = conversationHit!;
    expect(hit.kind).toBe('conversation');
    expect(hit.sessionId).toBe(liveSession.id);
    expect(hit.agentName).toBe('Claude Code');
    expect(hit.snippet.toLowerCase()).toContain(SEARCH_TOKEN.toLowerCase());
  });
});
