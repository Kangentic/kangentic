/**
 * UI-tier coverage for the Knowledge Graph surface.
 *
 * Scope is deliberate: the surface opening, the coverage strip's NUMBERS and
 * TONE, and the four empty/loading states. The canvas itself is not asserted -
 * per-pixel canvas output is not reliably reproducible on CI's headless Linux
 * (font metrics and devicePixelRatio both differ), and the layout math that
 * actually matters is covered exhaustively in the unit tier
 * (`knowledge-graph-layout.test.ts`).
 *
 * The tone assertions are the ones worth having here. `missing-source` covers
 * 65% of a real corpus and is NOT an error, so a regression that paints it as
 * one would be a real product bug that no unit test catches.
 */

import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

function bucket(documents: number, chunks: number, tone: string): string {
  return `{ documents: ${documents}, chunks: ${chunks}, tone: '${tone}' }`;
}

/** A snapshot shaped like the real corpus: most documents indexed with their
 *  transcript deleted but still searchable. */
function snapshotScript(options: {
  projection?: string;
  building?: boolean;
  semanticAvailable?: boolean;
  stale?: boolean;
  /** Whether the answering agent and model are chosen. They have no fallback,
   *  so a question with neither goes to Settings > Knowledge Graph instead of
   *  running. */
  answerAgentChosen?: boolean;
  /** Task summaries (summaries): on in the app by default, so this fixture
   *  switches them off explicitly unless asked for 'on'. They are written by
   *  the Knowledge Graph's agent, so on with `answerAgentChosen: false` waits. */
  summarySetting?: 'off' | 'on';
  /** Summaries the index holds, of 412 finished tasks. */
  summariesWritten?: number;
  /** Source code indexed: on in the app by default, so switched off here
   *  unless asked for, and on it comes with the Knowledge Graph it needs. */
  codeIndexed?: boolean;
} = {}): string {
  const {
    projection = 'null',
    building = false,
    semanticAvailable = true,
    stale = false,
    answerAgentChosen = true,
    summarySetting = 'off',
    summariesWritten = 300,
    codeIndexed = false,
  } = options;
  return `window.__mockPreConfigure(function (state) {
    ${answerAgentChosen
      ? "state.config.knowledgeGraph = Object.assign({}, state.config.knowledgeGraph, { agent: 'claude', model: 'haiku' });"
      : ''}
    ${codeIndexed
      ? 'state.config.knowledgeGraph = Object.assign({}, state.config.knowledgeGraph, { sourceCode: true, indexingEnabled: true, enabled: true });'
      : 'state.config.knowledgeGraph = Object.assign({}, state.config.knowledgeGraph, { sourceCode: false });'}
    ${summarySetting === 'off'
      ? 'state.config.knowledgeGraph = Object.assign({}, state.config.knowledgeGraph, { taskSummaries: false });'
      : 'state.config.knowledgeGraph = Object.assign({}, state.config.knowledgeGraph, { taskSummaries: true });'}
    return {
      knowledgeGraphSnapshot: {
        projectId: 'project-1',
        projection: ${projection},
        building: ${building},
        stale: ${stale},
        semanticAvailable: ${semanticAvailable},
        coverage: {
          indexed: ${bucket(224, 22620, 'ok')},
          sourceMissingButSearchable: ${bucket(414, 28745, 'neutral')},
          empty: ${bucket(165, 0, 'neutral')},
          failed: ${bucket(0, 0, 'ok')},
          notYetIndexed: ${bucket(0, 0, 'ok')},
          totalDocumentsWithChunks: 638,
          totalChunks: 51365,
          totalEmbeddedChunks: 51365,
          embeddedFraction: 1,
          knownDocumentIdsMatched: 638,
        },
        // Every corpus the store holds: conversations drawn and fully
        // embedded, task records still embedding, session changes not reached,
        // commits kept as text.
        index: {
          corpora: [
            { corpus: 'conversation', documents: 638, chunks: 51365, embeddedChunks: 51365, embeds: true },
            { corpus: 'task', documents: 412, chunks: 1400, embeddedChunks: 700, embeds: true },
            { corpus: 'change', documents: 0, chunks: 0, embeddedChunks: 0, embeds: false },
            { corpus: 'commit', documents: 1422, chunks: 1422, embeddedChunks: 0, embeds: false },
            ${codeIndexed
              ? "{ corpus: 'code', documents: 1488, chunks: 12186, embeddedChunks: 4210, embeds: true },"
              : "{ corpus: 'code', documents: 0, chunks: 0, embeddedChunks: 0, embeds: true },"}
          ],
          summaries: { written: ${summariesWritten}, finishedTasks: 412, skipped: 1 },
          storageBytes: 3221225472,
          lastIndexedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
        },
      },
    };
  });`;
}

/** A projection in the shipped shape: one 3D position per node and cluster. */
/**
 * `collapsed` models a SMALL index, where every band clamps to the same region
 * count and all three granularities are one identical carve-up. Four of the
 * eight real projects measured behave this way, so it is the common case rather
 * than an edge one.
 */
function projectionLiteral(nodeCount: number, options: { collapsed?: boolean } = {}): string {
  if (options.collapsed) {
    const regions = `[
      { id: 0, label: 'terminal / pty', x: 0.25, y: 0.25, z: 0.3, size: Math.ceil(${nodeCount} / 2) },
      { id: 1, label: 'database / schema', x: 0.75, y: 0.75, z: 0.7, size: Math.floor(${nodeCount} / 2) }
    ]`;
    return projectionLiteral(nodeCount)
      .replace(
        /clusters: \{\n[\s\S]*?\n        \},/,
        `clusters: (function () {
          var half = i < ${nodeCount} / 2 ? 0 : 1;
          return { coarse: half, balanced: half, fine: half };
        })(),`,
      )
      .replace(
        /clusterings: \[[\s\S]*?\n      \],/,
        `clusterings: [
        { granularity: 'coarse', regions: ${regions} },
        { granularity: 'balanced', regions: ${regions} },
        { granularity: 'fine', regions: ${regions} }
      ],`,
      );
  }
  return `(function () {
    var nodes = [];
    for (var i = 0; i < ${nodeCount}; i++) {
      var node = {
        docKey: 'conversation::doc-' + i,
        x: (i % 20) / 20,
        y: Math.floor(i / 20) / 20,
        z: (i % 7) / 7,
        chunkCount: 10 + i,
        title: 'Conversation ' + i,
        sessionId: 'session-' + i,
        taskId: 'task-' + i,
        // The board ticket a card prints. Carried because a node field the
        // fixture omits is invisible in every test that reads it, which is how
        // four rounds of "the row did not render" turned out to be an
        // incomplete fixture rather than a broken feature.
        displayId: 100 + i,
        agent: 'Claude Code',
        model: 'Opus 5',
        effort: 'high',
        lastActivityMs: 1700000000000 + i * 1000,
        // Mostly present, some null - the real mix, since a conversation indexed
        // before the metrics were captured carries none. A fixture where every
        // node had a cost could not catch the mode being offered on an index
        // that has none.
        costUsd: i % 5 === 0 ? null : i * 1.5,
        // Input plus output tokens, null on the same terms as the cost.
        tokens: i % 5 === 0 ? null : i * 1000,
        durationMs: i % 7 === 0 ? null : (i + 1) * 90000,
        outcome: i % 3 === 0 ? 'done' : (i % 3 === 1 ? 'active' : 'done'),
        // Every granularity, since the projection ships all three. The
        // fixture keeps them DIFFERENT so a test cannot pass by reading the
        // wrong one: coarse merges what balanced splits.
        //
        // CONTIGUOUS, not interleaved by remainder as this was. A real
        // clustering is k-means over the layout, so a region is a PLACE - and
        // under an interleaved assignment every region shares one centroid,
        // which made the region pills collide and drop each other the moment a
        // pill moved to where its nodes actually are. x runs with i here, so
        // slicing on i gives regions that occupy different parts of the map.
        clusters: {
          coarse: 0,
          balanced: i < ${nodeCount} / 2 ? 0 : 1,
          fine: i < ${nodeCount} / 3 ? 0 : (i < (2 * ${nodeCount}) / 3 ? 1 : 2),
        },
      };
      nodes.push(node);
    }
    return {
      nodes: nodes,
      // Only nodes 0 and 1 are linked, so the DRAWN mesh is sparse -
      // which is what the isolated-node affordance is for.
      edges: [{ source: 0, target: 1, similarity: 0.9 }],
      // Deliberately RICHER than the drawn edge list: the panel reads these,
      // and a fixture where the two agreed could not catch it reading the mesh.
      nodeNeighbors: nodes.map(function (_node, i) {
        return [
          { index: (i + 1) % nodes.length, similarity: 0.95 },
          { index: (i + 2) % nodes.length, similarity: 0.91 },
          { index: (i + 3) % nodes.length, similarity: 0.88 }
        ];
      }),
      clusterings: [
        {
          granularity: 'coarse',
          regions: [
            { id: 0, label: 'everything', x: 0.5, y: 0.5, z: 0.5, size: ${nodeCount} }
          ]
        },
        {
          granularity: 'balanced',
          regions: [
            { id: 0, label: 'terminal / pty', x: 0.25, y: 0.25, z: 0.3, size: Math.ceil(${nodeCount} / 2) },
            { id: 1, label: 'database / schema', x: 0.75, y: 0.75, z: 0.7, size: Math.floor(${nodeCount} / 2) }
          ]
        },
        {
          granularity: 'fine',
          regions: [
            { id: 0, label: 'terminal / pty', x: 0.2, y: 0.2, z: 0.3, size: Math.ceil(${nodeCount} / 3) },
            { id: 1, label: 'database / schema', x: 0.5, y: 0.5, z: 0.5, size: Math.ceil(${nodeCount} / 3) },
            { id: 2, label: 'relay / mobile', x: 0.8, y: 0.8, z: 0.7, size: Math.floor(${nodeCount} / 3) }
          ]
        }
      ],
      signature: 'sig-1', modelTag: 'bge-base@q8-cls', dimensions: 768,
      storageBytes: 3_221_225_472,
      builtAt: '2026-08-17T00:00:00.000Z'
    };
  })()`;
}

/**
 * Titles currently drawn, by their real opacity.
 *
 * NOT a `:not([style*="opacity: 0"])` selector: that is a substring match, so it
 * also excludes `opacity: 0.98` and reports every visible label as hidden. The
 * first version of these tests failed for exactly that reason while the feature
 * was working.
 */
async function visibleNodeTitles(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="knowledge-graph-node-title"]'))
      .filter((element) => Number((element as HTMLElement).style.opacity || '0') > 0)
      .map((element) => element.textContent ?? ''),
  );
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * A graph plus an answer naming the task whose conversation is node 0, plus a
 * real transcript for that node's session.
 *
 * Seeding the transcript with a `taskId` is what keeps the "Open task" assertion
 * honest: with the mock's default (`taskId: null`) the button is absent because
 * there is no task to open, which would pass the test for entirely the wrong
 * reason and hide a regression in the layer-capability gate.
 */
function conversationFixture(): string {
  return `${snapshotScript({ projection: projectionLiteral(30) })}
    window.__mockPreConfigure(function () {
      return {
        knowledgeGraphAnswerResult: {
          ok: true,
          agentName: 'Claude Code',
          answer: 'That was #100.',
          rows: [
            { key: 'task-0', taskId: 'task-0', displayId: 100, title: 'Conversation 0', strength: 1, docKeys: ['conversation::doc-0'], passage: { sessionId: 'session-0', turnUuid: 'u-1' } }
          ],
          related: [],
          handedCount: 1,
          promptTokens: 1,
        },
        transcriptSeeds: {
          'session-0': {
            sessionId: 'session-0',
            taskId: 'task-0',
            taskTitle: 'Conversation 0',
            agentName: 'claude',
            startedAt: '2026-08-17T00:00:00.000Z',
            sessionStatus: 'suspended',
            source: 'transcript',
            sourcePath: null,
            entries: [{ kind: 'user', uuid: 'u-1', ts: 1700000000000, text: 'hello' }],
            degraded: false,
            unavailableReason: null,
            sessions: [],
            revision: 1,
          },
        },
      };
    });`;
}

/** Open node 0's conversation through an answer: ask, click the row it
 *  names. Deterministic, unlike aiming at the canvas. */
async function openConversationFromChat(page: Page): Promise<void> {
  await page.locator('[data-testid="knowledge-graph-search-input"]').fill('what was conversation 0?');
  await page.keyboard.press('Enter');
  await page.locator('[data-testid="knowledge-graph-chat-row"]').first().click();
  await page.locator('[data-testid="conversation-window"]').waitFor({ state: 'visible', timeout: 10000 });
}

async function openKnowledgeGraph(page: Page): Promise<void> {
  await page.locator('[data-testid="knowledge-graph-button"]').click();
  await page.locator('[data-testid="knowledge-graph-page"]').waitFor({ state: 'visible', timeout: 10000 });
  // The body is lazy; wait for real content, not the skeleton. Deliberately NOT
  // the coverage strip: it now lives inside the left panel's Index section,
  // which is collapsed by default, so it is absent in the common case.
  await page.locator('[data-testid="knowledge-graph-body"]').waitFor({ state: 'visible', timeout: 10000 });
}

test.describe('knowledge graph', () => {
  test('opens from the title bar and shows reconciled coverage', async () => {
    const { browser, page } = await launchWithState(snapshotScript());
    try {
      await openKnowledgeGraph(page);
      const strip = page.locator('[data-testid="knowledge-graph-coverage-strip"]');

      // The reconciled total, not the naive memory_index_state read (224).
      await expect(strip).toContainText('638');
      await expect(strip).toContainText('51,365');
      await expect(strip).toContainText('100%');

      // Labelled as conversation coverage, never repo coverage.
      await expect(strip).toContainText('not files in the repository');
    } finally {
      await browser.close();
    }
  });

  test('presents a deleted transcript as searchable, not as a failure', async () => {
    // 414 of 638 real documents are in this state. Painting it as an error
    // would misrepresent the steady state of a mature index.
    const { browser, page } = await launchWithState(snapshotScript());
    try {
      await openKnowledgeGraph(page);
      const strip = page.locator('[data-testid="knowledge-graph-coverage-strip"]');
      await expect(strip).toContainText('414');
      await expect(strip).toContainText('still fully searchable');
      // No failure bucket is rendered when there are none.
      await expect(strip).not.toContainText('failed to index');
    } finally {
      await browser.close();
    }
  });

  test('explains a missing semantic layer instead of showing an empty map', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ semanticAvailable: false }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-body"]')).toContainText('The Knowledge Graph is off');
      // The coverage numbers are still accurate and still shown.
      await expect(page.locator('[data-testid="knowledge-graph-coverage-strip"]')).toContainText('638');
    } finally {
      await browser.close();
    }
  });

  test('shows a building state rather than an empty map on the first pass', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ building: true, stale: true }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-body"]')).toContainText('Building the map');
    } finally {
      await browser.close();
    }
  });

  test('renders the canvas and states that links are exact but position is not', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(60) }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-canvas"]')).toBeVisible();

      // The counts and the honesty line live in the Index flyout, closed by
      // default because they are reference rather than a control.
      await page.locator('[data-testid="knowledge-graph-index-toggle"]').click();
      const index = page.locator('[data-testid="knowledge-graph-index-panel"]');
      await expect(index).toContainText('Conversations');
      await expect(index).toContainText('638');
      // Size beside the count, because a chunk total only means something to a
      // reader who already knows what a chunk is.
      await expect(index).toContainText('Size on disk');
      await expect(index).toContainText('3.00 GB');
      // Position is a ~33%-faithful reduction of 1024 dimensions; edges are exact.
      await expect(index).toContainText('Links are exact');
    } finally {
      await browser.close();
    }
  });

  test('the Index lists every corpus the store holds, and says which is not indexed yet', async () => {
    // The map draws conversations, but the index holds more than that. Each
    // corpus gets its own row, a corpus still embedding says how far along it
    // is, and one with nothing in it says so rather than showing a zero.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      await page.locator('[data-testid="knowledge-graph-index-toggle"]').click();
      const conversations = page.locator('[data-testid="knowledge-graph-index-corpus-conversation"]');
      const tasks = page.locator('[data-testid="knowledge-graph-index-corpus-task"]');
      const changes = page.locator('[data-testid="knowledge-graph-index-corpus-change"]');
      await expect(conversations).toContainText('Conversations');
      await expect(conversations).toContainText('638');
      await expect(conversations).not.toContainText('embedded');
      // The same name the Settings Index card uses.
      await expect(tasks).toContainText('Tasks');
      await expect(tasks).not.toContainText('Task records');
      await expect(tasks).toContainText('412, 50% embedded');
      await expect(changes).toContainText('Session changes');
      await expect(changes).toContainText('Not yet indexed');
      // Kept as text, so the count alone: no embedded share, ever.
      const commits = page.locator('[data-testid="knowledge-graph-index-corpus-commit"]');
      await expect(commits).toContainText('Commits');
      await expect(commits).toContainText('1,422');
      await expect(commits).not.toContainText('embedded');
      // Source code is opt-in: off and empty, it has no row, since "Not yet
      // indexed" would promise a fill that never comes.
      await expect(page.locator('[data-testid="knowledge-graph-index-corpus-code"]')).toHaveCount(0);
      // Summaries are written in the background, so the row counts toward the
      // finished tasks. The count alone: why it falls short (off here, and one
      // task skipped) is Settings' to say, not a suffix's.
      const summaries = page.locator('[data-testid="knowledge-graph-index-summaries"]');
      await expect(summaries).toContainText('300 of 412');
      await expect(summaries).not.toContainText(',');
      // No Chunks and no overall Embedded row: size on disk says the first in a
      // unit people read, and each corpus row carries its own embedded share.
      const rows = page.locator('[data-testid="knowledge-graph-index-rows"]');
      await expect(rows).toContainText('Size on disk');
      await expect(rows).not.toContainText('Chunks');
      await expect(rows).not.toContainText('Embedded');
      // Whether the numbers are current, and where to act on them.
      // The fixture's clock starts at init, so a slow runner can round the
      // three minutes up to four before this renders.
      await expect(page.locator('[data-testid="knowledge-graph-index-updated"]')).toHaveText(/^Updated [34] minutes ago$/);
      await page.locator('[data-testid="knowledge-graph-index-settings"]').click();
      await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
      await expect(page.locator('[data-testid="settings-tab-knowledgeGraph"]')).toHaveClass(/font-medium/);
    } finally {
      await browser.close();
    }
  });

  test('the Index shows task summaries while they are on or exist, and names a missing agent', async () => {
    // Opt-in: with summaries off and none written, the row is absent. Switched
    // on with no agent chosen, it says so rather than showing a
    // count that is not moving.
    const states: Array<{ summarySetting: 'off' | 'on'; answerAgentChosen: boolean; summariesWritten: number; expected: string | null }> = [
      { summarySetting: 'off', answerAgentChosen: true, summariesWritten: 0, expected: null },
      { summarySetting: 'on', answerAgentChosen: false, summariesWritten: 0, expected: 'Needs an agent' },
      { summarySetting: 'on', answerAgentChosen: true, summariesWritten: 0, expected: '0 of 412' },
    ];
    for (const { summarySetting, answerAgentChosen, summariesWritten, expected } of states) {
      const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20), summarySetting, answerAgentChosen, summariesWritten }));
      try {
        await openKnowledgeGraph(page);
        await page.locator('[data-testid="knowledge-graph-index-toggle"]').click();
        await expect(page.locator('[data-testid="knowledge-graph-index-corpus-task"]')).toBeVisible();
        const row = page.locator('[data-testid="knowledge-graph-index-summaries"]');
        if (expected === null) await expect(row).toHaveCount(0);
        else await expect(row).toContainText(expected);
        if (expected !== null) await expect(row).toContainText('Task summaries');
      } finally {
        await browser.close();
      }
    }
  });

  test('requests a refresh when the cached projection is stale', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(10), stale: true }));
    try {
      await openKnowledgeGraph(page);
      await expect
        .poll(async () => page.evaluate(() => (window as unknown as { __mockRefreshGraphCalls?: unknown[] }).__mockRefreshGraphCalls?.length ?? 0))
        .toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  test('does NOT request a refresh when the projection is fresh', async () => {
    // Firing the paced pass on every open would re-enter a minutes-long scan
    // for no reason.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(10), stale: false }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-canvas"]')).toBeVisible();
      const calls = await page.evaluate(
        () => (window as unknown as { __mockRefreshGraphCalls?: unknown[] }).__mockRefreshGraphCalls?.length ?? 0,
      );
      expect(calls).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('re-reads the snapshot when settings change, without being reopened', async () => {
    // Turning semantic search on changes what this surface renders - the
    // "The Knowledge Graph is off" notice comes from the snapshot - but starts no
    // projection pass. The only push was pass COMPLETION, so the notice stayed
    // over a working index until the surface was closed and reopened, which
    // reads as the setting not taking effect.
    const preConfig = `${snapshotScript({ semanticAvailable: false })}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await expect(page.getByText('The Knowledge Graph is off')).toBeVisible();

      // Re-point the mock at a snapshot reporting a working semantic layer, as
      // it would once the setting persisted, then announce the config change.
      await page.evaluate(() => {
        const api = (window as unknown as {
          electronAPI: { knowledgeGraph: { graphSnapshot: () => Promise<unknown> } };
        }).electronAPI;
        const previous = api.knowledgeGraph.graphSnapshot.bind(api.knowledgeGraph);
        api.knowledgeGraph.graphSnapshot = async () => {
          const snapshot = await previous() as { semanticAvailable: boolean } | null;
          return snapshot ? { ...snapshot, semanticAvailable: true } : snapshot;
        };
        (window as unknown as { __mockEmitConfigChanged: () => void }).__mockEmitConfigChanged();
      });

      // No reopen, no reload: the notice clears on its own.
      await expect(page.getByText('The Knowledge Graph is off')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('reloads on a completion push for the current project', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(10) }));
    try {
      await openKnowledgeGraph(page);
      const before = await page.evaluate(
        () => (window as unknown as { __mockGraphSnapshotCalls?: unknown[] }).__mockGraphSnapshotCalls?.length ?? 0,
      );
      await page.evaluate(() => (window as unknown as { __mockFireGraphChanged: (id: string) => void }).__mockFireGraphChanged('project-1'));
      await expect
        .poll(async () => page.evaluate(
          () => (window as unknown as { __mockGraphSnapshotCalls?: unknown[] }).__mockGraphSnapshotCalls?.length ?? 0,
        ))
        .toBeGreaterThan(before);
    } finally {
      await browser.close();
    }
  });

  test('a push over a map that was fresh when opened re-reads it without asking for a rebuild', async () => {
    // Record sweeps and finished embedding drains push too, and an agent's turn
    // makes the map stale. Rebuilding on such a push started a pass on every
    // turn of an open graph and moved its nodes under the reader.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(10), stale: false }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-canvas"]')).toBeVisible();
      const readsBefore = await page.evaluate(
        () => (window as unknown as { __mockGraphSnapshotCalls?: unknown[] }).__mockGraphSnapshotCalls?.length ?? 0,
      );
      await page.evaluate(() => {
        const api = (window as unknown as { electronAPI: { knowledgeGraph: { graphSnapshot: () => Promise<unknown> } } }).electronAPI;
        const previous = api.knowledgeGraph.graphSnapshot.bind(api.knowledgeGraph);
        api.knowledgeGraph.graphSnapshot = async () => {
          const snapshot = await previous() as { stale: boolean } | null;
          return snapshot ? { ...snapshot, stale: true } : snapshot;
        };
        (window as unknown as { __mockFireGraphChanged: (id: string) => void }).__mockFireGraphChanged('project-1');
      });
      await expect
        .poll(async () => page.evaluate(
          () => (window as unknown as { __mockGraphSnapshotCalls?: unknown[] }).__mockGraphSnapshotCalls?.length ?? 0,
        ))
        .toBeGreaterThan(readsBefore);
      const refreshes = await page.evaluate(
        () => (window as unknown as { __mockRefreshGraphCalls?: unknown[] }).__mockRefreshGraphCalls?.length ?? 0,
      );
      expect(refreshes).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('a push that finds a requested rebuild still stale asks for the next one', async () => {
    // A pass that finishes while the index kept growing leaves the map stale
    // again, and the map fills in pass by pass, as on a first build.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(10), stale: true }));
    try {
      await openKnowledgeGraph(page);
      const refreshCount = () => page.evaluate(
        () => (window as unknown as { __mockRefreshGraphCalls?: unknown[] }).__mockRefreshGraphCalls?.length ?? 0,
      );
      await expect.poll(refreshCount).toBe(1);
      await page.evaluate(() => (window as unknown as { __mockFireGraphChanged: (id: string) => void }).__mockFireGraphChanged('project-1'));
      await expect.poll(refreshCount).toBe(2);
    } finally {
      await browser.close();
    }
  });

  /**
   * Select a conversation on the map the way a reader does: press on it.
   *
   * Pressed at a drawn TITLE, which sits on its node and is the one place this
   * tier can aim at without reading canvas pixels, and away from the floating
   * panels so the press reaches the map. Which conversation it lands on is read
   * back off the detail panel rather than assumed, since the layout decides
   * which titles are drawn.
   */
  async function selectVisibleNode(page: Page): Promise<number> {
    await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);
    const { point, seen } = await page.evaluate(() => {
      // Aimed near the title's START, which is where its node is drawn.
      const aimAt = (rect: DOMRect) => ({ x: rect.left + Math.min(12, rect.width / 2), y: rect.top + rect.height / 2 });
      const clearOfPanels = (rect: DOMRect) => {
        const aim = aimAt(rect);
        return aim.x > 280 && aim.x < window.innerWidth - 440 && aim.y > 60;
      };
      const titles = Array.from(document.querySelectorAll('[data-testid="knowledge-graph-node-title"]'))
        .map((element) => ({ element: element as HTMLElement, rect: element.getBoundingClientRect() }))
        .filter(({ element }) => Number(element.style.opacity || '0') > 0);
      const title = titles.find(({ rect }) => clearOfPanels(rect));
      return {
        point: title ? aimAt(title.rect) : null,
        seen: titles.map(({ element, rect }) => `${element.textContent} at ${Math.round(rect.left)},${Math.round(rect.top)}`),
      };
    });
    if (!point) throw new Error(`no conversation title clear of the panels; drawn: ${seen.join('; ')}`);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
    const title = page.locator('[data-testid="knowledge-graph-detail-title"]');
    await expect(title).toBeVisible();
    const match = /Conversation (\d+)/.exec(await title.innerText());
    if (!match) throw new Error('the detail panel names no conversation');
    return Number(match[1]);
  }

  /** A source row as main sends it: the task of conversation `index`. */
  function chatRow(index: number, strength = 1) {
    return {
      key: `task-${index}`,
      taskId: `task-${index}`,
      displayId: 100 + index,
      title: `Conversation ${index}`,
      strength,
      docKeys: [`conversation::doc-${index}`],
      passage: { sessionId: `session-${index}`, turnUuid: `u-${index}` },
    };
  }

  /** A row of an answer asked across projects carries its project and ref too. */
  type ChatRow = ReturnType<typeof chatRow> & { projectId?: string; projectName?: string; ref?: string };

  function answeredScript(answer: string, rows: ReadonlyArray<ChatRow>, extra = ''): string {
    const result = {
      ok: true,
      agentName: 'Claude Code',
      answer,
      rows,
      related: rows,
      handedCount: rows.length,
      promptTokens: 100,
    };
    return `window.__mockPreConfigure(function () {
      return { knowledgeGraphAnswerResult: ${JSON.stringify(result)} };
    });${extra}`;
  }

  type AnswerCall = {
    question: string;
    projectId: string;
    granularity: string;
    requestId: string;
    context: { chatId?: string; history?: Array<{ question: string; answer: string; taskKeys: string[] }>; scopeDocKeys?: string[] | null } | null;
  };

  async function answerCalls(page: Page): Promise<AnswerCall[]> {
    return page.evaluate(() => (window as unknown as { __mockGraphAnswerCalls?: AnswerCall[] }).__mockGraphAnswerCalls ?? []);
  }

  async function fireStream(page: Page, event: Record<string, unknown>): Promise<void> {
    await page.evaluate((payload) => (window as unknown as {
      __mockFireAnswerStream: (event: unknown) => void;
    }).__mockFireAnswerStream(payload), event);
  }

  async function askInBox(page: Page, question: string): Promise<void> {
    const input = page.locator('[data-testid="knowledge-graph-search-input"]');
    await input.fill(question);
    await input.press('Enter');
  }

  const SIX_ROWS = [0, 1, 2, 3, 4, 5].map((index) => chatRow(index, 1 - index * 0.1));

  test('pressing a conversation selects it and offers to open it', async () => {
    // The point of the whole surface: a node has to lead somewhere. The first
    // version showed a raw hash and offered nothing to do with it.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(12) }));
    try {
      await openKnowledgeGraph(page);
      const index = await selectVisibleNode(page);

      const detail = page.locator('[data-testid="knowledge-graph-detail"]');
      // Labelled rows, not bare values: an unlabelled `#` in front of the
      // region name left the reader guessing what it was.
      await expect(detail).toContainText('Indexed');
      await expect(detail).toContainText(`${10 + index} chunks`);
      await expect(detail).toContainText('Agent');
      await expect(detail).toContainText('Claude Code');
      await expect(detail).toContainText('Region');
      await expect(page.locator('[data-testid="knowledge-graph-open-conversation"]')).toBeEnabled();

      // Open conversation passes the NODE's session id, onto the graph's own
      // window layer. `session-store.conversationSessionId` is the BOARD's
      // signal, and routing through it opened the transcript underneath.
      await page.locator('[data-testid="knowledge-graph-open-conversation"]').click();
      await expect
        .poll(async () => page.evaluate(
          () => (window as unknown as {
            __zustandStores?: { knowledgeGraphWindows?: { getState: () => { windows: Record<string, { kind: string; anchor: string }> } } };
          }).__zustandStores?.knowledgeGraphWindows?.getState().windows ?? {},
        ).then((windows) => Object.values(windows).map((entry) => `${entry.kind}:${entry.anchor}`)))
        .toEqual([`conversation:session-${index}`]);
    } finally {
      await browser.close();
    }
  });

  test('the selected conversation shows its task\'s summary under its title, and nothing without one', async () => {
    // Read on select, from the node's own project, rather than shipped in
    // every snapshot. With summaries off main answers null, and the panel is as
    // it was before summaries.
    const summaries = `window.__mockPreConfigure(function () {
      var memoryTaskSummaries = {};
      for (var i = 0; i < 12; i++) memoryTaskSummaries['task-' + i] = 'Fixed the wheel scroll for task ' + i + '.';
      return { memoryTaskSummaries: memoryTaskSummaries };
    });`;
    const withSummaries = await launchWithState(`${snapshotScript({ projection: projectionLiteral(12) })}${summaries}`);
    try {
      await openKnowledgeGraph(withSummaries.page);
      const index = await selectVisibleNode(withSummaries.page);
      const summary = withSummaries.page.locator('[data-testid="knowledge-graph-detail-summary"]');
      await expect(summary).toHaveText(`Fixed the wheel scroll for task ${index}.`);
      const calls = await withSummaries.page.evaluate(
        () => (window as unknown as { __mockTaskSummaryCalls?: Array<{ projectId: string; taskId: string }> }).__mockTaskSummaryCalls ?? [],
      );
      expect(calls.at(-1)).toEqual({ projectId: 'project-1', taskId: `task-${index}` });
    } finally {
      await withSummaries.browser.close();
    }

    const without = await launchWithState(snapshotScript({ projection: projectionLiteral(12) }));
    try {
      await openKnowledgeGraph(without.page);
      await selectVisibleNode(without.page);
      await expect(without.page.locator('[data-testid="knowledge-graph-detail-title"]')).toBeVisible();
      await expect.poll(() => without.page.evaluate(
        () => (window as unknown as { __mockTaskSummaryCalls?: unknown[] }).__mockTaskSummaryCalls?.length ?? 0,
      )).toBeGreaterThan(0);
      await expect(without.page.locator('[data-testid="knowledge-graph-detail-summary"]')).toHaveCount(0);
    } finally {
      await without.browser.close();
    }
  });

  /**
   * Ask, which is the whole of what the box does.
   *
   * These tests are about the things that make it trustworthy rather than
   * merely present: it runs on Enter and on nothing else, it names who answers
   * before it runs, the related set is on the map before the answer, the answer
   * is visible as it arrives, its tasks lead to their conversations, and the
   * chat ends when the reader says so.
   */
  test('typing runs nothing, and Enter asks', async () => {
    // ONE box, ONE path. It used to search live on every keystroke and
    // separately ask on Enter when a regex judged the text to be a question;
    // two systems answered the same input and the second overwrote the first.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openKnowledgeGraph(page);
      const input = page.locator('[data-testid="knowledge-graph-search-input"]');
      // Code is not indexed here, so the box does not offer it.
      await expect(input).toHaveAttribute('placeholder', 'Ask about your tasks and conversations');

      await input.fill('sphere fit');
      await input.fill('What was the most expensive task?');
      await page.waitForTimeout(400);
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).toHaveCount(0);
      expect(await answerCalls(page)).toHaveLength(0);

      // Enter asks. Exactly once, with the text as typed, the project the map
      // is pointed at (`.claude/rules/project-scoped-ipc.md`), the detail level
      // on screen, a request id the stream is keyed on, and a chat id.
      await input.press('Enter');
      await expect.poll(async () => (await answerCalls(page)).length).toBe(1);
      const [call] = await answerCalls(page);
      expect(call.question).toBe('What was the most expensive task?');
      expect(call.projectId).toBe('project-1');
      expect(call.granularity).toBe('balanced');
      expect(call.requestId).toBeTruthy();
      expect(call.context?.chatId).toBeTruthy();
      expect(call.context?.history).toEqual([]);
      // No filter is set, so nothing narrows the question.
      expect(call.context?.scopeDocKeys).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('the box offers code only when source code is indexed, and the Index counts its files', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(12), codeIndexed: true }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-search-input"]'))
        .toHaveAttribute('placeholder', 'Ask about your tasks, conversations and code');
      await page.locator('[data-testid="knowledge-graph-index-toggle"]').click();
      const code = page.locator('[data-testid="knowledge-graph-index-corpus-code"]');
      await expect(code).toContainText('Source code');
      await expect(code).toContainText('1,488, 34% embedded');
    } finally {
      await browser.close();
    }
  });

  test('says who answers, before it runs', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openKnowledgeGraph(page);
      const ask = page.locator('[data-testid="knowledge-graph-ask"]');
      await expect(ask).toHaveCount(0);

      await page.locator('[data-testid="knowledge-graph-search-input"]').fill('sphere fit');
      // The submit glyph appears once there is TEXT. Enter is the button; this
      // is for discoverability and the mouse, and it names the agent.
      await expect(ask).toBeVisible();
      await expect(ask).toHaveAttribute('aria-label', 'Ask Claude Code');
      await ask.hover();
      await expect(page.locator('[data-testid="knowledge-graph-ask-tip"]')).toContainText('related work');
      expect(await answerCalls(page)).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  test('the ask glyph\'s tip opens on keyboard focus and closes when focus leaves', async () => {
    // The tip used to open on pointer enter only, so someone tabbing to the
    // glyph was told nothing about who answers. Focus now opens it and blur
    // closes it, and the words are ALSO in the trigger for a reader with
    // neither a pointer nor sight of the tip, which is only mounted while open.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openKnowledgeGraph(page);
      const input = page.locator('[data-testid="knowledge-graph-search-input"]');
      const ask = page.locator('[data-testid="knowledge-graph-ask"]');
      const tip = page.locator('[data-testid="knowledge-graph-ask-tip"]');

      await input.fill('sphere fit');
      await expect(ask).toBeVisible();
      await expect(tip).toHaveCount(0);
      // Closed, the words are still in the trigger (the button's sibling).
      await expect(ask.locator('xpath=..')).toContainText('It reads the related work');

      // Tab from the box lands on the glyph, and the tip follows focus.
      await input.press('Tab');
      await expect(ask).toBeFocused();
      await expect(tip).toBeVisible();
      await expect(tip).toContainText('related work');

      // Shift+Tab back to the box moves focus off the glyph, and the tip goes.
      await page.keyboard.press('Shift+Tab');
      await expect(input).toBeFocused();
      await expect(tip).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('asking moves the question into a chat, and the related set lands before the answer', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('The settled answer, about #103.', [chatRow(3)], 'window.__mockHoldAnswer = true;')}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await askInBox(page, 'what fixed the relay?');

      // The box goes and the question is the first bubble of the chat, titled
      // for what it is rather than who answers (the agent is a Settings choice).
      const chat = page.locator('[data-testid="knowledge-graph-chat"]');
      await expect(chat).toBeVisible();
      await expect(page.locator('[data-testid="knowledge-graph-chat-title"]')).toHaveText('Chat');
      await expect(chat).not.toContainText('Claude Code');
      await expect(page.locator('[data-testid="knowledge-graph-search-input"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-chat-question"]')).toHaveText('what fixed the relay?');
      await expect(page.locator('[data-testid="knowledge-graph-chat-pending"]')).toContainText('Finding related work');

      await expect.poll(async () => (await answerCalls(page)).length).toBe(1);
      const [{ requestId }] = await answerCalls(page);

      // Set first, answer on top: the related work arrives before any prose,
      // and the turn says how much of it the agent is reading.
      await fireStream(page, { requestId, kind: 'set', related: [chatRow(3), chatRow(4, 0.5)], handedCount: 2 });
      await expect(page.locator('[data-testid="knowledge-graph-chat-reading"]')).toHaveText('Reading 2 related tasks');
      expect(await page.evaluate(() => (window as unknown as {
        __zustandStores: { knowledgeGraph: { getState: () => { thread: Array<{ related: unknown[] | null }> } } };
      }).__zustandStores.knowledgeGraph.getState().thread[0].related?.length)).toBe(2);

      // A search the agent makes on its own is a step, named by its query.
      await fireStream(page, { requestId, kind: 'search', query: 'relay pairing', docKeys: ['conversation::doc-3'] });
      const pending = page.locator('[data-testid="knowledge-graph-chat-pending"]');
      await expect(pending).toContainText('Read 2 related tasks');
      await expect(pending).toContainText('relay pairing');

      // Text renders while the answer is still open, and replaces the steps.
      await fireStream(page, { requestId, kind: 'text', text: 'We dropped it because ' });
      await expect(page.locator('[data-testid="knowledge-graph-chat-answer"]')).toContainText('We dropped it because');
      await expect(pending).toHaveCount(0);

      // A delta for a DIFFERENT request is dropped, never appended.
      await fireStream(page, { requestId: 'stale', kind: 'text', text: 'NOT THIS' });
      await expect(page.locator('[data-testid="knowledge-graph-chat-answer"]')).not.toContainText('NOT THIS');

      // The settled answer REPLACES the stream, and its rows appear.
      await page.evaluate(() => (window as unknown as { __mockReleaseAnswer: () => void }).__mockReleaseAnswer());
      await expect(page.locator('[data-testid="knowledge-graph-chat-answer"]')).toContainText('The settled answer');
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('an answer is prose with ticket marks, then rows of one kind', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('Mostly #100, then #103. Step #999 is not a task here.', SIX_ROWS)}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await askInBox(page, 'which tasks touched the relay?');

      // A ticket the answer is about is a mark; one it is not stays text.
      const marks = page.locator('[data-testid="knowledge-graph-chat-ticket"]');
      await expect(marks).toHaveText(['#100', '#103']);
      await expect(page.locator('[data-testid="knowledge-graph-chat-answer"]')).toContainText('#999');

      // Rows of ONE kind: the ticket and the title. Five, then the rest on ask.
      const rows = page.locator('[data-testid="knowledge-graph-chat-row"]');
      await expect(rows).toHaveCount(5);
      await expect(rows.first()).toContainText('#100');
      await expect(rows.first()).toContainText('Conversation 0');
      const more = page.locator('[data-testid="knowledge-graph-chat-rows-more"]');
      await expect(more).toHaveText('Show all 6');
      await more.click();
      await expect(rows).toHaveCount(6);

      // And it folds back. Reported: after "Show all 32" there was no way to
      // shrink the list again short of ending the chat.
      await page.locator('[data-testid="knowledge-graph-chat-rows-fewer"]').click();
      await expect(rows).toHaveCount(5);
      await expect(more).toHaveText('Show all 6');
    } finally {
      await browser.close();
    }
  });

  test('a row opens that task\'s conversation over the map, at the passage the answer used', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('#103 fixed it.', [chatRow(3)])}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await askInBox(page, 'what fixed the relay?');

      // Record what each open ASKED for. The scroll target is consumed the
      // moment the viewer scrolls, so the store cannot be read for it afterwards.
      await page.evaluate(() => {
        type Opened = { kind: string; anchor: string; scrollToTurnUuid?: string };
        const holder = window as unknown as {
          __openedWindows: Opened[];
          __zustandStores: { knowledgeGraphWindows: { getState: () => { openWindow: (input: Opened) => unknown }; setState: (patch: object) => void } };
        };
        holder.__openedWindows = [];
        const store = holder.__zustandStores.knowledgeGraphWindows;
        const original = store.getState().openWindow;
        store.setState({
          openWindow: (input: Opened) => {
            holder.__openedWindows.push({ kind: input.kind, anchor: input.anchor, scrollToTurnUuid: input.scrollToTurnUuid });
            return original(input);
          },
        });
      });
      const opened = () => page.evaluate(() => (window as unknown as {
        __openedWindows: Array<{ kind: string; anchor: string; scrollToTurnUuid?: string }>;
      }).__openedWindows);

      await page.locator('[data-testid="knowledge-graph-chat-row"]').click();
      await expect.poll(opened).toEqual([{ kind: 'conversation', anchor: 'session-3', scrollToTurnUuid: 'u-3' }]);

      // The mark in the prose leads to the same place, and focuses rather than
      // stacking a second window. Dispatched: the window may sit over the chat.
      await page.locator('[data-testid="knowledge-graph-chat-ticket"]').dispatchEvent('click');
      await expect.poll(async () => (await opened()).length).toBe(2);
      expect((await opened())[1]).toEqual({ kind: 'conversation', anchor: 'session-3', scrollToTurnUuid: 'u-3' });
      expect(await page.evaluate(() => Object.keys((window as unknown as {
        __zustandStores: { knowledgeGraphWindows: { getState: () => { windows: Record<string, unknown> } } };
      }).__zustandStores.knowledgeGraphWindows.getState().windows).length)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('an answer narrows the map to the tasks it is about', async () => {
    const answered = {
      ok: true, agentName: 'Claude Code', answer: 'It was #103.', rows: [chatRow(3)],
      related: [chatRow(3), chatRow(4, 0.9), chatRow(5, 0.8)], handedCount: 3, promptTokens: 1,
    };
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () { return { knowledgeGraphAnswerResult: ${JSON.stringify(answered)} }; });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      const drawn = () => page.locator('[data-testid="knowledge-graph-canvas"]').getAttribute('data-drawn-count');
      expect(await drawn()).toBe('30');
      await askInBox(page, 'what fixed the relay?');
      // Once it lands, the map IS the answer: its one task, not the related set
      // dimmed behind it, and not a grey wash of everything else.
      await expect.poll(async () => visibleNodeTitles(page)).toEqual(['Conversation 3']);
      await expect.poll(drawn).toBe('1');
    } finally {
      await browser.close();
    }
  });

  test('a task with no recorded conversation opens on the board, or shows as unopenable detached', async () => {
    // On the real board four of the tasks that added an agent have no indexed
    // conversation. They are answer rows now, and a row has to lead somewhere.
    const oldTask = {
      key: 'task-old', taskId: 'task-old', displayId: 14, title: 'Add support for OpenCode agent',
      strength: 1, docKeys: [], passage: null,
    };
    const answered = `window.__mockPreConfigure(function () {
      return { knowledgeGraphAnswerResult: ${JSON.stringify({
        ok: true, agentName: 'Claude Code', answer: 'That was #14.', rows: [oldTask], related: [], handedCount: 0, promptTokens: 1,
      })} };
    });`;

    const inApp = await launchWithState(`${snapshotScript({ projection: projectionLiteral(12) })}${answered}`);
    try {
      await openKnowledgeGraph(inApp.page);
      await askInBox(inApp.page, 'which task added OpenCode?');
      const row = inApp.page.locator('[data-testid="knowledge-graph-chat-row"]');
      await expect(row).toBeEnabled();
      await row.click();
      // The graph closes and the board is asked to open the task.
      await expect(inApp.page.locator('[data-testid="knowledge-graph-page"]')).toHaveCount(0);
      await expect.poll(async () => inApp.page.evaluate(() => (window as unknown as {
        __zustandStores: { session: { getState: () => { detailTaskId: string | null } } };
      }).__zustandStores.session.getState().detailTaskId)).toBe('task-old');
    } finally {
      await inApp.browser.close();
    }

    const detached = await launchDetached(`${snapshotScript({ projection: projectionLiteral(12) })}${answered}`);
    try {
      await askInBox(detached.page, 'which task added OpenCode?');
      // No conversation and no board here: the row names the task but is not a control.
      await expect(detached.page.locator('[data-testid="knowledge-graph-chat-row"]')).toBeDisabled();
      await expect(detached.page.locator('button[data-testid="knowledge-graph-chat-ticket"]')).toHaveCount(0);
    } finally {
      await detached.browser.close();
    }
  });

  test('a follow-up carries the chat, and the earlier rows collapse', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('Mostly #100.', SIX_ROWS)}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await askInBox(page, 'which tasks touched the relay?');
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(5);

      const composer = page.locator('[data-testid="knowledge-graph-chat-input"]');
      await expect(composer).toHaveAttribute('placeholder', 'Ask a follow-up');
      await composer.fill('which of those cost the most?');
      await composer.press('Enter');

      await expect.poll(async () => (await answerCalls(page)).length).toBe(2);
      const [first, second] = await answerCalls(page);
      // Same chat, and the earlier turn rides along with the tasks it was about.
      expect(second.context?.chatId).toBe(first.context?.chatId);
      expect(second.context?.history).toEqual([{
        question: 'which tasks touched the relay?',
        answer: 'Mostly #100.',
        taskKeys: SIX_ROWS.map((row) => row.key),
      }]);

      await expect(page.locator('[data-testid="knowledge-graph-chat-question"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="knowledge-graph-chat-rows-collapsed"]')).toHaveText('Show 6 tasks');
      // The latest turn's rows are the open ones.
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(5);
      // The box stays gone: the composer is the one place to type.
      await expect(page.locator('[data-testid="knowledge-graph-search-input"]')).toHaveCount(0);

      // Opening the earlier turn's rows puts ITS tasks back on the map.
      const focused = () => page.evaluate(() => {
        const state = (window as unknown as {
          __zustandStores: { knowledgeGraph: { getState: () => { focusedTurnId: string | null; thread: Array<{ id: string }> } } };
        }).__zustandStores.knowledgeGraph.getState();
        return state.focusedTurnId === state.thread[0].id;
      });
      expect(await focused()).toBe(false);
      await page.locator('[data-testid="knowledge-graph-chat-rows-collapsed"]').click();
      await expect.poll(focused).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('an answer about one conversation shows just that one', async () => {
    // Its neighbours used to come back as dim context, which read as clutter
    // around a one-task answer. The camera flies in close instead, so the one
    // conversation is the picture.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      ${answeredScript('That was #110, one conversation.', [chatRow(10)])}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await askInBox(page, 'what was the longest conversation?');
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(1);

      await expect.poll(async () => (await visibleNodeTitles(page)).sort()).toEqual(['Conversation 10']);
      await expect.poll(() => page.locator('[data-testid="knowledge-graph-canvas"]').getAttribute('data-drawn-count')).toBe('1');
    } finally {
      await browser.close();
    }
  });

  test('an answer that names no tasks lights nothing', async () => {
    // Retrieval always hands over its closest matches, so a question about
    // something that is not here still had a related set, and the map lit it
    // under an answer saying nothing matched. The mockup's Empty board draws
    // the plain map. While a highlight is on, only lit nodes are titled, so a
    // title outside the related set proves nothing is lit.
    const answered = {
      ok: true, agentName: 'Claude Code', answer: 'Nothing here covers Kubernetes autoscaling.', rows: [],
      related: [chatRow(3), chatRow(4, 0.9), chatRow(5, 0.8)], handedCount: 3, promptTokens: 1,
    };
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () { return { knowledgeGraphAnswerResult: ${JSON.stringify(answered)} }; });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await askInBox(page, 'How did we set up Kubernetes autoscaling?');
      await expect(page.locator('[data-testid="knowledge-graph-chat-answer"]')).toContainText('Nothing here covers');
      const related = ['Conversation 3', 'Conversation 4', 'Conversation 5'];
      await expect.poll(async () => (await visibleNodeTitles(page)).some((title) => !related.includes(title)))
        .toBe(true);
    } finally {
      await browser.close();
    }
  });

  /**
   * The detached window: the same body in a renderer of its own, with its own
   * store and no settings panel. Loaded by handing the renderer the descriptor
   * main would pass a pop-out.
   */
  async function launchDetached(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
    await waitForViteReady(VITE_URL);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(`${preConfigScript}
      window.electronAPI.popOut.descriptor = { kind: 'knowledge-graph', params: {} };`);
    await page.goto(VITE_URL);
    // No title bar in a detached window, so wait for the graph itself.
    await page.locator('[data-testid="knowledge-graph-search-input"]').waitFor({ state: 'visible', timeout: 15000 });
    return { browser, page };
  }

  test('the detached window asks and answers the same way', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('It was #103.', [chatRow(3)])}`;
    const { browser, page } = await launchDetached(preConfig);
    try {
      // No board behind it: this renderer is the graph alone.
      await expect(page.locator('[data-testid="knowledge-graph-page"]')).toHaveCount(0);
      await askInBox(page, 'what fixed the relay?');
      await expect(page.locator('[data-testid="knowledge-graph-chat-answer"]')).toContainText('It was');
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(1);

      await page.locator('[data-testid="knowledge-graph-chat-end"]').click();
      await expect(page.locator('[data-testid="knowledge-graph-search-input"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('the detached window names where the answering agent is chosen, instead of opening a panel it lacks', async () => {
    const { browser, page } = await launchDetached(
      snapshotScript({ projection: projectionLiteral(12), answerAgentChosen: false }),
    );
    try {
      await askInBox(page, 'what fixed the relay?');
      await expect(page.locator('[data-testid="knowledge-graph-setup-hint"]')).toContainText('Settings > Knowledge Graph');
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).toHaveCount(0);
      expect(await answerCalls(page)).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  test('X ends the chat and brings the box back', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('Mostly #100.', [chatRow(0)])}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await askInBox(page, 'which tasks touched the relay?');
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(1);

      await page.locator('[data-testid="knowledge-graph-chat-end"]').click();
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).toHaveCount(0);
      const input = page.locator('[data-testid="knowledge-graph-search-input"]');
      await expect(input).toBeVisible();
      await expect(input).toHaveValue('');
    } finally {
      await browser.close();
    }
  });

  test('warms the answering agent for the chat, and lets it go when the chat or the graph ends', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('Mostly #100.', [chatRow(0)])}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      type Recorded = { prewarms: Array<{ chatId: string }>; ended: string[]; asked: string[] };
      const recorded = () => page.evaluate((): Recorded => {
        const scope = window as unknown as {
          __mockAnswerPrewarms?: Array<{ chatId: string }>;
          __mockEndChatCalls?: string[];
          __mockGraphAnswerCalls?: Array<{ context: { chatId?: string } | null }>;
        };
        return {
          prewarms: scope.__mockAnswerPrewarms ?? [],
          ended: scope.__mockEndChatCalls ?? [],
          asked: (scope.__mockGraphAnswerCalls ?? []).map((call) => call.context?.chatId ?? ''),
        };
      });

      // Opening warms a session for a chat, and the question asks in that chat.
      await openKnowledgeGraph(page);
      await expect.poll(async () => (await recorded()).prewarms.length).toBeGreaterThan(0);
      const warmed = (await recorded()).prewarms.at(-1)!.chatId;
      await askInBox(page, 'which tasks touched the relay?');
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(1);
      expect((await recorded()).asked).toEqual([warmed]);

      // X lets that session go and warms the next chat's.
      await page.locator('[data-testid="knowledge-graph-chat-end"]').click();
      await expect.poll(async () => (await recorded()).ended).toContain(warmed);
      const next = (await recorded()).prewarms.at(-1)!.chatId;
      expect(next).not.toBe(warmed);

      // Closing the graph lets the warm session go too.
      await page.locator('[data-testid="knowledge-graph-close"]').click();
      await page.locator('[data-testid="knowledge-graph-page"]').waitFor({ state: 'hidden', timeout: 5000 });
      await expect.poll(async () => (await recorded()).ended).toContain(next);
    } finally {
      await browser.close();
    }
  });

  test('shows why an answer failed, verbatim, and tries again in place', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('It was #100.', [chatRow(0)], `
        window.__mockAnswerResultQueue = [{ ok: false, reason: 'Claude Code CLI not found' }];`)}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await askInBox(page, 'what happened?');

      // Every reason is actionable, so a generic failure line would take it away.
      const failed = page.locator('[data-testid="knowledge-graph-chat-turn-failed"]');
      await expect(failed).toContainText('CLI not found');
      await page.locator('[data-testid="knowledge-graph-chat-retry"]').click();

      await expect(page.locator('[data-testid="knowledge-graph-chat-answer"]')).toContainText('It was');
      await expect(failed).toHaveCount(0);
      // In place: the question is asked again, not added as a second turn.
      await expect(page.locator('[data-testid="knowledge-graph-chat-question"]')).toHaveCount(1);
      expect((await answerCalls(page)).map((call) => call.question)).toEqual(['what happened?', 'what happened?']);
    } finally {
      await browser.close();
    }
  });

  test('the map\'s filters are the scope of the question', async () => {
    // Nothing in the chat restates the filters: they go with the question, and
    // main counts, ranks and searches only inside them.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('Eight finished.', [])}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await page.locator('[data-testid="knowledge-graph-filter-outcome-done"]').click();
      await askInBox(page, 'how many tasks finished?');

      await expect.poll(async () => (await answerCalls(page)).length).toBe(1);
      const [call] = await answerCalls(page);
      // The fixture marks every node whose index is not 1 more than a multiple of 3 as done.
      const expected = [0, 2, 3, 5, 6, 8, 9, 11].map((index) => `conversation::doc-${index}`);
      expect([...(call.context?.scopeDocKeys ?? [])].sort()).toEqual(expected.sort());
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).not.toContainText('Done');
    } finally {
      await browser.close();
    }
  });

  test('sends a question to Settings > Knowledge Graph when no answering agent is chosen, and keeps it', async () => {
    // The agent and model are one explicit global choice with no fallback, so
    // a question asked before they are set runs nothing. It goes to the place
    // the choice is made, and the typed question waits in the box.
    const preConfig = snapshotScript({ projection: projectionLiteral(30), answerAgentChosen: false });
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      const input = page.locator('[data-testid="knowledge-graph-search-input"]');
      await expect(input).toBeEnabled();
      await input.fill('what changed the renderer?');
      await input.press('Enter');

      await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
      await expect(page.locator('[data-testid="settings-tab-knowledgeGraph"]')).toHaveClass(/font-medium/);
      // No answer ran: the chat never started.
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).toHaveCount(0);
      // The question survives the trip to settings.
      await expect(input).toHaveValue('what changed the renderer?');
    } finally {
      await browser.close();
    }
  });

  // Quick Find matches words only; its last row hands what you typed to the
  // Knowledge Graph, which asks it through the same path as its own box.
  test('Quick Find\'s Ask row opens the graph with the question asked', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('what changed the renderer?');
      const askRow = page.getByTestId('search-palette-ask');
      // No keyword matches, so the Ask row holds the selection and Enter asks.
      await expect(askRow).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Enter');

      await expect(page.getByTestId('search-palette')).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-page"]')).toBeVisible();
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).toContainText('what changed the renderer?');
    } finally {
      await browser.close();
    }
  });

  test('Quick Find\'s Ask row sends the question to Settings when no answering agent is chosen, and keeps it', async () => {
    const preConfig = snapshotScript({ projection: projectionLiteral(30), answerAgentChosen: false });
    const { browser, page } = await launchWithState(preConfig);
    try {
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('what changed the renderer?');
      await page.getByTestId('search-palette-ask').click();

      await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).toHaveCount(0);
      // The question waits in the graph's box for when the user comes back.
      await expect(page.locator('[data-testid="knowledge-graph-search-input"]')).toHaveValue('what changed the renderer?');
    } finally {
      await browser.close();
    }
  });

  test('a question queued from Quick Find while an answer is running is asked when that answer lands', async () => {
    // A turn still answering refuses a new question. The queued one used to be
    // taken (and so cleared) the moment it arrived, then refused, and was lost.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('The first answer.', [chatRow(0)], 'window.__mockHoldAnswer = true;')}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      await askInBox(page, 'first question');
      await expect.poll(async () => (await answerCalls(page)).length).toBe(1);

      // What Quick Find's Ask row calls: it queues the question and opens the
      // graph, which is already open here. Called directly, since the palette
      // would have to be layered over the graph to reach it by keyboard.
      await page.evaluate(() => (window as unknown as {
        __zustandStores: { knowledgeGraph: { getState: () => { askInGraph: (question: string, projectId: string | null) => void } } };
      }).__zustandStores.knowledgeGraph.getState().askInGraph('second question', null));
      // Not asked over the answer that is still running.
      expect((await answerCalls(page)).map((call) => call.question)).toEqual(['first question']);

      // The first answer lands, and the queued question follows it.
      await page.evaluate(() => {
        const scope = window as unknown as { __mockHoldAnswer: boolean; __mockReleaseAnswer: () => void };
        scope.__mockHoldAnswer = false;
        scope.__mockReleaseAnswer();
      });
      await expect
        .poll(async () => (await answerCalls(page)).map((call) => call.question))
        .toEqual(['first question', 'second question']);
      await expect(page.locator('[data-testid="knowledge-graph-chat-question"]')).toHaveCount(2);
    } finally {
      await browser.close();
    }
  });

  test('treats a chosen agent that cannot answer as not chosen', async () => {
    // The gate is the CAPABILITY, never the agent's name
    // (`.claude/rules/agent-adapters-boundary.md`), and no other agent is
    // substituted for it.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}      window.__mockAgentListOverrides = { claude: { supportsAnswerFromContext: false } };`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      const input = page.locator('[data-testid="knowledge-graph-search-input"]');
      await input.fill('anything');
      await input.press('Enter');
      await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('offers an answering effort that starts at the recommended level and clears with the agent', async () => {
    // The row follows the adapter's declaration and the CLI's own levels, never
    // a name. Unset shows the recommended level, so leaving it alone is visible.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30), answerAgentChosen: false })}
      window.__mockPreConfigure(function (state) {
        state.config.knowledgeGraph = Object.assign({}, state.config.knowledgeGraph, { indexingEnabled: true, enabled: true });
        return {};
      });
      window.__mockAgentListOverrides = { grok: { found: true, path: '/usr/bin/grok', version: '1', capabilities: { effortLevels: ['low', 'medium', 'high', 'xhigh'], supportsModelOverride: true, models: ['grok-4.7'] } } };`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      const input = page.locator('[data-testid="knowledge-graph-search-input"]');
      await input.fill('anything');
      await input.press('Enter');
      await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();

      const agent = page.locator('[data-testid="knowledge-graph-answer-agent"]');
      const modelRow = page.locator('[data-testid="setting-row-knowledgeGraph.model"]');
      const effortRow = page.locator('[data-testid="setting-row-knowledgeGraph.effort"]');
      const effort = page.locator('[data-testid="knowledge-graph-answer-effort"]');
      const choose = async (agentName: string): Promise<void> => {
        await agent.click();
        await page.locator(`[data-testid="knowledge-graph-answer-agent-option-${agentName}"]`).click();
      };

      await choose('claude');
      await expect(modelRow).toBeVisible();
      await expect(effortRow).toBeVisible();
      await expect(effort).toHaveValue('');
      await expect(effort).toHaveAttribute('placeholder', 'low');

      await effort.click();
      await page.locator('[data-testid="knowledge-graph-answer-effort-option-max"]').click();
      await expect(effort).toHaveValue('max');

      // Levels belong to one CLI, so changing the agent clears the effort, and
      // the new agent starts at its own recommendation.
      await choose('grok');
      await expect(effort).toHaveValue('');
      await expect(effort).toHaveAttribute('placeholder', 'low');
      await effort.click();
      await expect(page.locator('[data-testid="knowledge-graph-answer-effort-option-max"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-answer-effort-option-xhigh"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('offers region, time and outcome filters', async () => {
    // The same dimensions the colour modes encode. Before this you could colour
    // by status and SEE which work was still open, but could not scope the map
    // to it.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      const since = page.locator('[data-testid="knowledge-graph-filter-since"]');
      const outcome = page.locator('[data-testid="knowledge-graph-filter-outcome"]');
      await expect(since).toBeVisible();
      await expect(outcome).toBeVisible();
      // Segmented, so every option shows: a row of days and a row of statuses,
      // each option's full meaning kept as its accessible name.
      await expect(since.getByRole('radio', { name: 'Last 30 days' })).toHaveText('30 days');
      await expect(outcome.getByRole('radio', { name: 'Done' })).toBeVisible();
      await page.locator('[data-testid="knowledge-graph-filter-since-90d"]').click();
      await expect(page.locator('[data-testid="knowledge-graph-filter-since-90d"]')).toHaveAttribute('aria-checked', 'true');
      // A narrow panel: none of the options may be cut off.
      const clipped = await page.evaluate(() => Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="knowledge-graph-filter-since"] [role="radio"], [data-testid="knowledge-graph-filter-outcome"] [role="radio"]'),
      ).filter((option) => option.scrollWidth > option.clientWidth + 1 || option.getBoundingClientRect().right > option.closest('[role="radiogroup"]')!.getBoundingClientRect().right + 1)
        .map((option) => option.textContent));
      expect(clipped).toEqual([]);
      // Regions are their own card now, not a row in the Filter card: the
      // region rows are in the Regions card, and none is in this one.
      await expect(
        page.locator('[data-testid="knowledge-graph-regions-card"] [data-testid="knowledge-graph-region-row"]'),
      ).toHaveCount(2);
      await expect(
        page.locator('[data-testid="knowledge-graph-filter-card"] [data-testid="knowledge-graph-region-row"]'),
      ).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('names each region by its own label, not by an index', async () => {
    // A region picker reading "Cluster 0" would make the reader hold a mapping
    // in their head that the map already draws for them.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      const rows = page.locator('[data-testid="knowledge-graph-region-row"]');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText('terminal / pty');
      await expect(rows.nth(1)).toContainText('database / schema');
      // Each carries how many conversations it holds, counted from the nodes.
      await expect(rows.nth(0)).toContainText('10');
    } finally {
      await browser.close();
    }
  });

  test('a region filter hides the regions it scoped out', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      // Labels stay mounted and fade, because the frame loop positions them - so
      // this asserts opacity rather than element count.
      const kept = page.locator('[data-testid="knowledge-graph-cluster-label"][data-cluster="0"]');
      const dropped = page.locator('[data-testid="knowledge-graph-cluster-label"][data-cluster="1"]');
      await expect(kept).not.toHaveCSS('opacity', '0');
      await expect(dropped).not.toHaveCSS('opacity', '0');

      // Toggle the SECOND region off; the first stays.
      await page.locator('[data-testid="knowledge-graph-region-row"]').nth(1).click();
      // A label hanging over the space where its conversations used to be names
      // something that is not there.
      await expect(dropped).toHaveCSS('opacity', '0');
      await expect(kept).not.toHaveCSS('opacity', '0');

      await page.locator('[data-testid="knowledge-graph-region-row"]').nth(1).click();
      await expect(dropped).not.toHaveCSS('opacity', '0');
    } finally {
      await browser.close();
    }
  });

  test('renames regions in place when a push brings new names for the same map', async () => {
    // Summaries rename regions without rebuilding the map: same signature, same
    // ids and positions, new label text. The pills and the panel take the new
    // names, the regions switched off stay off, and nothing asks for a rebuild.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      const first = page.locator('[data-testid="knowledge-graph-cluster-label"][data-cluster="0"]');
      const second = page.locator('[data-testid="knowledge-graph-cluster-label"][data-cluster="1"]');
      await expect(first).toHaveText('terminal / pty');
      await page.locator('[data-testid="knowledge-graph-region-row"]').nth(1).click();
      await expect(second).toHaveCSS('opacity', '0');

      await page.evaluate(() => {
        const api = (window as unknown as { electronAPI: { knowledgeGraph: { graphSnapshot: (...args: unknown[]) => Promise<unknown> } } }).electronAPI;
        const previous = api.knowledgeGraph.graphSnapshot.bind(api.knowledgeGraph);
        api.knowledgeGraph.graphSnapshot = async (...args: unknown[]) => {
          const snapshot = await previous(...args) as { projection: { clusterings: Array<{ regions: Array<{ id: number; label: string }> }> } | null } | null;
          if (!snapshot?.projection) return snapshot;
          const renamed = { 0: 'alt screen / wheel scroll', 1: 'schema migration / sqlite' } as Record<number, string>;
          return {
            ...snapshot,
            projection: {
              ...snapshot.projection,
              clusterings: snapshot.projection.clusterings.map((clustering) => ({
                ...clustering,
                regions: clustering.regions.map((region) => ({ ...region, label: renamed[region.id] ?? region.label })),
              })),
            },
          };
        };
        (window as unknown as { __mockFireGraphChanged: (id: string) => void }).__mockFireGraphChanged('project-1');
      });

      await expect(first).toHaveText('alt screen / wheel scroll');
      await expect(page.locator('[data-testid="knowledge-graph-region-row"]').first()).toContainText('alt screen / wheel scroll');
      // The switched-off region is still off: same map, same exclusions.
      await expect(second).toHaveCSS('opacity', '0');
      await expect(first).not.toHaveCSS('opacity', '0');
      const refreshes = await page.evaluate(
        () => (window as unknown as { __mockRefreshGraphCalls?: unknown[] }).__mockRefreshGraphCalls?.length ?? 0,
      );
      expect(refreshes).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('drops a region label the filter has left a single conversation of', async () => {
    // A pill names an AREA, and the projection's centroid is the average of
    // every node the region ever had. With one hit left that centroid is the
    // hit, so the region name became a second, vaguer label on a conversation
    // whose own title was already there - and a search returning 42 across 39
    // regions therefore drew a wall of them, churning as the camera moved.
    //
    // Region 0 keeps three conversations (docs 0-2) and region 1 exactly one
    // (doc 15), because the fixture splits balanced at the halfway node.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(20) })}
      window.__mockPreConfigure(function () {
        return {
          knowledgeGraphAnswerResult: {
            ok: true, agentName: 'Claude Code', answer: 'Four conversations.',
            rows: [0, 1, 2, 15].map(function (index) {
              return { key: 'task-' + index, taskId: 'task-' + index, displayId: 100 + index, title: 'Conversation ' + index, strength: 1, docKeys: ['conversation::doc-' + index], passage: null };
            }),
            related: [], handedCount: 4, promptTokens: 1,
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      const kept = page.locator('[data-testid="knowledge-graph-cluster-label"][data-cluster="0"]');
      const thinned = page.locator('[data-testid="knowledge-graph-cluster-label"][data-cluster="1"]');
      await expect(kept).not.toHaveCSS('opacity', '0');
      await expect(thinned).not.toHaveCSS('opacity', '0');

      await page.locator('[data-testid="knowledge-graph-search-input"]').fill('terminal');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(4);

      // Opacity, not element count: the labels stay mounted and the frame loop
      // fades them, so a count assertion passes against a merely invisible pill.
      await expect(thinned).toHaveCSS('opacity', '0');
      await expect(kept).not.toHaveCSS('opacity', '0');
    } finally {
      await browser.close();
    }
  });

  test('reads Any, Done and Open in three columns under the time row\'s three', async () => {
    // The board's own words: Done is the Done column, Open is everything still
    // on the board. There is no third status, since only the move into Done
    // archives a task. Same count, same width, so the segments stack in columns.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      const since = page.locator('[data-testid="knowledge-graph-filter-since"]');
      const outcome = page.locator('[data-testid="knowledge-graph-filter-outcome"]');
      await expect(since.getByRole('radio')).toHaveText(['Any', '30 days', '90 days']);
      await expect(outcome.getByRole('radio')).toHaveText(['Any', 'Done', 'Open']);
      await expect(page.locator('[data-testid="knowledge-graph-filter-outcome-done"]')).toBeEnabled();
      await expect(page.locator('[data-testid="knowledge-graph-filter-outcome-active"]')).toBeEnabled();

      // The tolerance is for font metrics: a missing segment moves a column by
      // a third of the row, about 75px, not a few.
      const columns = await page.evaluate(() => ['since', 'outcome'].map((row) => Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="knowledge-graph-filter-${row}"] [role="radio"]`),
      ).map((option) => option.getBoundingClientRect().left)));
      expect(columns[0]).toHaveLength(3);
      expect(columns[1]).toHaveLength(3);
      columns[0].forEach((left, index) => expect(Math.abs(left - columns[1][index])).toBeLessThanOrEqual(3));
    } finally {
      await browser.close();
    }
  });

  test('regions are all on by default, and toggle independently', async () => {
    // The regions ARE the map's domains, so comparing two of them or hiding one
    // noisy area is the natural thing to want. The single-select dropdown this
    // replaced could only ever answer "just this one".
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      const rows = page.locator('[data-testid="knowledge-graph-region-row"]');
      await expect(rows).toHaveCount(2);
      for (const row of await rows.all()) {
        await expect(row).toHaveAttribute('data-region-on', 'true');
      }
      await expect(page.locator('[data-testid="knowledge-graph-regions-toggle"]')).toContainText('Regions');

      await rows.nth(0).click();
      await expect(rows.nth(0)).toHaveAttribute('data-region-on', 'false');
      // Independent: switching one off leaves the other alone, which is the
      // whole point of the change.
      await expect(rows.nth(1)).toHaveAttribute('data-region-on', 'true');
    } finally {
      await browser.close();
    }
  });

  test('offers select all and deselect all', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      const rows = page.locator('[data-testid="knowledge-graph-region-row"]');
      const showAll = page.locator('[data-testid="knowledge-graph-regions-all"]');
      const showNone = page.locator('[data-testid="knowledge-graph-regions-none"]');

      // Nothing to restore yet, so All is inert rather than a no-op that looks live.
      await expect(showAll).toBeDisabled();

      await showNone.click();
      for (const row of await rows.all()) {
        await expect(row).toHaveAttribute('data-region-on', 'false');
      }
      await expect(showNone).toBeDisabled();

      await showAll.click();
      for (const row of await rows.all()) {
        await expect(row).toHaveAttribute('data-region-on', 'true');
      }
    } finally {
      await browser.close();
    }
  });

  test('says how many regions are showing', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      const panel = page.locator('[data-testid="knowledge-graph-controls"]');
      await expect(panel).toContainText('2 of 2 shown');
      await page.locator('[data-testid="knowledge-graph-region-row"]').nth(0).click();
      await expect(panel).toContainText('1 of 2 shown');
    } finally {
      await browser.close();
    }
  });

  test('a long region list gets a filter field, a short one does not', async () => {
    // A control that can only ever do nothing is not rendered - the rule the
    // dead facet rows and the Detail chips already follow. Measured across the
    // eight real project indexes, the seven small ones top out at eight regions
    // and the 646-conversation one starts at twenty-two, so the threshold sits
    // in the gap between them.
    const manyRegions = `(function () {
      var base = ${projectionLiteral(42)};
      var regions = [];
      for (var r = 0; r < 14; r++) {
        regions.push({ id: r, label: 'topic ' + r, x: 0.5, y: 0.5, z: 0.5, size: 3 });
      }
      base.clusterings = base.clusterings.map(function (entry) {
        return { granularity: entry.granularity, regions: regions };
      });
      base.nodes.forEach(function (node, i) {
        node.clusters = { coarse: i % 14, balanced: i % 14, fine: i % 14 };
      });
      return base;
    })()`;
    const { browser, page } = await launchWithState(snapshotScript({ projection: manyRegions }));
    try {
      await openKnowledgeGraph(page);
      const rows = page.locator('[data-testid="knowledge-graph-region-row"]');
      const field = page.locator('[data-testid="knowledge-graph-region-filter"]');
      await expect(rows).toHaveCount(14);
      await expect(field).toBeVisible();

      // Narrows the LIST. "topic 1" also prefixes 10 through 13.
      await field.fill('topic 1');
      await expect(rows).toHaveCount(5);
      await field.fill('topic 7');
      await expect(rows).toHaveCount(1);
      await expect(rows.nth(0)).toContainText('topic 7');

      // The map is untouched by the text box: every region is still shown, which
      // is what the count line above All and None keeps saying.
      await expect(page.locator('[data-testid="knowledge-graph-controls"]')).toContainText('14 of 14 shown');

      // An empty result says so rather than leaving a blank box.
      await field.fill('nothing matches this');
      await expect(rows).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-region-filter-empty"]')).toBeVisible();

      await page.locator('[data-testid="knowledge-graph-region-filter-clear"]').click();
      await expect(rows).toHaveCount(14);
    } finally {
      await browser.close();
    }
  });

  test('does not offer a region filter over a list short enough to read', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-region-row"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="knowledge-graph-region-filter"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('keeps a filter row that could only ever do nothing, each choice disabled with its reason', async () => {
    // One region means the region picker can only return everything, so the
    // Regions card goes. One status means the same of the status row, but the
    // filter rows never leave: a scope change must not move the panel, so the
    // row stays with every status disabled and saying why.
    const oneRegion = `(function () {
      var base = ${projectionLiteral(6)};
      base.clusterings = base.clusterings.map(function (entry) {
        return { granularity: entry.granularity, regions: [entry.regions[0]] };
      });
      base.nodes.forEach(function (node) {
        node.clusters = { coarse: 0, balanced: 0, fine: 0 };
        node.outcome = 'done';
      });
      return base;
    })()`;
    const { browser, page } = await launchWithState(snapshotScript({ projection: oneRegion }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-canvas"]')).toBeVisible();
      // One region means the panel can only ever show everything.
      await expect(page.locator('[data-testid="knowledge-graph-regions-toggle"]')).toHaveCount(0);

      await expect(page.locator('[data-testid="knowledge-graph-filter-outcome"]')).toBeVisible();
      await expect(page.locator('[data-testid="knowledge-graph-filter-outcome-any"]')).toBeEnabled();
      const done = page.locator('[data-testid="knowledge-graph-filter-outcome-done"]');
      await expect(done).toBeDisabled();
      await expect(done).toHaveAttribute('title', 'Every task on this map is done');
      const open = page.locator('[data-testid="knowledge-graph-filter-outcome-active"]');
      await expect(open).toBeDisabled();
      await expect(open).toHaveAttribute('title', 'No open tasks on this map');

      // Time stays live: the fixture's timestamps are years old, so the
      // windows still select different sets.
      await expect(page.locator('[data-testid="knowledge-graph-filter-since-30d"]')).toBeEnabled();
    } finally {
      await browser.close();
    }
  });

  test('keeps the time row when everything is recent, its windows disabled with the reason', async () => {
    // Every conversation inside the narrowest window means all four time
    // choices select the same set. The row stays, so the status row below it
    // does not jump up.
    const allRecent = `(function () {
      var base = ${projectionLiteral(6)};
      base.nodes.forEach(function (node) { node.lastActivityMs = Date.now() - 60 * 60 * 1000; });
      return base;
    })()`;
    const { browser, page } = await launchWithState(snapshotScript({ projection: allRecent }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-filter-since"]')).toBeVisible();
      await expect(page.locator('[data-testid="knowledge-graph-filter-since-any"]')).toBeEnabled();
      for (const timeWindow of ['30d', '90d']) {
        const option = page.locator(`[data-testid="knowledge-graph-filter-since-${timeWindow}"]`);
        await expect(option).toBeDisabled();
        await expect(option).toHaveAttribute('title', 'Nothing on this map is older than 30 days');
      }
    } finally {
      await browser.close();
    }
  });

  test('offers a detail control that recuts the map without a rebuild', async () => {
    // How finely to cut is a preference, not a measurement: every way of scoring
    // a clustering prefers the fewest regions on a cloud this continuous. All
    // three carve-ups ship with the projection, so switching is a lookup - the
    // test proves that by asserting the regions change with NO refresh request.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(12) }));
    try {
      await openKnowledgeGraph(page);
      const detail = page.locator('[data-testid="knowledge-graph-granularity"]');
      await expect(detail).toBeVisible();

      // Balanced by default: the fixture's balanced carve-up has two regions.
      const regionRows = page.locator('[data-testid="knowledge-graph-region-row"]');
      await expect(regionRows).toHaveCount(2);

      await detail.getByRole('radio', { name: 'Fine' }).click();
      await expect(regionRows).toHaveCount(3);

      // Coarse merges the fixture into ONE region, and the region list then
      // hides itself - the same rule every other filter follows, since a picker
      // that can only return everything is worse than no picker. The card stays,
      // because Detail lives in it: hiding it would strand the map at Coarse.
      await detail.getByRole('radio', { name: 'Coarse' }).click();
      await expect(page.locator('[data-testid="knowledge-graph-region-list"]')).toHaveCount(0);
      await expect(detail).toBeVisible();

      // No rebuild was asked for: the whole point of shipping all three.
      const refreshes = await page.evaluate(
        () => (window as unknown as { __mockRefreshGraphCalls?: unknown[] }).__mockRefreshGraphCalls?.length ?? 0,
      );
      expect(refreshes).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('hides the detail control when every setting is the same map', async () => {
    // How finely the map CAN be cut is bounded by the corpus, not by the
    // control. Below roughly 55 conversations every band clamps to the same
    // floor and all three settings resolve to one carve-up - four of the eight
    // real projects measured do exactly this. Offering three chips that repaint
    // the identical picture is the defect this surface already refuses
    // elsewhere: the dead facet rows hide the same way.
    const { browser, page } = await launchWithState(
      snapshotScript({ projection: projectionLiteral(12, { collapsed: true }) }),
    );
    try {
      await openKnowledgeGraph(page);
      // The regions themselves are still there and still switchable - it is the
      // DETAIL picker that has nothing to offer, not the map.
      await expect(page.locator('[data-testid="knowledge-graph-region-row"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="knowledge-graph-granularity"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a click on the map selects, and a small hand tremor does not undo it', async () => {
    // The reported bug: clicking a node made the detail panel flash open and
    // vanish. Selection was decided on pointerDOWN and then RE-PICKED on
    // pointerUP, so anything that moved the projection between the two - the
    // camera's own damping, or a chrome re-aim - meant the release missed the
    // node the press had hit, and the miss was read as "clicked empty space".
    // It presented as intermittent because it depended on whether the camera
    // happened to be settling.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(12) }));
    try {
      await openKnowledgeGraph(page);
      const title = page.locator('[data-testid="knowledge-graph-node-title"]').first();
      await expect(title).toBeVisible();
      const box = (await title.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;

      // Press, wobble a pixel, release. This is a click, not a drag.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 1, y + 1);
      await page.mouse.up();

      const detail = page.locator('[data-testid="knowledge-graph-detail"]');
      await expect(detail).toBeVisible();
      // It must still be there a moment later: the flash was an open followed by
      // an immediate close, which an assertion on the press alone would miss.
      await page.waitForTimeout(300);
      await expect(detail).toBeVisible();

      // And a real drag is camera work, so it must not change the selection.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 120, y + 90, { steps: 8 });
      await page.mouse.up();
      await expect(detail).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('names the conversations on the map, not just the regions', async () => {
    // The gap this closes: scoping the map - by search, by filter, or by
    // "Explore from here" - left the user looking at anonymous points while the
    // rail beside it knew every name.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(12) }));
    try {
      await openKnowledgeGraph(page);
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);
      // The text is the conversation's own title, not its region's.
      expect((await visibleNodeTitles(page))[0]).toContain('Conversation');
    } finally {
      await browser.close();
    }
  });

  test('never draws two titles on top of each other', async () => {
    // The property that keeps a busy map readable: nearest to camera wins and
    // anything that would overlap is dropped, so the worst case is fewer names
    // rather than an illegible pile of them. Region labels are seeded into the
    // same collision set, so a title cannot land on one of those either.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(60) }));
    try {
      await openKnowledgeGraph(page);
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);

      const overlaps = await page.evaluate(() => {
        const visible = Array.from(document.querySelectorAll('[data-testid="knowledge-graph-node-title"]'))
          .filter((element) => Number((element as HTMLElement).style.opacity || '0') > 0)
          .map((element) => element.getBoundingClientRect());
        let collisions = 0;
        for (let first = 0; first < visible.length; first += 1) {
          for (let second = first + 1; second < visible.length; second += 1) {
            const firstBox = visible[first];
            const secondBox = visible[second];
            if (
              firstBox.left < secondBox.right && firstBox.right > secondBox.left
              && firstBox.top < secondBox.bottom && firstBox.bottom > secondBox.top
            ) collisions += 1;
          }
        }
        return collisions;
      });
      expect(overlaps).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('draws every label inside the canvas, not off its edge', async () => {
    // The reported symptom: the labels down the right-hand side were cut in half
    // by the window edge. The fit frames node POSITIONS, and a title chip is
    // centred on its node and runs to ~220px, so a node framed flush against the
    // edge puts half its label past it - the thing you can read is the thing
    // that has to fit, not the point it names.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(60) }));
    try {
      await openKnowledgeGraph(page);
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);

      const escaping = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="knowledge-graph-canvas"]')!.getBoundingClientRect();
        const selector = '[data-testid="knowledge-graph-node-title"], [data-testid="knowledge-graph-cluster-label"]';
        return Array.from(document.querySelectorAll(selector))
          .filter((element) => Number((element as HTMLElement).style.opacity || '0') > 0)
          .map((element) => element.getBoundingClientRect())
          // One pixel of slack for sub-pixel rounding, which differs between
          // Windows and the Linux runner.
          .filter((box) => box.left < canvas.left - 1
            || box.right > canvas.right + 1
            || box.top < canvas.top - 1
            || box.bottom > canvas.bottom + 1)
          .length;
      });
      expect(escaping).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('shows one label per distinct title', async () => {
    // Several conversations can belong to one task and a node is named after its
    // task, so the same words legitimately land on several points. Truthful, and
    // it reads as a rendering bug, so the nearest one keeps the label.
    const sharedTitles = `(function () {
      var base = ${projectionLiteral(20)};
      base.nodes.forEach(function (node, i) { node.title = 'Shared ' + (i % 3); });
      return base;
    })()`;
    const { browser, page } = await launchWithState(snapshotScript({ projection: sharedTitles }));
    try {
      await openKnowledgeGraph(page);
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);

      const texts = await visibleNodeTitles(page);
      expect(texts.length).toBe(new Set(texts).size);
      // Three distinct titles across twenty nodes, so at most three labels.
      expect(texts.length).toBeLessThanOrEqual(3);
    } finally {
      await browser.close();
    }
  });

  test('titles are on by default and can be turned off', async () => {
    // On by default because they are the map's main source of context clues.
    // The control is an OFF switch for a map the user finds busy.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(12) }));
    try {
      await openKnowledgeGraph(page);
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);

      const toggle = page.locator('[data-testid="knowledge-graph-toggle-titles"]');
      await toggle.getByRole('radio', { name: 'Hidden' }).click();
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBe(0);

      await toggle.getByRole('radio', { name: 'Titles' }).click();
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  test('closes via the X and via Escape', async () => {
    const { browser, page } = await launchWithState(snapshotScript());
    try {
      await openKnowledgeGraph(page);
      await page.locator('[data-testid="knowledge-graph-close"]').click();
      await page.locator('[data-testid="knowledge-graph-page"]').waitFor({ state: 'hidden', timeout: 5000 });

      await openKnowledgeGraph(page);
      await page.keyboard.press('Escape');
      await page.locator('[data-testid="knowledge-graph-page"]').waitFor({ state: 'hidden', timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  /**
   * Found driving the preview: one Escape closed the focused conversation window
   * AND the graph under it. The graph unmounted the window mid-exit, so it stayed
   * in the store and came back on the next open. Escape closes the top thing only.
   */
  test('Escape closes a conversation over the map before the graph', async () => {
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openKnowledgeGraph(page);
      await page.locator('[data-testid="knowledge-graph-canvas"]').waitFor({ state: 'visible' });
      await openConversationFromChat(page);

      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid="conversation-window"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-page"]')).toBeVisible();

      await page.keyboard.press('Escape');
      await page.locator('[data-testid="knowledge-graph-page"]').waitFor({ state: 'hidden', timeout: 5000 });

      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="conversation-window"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  /**
   * The reported bug: "Open conversation" opened the transcript on the BOARD's
   * window layer at z-40, underneath this surface's z-42 overlay, so it looked
   * like the click did nothing.
   *
   * The assertion that actually catches a regression is ANCESTRY, not visibility:
   * a conversation window mounted on the board layer is perfectly "visible" to
   * Playwright while being completely hidden behind the graph on screen. So this
   * checks WHICH layer's portal host it landed in.
   */
  test('opens a conversation on the graph\'s own layer, not under the board', async () => {
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openKnowledgeGraph(page);
      await page.locator('[data-testid="knowledge-graph-canvas"]').waitFor({ state: 'visible' });
      await openConversationFromChat(page);

      // ANCESTRY, not visibility, is what catches this regression: a conversation
      // window mounted on the board layer is perfectly "visible" to Playwright
      // while being completely hidden behind the graph on screen.
      await expect(page.locator('#knowledge-graph-detail-layer-root [data-testid="conversation-window"]'))
        .toHaveCount(1);
      await expect(page.locator('#window-layer-root [data-testid="conversation-window"]'))
        .toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('"Open task" closes the graph and opens the task on the board', async () => {
    // A task detail lives on the board, so opening one BEHIND the graph's
    // overlay would be invisible. The graph closes first, then the board opens
    // the task. The fixture seeds a real taskId, so the button has a task.
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openKnowledgeGraph(page);
      await openConversationFromChat(page);
      await expect(page.locator('[data-testid="conversation-title"]')).toContainText('Conversation 0');
      // Copy is there too: it needs nothing from a layer.
      await expect(page.locator('[data-testid="conversation-copy-markdown-button"]')).toHaveCount(1);

      await page.locator('[data-testid="conversation-open-task-button"]').click();
      await expect(page.locator('[data-testid="knowledge-graph-page"]')).toHaveCount(0);
      await expect.poll(async () => page.evaluate(() => (window as unknown as {
        __zustandStores: { session: { getState: () => { detailTaskId: string | null } } };
      }).__zustandStores.session.getState().detailTaskId)).toBe('task-0');
    } finally {
      await browser.close();
    }
  });

  test('"Open task" reaches a finished task the board has not loaded yet', async () => {
    // Most of the graph is finished work, and the board holds only the newest
    // few finished tasks. task-0 is seeded as the OLDEST of twenty, outside that
    // preview, which is where "Open task" used to close the graph and open nothing.
    const archive = `window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      // An open project with a board, which the graph's snapshot names too.
      state.projects.push({
        id: 'project-1', name: 'Memory Project', path: '/mock/memory-project', github_url: null,
        default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      var doneLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (lane, position) {
        var id = 'lane-memory-' + position;
        if (lane.role === 'done') doneLaneId = id;
        state.swimlanes.push(Object.assign({}, lane, { id: id, position: position, created_at: ts }));
      });
      for (var i = 0; i < 20; i += 1) {
        state.archivedTasks.push({
          id: i === 19 ? 'task-0' : 'finished-' + i,
          display_id: 900 + i,
          title: i === 19 ? 'Conversation 0' : 'Finished ' + i,
          description: '', swimlane_id: doneLaneId, position: 0, agent: 'claude',
          session_id: null, worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
          base_branch: 'main', use_worktree: 0, labels: [], priority: 0, attachment_count: 0,
          archived_at: new Date(Date.now() - i * 60000).toISOString(),
          created_at: ts, updated_at: ts,
        });
      }
      return { currentProjectId: 'project-1' };
    });`;
    const { browser, page } = await launchWithState(`${conversationFixture()}${archive}`);
    try {
      await openKnowledgeGraph(page);
      await openConversationFromChat(page);
      await page.locator('[data-testid="conversation-open-task-button"]').click();

      await expect.poll(async () => page.evaluate(() => Object.values((window as unknown as {
        __zustandStores: { window: { getState: () => { windows: Record<string, { kind: string; anchor: string }> } } };
      }).__zustandStores.window.getState().windows).map((entry) => `${entry.kind}:${entry.anchor}`))).toContain('task-detail:task-0');
    } finally {
      await browser.close();
    }
  });

  test('re-opening the same conversation focuses it instead of stacking a copy', async () => {
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openKnowledgeGraph(page);
      await openConversationFromChat(page);
      // Dispatched rather than clicked: the open window may sit over the row,
      // and what is under test is the open, not the hit test.
      await page.locator('[data-testid="knowledge-graph-chat-row"]').first().dispatchEvent('click');
      await expect(page.locator('[data-testid="conversation-window"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('is spatial-only: no view toggle to get lost in', async () => {
    // The flat view and its 2D/3D switch are gone. Pinned because the toggle's
    // absence is a product decision, not an oversight - a stray reintroduction
    // would also mean a second layout to keep in step.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-canvas"]'))
        .toHaveAttribute('data-view-mode', '3d');
      await expect(page.locator('[data-testid="knowledge-graph-view-2d"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-view-3d"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('prints the camera controls as a key legend', async () => {
    // Nothing else in the app is navigated by flying, so none of these gestures
    // transfer from the rest of the UI. Every input is PRINTED, one labelled
    // click away rather than on the map at every open - what each one does
    // arrives on hover, since the keys are the part you cannot deduce and the
    // verbs are the part you only read once.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(12) }));
    try {
      await openKnowledgeGraph(page);
      const legend = page.locator('[data-testid="knowledge-graph-camera-hint"]');
      await expect(legend).toHaveCount(0);
      const toggle = page.locator('[data-testid="knowledge-graph-camera-toggle"]');
      await expect(toggle).toHaveText('Controls');
      await toggle.click();
      await expect(legend).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      // Keys as keys, not as prose: the shape a game uses, because that is what
      // this is. `kbd` carries the meaning; the styling only makes it look
      // pressable.
      for (const key of ['W', 'A', 'S', 'D', 'Q', 'E', 'Drag', 'Right Drag', 'Scroll']) {
        await expect(legend.locator('kbd', { hasText: new RegExp(`^${key}$`) }).first()).toBeVisible();
      }
      const cap = (key: string) => legend.locator('kbd', { hasText: new RegExp(`^${key}$`) }).first().boundingBox();

      // Nothing said until asked, then the verb in a tooltip over the key that
      // does it. The tooltip is PORTALED to the body, so it is looked up on the
      // page rather than inside the legend - which is the whole point: an
      // in-flow chip was clipped by the canvas wrapper's `overflow-hidden`.
      const tip = page.locator('[data-testid="knowledge-graph-camera-tip"]');

      const bindings = [
        { id: 'move', label: 'Fly Forward and Sideways' },
        { id: 'up-and-down', label: 'Fly Up and Down' },
        { id: 'orbit', label: 'Orbit the Map' },
        { id: 'pan', label: 'Pan the View' },
        { id: 'zoom', label: 'Zoom In and Out' },
      ];

      await expect(tip).toHaveCount(0);
      for (const { id, label } of bindings) {
        await legend.locator(`[data-binding="${id}"]`).hover({ timeout: 4000 });
        await expect(tip).toHaveText(label, { timeout: 3000 });

        // The reported bug: a tip centred over a control near the left edge was
        // cut in half by the canvas wrapper. It must sit inside the viewport on
        // every side, whichever control it belongs to.
        const box = (await tip.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      }

      // The keys never move when a tooltip opens: it is portaled out of the
      // legend entirely, so reading one binding cannot shift the next.
      const beforeHover = await cap('Scroll');
      await legend.locator('[data-binding="move"]').hover();
      const afterHover = await cap('Scroll');
      expect(afterHover!.x).toBeCloseTo(beforeHover!.x, 0);
      expect(afterHover!.y).toBeCloseTo(beforeHover!.y, 0);

      // Every mapping is readable without a pointer at all, or it does not
      // exist for anyone who cannot hover.
      const spoken = (await legend.textContent()) ?? '';
      for (const { label } of bindings) expect(spoken).toContain(label);

      // The legend must not name a gesture the app does not have. `Shift + Drag`
      // was advertised for a release and did NOTHING: camera-controls binds
      // actions to left / middle / right / wheel and has no shift-modified
      // button, so panning has always been the right button.
      await expect(legend.locator('kbd', { hasText: /Shift/ })).toHaveCount(0);

      // W sits ABOVE and between A and D: the physical arrangement, which is a
      // picture of where the hand goes rather than a list of four letters.
      const [wKey, aKey, sKey, dKey] = await Promise.all([cap('W'), cap('A'), cap('S'), cap('D')]);
      expect(wKey!.y + wKey!.height).toBeLessThanOrEqual(aKey!.y + 1);
      expect(aKey!.x).toBeLessThan(sKey!.x);
      expect(sKey!.x).toBeLessThan(dKey!.x);
      const wCentre = wKey!.x + wKey!.width / 2;
      expect(wCentre).toBeGreaterThan(aKey!.x);
      expect(wCentre).toBeLessThan(dKey!.x + dKey!.width);

      // Grouped by what you touch. Q and E are keyboard keys, so they belong
      // beside WASD and not next to Scroll - and the two DRAG gestures, which
      // differ only by a modifier, sit adjacent rather than diagonally apart.
      const [qKey, drag, rightDrag, scroll] = await Promise.all([
        cap('Q'), cap('Drag'), cap('Right Drag'), cap('Scroll'),
      ]);
      expect(Math.abs(qKey!.x - dKey!.x)).toBeLessThan(Math.abs(qKey!.x - scroll!.x));
      expect(drag!.x).toBeLessThan(rightDrag!.x);
      expect(rightDrag!.x).toBeLessThan(scroll!.x);

      // One toolbar at the bottom centre of the map, where no rail reaches, with
      // the legend opening above it, over the map.
      const canvas = (await page.locator('[data-testid="knowledge-graph-canvas"]').boundingBox())!;
      const toolbar = (await page.locator('[data-testid="knowledge-graph-camera-controls"]').boundingBox())!;
      const legendBox = (await legend.boundingBox())!;
      const toolbarCentre = toolbar.x + toolbar.width / 2;
      expect(Math.abs(toolbarCentre - (canvas.x + canvas.width / 2))).toBeLessThan(canvas.width * 0.05);
      expect(toolbar.y).toBeGreaterThan(canvas.y + canvas.height / 2);
      expect(legendBox.y + legendBox.height).toBeLessThanOrEqual(toolbar.y);

      // Escape closes the legend first and leaves the graph open.
      await page.keyboard.press('Escape');
      await expect(legend).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-page"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  /**
   * Rebuild the open map the way main does after a pass: every later snapshot
   * read answers with `change` applied to the projection, then a completion
   * push makes the store read it. The signature moves, as a rebuilt map's does.
   *
   * `keepNodes` truncates to the first N conversations (and the links and
   * neighbour lists that pointed past them). `renameTo` retitles every
   * conversation while leaving its position, so the same node index now
   * carries different words.
   */
  async function rebuildMap(page: Page, change: { keepNodes?: number; renameTo?: string }): Promise<void> {
    await page.evaluate((requested) => {
      type Neighbor = { index: number; similarity: number };
      type Projection = {
        signature: string;
        nodes: Array<{ title?: string | null }>;
        edges: Array<{ source: number; target: number }>;
        nodeNeighbors: Neighbor[][];
      };
      type Snapshot = { projection: Projection | null };
      const holder = window as unknown as {
        electronAPI: { knowledgeGraph: { graphSnapshot: () => Promise<Snapshot | null> } };
        __mockFireGraphChanged: (projectId: string) => void;
      };
      const api = holder.electronAPI.knowledgeGraph;
      const previous = api.graphSnapshot.bind(api);
      api.graphSnapshot = async () => {
        const snapshot = await previous();
        if (!snapshot || !snapshot.projection) return snapshot;
        const projection = snapshot.projection;
        const keep = requested.keepNodes ?? projection.nodes.length;
        const rebuilt: Projection = {
          ...projection,
          signature: 'sig-rebuilt',
          nodes: projection.nodes.slice(0, keep).map((node, index) => (
            requested.renameTo ? { ...node, title: `${requested.renameTo} ${index}` } : node
          )),
          edges: projection.edges.filter((edge) => edge.source < keep && edge.target < keep),
          nodeNeighbors: projection.nodeNeighbors.slice(0, keep).map((list) => list.filter((neighbor) => neighbor.index < keep)),
        };
        return { ...snapshot, projection: rebuilt };
      };
      holder.__mockFireGraphChanged('project-1');
    }, change);
  }

  /**
   * Rebuild the open map so its conversations sit at different positions, the
   * way a re-cluster or a scope change reorders them, then push it.
   *
   * `reverse` lists the conversations back to front, with the links and the
   * neighbour lists remapped so each still joins the same two conversations, and
   * retitles "Conversation k" as "Rebuilt k". The number stays with the
   * conversation and the word changes, so a panel still reading "Conversation k"
   * has not seen the rebuild yet, and one reading "Rebuilt j" for a j that is not
   * the conversation it was showing has followed the position instead of the
   * conversation. With an even node count no position maps to itself.
   *
   * `replaceDocKey` swaps that conversation for a newcomer, titled
   * "Replacement", at the same position.
   */
  async function reshapeMap(page: Page, change: { reverse?: boolean; replaceDocKey?: string }): Promise<void> {
    await page.evaluate((requested) => {
      type Neighbor = { index: number; similarity: number };
      type MapNode = { docKey: string; title?: string | null };
      type Projection = {
        signature: string;
        nodes: MapNode[];
        edges: Array<{ source: number; target: number }>;
        nodeNeighbors: Neighbor[][];
      };
      type Snapshot = { projection: Projection | null };
      const holder = window as unknown as {
        electronAPI: { knowledgeGraph: { graphSnapshot: () => Promise<Snapshot | null> } };
        __mockFireGraphChanged: (projectId: string) => void;
      };
      const api = holder.electronAPI.knowledgeGraph;
      const previous = api.graphSnapshot.bind(api);
      api.graphSnapshot = async () => {
        const snapshot = await previous();
        if (!snapshot || !snapshot.projection) return snapshot;
        const projection = snapshot.projection;
        const count = projection.nodes.length;
        const positionOf = (index: number): number => (requested.reverse ? count - 1 - index : index);
        const nodes: MapNode[] = new Array(count);
        const nodeNeighbors: Neighbor[][] = new Array(count);
        projection.nodes.forEach((node, index) => {
          nodes[positionOf(index)] = requested.replaceDocKey === node.docKey
            ? { ...node, docKey: 'conversation::doc-replacement', title: 'Replacement' }
            : requested.reverse
              ? { ...node, title: (node.title ?? '').replace('Conversation', 'Rebuilt') }
              : node;
        });
        projection.nodeNeighbors.forEach((list, index) => {
          nodeNeighbors[positionOf(index)] = list.map((entry) => ({ ...entry, index: positionOf(entry.index) }));
        });
        return {
          ...snapshot,
          projection: {
            ...projection,
            signature: 'sig-reshaped',
            nodes,
            edges: projection.edges.map((edge) => ({ ...edge, source: positionOf(edge.source), target: positionOf(edge.target) })),
            nodeNeighbors,
          },
        };
      };
      holder.__mockFireGraphChanged('project-1');
    }, change);
  }

  test('keeps showing the same conversation, and the way back to the one before, when a rebuild reorders the map', async () => {
    // The selection and the trail of followed neighbours are positions in the
    // map's node list. A rebuild re-clusters and reorders it, so carried by
    // position the panel showed another conversation under the same selection.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openKnowledgeGraph(page);
      const start = await selectVisibleNode(page);
      const hopped = (start + 1) % 30;
      const title = page.locator('[data-testid="knowledge-graph-detail-title"]');
      // The fixture makes a node's nearest neighbour the next one. Following it
      // puts the conversation it came from on the trail.
      await page.locator('[data-testid="knowledge-graph-neighbor"]').first().click();
      await expect(title).toHaveText(`Conversation ${hopped}`);

      await reshapeMap(page, { reverse: true });

      // The same conversation, in the rebuilt map's words.
      await expect(title).toHaveText(`Rebuilt ${hopped}`);
      // And Back still names the conversation the trail came from, and goes there.
      const back = page.locator('[data-testid="knowledge-graph-detail-back"]');
      await expect(back).toContainText(new RegExp(`Rebuilt ${start}\\b`));
      await back.click();
      await expect(title).toHaveText(`Rebuilt ${start}`);
    } finally {
      await browser.close();
    }
  });

  test('keeps exploring the same neighbourhood when a rebuild reorders the map', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openKnowledgeGraph(page);
      const index = await selectVisibleNode(page);
      await page.locator('[data-testid="knowledge-graph-explore-from"]').click();
      const chip = page.locator('[data-testid="knowledge-graph-explore-chip"]');
      await expect(chip).toContainText(new RegExp(`Conversation ${index}\\b`));

      await reshapeMap(page, { reverse: true });

      // Still around the conversation the reader chose, whatever position it took.
      await expect(chip).toContainText(new RegExp(`Rebuilt ${index}\\b`));
    } finally {
      await browser.close();
    }
  });

  test('drops the selection when its conversation has left the map', async () => {
    // The map is rebuilt without the selected conversation, and another one
    // takes its position. Carried by position, the panel went on showing that
    // other conversation as if it were the one the reader had chosen.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openKnowledgeGraph(page);
      const index = await selectVisibleNode(page);
      const detail = page.locator('[data-testid="knowledge-graph-detail"]');
      await expect(detail).toBeVisible();

      await reshapeMap(page, { replaceDocKey: `conversation::doc-${index}` });

      await expect(detail).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-page"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a smaller map swapped in under a resting cursor leaves the graph standing', async () => {
    // The hover card indexed the projection by the hovered node's INDEX. A
    // rebuild (or a scope change) can swap in a smaller map while the pointer
    // rests, so that index then names no node: the card threw while rendering
    // and unmounted the whole graph.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
      await openKnowledgeGraph(page);
      const canvas = page.locator('[data-testid="knowledge-graph-canvas"]');
      const card = page.locator('[data-testid="knowledge-graph-hover-card"]');
      await expect(canvas).toHaveAttribute('data-drawn-count', '30');

      // Rest the cursor on a drawn title whose conversation sits past index 1, so
      // a map cut to that many conversations no longer holds it. Aimed at the
      // title's start, where its node is, and clear of the floating panels.
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);
      const point = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('[data-testid="knowledge-graph-node-title"]'))
          .map((element) => ({ element: element as HTMLElement, rect: element.getBoundingClientRect() }))
          .filter(({ element }) => Number(element.style.opacity || '0') > 0)
          .map(({ element, rect }) => ({
            index: Number(/Conversation (\d+)/.exec(element.textContent ?? '')?.[1] ?? -1),
            x: rect.left + Math.min(12, rect.width / 2),
            y: rect.top + rect.height / 2,
          }))
          .filter((candidate) => candidate.index >= 2 && candidate.x > 280 && candidate.x < window.innerWidth - 440 && candidate.y > 60);
        // The highest index, so a hit that lands on a neighbouring node (font
        // metrics move a title's left edge) is still well past index 1.
        candidates.sort((left, right) => right.index - left.index);
        return candidates[0] ?? null;
      });
      if (!point) throw new Error('no drawn conversation past index 1, clear of the panels');
      await page.mouse.move(point.x, point.y);
      await expect(card).toBeVisible();
      // Which node the pointer resolved to is read back, not assumed: the map's
      // own hit test decides whether the node or its title was under it.
      const hoveredIndex = Number(/Conversation (\d+)/.exec(await card.innerText())?.[1] ?? -1);
      expect(hoveredIndex).toBeGreaterThanOrEqual(2);

      // Cut the map to hoveredIndex conversations: indices 0..hoveredIndex-1, so
      // the hovered index is now one past the end. The mouse does not move again.
      await rebuildMap(page, { keepNodes: hoveredIndex });
      await expect(canvas).toHaveAttribute('data-drawn-count', String(hoveredIndex));

      await expect(page.locator('[data-testid="knowledge-graph-page"]')).toBeVisible();
      await expect(canvas).toBeVisible();
      // No card for a node the map no longer holds. The error boundary catches a
      // render throw, so the canvas staying mounted above is the guard; this
      // only adds an uncaught error, should one ever escape it.
      await expect(card).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('a rebuilt map retitles the chips when the same node index carries new words', async () => {
    // The title chips are a pool, reassigned every frame. They rewrote their
    // text only when the NODE INDEX assigned to a chip changed, so a rebuilt map
    // that put a different title at the same index kept the old map's words on
    // the chip until the camera moved that node out of the pool.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openKnowledgeGraph(page);
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);
      expect((await visibleNodeTitles(page)).every((title) => /^Conversation \d+$/.test(title))).toBe(true);

      await rebuildMap(page, { renameTo: 'Renamed' });

      // Every chip on screen carries the rebuilt map's words, none the old.
      await expect.poll(async () => {
        const titles = await visibleNodeTitles(page);
        return titles.length > 0 && titles.every((title) => /^Renamed \d+$/.test(title));
      }).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('reset view frames the regions still on the map, not the ones filtered out', async () => {
    // A facet exclusion re-scopes what the map IS, so the map's canonical
    // framing has to move with it. Framing every node the projection holds put
    // the surviving regions in a corner: measured on the real 648-conversation
    // corpus with 9 of 39 regions on, the visible 177 filled 0.57 of the safe
    // area's height against the 0.88 an unfiltered map gets. Reset view was
    // therefore the one control that pulled the view further OUT after a filter.
    //
    // Two well-separated blocks, because the fixture's own regions are
    // contiguous slices of a 20-column grid that sit side by side, so hiding
    // one there barely moves the extent and the assertion could hardly fail.
    const separated = `(function () {
      var base = ${projectionLiteral(40)};
      base.nodes.forEach(function (node, i) {
        var far = i >= 20;
        node.clusters = { coarse: 0, balanced: far ? 1 : 0, fine: far ? 1 : 0 };
        node.x = (far ? 0.55 : 0.12) + (i % 5) * 0.06;
        node.y = (far ? 0.55 : 0.12) + (Math.floor(i / 5) % 4) * 0.06;
        node.z = (far ? 0.55 : 0.12) + (i % 4) * 0.06;
      });
      return base;
    })()`;
    const { browser, page } = await launchWithState(snapshotScript({ projection: separated }));
    try {
      await openKnowledgeGraph(page);
      // The titles are the only thing in the DOM that carries where the camera
      // put the map: they are positioned by projecting each node through it on
      // every rendered frame.
      const titleExtent = async () => page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('[data-testid="knowledge-graph-node-title"]'))
          .filter((element) => Number((element as HTMLElement).style.opacity || '0') > 0)
          .map((element) => element.getBoundingClientRect());
        if (boxes.length === 0) return { width: 0, height: 0, count: 0 };
        return {
          width: Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left)),
          height: Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.top)),
          count: boxes.length,
        };
      });

      await expect.poll(async () => (await titleExtent()).count).toBeGreaterThan(0);
      const whole = await titleExtent();

      // Hide the far block, then ask for the default view back.
      await page.locator('[data-testid="knowledge-graph-region-row"]').nth(1).click();
      await page.locator('[data-testid="knowledge-graph-reset-view"]').click();

      // Polled rather than waited out: Reset view is an animated fly, so this
      // retries until the camera settles instead of guessing how long it takes.
      // Measured on this fixture: 632 x 560 across 19 titles with the fit scoped
      // to the visible region, against 230 x 136 across 6 when it framed all
      // forty nodes - so 0.85 of the unfiltered extent sits far from both.
      await expect.poll(
        async () => (await titleExtent()).height / whole.height,
        { timeout: 10_000 },
      ).toBeGreaterThan(0.85);
      const scoped = await titleExtent();
      expect(scoped.width).toBeGreaterThan(whole.width * 0.85);
      // An independent signal on the same framing: nodes pushed into the
      // distance lose their titles to the label distance cap, so a map framed
      // for regions that are no longer drawn also draws fewer names. Held to a
      // looser ratio than the extents on purpose - how many titles survive
      // collision culling depends on the label width estimate against real font
      // metrics, which differ on the headless Linux runner. Measured here: 19
      // against the whole map's 15 with the fit scoped, 6 without it.
      expect(scoped.count).toBeGreaterThan(whole.count * 0.6);
    } finally {
      await browser.close();
    }
  });

  test('the camera toolbar holds its place when the chat opens', async () => {
    // Reported: centred on the pane between the rails, it slid sideways every
    // time the chat opened. It holds the surface's centre instead.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('#103 fixed it.', [chatRow(3)])}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openKnowledgeGraph(page);
      const toolbar = page.locator('[data-testid="knowledge-graph-camera-controls"]');
      const before = (await toolbar.boundingBox())!;
      await askInBox(page, 'what fixed the relay?');
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).toBeVisible();
      // Past the panel's own slide-in, which is when the rails are re-measured.
      // Not its subtree: the chat's loading shimmer loops forever. And by play
      // state, since a forwards-filled animation stays listed once it ends.
      await page.waitForFunction(() => {
        const panel = document.querySelector('[data-graph-chrome="right"]');
        return panel !== null && panel.getAnimations().every((animation) => animation.playState === 'finished');
      });
      const after = (await toolbar.boundingBox())!;
      expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    } finally {
      await browser.close();
    }
  });

  test('the camera toolbar stays clear of both panels at the smallest window', async () => {
    // At the 900x600 floor with the chat open, the gap between the rails is
    // about 200px. The toolbar compacts (Controls becomes an icon that keeps its
    // name) so it fits there, rather than sliding under the chat and taking
    // Reset view with it.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      ${answeredScript('#103 fixed it.', [chatRow(3)])}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await page.setViewportSize({ width: 900, height: 600 });
      await openKnowledgeGraph(page);
      await askInBox(page, 'what fixed the relay?');
      await expect(page.locator('[data-testid="knowledge-graph-chat"]')).toBeVisible();
      await page.waitForFunction(() => {
        const panel = document.querySelector('[data-graph-chrome="right"]');
        return panel !== null && panel.getAnimations().every((animation) => animation.playState === 'finished');
      });
      const toolbar = (await page.locator('[data-testid="knowledge-graph-camera-controls"]').boundingBox())!;
      const chat = (await page.locator('[data-graph-chrome="right"]').boundingBox())!;
      const rail = (await page.locator('[data-graph-chrome="left"]').boundingBox())!;
      expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(chat.x);
      expect(toolbar.x).toBeGreaterThanOrEqual(rail.x + rail.width);
      await expect(page.locator('[data-testid="knowledge-graph-camera-toggle"]')).toHaveAccessibleName('Controls');
    } finally {
      await browser.close();
    }
  });

  test('offers a reset back to the default view', async () => {
    // A camera with orbit, tilt, pan and zoom can end up somewhere with nothing
    // recognisable on screen, so the way back must always be on screen too -
    // never hover-only.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openKnowledgeGraph(page);
      const canvas = page.locator('[data-testid="knowledge-graph-canvas"]');
      const reset = page.locator('[data-testid="knowledge-graph-reset-view"]');
      await expect(reset).toBeVisible();

      // Scope note: what the camera DOES on reset is not assertable here (it is
      // GPU state, and this tier runs headless). What is assertable, and what
      // actually regresses, is that the control is always on screen rather than
      // hover-revealed, and that pressing it neither throws nor tears the
      // surface down.
      await canvas.hover();
      await page.mouse.wheel(0, -300);
      await reset.click();
      await expect(reset).toBeVisible();
      await expect(page.locator('[data-testid="knowledge-graph-body"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('lists closest conversations without a similarity percentage', async () => {
    // Every row used to read "99% similar", which is the corpus rather than a
    // rounding accident: anisotropy puts >98% of top-10 pairs above 0.8 cosine,
    // so a percentage cannot resolve them and six identical numbers looked like
    // precision while saying nothing. The ORDER carries the signal; the raw value
    // stays on the row's title for anyone who wants it.
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openKnowledgeGraph(page);
      await selectVisibleNode(page);

      const neighbor = page.locator('[data-testid="knowledge-graph-neighbor"]').first();
      await expect(neighbor).toBeVisible();
      await expect(neighbor).not.toContainText('%');
      await expect(neighbor).toHaveAttribute('title', /Cosine similarity 0\.\d+/);
      // The section carries no subtitle. It used to read "Strongest first.
      // Exact, not read off the map.", which defended an implementation detail
      // the reader never asked about.
      await expect(page.locator('[data-testid="knowledge-graph-detail"]')).not.toContainText('Strongest first');
      await expect(page.locator('[data-testid="knowledge-graph-detail"]')).not.toContainText('read off the map');
      // Every one of the node's nearest conversations, not just those that
      // survived the mesh quantile - the fixture gives each node three.
      await expect(page.locator('[data-testid="knowledge-graph-neighbor"]')).toHaveCount(3);
    } finally {
      await browser.close();
    }
  });

  test('explores a neighbourhood and offers a way back', async () => {
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openKnowledgeGraph(page);
      const index = await selectVisibleNode(page);

      // Every fixture node has neighbours, so the action is enabled.
      const explore = page.locator('[data-testid="knowledge-graph-explore-from"]');
      await expect(explore).toBeEnabled();
      await explore.click();

      // The breadcrumb is what makes the narrowing explainable AND undoable.
      const chip = page.locator('[data-testid="knowledge-graph-explore-chip"]');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText(new RegExp(`Conversation ${index}\\b`));

      await page.locator('[data-testid="knowledge-graph-explore-clear"]').click();
      await expect(chip).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('goes back to the chat after selecting a conversation', async () => {
    // Selecting a conversation replaces the chat with the detail panel, so the
    // panel has to lead back to what you had just asked.
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openKnowledgeGraph(page);
      await page.locator('[data-testid="knowledge-graph-search-input"]').fill('what was conversation 0?');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(1);
      await selectVisibleNode(page);

      const back = page.locator('[data-testid="knowledge-graph-detail-back"]');
      await expect(back).toContainText('the chat');
      await back.click();

      // The chat is showing again, as it was, and the detail is gone.
      await expect(page.locator('[data-testid="knowledge-graph-chat-row"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="knowledge-graph-detail"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('goes back along a trail of followed neighbours', async () => {
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openKnowledgeGraph(page);
      const index = await selectVisibleNode(page);
      const title = page.locator('[data-testid="knowledge-graph-detail-title"]');

      // Hop to the node's nearest neighbour, which the fixture makes the next one.
      await page.locator('[data-testid="knowledge-graph-neighbor"]').first().click();
      await expect(title).toHaveText(`Conversation ${(index + 1) % 30}`);

      // Back NAMES where it returns to, rather than being a bare arrow.
      const back = page.locator('[data-testid="knowledge-graph-detail-back"]');
      await expect(back).toContainText(new RegExp(`Conversation ${index}\\b`));
      await back.click();
      await expect(title).toHaveText(`Conversation ${index}`);
    } finally {
      await browser.close();
    }
  });

  test('Back retraces one hop per click along a two-hop trail', async () => {
    // Each hop goes onto the trail once. A hop pushed twice (a state updater
    // that sets other state runs twice under StrictMode, which the dev renderer
    // mounts) needs two Back clicks per hop: the first shows the same
    // conversation again, and the second is the one that moves.
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openKnowledgeGraph(page);
      const start = await selectVisibleNode(page);
      const named = (hops: number) => `Conversation ${(start + hops) % 30}`;
      const title = page.locator('[data-testid="knowledge-graph-detail-title"]');
      const back = page.locator('[data-testid="knowledge-graph-detail-back"]');
      const nearest = page.locator('[data-testid="knowledge-graph-neighbor"]').first();

      // The fixture makes a node's nearest neighbour the next one, twice over.
      await nearest.click();
      await expect(title).toHaveText(named(1));
      await nearest.click();
      await expect(title).toHaveText(named(2));

      // Back names the conversation it returns to, and one click returns to it.
      await expect(back).toContainText(new RegExp(`${named(1)}\\b`));
      await back.click();
      await expect(title).toHaveText(named(1));

      // The second click reaches the first conversation, not the same one again.
      await expect(back).toContainText(new RegExp(`${named(0)}\\b`));
      await back.click();
      await expect(title).toHaveText(named(0));

      // The trail is spent: with no chat open there is nothing left to go back to.
      await expect(back).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('the index section is collapsed by default and opens on demand', async () => {
    // One left panel, four cards: Filter, Regions and Display are what you
    // touch, Index is reference. It used to be a second floating slab pinned to
    // the bottom of the left edge with a screen-height void between them.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      const panel = page.locator('[data-testid="knowledge-graph-controls"]');
      await expect(panel).toContainText('Display');
      await expect(panel).toContainText('Index');
      // Reference numbers, so the section rests collapsed. The full-width
      // coverage strip is NOT what opens here - that shape is for the states
      // with no map to draw; this panel renders its own aligned row list.
      const indexPanel = page.locator('[data-testid="knowledge-graph-index-panel"]');
      await expect(indexPanel).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-coverage-strip"]')).toHaveCount(0);

      await page.locator('[data-testid="knowledge-graph-index-toggle"]').click();
      await expect(indexPanel).toContainText('Size on disk');
      await expect(indexPanel).toContainText('Links');
      await expect(page.locator('[data-testid="knowledge-graph-coverage-strip"]')).toHaveCount(0);

      // It opens to the SIDE, and that is not cosmetic: Index is the last thing
      // in a column whose middle is a list of every region the index holds, so
      // downward there is nothing left and its rows ran off the bottom of the
      // window. Asserted as geometry because that IS the bug - the rows are in
      // the DOM either way.
      const panelBox = (await panel.boundingBox())!;
      const indexBox = (await page.locator('[data-testid="knowledge-graph-index-panel"]').boundingBox())!;
      expect(indexBox.x).toBeGreaterThanOrEqual(panelBox.x + panelBox.width - 2);
      expect(indexBox.y + indexBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    } finally {
      await browser.close();
    }
  });

  test('Escape closes the Index flyout and leaves the graph open', async () => {
    // The flyout is the top thing, so Escape closes it and stops there, as the
    // Projects picker and the camera legend do. Without its own Escape the key
    // fell through to the page and closed the whole graph under the flyout.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openKnowledgeGraph(page);
      const indexPanel = page.locator('[data-testid="knowledge-graph-index-panel"]');
      const indexToggle = page.locator('[data-testid="knowledge-graph-index-toggle"]');
      await indexToggle.click();
      await expect(indexPanel).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(indexPanel).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-page"]')).toBeVisible();

      // With the flyout gone the next Escape is the graph's own, so the flyout's
      // listener does not outlive it.
      await page.keyboard.press('Escape');
      await page.locator('[data-testid="knowledge-graph-page"]').waitFor({ state: 'hidden', timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a long region list scrolls inside its card, and the panel fits with Index at the bottom', async () => {
    // The panel never scrolls while it fits: the Regions card gives way and its
    // list is the one scroller, so Display and Index stay in view below it.
    const manyRegions = `(function () {
      var base = ${projectionLiteral(42)};
      var regions = [];
      for (var r = 0; r < 14; r++) {
        regions.push({ id: r, label: 'topic ' + r, x: 0.5, y: 0.5, z: 0.5, size: 3 });
      }
      base.clusterings = base.clusterings.map(function (entry) {
        return { granularity: entry.granularity, regions: regions };
      });
      base.nodes.forEach(function (node, i) {
        node.clusters = { coarse: i % 14, balanced: i % 14, fine: i % 14 };
      });
      return base;
    })()`;
    const { browser, page } = await launchWithState(snapshotScript({ projection: manyRegions }));
    try {
      // Tall enough for every card, too short for all fourteen rows.
      await page.setViewportSize({ width: 1280, height: 860 });
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-region-row"]')).toHaveCount(14);
      const layout = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="knowledge-graph-controls"]') as HTMLElement;
        const list = document.querySelector('[data-testid="knowledge-graph-region-list"]') as HTMLElement;
        const toggle = document.querySelector('[data-testid="knowledge-graph-index-toggle"]') as HTMLElement;
        const panelBox = panel.getBoundingClientRect();
        const toggleBox = toggle.getBoundingClientRect();
        return {
          panelOverflow: panel.scrollHeight - panel.clientHeight,
          listOverflow: list.scrollHeight - list.clientHeight,
          listHeight: list.clientHeight,
          toggleInside: toggleBox.top >= panelBox.top && toggleBox.bottom <= panelBox.bottom + 1,
        };
      });
      expect(layout.panelOverflow).toBeLessThanOrEqual(1);
      expect(layout.listOverflow).toBeGreaterThan(0);
      // About three rows at the least, so the list is still a list.
      expect(layout.listHeight).toBeGreaterThanOrEqual(60);
      expect(layout.toggleInside).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('the panel scrolls at the smallest window, and Index still opens in full', async () => {
    // At 900x600 even Filter, Display and Index are taller than the space the
    // panel has, so this is the one size where the panel scrolls. The Index
    // flyout renders outside it so the scrolling box cannot clip it.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await page.setViewportSize({ width: 900, height: 600 });
      await openKnowledgeGraph(page);
      const panel = page.locator('[data-testid="knowledge-graph-controls"]');
      const scrolls = await panel.evaluate((element) => element.scrollHeight > element.clientHeight);
      expect(scrolls).toBe(true);
      const surface = (await page.locator('[data-testid="knowledge-graph-body"]').boundingBox())!;
      const panelBox = (await panel.boundingBox())!;
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(surface.y + surface.height + 1);

      const toggle = page.locator('[data-testid="knowledge-graph-index-toggle"]');
      await toggle.scrollIntoViewIfNeeded();
      await toggle.click();
      const indexBox = (await page.locator('[data-testid="knowledge-graph-index-panel"]').boundingBox())!;
      expect(indexBox.y).toBeGreaterThanOrEqual(0);
      expect(indexBox.y + indexBox.height).toBeLessThanOrEqual(600);
    } finally {
      await browser.close();
    }
  });

  /**
   * The Projects filter: which projects the map shows and a question spans.
   *
   * Three projects: the open one, a second indexed one with conversations and
   * tickets of its own, and one with nothing indexed, which the picker lists
   * but cannot select.
   */
  function projectsScript(options: { otherBuilding?: boolean } = {}): string {
    const other = options.otherBuilding ? 'null' : projectionLiteral(10)
      .replace("docKey: 'conversation::doc-' + i", "docKey: 'conversation::m-' + i")
      .replace("title: 'Conversation ' + i", "title: 'Mobile ' + i")
      .replace("sessionId: 'session-' + i", "sessionId: 'm-session-' + i")
      .replace("taskId: 'task-' + i", "taskId: 'm-task-' + i")
      .replace("signature: 'sig-1'", "signature: 'sig-m'");
    return `${snapshotScript({ projection: projectionLiteral(20) })}
      window.__mockPreConfigure(function () {
        return {
          knowledgeGraphProjects: [
            { id: 'project-1', name: 'Kangentic', conversations: 20, taskRecords: 30, lastActivityMs: 1700000100000 },
            { id: 'project-2', name: 'Mobile App', conversations: 10, taskRecords: 12, lastActivityMs: 1700000050000 },
            { id: 'project-3', name: 'Website', conversations: 0, taskRecords: 0, lastActivityMs: null },
          ],
          knowledgeGraphSnapshotsByProject: {
            'project-2': {
              projectId: 'project-2',
              projection: ${other},
              building: ${options.otherBuilding === true},
              stale: false,
              semanticAvailable: true,
              coverage: {
                indexed: ${bucket(10, 900, 'ok')},
                sourceMissingButSearchable: ${bucket(0, 0, 'neutral')},
                empty: ${bucket(0, 0, 'neutral')},
                failed: ${bucket(0, 0, 'ok')},
                notYetIndexed: ${bucket(0, 0, 'ok')},
                totalDocumentsWithChunks: 10,
                totalChunks: 900,
                totalEmbeddedChunks: 900,
                embeddedFraction: 1,
                knownDocumentIdsMatched: 10,
              },
              index: {
                corpora: [
                  { corpus: 'conversation', documents: 10, chunks: 900, embeddedChunks: 900, embeds: true },
                  { corpus: 'task', documents: 12, chunks: 30, embeddedChunks: 30, embeds: true },
                  { corpus: 'change', documents: 8, chunks: 8, embeddedChunks: 0, embeds: false },
                ],
                summaries: { written: 0, finishedTasks: 5 },
                storageBytes: 1048576,
              },
            },
          },
        };
      });`;
  }

  /** Add the second project to the map through the picker, and close it. */
  async function addMobileProject(page: Page): Promise<void> {
    await page.locator('[data-testid="knowledge-graph-projects"]').click();
    const menu = page.locator('[data-testid="knowledge-graph-projects-menu"]');
    await menu.locator('[data-testid="knowledge-graph-projects-row"][data-project-id="project-2"]').click();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }

  test('offers the Projects filter with one project indexed, the rest listed but not pickable', async () => {
    // The row never comes and goes with the index count, which moved the whole
    // panel. With one indexed project it names the scope, and a project with
    // nothing indexed is in its list, disabled.
    const { browser, page } = await launchWithState(`${snapshotScript({ projection: projectionLiteral(12) })}
      window.__mockPreConfigure(function () {
        return {
          knowledgeGraphProjects: [
            { id: 'project-1', name: 'Kangentic', conversations: 12, taskRecords: 20, lastActivityMs: 1700000100000 },
            { id: 'project-3', name: 'Website', conversations: 0, taskRecords: 0, lastActivityMs: null },
          ],
        };
      });`);
    try {
      await openKnowledgeGraph(page);
      const picker = page.locator('[data-testid="knowledge-graph-projects"]');
      await expect(picker).toContainText('Kangentic');
      await expect(picker).toContainText('1 of 1');
      // The row names the scope, so the header does not repeat it: it holds the
      // surface's title and no project name.
      const header = page.locator('[data-testid="surface-header-knowledge-graph"]');
      await expect(header.locator('h1')).toHaveText('Knowledge Graph');
      await expect(header).not.toContainText('Kangentic');

      await picker.click();
      const menu = page.locator('[data-testid="knowledge-graph-projects-menu"]');
      await expect(menu.locator('[data-testid="knowledge-graph-projects-row"]')).toHaveCount(1);
      const unindexed = menu.locator('[data-testid="knowledge-graph-projects-row-unindexed"]');
      await expect(unindexed).toHaveText(/Website/);
      await expect(unindexed).toBeDisabled();
      // The scope is never empty, so with one project there is nothing to add or drop.
      await expect(menu.locator('[data-testid="knowledge-graph-projects-all"]')).toBeDisabled();
      await expect(menu.locator('[data-testid="knowledge-graph-projects-none"]')).toBeDisabled();
    } finally {
      await browser.close();
    }
  });

  test('a second project joins the map as its own labelled island, and the Projects row and regions say so', async () => {
    const { browser, page } = await launchWithState(projectsScript());
    try {
      await openKnowledgeGraph(page);
      const picker = page.locator('[data-testid="knowledge-graph-projects"]');
      await expect(picker).toContainText('Kangentic');
      // The project with nothing indexed is not counted as one to show.
      await expect(picker).toContainText('1 of 2');
      await expect(page.locator('[data-testid="knowledge-graph-island-label"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="knowledge-graph-region-row"]')).toHaveCount(2);

      await picker.click();
      const menu = page.locator('[data-testid="knowledge-graph-projects-menu"]');
      const unindexed = menu.locator('[data-testid="knowledge-graph-projects-row-unindexed"]');
      await expect(unindexed).toContainText('Website');
      await expect(unindexed).toBeDisabled();
      await menu.locator('[data-testid="knowledge-graph-projects-row"][data-project-id="project-2"]').click();

      // Escape closes the picker first, and the graph stays.
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(page.locator('[data-testid="knowledge-graph-page"]')).toBeVisible();

      // Every indexed project is on, so the Projects row says so.
      await expect(picker).toContainText('All projects');
      // One island per project, the open one first, each named.
      await expect(page.locator('[data-testid="knowledge-graph-island-label"]')).toHaveText(['Kangentic', 'Mobile App']);
      // Both projects' regions, grouped under their project.
      await expect(page.locator('[data-testid="knowledge-graph-region-row"]')).toHaveCount(4);
      await expect(page.locator('[data-testid="knowledge-graph-region-group"]')).toHaveText(['Kangentic', 'Mobile App']);
      // The box says a question now spans both.
      await expect(page.locator('[data-testid="knowledge-graph-search-input"]'))
        .toHaveAttribute('placeholder', 'Ask across 2 projects');
    } finally {
      await browser.close();
    }
  });

  test('the picker finds a project by name, and All and None set the scope', async () => {
    const { browser, page } = await launchWithState(projectsScript());
    try {
      await openKnowledgeGraph(page);
      const picker = page.locator('[data-testid="knowledge-graph-projects"]');
      await expect(picker).toContainText('Kangentic');
      await picker.click();
      const menu = page.locator('[data-testid="knowledge-graph-projects-menu"]');
      const rows = menu.locator('[data-testid="knowledge-graph-projects-row"]');
      const search = page.locator('[data-testid="knowledge-graph-projects-search"]');

      await search.fill('mob');
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText('Mobile App');
      await expect(menu.locator('[data-testid="knowledge-graph-projects-row-unindexed"]')).toHaveCount(0);
      await search.fill('');

      await page.locator('[data-testid="knowledge-graph-projects-all"]').click();
      await expect(picker).toContainText('All projects');
      // None is never an empty map: it is the open project alone.
      await page.locator('[data-testid="knowledge-graph-projects-none"]').click();
      await expect(picker).toContainText('Kangentic');
      await expect(picker).toContainText('1 of 2');
      // And the last project on cannot be switched off.
      const openRow = menu.locator('[data-testid="knowledge-graph-projects-row"][data-project-id="project-1"]');
      await openRow.click();
      await expect(openRow).toHaveAttribute('aria-selected', 'true');
      await expect(picker).toContainText('1 of 2');
    } finally {
      await browser.close();
    }
  });

  /**
   * In how many of the frames after a click the camera was moving. Titles are
   * placed by projecting each node through the camera on every frame, so a frame
   * counts when a title that was drawn in the frame before is drawn somewhere
   * else: a fly moves them frame after frame, a cut moves them once. Titles are
   * matched by their text across the pooled slots, and ones fading in or out
   * are simply not compared.
   */
  async function movingFramesAfterClick(page: Page, selector: string | null, nth = 0, frames = 45): Promise<number> {
    return page.evaluate(async ({ target, index, count }) => {
      const placed = (): Map<string, string> => new Map(Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="knowledge-graph-node-title"]'),
      )
        .filter((element) => Number(element.style.opacity || '0') > 0)
        .map((element) => {
          const box = element.getBoundingClientRect();
          return [element.textContent ?? '', `${Math.round(box.left)},${Math.round(box.top)}`];
        }));
      if (target) document.querySelectorAll<HTMLElement>(target)[index]?.click();
      let previous = placed();
      let moving = 0;
      for (let frame = 0; frame < count; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        const current = placed();
        if ([...current].some(([text, where]) => previous.has(text) && previous.get(text) !== where)) moving += 1;
        previous = current;
      }
      return moving;
    }, { target: selector, index: nth, count: frames });
  }

  /** Until the camera has stopped, so the next step's frames are its own. */
  async function waitForCameraToSettle(page: Page): Promise<void> {
    await expect.poll(async () => movingFramesAfterClick(page, null, 0, 12), { timeout: 10_000 }).toBe(0);
  }

  test('adding a project to the map flies there, rather than cutting', async () => {
    const { browser, page } = await launchWithState(projectsScript());
    try {
      await openKnowledgeGraph(page);
      await expect.poll(async () => page.locator('[data-testid="knowledge-graph-node-title"]').count()).toBeGreaterThan(0);
      await page.locator('[data-testid="knowledge-graph-projects"]').click();
      await waitForCameraToSettle(page);
      const moving = await movingFramesAfterClick(page, '[data-testid="knowledge-graph-projects-all"]');
      await expect(page.locator('[data-testid="knowledge-graph-island-label"]')).toHaveCount(2);
      // A cut moves the titles in a frame or two; the fly moves them in many.
      expect(moving).toBeGreaterThanOrEqual(5);
    } finally {
      await browser.close();
    }
  });

  test('clearing a filter flies back to the whole map, and a resize still refits at once', async () => {
    const separated = `(function () {
      var base = ${projectionLiteral(40)};
      base.nodes.forEach(function (node, i) {
        var far = i >= 20;
        node.clusters = { coarse: 0, balanced: far ? 1 : 0, fine: far ? 1 : 0 };
        node.x = (far ? 0.55 : 0.12) + (i % 5) * 0.06;
        node.y = (far ? 0.55 : 0.12) + (Math.floor(i / 5) % 4) * 0.06;
        node.z = (far ? 0.55 : 0.12) + (i % 4) * 0.06;
      });
      return base;
    })()`;
    const { browser, page } = await launchWithState(snapshotScript({ projection: separated }));
    try {
      await openKnowledgeGraph(page);
      await expect.poll(async () => page.locator('[data-testid="knowledge-graph-node-title"]').count()).toBeGreaterThan(0);
      const rowSelector = '[data-testid="knowledge-graph-region-row"]';
      await waitForCameraToSettle(page);
      // Hide the far block: the camera flies to what is left.
      expect(await movingFramesAfterClick(page, rowSelector, 1)).toBeGreaterThanOrEqual(5);
      await waitForCameraToSettle(page);
      // Show it again: that is a change to the map too, so it flies home.
      expect(await movingFramesAfterClick(page, rowSelector, 1)).toBeGreaterThanOrEqual(5);
      await waitForCameraToSettle(page);

      // A resize is not a change to the map: it refits in one step, since a
      // drag-resize fires every frame and a fly would fight itself.
      await page.setViewportSize({ width: 1200, height: 760 });
      const afterResize = await page.evaluate(async () => {
        const seen = new Set<string>();
        for (let frame = 0; frame < 20; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
          const titles = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="knowledge-graph-node-title"]'))
            .filter((element) => Number(element.style.opacity || '0') > 0)
            .map((element) => { const box = element.getBoundingClientRect(); return `${Math.round(box.left)},${Math.round(box.top)}`; });
          seen.add(titles.join('|'));
        }
        return seen.size;
      });
      expect(afterResize).toBeLessThanOrEqual(2);
    } finally {
      await browser.close();
    }
  });

  test('a scope whose map is still building keeps the picker, so the scope can be changed back', async () => {
    // A never-shown project builds its map once, which takes about a minute on
    // a large one. Without the picker on that screen, closing the graph was
    // the only way back.
    const { browser, page } = await launchWithState(projectsScript({ otherBuilding: true }));
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-projects"]')).toContainText('Kangentic');
      await page.locator('[data-testid="knowledge-graph-projects"]').click();
      const menu = page.locator('[data-testid="knowledge-graph-projects-menu"]');
      await menu.locator('[data-testid="knowledge-graph-projects-row"][data-project-id="project-2"]').click();
      // Leave only the building project.
      await menu.locator('[data-testid="knowledge-graph-projects-row"][data-project-id="project-1"]').click();

      await expect(page.locator('[data-testid="knowledge-graph-body"]')).toContainText('Building the map');
      const pendingPicker = page.locator('[data-testid="knowledge-graph-pending-scope"] [data-testid="knowledge-graph-projects"]');
      await expect(pendingPicker).toBeVisible();

      // The picker moved onto the building screen, so it opens afresh there.
      await expect(menu).toBeHidden();
      await pendingPicker.click();
      await menu.locator('[data-testid="knowledge-graph-projects-row"][data-project-id="project-1"]').click();
      await expect(page.locator('[data-testid="knowledge-graph-region-row"]')).toHaveCount(2);
    } finally {
      await browser.close();
    }
  });

  test('an answer across projects names each task\'s project and opens its conversation there', async () => {
    const rows: ChatRow[] = [
      {
        ...chatRow(1),
        key: 'm-task-1',
        taskId: 'm-task-1',
        title: 'Mobile 1',
        docKeys: ['conversation::m-1'],
        passage: { sessionId: 'm-session-1', turnUuid: 'u-1' },
        projectId: 'project-2',
        projectName: 'Mobile App',
        ref: 'mobile-app#101',
      },
      // Across projects every ref names its project, the open one's too.
      { ...chatRow(0, 0.8), projectId: 'project-1', projectName: 'Kangentic', ref: 'kangentic#100' },
    ];
    const { browser, page } = await launchWithState(
      `${projectsScript()}${answeredScript('Mostly mobile-app#101, then kangentic#100.', rows)}`,
    );
    try {
      await openKnowledgeGraph(page);
      await expect(page.locator('[data-testid="knowledge-graph-projects"]')).toContainText('Kangentic');
      await addMobileProject(page);
      await expect(page.locator('[data-testid="knowledge-graph-island-label"]')).toHaveCount(2);
      await askInBox(page, 'what touched pairing?');

      // The question goes out naming both projects.
      await expect.poll(async () => (await answerCalls(page)).length).toBe(1);
      const [call] = await answerCalls(page);
      expect((call.context as { projectIds?: string[] } | null)?.projectIds).toEqual(['project-1', 'project-2']);

      // Another project's ticket names its project; the open project's draws
      // bare, though the answer wrote it with its project.
      await expect(page.locator('[data-testid="knowledge-graph-chat-ticket"]')).toHaveText(['Mobile App #101', '#100']);
      await expect(page.locator('[data-testid="knowledge-graph-chat-row-project"]')).toHaveText(['Mobile App', 'Kangentic']);

      // The row opens its conversation in ITS project, not the open one.
      await page.evaluate(() => {
        const host = window as unknown as {
          __transcriptProjects: Array<string | null>;
          __mockTranscriptsGetOverride: (input: { projectId?: string | null }) => undefined;
        };
        host.__transcriptProjects = [];
        host.__mockTranscriptsGetOverride = (input) => {
          host.__transcriptProjects.push(input.projectId ?? null);
          return undefined;
        };
      });
      await page.locator('[data-testid="knowledge-graph-chat-row"]').first().click();
      await page.locator('[data-testid="conversation-window"]').waitFor({ state: 'visible', timeout: 10000 });
      await expect
        .poll(async () => page.evaluate(
          () => (window as unknown as { __transcriptProjects: Array<string | null> }).__transcriptProjects,
        ))
        .toContain('project-2');
    } finally {
      await browser.close();
    }
  });
});
