/**
 * UI-tier coverage for the Memory Graph surface.
 *
 * Scope is deliberate: the surface opening, the coverage strip's NUMBERS and
 * TONE, and the four empty/loading states. The canvas itself is not asserted -
 * per-pixel canvas output is not reliably reproducible on CI's headless Linux
 * (font metrics and devicePixelRatio both differ), and the layout math that
 * actually matters is covered exhaustively in the unit tier
 * (`memory-graph-layout.test.ts`).
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
} = {}): string {
  const {
    projection = 'null',
    building = false,
    semanticAvailable = true,
    stale = false,
  } = options;
  return `window.__mockPreConfigure(function () {
    return {
      memoryGraphSnapshot: {
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
    Array.from(document.querySelectorAll('[data-testid="memory-graph-node-title"]'))
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
        memoryGraphAnswerResult: {
          ok: true,
          agentName: 'Claude Code',
          answer: 'That was T1.',
          selectedDocKeys: ['conversation::doc-0'],
          taskRefs: [
            { ref: 1, displayId: 100, title: 'Conversation 0', docKeys: ['conversation::doc-0'], costUsd: null, durationMs: null, tokens: null, outcome: 'done', sessions: 1, lastActivityMs: null, region: null, agent: null, model: null }
          ],
          view: null,
          grounds: null,
          promptTokens: 1,
          taskCount: 30,
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

/** Select node 0 through an answer: ask, click the task row it named, click the
 *  conversation. Deterministic, unlike clicking canvas pixels - which this tier
 *  deliberately never does. */
async function selectFirstResult(page: Page): Promise<void> {
  await page.locator('[data-testid="memory-graph-search-input"]').fill('what was conversation 0?');
  await page.keyboard.press('Enter');
  await page.locator('[data-testid="memory-graph-answer-task-row"]').first().click();
  await page.locator('[data-testid="memory-graph-task-conversation-row"]').first().click();
}

async function openMemoryGraph(page: Page): Promise<void> {
  await page.locator('[data-testid="memory-graph-button"]').click();
  await page.locator('[data-testid="memory-graph-page"]').waitFor({ state: 'visible', timeout: 10000 });
  // The body is lazy; wait for real content, not the skeleton. Deliberately NOT
  // the coverage strip: it now lives inside the left panel's Index section,
  // which is collapsed by default, so it is absent in the common case.
  await page.locator('[data-testid="memory-graph-body"]').waitFor({ state: 'visible', timeout: 10000 });
}

test.describe('memory graph', () => {
  test('opens from the title bar and shows reconciled coverage', async () => {
    const { browser, page } = await launchWithState(snapshotScript());
    try {
      await openMemoryGraph(page);
      const strip = page.locator('[data-testid="memory-coverage-strip"]');

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
      await openMemoryGraph(page);
      const strip = page.locator('[data-testid="memory-coverage-strip"]');
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
      await openMemoryGraph(page);
      await expect(page.locator('[data-testid="memory-graph-body"]')).toContainText('Semantic search is off');
      // The coverage numbers are still accurate and still shown.
      await expect(page.locator('[data-testid="memory-coverage-strip"]')).toContainText('638');
    } finally {
      await browser.close();
    }
  });

  test('shows a building state rather than an empty map on the first pass', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ building: true, stale: true }));
    try {
      await openMemoryGraph(page);
      await expect(page.locator('[data-testid="memory-graph-body"]')).toContainText('Building the map');
    } finally {
      await browser.close();
    }
  });

  test('renders the canvas and states that links are exact but position is not', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(60) }));
    try {
      await openMemoryGraph(page);
      await expect(page.locator('[data-testid="memory-graph-canvas"]')).toBeVisible();

      // The counts and the honesty line live in the left panel's Index section,
      // collapsed by default because they are reference rather than a control.
      await page.locator('[data-testid="memory-graph-index-toggle"]').click();
      await expect(page.locator('[data-testid="memory-graph-controls"]')).toContainText('Conversations');
      await expect(page.locator('[data-testid="memory-graph-controls"]')).toContainText('638');
      // Size beside the count, because a chunk total only means something to a
      // reader who already knows what a chunk is.
      await expect(page.locator('[data-testid="memory-graph-controls"]')).toContainText('Size on disk');
      await expect(page.locator('[data-testid="memory-graph-controls"]')).toContainText('3.00 GB');
      // Position is a ~33%-faithful reduction of 1024 dimensions; edges are exact.
      await expect(page.locator('[data-testid="memory-graph-controls"]')).toContainText('Links are exact');
    } finally {
      await browser.close();
    }
  });

  test('requests a refresh when the cached projection is stale', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(10), stale: true }));
    try {
      await openMemoryGraph(page);
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
      await openMemoryGraph(page);
      await expect(page.locator('[data-testid="memory-graph-canvas"]')).toBeVisible();
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
    // "Semantic search is off" notice comes from the snapshot - but starts no
    // projection pass. The only push was pass COMPLETION, so the notice stayed
    // over a working index until the surface was closed and reopened, which
    // reads as the setting not taking effect.
    const preConfig = `${snapshotScript({ semanticAvailable: false })}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await expect(page.getByText('Semantic search is off')).toBeVisible();

      // Re-point the mock at a snapshot reporting a working semantic layer, as
      // it would once the setting persisted, then announce the config change.
      await page.evaluate(() => {
        const api = (window as unknown as {
          electronAPI: { memory: { graphSnapshot: () => Promise<unknown> } };
        }).electronAPI;
        const previous = api.memory.graphSnapshot.bind(api.memory);
        api.memory.graphSnapshot = async () => {
          const snapshot = await previous() as { semanticAvailable: boolean } | null;
          return snapshot ? { ...snapshot, semanticAvailable: true } : snapshot;
        };
        (window as unknown as { __mockEmitConfigChanged: () => void }).__mockEmitConfigChanged();
      });

      // No reopen, no reload: the notice clears on its own.
      await expect(page.getByText('Semantic search is off')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('reloads on a completion push for the current project', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(10) }));
    try {
      await openMemoryGraph(page);
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

  /**
   * An answer naming ONE task, whose conversation is node 3.
   *
   * The way a reader reaches a conversation now: ask, click the task row the
   * answer named, click the conversation. There is no search rail to click a
   * card in - that rail showed our retrieval's raw passages before the agent
   * saw the question, and the user's verdict on it was "confusing".
   */
  const answerNamingTask3 = `
      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true,
            agentName: 'Claude Code',
            answer: 'That was T1.',
            selectedDocKeys: ['conversation::doc-3'],
            taskRefs: [
              { ref: 1, displayId: 103, title: 'Fix PTY resize', docKeys: ['conversation::doc-3'], costUsd: 4.5, durationMs: 60000, tokens: null, outcome: 'done', sessions: 1, lastActivityMs: null, region: null, agent: null, model: null }
            ],
            view: null,
            grounds: null,
            promptTokens: 100,
            taskCount: 12,
          },
        };
      });`;

  /** Ask, then drill from the answer's task row into its one conversation. */
  async function askAndDrillIntoTask(page: Page): Promise<void> {
    await page.locator('[data-testid="memory-graph-search-input"]').fill('what fixed the resize?');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="memory-graph-answer-task-row"]').click();
    await page.locator('[data-testid="memory-graph-task-conversation-row"]').click();
  }

  test('a conversation row selects the node and offers to open the conversation', async () => {
    // The point of the whole surface: a node has to lead somewhere. The first
    // version showed a raw hash and offered nothing to do with it.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}${answerNamingTask3}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await askAndDrillIntoTask(page);

      const detail = page.locator('[data-testid="memory-graph-detail"]');
      await expect(detail).toBeVisible();
      // The node's OWN title and metadata, not the raw doc key.
      await expect(detail).toContainText('Conversation 3');
      // Labelled rows, not bare values: an unlabelled `#` in front of the
      // region name left the reader guessing what it was.
      await expect(detail).toContainText('Indexed');
      await expect(detail).toContainText('13 chunks');
      await expect(detail).toContainText('Agent');
      await expect(detail).toContainText('Claude Code');
      await expect(detail).toContainText('Region');
      await expect(page.locator('[data-testid="memory-graph-open-conversation"]')).toBeEnabled();
    } finally {
      await browser.close();
    }
  });

  test('clicking Open conversation hands the session to the viewer', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}${answerNamingTask3}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await askAndDrillIntoTask(page);
      await page.locator('[data-testid="memory-graph-open-conversation"]').click();

      // The graph passes the NODE's session id (it knows it directly) rather
      // than resolving a task's newest session the way task detail must.
      //
      // Asserted on the window's anchor rather than on
      // `session-store.conversationSessionId`, which this used to check: that
      // signal is the BOARD's, and routing through it is what opened the
      // transcript at z-40 underneath this surface. The graph now writes to its
      // own layer, and the shared signal is deliberately left alone.
      await expect
        .poll(async () => page.evaluate(
          () => (window as unknown as {
            __zustandStores?: { memoryWindows?: { getState: () => { windows: Record<string, { kind: string; anchor: string }> } } };
          }).__zustandStores?.memoryWindows?.getState().windows ?? {},
        ).then((windows) => Object.values(windows).map((entry) => `${entry.kind}:${entry.anchor}`)))
        .toEqual(['conversation:session-3']);
    } finally {
      await browser.close();
    }
  });

  test('offers topic, recency, outcome, length and cost colour modes', async () => {
    // One word each. "Conversation length" was the odd one out in a list of
    // single words, and the qualifier stopped being needed once Duration and
    // Cost sat beside it: three magnitudes in a row disambiguate each other. They
    // are three DIFFERENT magnitudes, measured on the real corpus - length to
    // duration 0.507, length to cost 0.560, duration to cost 0.664.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openMemoryGraph(page);
      // A Select, not a segmented control: four labels never fit the panel's
      // width, and `ui-conventions` names Select for exactly that case.
      const select = page.locator('[data-testid="memory-graph-color-mode"]');
      for (const [value, label] of [['cluster', 'Topic'], ['recency', 'Recency'], ['outcome', 'Outcome'], ['size', 'Length'], ['duration', 'Duration'], ['cost', 'Cost']]) {
        await select.selectOption(value);
        await expect(select).toHaveValue(value);
        // The description under the control tracks the selection, so the user
        // can tell what the mode MEANS without hovering for a title.
        await expect(page.locator('[data-testid="memory-graph-controls"]')).toContainText(label);
      }
    } finally {
      await browser.close();
    }
  });

  test('does not offer a metric mode on an index that records no metrics', async () => {
    // The same rule the outcome facet follows. Cost and duration are absent on
    // conversations indexed before the metrics were captured, and a mode that
    // paints every node identically is worse than no mode.
    const noMetrics = `(function () {
      var base = ${projectionLiteral(20)};
      base.nodes.forEach(function (node) { node.costUsd = null; node.durationMs = null; });
      return base;
    })()`;
    const { browser, page } = await launchWithState(snapshotScript({ projection: noMetrics }));
    try {
      await openMemoryGraph(page);
      const select = page.locator('[data-testid="memory-graph-color-mode"]');
      // Topic, Recency, Outcome, Length - the four that need no captured metric.
      await expect(select.locator('option')).toHaveCount(4);
      await expect(select).not.toContainText('Cost');
      await expect(select).not.toContainText('Duration');
      // And it is not merely hidden from the list: selecting it is impossible,
      // so a projection that loses its costs mid-session cannot strand the map
      // in a mode with no control left on screen to explain it.
      await expect(select).toHaveValue('cluster');
    } finally {
      await browser.close();
    }
  });

  /**
   * Ask, which is the whole of what the box does.
   *
   * These tests are about the things that make it trustworthy rather than
   * merely present: it runs on Enter and on nothing else, it names who answers
   * and what that costs before it runs, the tasks it names go back to the map,
   * the answer is visible as it arrives, and it is not offered at all when no
   * agent can do it.
   */
  test('typing runs nothing, and Enter asks', async () => {
    // ONE box, ONE path. It used to search live on every keystroke and
    // separately ask on Enter when a regex judged the text to be a question;
    // two systems answered the same input and the second overwrote the first,
    // so the user watched a hairball of raw passages appear and then vanish
    // under the actual answer. Nothing on screen explained why "mobile
    // pairing" and "what did we do about mobile pairing?" behaved differently,
    // because the reason was a regex they could not see.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      const input = page.locator('[data-testid="memory-graph-search-input"]');

      // Keywords, a question, an empty box: none of it does anything.
      await input.fill('sphere fit');
      await input.fill('What was the most expensive task?');
      await page.waitForTimeout(400);
      await expect(page.locator('[data-testid="memory-graph-results"]')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as {
        __mockGraphAnswerCalls?: unknown[];
      }).__mockGraphAnswerCalls ?? [])).toHaveLength(0);

      // Enter asks. Exactly once, with the text as typed and the project the
      // map is pointed at (`.claude/rules/project-scoped-ipc.md`), the detail
      // level the user is looking at, and a request id the stream is keyed on.
      await input.press('Enter');
      await expect.poll(async () => page.evaluate(() => (window as unknown as {
        __mockGraphAnswerCalls?: Array<{ question: string; projectId: string; granularity: string; requestId: string | null }>;
      }).__mockGraphAnswerCalls ?? [])).toHaveLength(1);
      const [call] = await page.evaluate(() => (window as unknown as {
        __mockGraphAnswerCalls: Array<{ question: string; projectId: string; granularity: string; requestId: string | null }>;
      }).__mockGraphAnswerCalls);
      expect(call.question).toBe('What was the most expensive task?');
      expect(call.projectId).toBe('project-1');
      expect(call.granularity).toBe('balanced');
      expect(call.requestId).toBeTruthy();
    } finally {
      await browser.close();
    }
  });

  test('says who answers and what it costs, before it runs', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      const ask = page.locator('[data-testid="memory-graph-ask"]');
      // Nothing typed, nothing to offer.
      await expect(ask).toHaveCount(0);

      await page.locator('[data-testid="memory-graph-search-input"]').fill('sphere fit');

      // The submit glyph appears once there is TEXT. Enter is the button; this
      // is for discoverability and for the mouse, and it carries the agent and
      // the cost - reachable without a pointer, since HoverTip renders its
      // label sr-only inside the trigger at all times.
      await expect(ask).toBeVisible();
      await expect(ask).toHaveAttribute('aria-label', 'Ask Claude Code');
      await expect(page.getByText('One agent call', { exact: false }).first()).toBeAttached();
      await ask.hover();
      await expect(page.locator('[data-testid="memory-graph-ask-tip"]')).toContainText('One agent call');

      // And it has NOT run.
      expect(await page.evaluate(() => (window as unknown as {
        __mockGraphAnswerCalls?: unknown[];
      }).__mockGraphAnswerCalls ?? [])).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  test('a task the answer named is a control that selects its conversation', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true,
            agentName: 'Claude Code',
            answer: 'A sphere circumscribes, so T1 framed nothing like the default view.',
            selectedDocKeys: [],
            taskRefs: [
              { ref: 1, displayId: 107, title: 'Reset view', docKeys: ['conversation::doc-7'], costUsd: 12, durationMs: null, tokens: null, outcome: 'done', sessions: 1, lastActivityMs: null, region: null, agent: null, model: null }
            ],
            view: null,
            grounds: null,
            promptTokens: 100,
            taskCount: 30,
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('why did we drop the sphere fit?');
      await page.keyboard.press('Enter');

      const answered = page.locator('[data-testid="memory-answer"]');
      await expect(answered).toBeVisible();
      await expect(answered).toContainText('A sphere circumscribes');
      await expect(answered).toContainText('Answered by Claude Code');

      // The ref in the prose is the board's ticket, and it is a control.
      const refs = page.locator('[data-testid="memory-answer-task"]');
      await expect(refs).toHaveCount(1);
      await expect(refs.first()).toHaveText('#107');
      await refs.first().click();
      await expect(page.locator('[data-testid="memory-graph-task-chip"]')).toContainText('Reset view');
      await page.locator('[data-testid="memory-graph-task-conversation-row"]').click();
      await expect(page.locator('[data-testid="memory-graph-detail"]')).toContainText('Conversation 7');
    } finally {
      await browser.close();
    }
  });

  test('a new question drops the old answer', async () => {
    // An answer is ABOUT a question, and one left standing over a different
    // question claims to be about that one instead.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true, agentName: 'Claude Code', answer: 'It circumscribes.',
            selectedDocKeys: [], taskRefs: [], view: null, grounds: null, promptTokens: 1, taskCount: 30,
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      const input = page.locator('[data-testid="memory-graph-search-input"]');
      await input.fill('sphere fit');
      await input.press('Enter');
      await expect(page.locator('[data-testid="memory-answer"]')).toBeVisible();

      // Typing a different question does not by itself drop it - the answer
      // still applies to what was asked. Asking again does.
      await input.fill('something else entirely');
      await input.press('Enter');
      await expect.poll(async () => page.evaluate(() => (window as unknown as {
        __mockGraphAnswerCalls?: unknown[];
      }).__mockGraphAnswerCalls ?? [])).toHaveLength(2);

      // And clearing the box clears the answer with it, or an answer would
      // stand over an empty box claiming to be about nothing.
      await input.fill('');
      await expect(page.locator('[data-testid="memory-answer"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="memory-graph-results"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('shows why an answer failed, verbatim', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: { ok: false, reason: 'Claude Code CLI not found' },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('sphere fit');
      await page.keyboard.press('Enter');
      // Every reason is actionable - no CLI, the agent cannot answer, a timeout -
      // so a generic failure line would take that away.
      await expect(page.locator('[data-testid="memory-answer-error"]')).toContainText('CLI not found');
    } finally {
      await browser.close();
    }
  });

  test('shows the answer arriving, before it has finished', async () => {
    // Content at first-token time (measured 1.1 to 1.8s) rather than a spinner
    // until completion (measured ~6s). The mock's answerFromGraph resolves at
    // once, so the stream is driven by hand BEFORE Enter resolves it: the
    // events carry the request id the store minted, read back off the call.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true, agentName: 'Claude Code', answer: 'The settled answer.',
            selectedDocKeys: [], taskRefs: [], view: null, grounds: null, promptTokens: 1, taskCount: 30,
          },
        };
      });
      // Hold the answer open until the spec releases it, so the stream has a
      // window to be observed in. The call is recorded HERE, because the
      // mock's own recorder only runs when the held call is finally released,
      // and the spec needs the request id before that.
      var original = window.electronAPI.memory.answerFromGraph;
      window.electronAPI = Object.assign({}, window.electronAPI, {
        memory: Object.assign({}, window.electronAPI.memory, {
          answerFromGraph: function (question, projectId, granularity, requestId) {
            var args = arguments;
            if (!window.__mockGraphAnswerCalls) window.__mockGraphAnswerCalls = [];
            window.__mockGraphAnswerCalls.push({ question: question, projectId: projectId, granularity: granularity, requestId: requestId });
            return new Promise(function (resolve) {
              window.__mockReleaseAnswer = function () { resolve(original.apply(null, args)); };
            });
          },
        }),
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('why did we do that?');
      await page.keyboard.press('Enter');

      const requestId = await page.evaluate(() => (window as unknown as {
        __mockGraphAnswerCalls: Array<{ requestId: string }>;
      }).__mockGraphAnswerCalls[0].requestId);

      // A tool call shows as progress, named for the reader.
      await page.evaluate((id) => (window as unknown as {
        __mockFireAnswerStream: (event: unknown) => void;
      }).__mockFireAnswerStream({ requestId: id, kind: 'tool', name: 'mcp__kangentic__kangentic_search' }), requestId);
      await expect(page.locator('[data-testid="memory-answer-status"]')).toContainText('Searching your conversations');

      // Text arrives and renders while the answer is still open.
      await page.evaluate((id) => (window as unknown as {
        __mockFireAnswerStream: (event: unknown) => void;
      }).__mockFireAnswerStream({ requestId: id, kind: 'text', text: 'We dropped it because ' }), requestId);
      await expect(page.locator('[data-testid="memory-answer-streaming"]')).toContainText('We dropped it because');
      // The status line clears once prose is flowing.
      await expect(page.locator('[data-testid="memory-answer-status"]')).toHaveCount(0);

      // A delta for a DIFFERENT request is dropped, never appended.
      await page.evaluate(() => (window as unknown as {
        __mockFireAnswerStream: (event: unknown) => void;
      }).__mockFireAnswerStream({ requestId: 'stale', kind: 'text', text: 'NOT THIS' }));
      await expect(page.locator('[data-testid="memory-answer-streaming"]')).not.toContainText('NOT THIS');

      // The whole answer REPLACES the stream when it lands.
      await page.evaluate(() => (window as unknown as { __mockReleaseAnswer: () => void }).__mockReleaseAnswer());
      await expect(page.locator('[data-testid="memory-answer"]')).toContainText('The settled answer.');
      await expect(page.locator('[data-testid="memory-answer-streaming"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('scopes the map to the tasks an answer selected', async () => {
    // "Show me the tasks related to terminal bug fixes" wants the map filtered,
    // not a paragraph describing a filter. The agent read every task and said
    // which qualify; the surface treats that as the scope.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true,
            agentName: 'Claude Code',
            answer: 'Two tasks touch the terminal.',            selectedDocKeys: ['conversation::doc-3', 'conversation::doc-7'],
            taskCount: 30,          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('sphere fit');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="memory-answer"]')).toContainText('Two tasks touch the terminal');

      // The answer named no task, only conversations, so the rail LISTS what
      // it selected and counts them - a scoped map over an empty rail reads as
      // a filter that lost its list. Two rows, agreeing with the map.
      const rows = page.locator('[data-testid="memory-graph-task-conversation-row"]');
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toContainText('Conversation');
      await expect(page.getByText('2 conversations', { exact: true })).toBeVisible();
      // And a row is a way in: it selects that conversation.
      await rows.first().click();
      await expect(page.locator('[data-testid="memory-graph-detail"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('makes a task the answer named a control, and scopes the map to it', async () => {
    // Measured against a real agent: asked about mobile work it wrote an essay
    // naming 22 tasks inline as `T133` and never emitted the protocol line, so
    // every one of them rendered as dead text pointing at nothing.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true,
            agentName: 'Claude Code',
            answer: 'Mobile work spans T4 the bridge and T9 the relay.',            selectedDocKeys: [],
            taskRefs: [
              { ref: 4, title: 'Mobile Bridge Phase 1', docKeys: ['conversation::doc-3', 'conversation::doc-7'] }
            ],
            taskCount: 30,          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('mobile');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="memory-answer"]')).toContainText('Mobile work spans');

      // T4 resolved, so it is a control. T9 did not, so it stays plain text
      // rather than becoming a button that cannot act.
      const chips = page.locator('[data-testid="memory-answer-task"]');
      await expect(chips).toHaveCount(1);
      // This ref carries no board ticket, which is what a conversation with no
      // task looks like. It keeps the `T` label rather than inventing a `#`,
      // since it genuinely is not a ticket.
      await expect(chips.first()).toHaveText('T4');

      // Clicking it scopes the map to that task's conversations, and says so.
      await chips.first().click();
      await expect(page.locator('[data-testid="memory-graph-task-chip"]')).toContainText('Mobile Bridge Phase 1');
      await expect(page.locator('[data-testid="memory-graph-task-chip"]')).toContainText('2 conversations');
      // The rail DRILLS IN to that task's conversations. Re-listing the task
      // row would restate a scope the map is already holding, which is what
      // made clicking a row appear to do nothing at all.
      await expect(page.locator('[data-testid="memory-graph-task-conversation-row"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="memory-graph-answer-task-row"]')).toHaveCount(0);

      // And the scope is undoable, like every other narrowing on this surface.
      await page.locator('[data-testid="memory-graph-task-clear"]').click();
      await expect(page.locator('[data-testid="memory-graph-task-chip"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="memory-graph-answer-task-row"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('lists the tasks an answer named, as tasks, with no protocol line', async () => {
    // The reported case: "What is the biggest mobile task?" produced a correct
    // ranking naming six tasks, and the rail beneath it read "1 of 673" over a
    // single card showing a raw tool-call snippet. The agent emitted no
    // SELECTED line, so the rail kept the original search while the answer
    // discussed tasks it had already resolved.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true,
            agentName: 'Claude Code',
            answer: 'Ranking by cost: T1 (Research: Mobile App) at $308.42 is the largest, then T5.',            // No SELECTED line, exactly as the real agent behaved.
            selectedDocKeys: [],
            taskRefs: [
              { ref: 1, displayId: 529, title: 'Research: Mobile App', docKeys: ['conversation::doc-3', 'conversation::doc-7'], costUsd: 308.42, durationMs: 7_680_000, tokens: 12_400_000, outcome: 'done', sessions: 2, lastActivityMs: null, region: null, agent: null, model: null },
              { ref: 5, displayId: 44, title: 'Codex Agent-to-Board MCP', docKeys: ['conversation::doc-9'], costUsd: 199.76, durationMs: null, tokens: null, outcome: 'active', sessions: 1, lastActivityMs: null, region: null, agent: null, model: null }
            ],
            view: { select: ['cost_usd', 'duration', 'outcome'], order: { key: 'cost_usd', direction: 'desc' } },
            taskCount: 30,          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('biggest mobile task');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="memory-answer"]')).toContainText('Ranking by cost');

      // TASK rows, both tasks the answer named.
      const rows = page.locator('[data-testid="memory-graph-answer-task-row"]');
      await expect(rows).toHaveCount(2);

      // The row is labelled with the BOARD's ticket, which is the number the
      // reader has seen on a card - not `T1`, which is a position in the
      // prompt's task table and a different number for the same task.
      await expect(rows.first()).toContainText('#529');
      await expect(rows.first()).not.toContainText('T1');
      await expect(rows.first()).toContainText('Research: Mobile App');

      // The columns are the ones the ANSWER asked for, aligned under a header.
      const headers = page.locator('[data-testid="memory-graph-answer-task-header"] span');
      await expect(headers).toHaveText(['Task', 'Cost', 'Duration', 'Status']);
      await expect(rows.first().locator('[data-field="cost_usd"]')).toHaveText('$308.42');
      await expect(rows.first().locator('[data-field="duration"]')).toHaveText('2h 8m');
      // Named after the WORK, not after the board's Done column.
      await expect(rows.first().locator('[data-field="outcome"]')).toHaveText('Completed');
      await expect(rows.nth(1).locator('[data-field="outcome"]')).toHaveText('In Progress');

      // A task with no duration recorded leaves the cell EMPTY rather than
      // printing a zero it has not earned.
      await expect(rows.nth(1).locator('[data-field="cost_usd"]')).toHaveText('$199.76');
      await expect(rows.nth(1).locator('[data-field="duration"]')).toHaveText('');

      // Tokens were not selected, so no token figure appears anywhere.
      await expect(rows.first()).not.toContainText('12.4M');

      // And the count names the unit the rail is actually showing.
      await expect(page.getByText('2 tasks', { exact: false }).first()).toBeVisible();

      // Clicking a row DRILLS IN to that task's conversations. It used to set a
      // scope the map was already holding, so the click moved nothing at all.
      await rows.first().click();
      await expect(page.locator('[data-testid="memory-graph-task-chip"]')).toContainText('Research: Mobile App');
      await expect(page.locator('[data-testid="memory-graph-task-conversation-row"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="memory-graph-answer-task-row"]')).toHaveCount(0);
      await expect(page.getByText('2 conversations', { exact: false }).first()).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('keeps the working behind a disclosure instead of in the answer', async () => {
    // Quoting the sources before answering is the documented way to keep a
    // long-context answer on its material, and the measured failure it targets
    // is an answer reaching past 22k tokens of task history to answer from
    // general knowledge. But this rail is narrow and its answers run to a line
    // or two, so the quotes cannot sit above every one of them.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true,
            agentName: 'Claude Code',
            answer: '#286 at $308.42 is the largest.',
            grounds: 'T1 | 308.42 | cost_usd\\n[3] "we dropped the sphere fit"',            selectedDocKeys: [],
            taskRefs: [],
            view: null,
            taskCount: 349,          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('most expensive task');
      await page.keyboard.press('Enter');

      const answer = page.locator('[data-testid="memory-answer"]');
      await expect(answer).toContainText('#286 at $308.42 is the largest.');

      // COLLAPSED by default: the answer is what the reader came for.
      const grounds = page.locator('[data-testid="memory-answer-grounds"]');
      await expect(grounds).toBeVisible();
      await expect(grounds).not.toHaveAttribute('open', '');
      // The working is not in the answer body, which is the whole point of
      // separating it - otherwise the rail reads as a wall of quotes.
      await expect(page.locator('.memory-answer-body')).not.toContainText('cost_usd');

      // And it is one click away, verbatim.
      await grounds.locator('summary').click();
      await expect(grounds).toContainText('T1 | 308.42 | cost_usd');
      await expect(grounds).toContainText('we dropped the sphere fit');
    } finally {
      await browser.close();
    }
  });

  test('shows no disclosure when the answer carried no working', async () => {
    // An answer without grounds is an ordinary answer, not a degraded one. An
    // empty "Show what this is based on" that opens onto nothing would read as
    // a broken control.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true,
            agentName: 'Claude Code',
            answer: 'Nothing in the index covers that.',
            grounds: null,            selectedDocKeys: [],
            taskRefs: [],
            view: null,
            taskCount: 349,          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('kubernetes');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="memory-answer"]')).toContainText('Nothing in the index');
      await expect(page.locator('[data-testid="memory-answer-grounds"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('shows an answer to a question that never ran a search', async () => {
    // Found by driving the real product, not by reasoning: typing a QUESTION
    // deliberately does NOT run a search (questions wait for Ask, because
    // filtering the map on every keystroke was the reported annoyance). So a
    // question leaves `query` null - and the rail was gated on `query`, which
    // meant the answer, its citations and its task rows had nowhere to render.
    // The map still scoped to the answer, so it looked like the surface had
    // simply swallowed a reply that had already been paid for.
    //
    // No `askQuery` here on purpose: the absence of a search result is the
    // whole condition under test.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true,
            agentName: 'Claude Code',
            answer: 'The most expensive task is T1 at $308.42.',            selectedDocKeys: ['conversation::doc-3'],
            taskRefs: [
              { ref: 1, displayId: 286, title: 'Searchable conversation memory', docKeys: ['conversation::doc-3'], costUsd: 308.42, durationMs: 7_680_000, tokens: null, outcome: 'done', sessions: 1, lastActivityMs: null, region: null, agent: null, model: null }
            ],
            view: { select: ['cost_usd'], order: { key: 'cost_usd', direction: 'desc' } },
            taskCount: 349,          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('What is the most expensive task?');
      // No search ran, so there is no result rail yet.
      await expect(page.locator('[data-testid="memory-graph-results"]')).toHaveCount(0);

      await page.keyboard.press('Enter');

      // The answer has a home even though nothing was searched.
      await expect(page.locator('[data-testid="memory-answer"]')).toContainText('most expensive task');
      const rows = page.locator('[data-testid="memory-graph-answer-task-row"]');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText('#286');
      await expect(rows.first().locator('[data-field="cost_usd"]')).toHaveText('$308.42');
    } finally {
      await browser.close();
    }
  });

  test('follows the answer to a column that is not cost', async () => {
    // The defect this whole shape exists for: the rows printed a fixed four
    // facts, so an answer ranking tasks by TOKENS sat above rows showing dollar
    // amounts, and an answer about recency showed no date at all.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true,
            agentName: 'Claude Code',
            answer: 'By tokens, T1 leads at 12.4M.',            selectedDocKeys: [],
            taskRefs: [
              { ref: 1, displayId: 529, title: 'Research: Mobile App', docKeys: ['conversation::doc-3'], costUsd: 308.42, durationMs: 7_680_000, tokens: 12_400_000, outcome: 'done', sessions: 1, lastActivityMs: 1756000000000, region: null, agent: null, model: null },
              { ref: 5, displayId: 44, title: 'Codex Agent-to-Board MCP', docKeys: ['conversation::doc-9'], costUsd: 199.76, durationMs: 3_600_000, tokens: 900_000, outcome: 'done', sessions: 1, lastActivityMs: 1755000000000, region: null, agent: null, model: null }
            ],
            view: { select: ['tokens', 'last_active'], order: { key: 'tokens', direction: 'desc' } },
            taskCount: 30,          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('most tokens');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="memory-answer"]')).toContainText('By tokens');

      const headers = page.locator('[data-testid="memory-graph-answer-task-header"] span');
      await expect(headers).toHaveText(['Task', 'Tokens', 'Last active']);

      const rows = page.locator('[data-testid="memory-graph-answer-task-row"]');
      await expect(rows.first().locator('[data-field="tokens"]')).toHaveText('12.4M');
      // The number the prose names is the number on the row. Cost is not shown
      // at all, because nothing asked about it.
      await expect(rows.first()).not.toContainText('$308.42');

      // Outcome is identical on both rows, so it carries no signal and is not
      // rendered even though the catalog has it.
      await expect(rows.first()).not.toContainText('Completed');
    } finally {
      await browser.close();
    }
  });

  test('does not offer Ask when the agent cannot answer', async () => {
    // The gate is the CAPABILITY, never the agent's name
    // (`.claude/rules/agent-adapters-boundary.md`). An agent without it gets no
    // affordance rather than one that fails when pressed.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}      window.__mockAgentListOverrides = { claude: { supportsAnswerFromContext: false } };`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      // The box says so in place of doing nothing: a plain notice where the
      // prompt would be, and no way to type into a control that cannot act.
      const input = page.locator('[data-testid="memory-graph-search-input"]');
      await expect(input).toBeDisabled();
      await expect(input).toHaveAttribute('placeholder', 'No agent can answer here');
      await expect(page.locator('[data-testid="memory-graph-ask"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('offers region, time and outcome filters', async () => {
    // The same dimensions the colour modes encode. Before this you could colour
    // by Outcome and SEE that some work was abandoned, but could not scope the
    // map to it.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openMemoryGraph(page);
      await expect(page.locator('[data-testid="memory-graph-filter-since"]')).toBeVisible();
      await expect(page.locator('[data-testid="memory-graph-filter-outcome"]')).toBeVisible();
      // Every option says what it means on its own, so the rows need no labels.
      await expect(page.locator('[data-testid="memory-graph-filter-since"]')).toContainText('Last 30 days');
      await expect(page.locator('[data-testid="memory-graph-filter-outcome"]')).toContainText('Finished');
      // Regions are their own panel now, not a row in this group.
      await expect(page.locator('[data-testid="memory-graph-filter-region"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('names each region by its own label, not by an index', async () => {
    // A region picker reading "Cluster 0" would make the reader hold a mapping
    // in their head that the map already draws for them.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openMemoryGraph(page);
      const rows = page.locator('[data-testid="memory-graph-region-row"]');
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
      await openMemoryGraph(page);
      // Labels stay mounted and fade, because the frame loop positions them - so
      // this asserts opacity rather than element count.
      const kept = page.locator('[data-testid="memory-graph-cluster-label"][data-cluster="0"]');
      const dropped = page.locator('[data-testid="memory-graph-cluster-label"][data-cluster="1"]');
      await expect(kept).not.toHaveCSS('opacity', '0');
      await expect(dropped).not.toHaveCSS('opacity', '0');

      // Toggle the SECOND region off; the first stays.
      await page.locator('[data-testid="memory-graph-region-row"]').nth(1).click();
      // A label hanging over the space where its conversations used to be names
      // something that is not there.
      await expect(dropped).toHaveCSS('opacity', '0');
      await expect(kept).not.toHaveCSS('opacity', '0');

      await page.locator('[data-testid="memory-graph-region-row"]').nth(1).click();
      await expect(dropped).not.toHaveCSS('opacity', '0');
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
          memoryGraphAnswerResult: {
            ok: true, agentName: 'Claude Code', answer: 'Four conversations.',
            selectedDocKeys: ['conversation::doc-0', 'conversation::doc-1', 'conversation::doc-2', 'conversation::doc-15'],
            taskRefs: [], view: null, grounds: null, promptTokens: 1, taskCount: 20,
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      const kept = page.locator('[data-testid="memory-graph-cluster-label"][data-cluster="0"]');
      const thinned = page.locator('[data-testid="memory-graph-cluster-label"][data-cluster="1"]');
      await expect(kept).not.toHaveCSS('opacity', '0');
      await expect(thinned).not.toHaveCSS('opacity', '0');

      await page.locator('[data-testid="memory-graph-search-input"]').fill('terminal');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="memory-graph-task-conversation-row"]')).toHaveCount(4);

      // Opacity, not element count: the labels stay mounted and the frame loop
      // fades them, so a count assertion passes against a merely invisible pill.
      await expect(thinned).toHaveCSS('opacity', '0');
      await expect(kept).not.toHaveCSS('opacity', '0');
    } finally {
      await browser.close();
    }
  });

  test('a filter narrows an answer rather than replacing it', async () => {
    // An answer asks "which conversations", a facet asks "which part of the
    // index". They have to compose, and the LIST has to agree with the map - a
    // scoped map under an unfiltered list reads as a broken filter.
    // doc-3 reached Done (3 % 3 === 0) and doc-4 is still active, so the two
    // selected conversations deliberately straddle the outcome split.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(20) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true, agentName: 'Claude Code', answer: 'Two conversations.',
            selectedDocKeys: ['conversation::doc-3', 'conversation::doc-4'],
            taskRefs: [], view: null, grounds: null, promptTokens: 1, taskCount: 20,
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('terminal');
      await page.keyboard.press('Enter');
      const rows = page.locator('[data-testid="memory-graph-task-conversation-row"]');
      await expect(rows).toHaveCount(2);

      // Scoping to Done must drop exactly one row AND the count with it.
      await page.locator('[data-testid="memory-graph-filter-outcome"]').selectOption('done');
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText('Conversation 3');
      await expect(page.getByText('1 conversation', { exact: true })).toBeVisible();

      await page.locator('[data-testid="memory-graph-filter-outcome"]').selectOption('any');
      await expect(rows).toHaveCount(2);
    } finally {
      await browser.close();
    }
  });

  test('a filter narrows the tasks an answer named', async () => {
    // Same rule one level up. A task row whose every conversation the facet
    // hid would sit beside a map showing none of them.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(20) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphAnswerResult: {
            ok: true, agentName: 'Claude Code', answer: 'T1 finished and T2 is still going.',
            selectedDocKeys: [],
            taskRefs: [
              { ref: 1, displayId: 101, title: 'Finished task', docKeys: ['conversation::doc-3'], costUsd: 1, durationMs: null, tokens: null, outcome: 'done', sessions: 1, lastActivityMs: null, region: null, agent: null, model: null },
              { ref: 2, displayId: 102, title: 'Running task', docKeys: ['conversation::doc-4'], costUsd: 2, durationMs: null, tokens: null, outcome: 'active', sessions: 1, lastActivityMs: null, region: null, agent: null, model: null }
            ],
            view: null, grounds: null, promptTokens: 1, taskCount: 20,
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('which tasks?');
      await page.keyboard.press('Enter');
      const rows = page.locator('[data-testid="memory-graph-answer-task-row"]');
      await expect(rows).toHaveCount(2);

      await page.locator('[data-testid="memory-graph-filter-outcome"]').selectOption('done');
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText('#101');
      await expect(page.getByText('1 task', { exact: true })).toBeVisible();

      await page.locator('[data-testid="memory-graph-filter-outcome"]').selectOption('any');
      await expect(rows).toHaveCount(2);
    } finally {
      await browser.close();
    }
  });

  test('does not offer an outcome nothing in the index has', async () => {
    // Archiving happens after Done essentially always, so "Abandoned" (archived
    // without ever reaching Done) matches nothing on a real board and would sit
    // there as a permanently empty choice. The option list is built from what
    // the corpus actually contains, so this corrects itself per project rather
    // than being a judgement baked in about one board.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openMemoryGraph(page);
      const outcome = page.locator('[data-testid="memory-graph-filter-outcome"]');
      await expect(outcome).toContainText('Finished');
      await expect(outcome).toContainText('Still open');
      await expect(outcome).not.toContainText('Abandoned');
    } finally {
      await browser.close();
    }
  });

  test('offers an outcome once something in the index has it', async () => {
    // The other half of the rule: a board where work really was dropped gets the
    // option, so this is availability rather than removal.
    const withAbandoned = `(function () {
      var base = ${projectionLiteral(6)};
      base.nodes[1].outcome = 'abandoned';
      return base;
    })()`;
    const { browser, page } = await launchWithState(snapshotScript({ projection: withAbandoned }));
    try {
      await openMemoryGraph(page);
      await expect(page.locator('[data-testid="memory-graph-filter-outcome"]')).toContainText('Dropped');
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
      await openMemoryGraph(page);
      const rows = page.locator('[data-testid="memory-graph-region-row"]');
      await expect(rows).toHaveCount(2);
      for (const row of await rows.all()) {
        await expect(row).toHaveAttribute('data-region-on', 'true');
      }
      await expect(page.locator('[data-testid="memory-graph-regions-toggle"]')).toContainText('Regions');

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
      await openMemoryGraph(page);
      const rows = page.locator('[data-testid="memory-graph-region-row"]');
      const showAll = page.locator('[data-testid="memory-graph-regions-all"]');
      const showNone = page.locator('[data-testid="memory-graph-regions-none"]');

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
      await openMemoryGraph(page);
      const panel = page.locator('[data-testid="memory-graph-controls"]');
      await expect(panel).toContainText('2 of 2 shown');
      await page.locator('[data-testid="memory-graph-region-row"]').nth(0).click();
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
      await openMemoryGraph(page);
      const rows = page.locator('[data-testid="memory-graph-region-row"]');
      const field = page.locator('[data-testid="memory-graph-region-filter"]');
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
      await expect(page.locator('[data-testid="memory-graph-controls"]')).toContainText('14 of 14 shown');

      // An empty result says so rather than leaving a blank box.
      await field.fill('nothing matches this');
      await expect(rows).toHaveCount(0);
      await expect(page.locator('[data-testid="memory-graph-region-filter-empty"]')).toBeVisible();

      await page.locator('[data-testid="memory-graph-region-filter-clear"]').click();
      await expect(rows).toHaveCount(14);
    } finally {
      await browser.close();
    }
  });

  test('does not offer a region filter over a list short enough to read', async () => {
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openMemoryGraph(page);
      await expect(page.locator('[data-testid="memory-graph-region-row"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="memory-graph-region-filter"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('hides a filter row that could only ever do nothing', async () => {
    // One region means the region picker can
    // only return everything, and one outcome means the same of that row.
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
      await openMemoryGraph(page);
      await expect(page.locator('[data-testid="memory-graph-canvas"]')).toBeVisible();
      // One region means the panel can only ever show everything.
      await expect(page.locator('[data-testid="memory-graph-regions-toggle"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="memory-graph-filter-outcome"]')).toHaveCount(0);
      // Time survives: the fixture's timestamps are years old, so the windows
      // still select different sets.
      await expect(page.locator('[data-testid="memory-graph-filter-since"]')).toBeVisible();
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
      await openMemoryGraph(page);
      const detail = page.locator('[data-testid="memory-graph-granularity"]');
      await expect(detail).toBeVisible();

      // Balanced by default: the fixture's balanced carve-up has two regions.
      const regionRows = page.locator('[data-testid="memory-graph-region-row"]');
      await expect(regionRows).toHaveCount(2);

      await detail.getByRole('radio', { name: 'Fine' }).click();
      await expect(regionRows).toHaveCount(3);

      // Coarse merges the fixture into ONE region, and the panel then hides
      // itself - the same rule every other filter follows, since a picker that
      // can only return everything is worse than no picker.
      await detail.getByRole('radio', { name: 'Coarse' }).click();
      await expect(page.locator('[data-testid="memory-graph-regions-toggle"]')).toHaveCount(0);

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
      await openMemoryGraph(page);
      // The regions themselves are still there and still switchable - it is the
      // DETAIL picker that has nothing to offer, not the map.
      await expect(page.locator('[data-testid="memory-graph-region-row"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="memory-graph-granularity"]')).toHaveCount(0);
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
      await openMemoryGraph(page);
      const title = page.locator('[data-testid="memory-graph-node-title"]').first();
      await expect(title).toBeVisible();
      const box = (await title.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;

      // Press, wobble a pixel, release. This is a click, not a drag.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 1, y + 1);
      await page.mouse.up();

      const detail = page.locator('[data-testid="memory-graph-detail"]');
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
      await openMemoryGraph(page);
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
      await openMemoryGraph(page);
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);

      const overlaps = await page.evaluate(() => {
        const visible = Array.from(document.querySelectorAll('[data-testid="memory-graph-node-title"]'))
          .filter((element) => Number((element as HTMLElement).style.opacity || '0') > 0)
          .map((element) => element.getBoundingClientRect());
        let collisions = 0;
        for (let first = 0; first < visible.length; first += 1) {
          for (let second = first + 1; second < visible.length; second += 1) {
            const a = visible[first];
            const b = visible[second];
            if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) collisions += 1;
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
      await openMemoryGraph(page);
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);

      const escaping = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="memory-graph-canvas"]')!.getBoundingClientRect();
        const selector = '[data-testid="memory-graph-node-title"], [data-testid="memory-graph-cluster-label"]';
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
      await openMemoryGraph(page);
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
      await openMemoryGraph(page);
      await expect.poll(async () => (await visibleNodeTitles(page)).length).toBeGreaterThan(0);

      const toggle = page.locator('[data-testid="memory-graph-toggle-titles"]');
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
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-close"]').click();
      await page.locator('[data-testid="memory-graph-page"]').waitFor({ state: 'hidden', timeout: 5000 });

      await openMemoryGraph(page);
      await page.keyboard.press('Escape');
      await page.locator('[data-testid="memory-graph-page"]').waitFor({ state: 'hidden', timeout: 5000 });
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
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-canvas"]').waitFor({ state: 'visible' });
      await selectFirstResult(page);
      await page.locator('[data-testid="memory-graph-open-conversation"]').click();

      await page.locator('[data-testid="conversation-window"]')
        .waitFor({ state: 'visible', timeout: 10000 });

      // ANCESTRY, not visibility, is what catches this regression: a conversation
      // window mounted on the board layer is perfectly "visible" to Playwright
      // while being completely hidden behind the graph on screen.
      await expect(page.locator('#memory-detail-layer-root [data-testid="conversation-window"]'))
        .toHaveCount(1);
      await expect(page.locator('#window-layer-root [data-testid="conversation-window"]'))
        .toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('hides "Open task" where the layer cannot show one', async () => {
    // The same bug one hop deeper. On this layer the button would route to the
    // board (under the graph) in-app, and nowhere at all in the pop-out, so both
    // affordances hide rather than pretending to work. The fixture seeds a real
    // taskId, so a missing task cannot be what passes this test.
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openMemoryGraph(page);
      await selectFirstResult(page);
      await page.locator('[data-testid="memory-graph-open-conversation"]').click();
      await page.locator('[data-testid="conversation-title"]')
        .waitFor({ state: 'visible', timeout: 10000 });
      await expect(page.locator('[data-testid="conversation-title"]')).toContainText('Conversation 0');

      await expect(page.locator('[data-testid="conversation-open-task-button"]')).toHaveCount(0);
      // Copy stays: it needs nothing from a layer.
      await expect(page.locator('[data-testid="conversation-copy-markdown-button"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('re-opening the same conversation focuses it instead of stacking a copy', async () => {
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openMemoryGraph(page);
      await selectFirstResult(page);

      await page.locator('[data-testid="memory-graph-open-conversation"]').click();
      await page.locator('[data-testid="conversation-window"]')
        .waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-testid="memory-graph-open-conversation"]').click();

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
      await openMemoryGraph(page);
      await expect(page.locator('[data-testid="memory-graph-canvas"]'))
        .toHaveAttribute('data-view-mode', '3d');
      await expect(page.locator('[data-testid="memory-graph-view-2d"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="memory-graph-view-3d"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('prints the camera controls as a key legend', async () => {
    // Nothing else in the app is navigated by flying, so none of these gestures
    // transfer from the rest of the UI. Undiscoverable controls on a spatial
    // view mean orbiting by accident and then not knowing how to undo it, so
    // every input is PRINTED - what each one does arrives on hover, since the
    // keys are the part you cannot deduce and the verbs are the part you only
    // read once.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(12) }));
    try {
      await openMemoryGraph(page);
      const legend = page.locator('[data-testid="memory-graph-camera-hint"]');
      await expect(legend).toBeVisible();
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
      const tip = page.locator('[data-testid="memory-graph-camera-tip"]');

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
      const [w, a, s, d] = await Promise.all([cap('W'), cap('A'), cap('S'), cap('D')]);
      expect(w!.y + w!.height).toBeLessThanOrEqual(a!.y + 1);
      expect(a!.x).toBeLessThan(s!.x);
      expect(s!.x).toBeLessThan(d!.x);
      const wCentre = w!.x + w!.width / 2;
      expect(wCentre).toBeGreaterThan(a!.x);
      expect(wCentre).toBeLessThan(d!.x + d!.width);

      // Grouped by what you touch. Q and E are keyboard keys, so they belong
      // beside WASD and not next to Scroll - and the two DRAG gestures, which
      // differ only by a modifier, sit adjacent rather than diagonally apart.
      const [q, drag, rightDrag, scroll] = await Promise.all([
        cap('Q'), cap('Drag'), cap('Right Drag'), cap('Scroll'),
      ]);
      expect(Math.abs(q!.x - d!.x)).toBeLessThan(Math.abs(q!.x - scroll!.x));
      expect(drag!.x).toBeLessThan(rightDrag!.x);
      expect(rightDrag!.x).toBeLessThan(scroll!.x);

      // Reference bottom-left, action bottom-right: Reset view is something you
      // DO, so it does not sit inside the legend.
      const canvas = await page.locator('[data-testid="memory-graph-canvas"]').boundingBox();
      const legendBox = await legend.boundingBox();
      const reset = await page.locator('[data-testid="memory-graph-reset-view"]').boundingBox();
      expect(legendBox!.x).toBeLessThan(canvas!.x + canvas!.width / 2);
      expect(legendBox!.y).toBeGreaterThan(canvas!.y + canvas!.height / 2);
      expect(reset!.x).toBeGreaterThan(canvas!.x + canvas!.width / 2);
      expect(reset!.y).toBeGreaterThan(canvas!.y + canvas!.height / 2);
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
    // Two well-separated blocks, because the fixture's own clustering is
    // INTERLEAVED (`i % 2` over a grid), so hiding a region there leaves the
    // same spatial extent and the assertion could not fail.
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
      await openMemoryGraph(page);
      // The titles are the only thing in the DOM that carries where the camera
      // put the map: they are positioned by projecting each node through it on
      // every rendered frame.
      const titleExtent = async () => page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('[data-testid="memory-graph-node-title"]'))
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
      await page.locator('[data-testid="memory-graph-region-row"]').nth(1).click();
      await page.locator('[data-testid="memory-graph-reset-view"]').click();

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

  test('offers a reset back to the default view', async () => {
    // A camera with orbit, tilt, pan and zoom can end up somewhere with nothing
    // recognisable on screen, so the way back must always be on screen too -
    // never hover-only.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openMemoryGraph(page);
      const canvas = page.locator('[data-testid="memory-graph-canvas"]');
      const reset = page.locator('[data-testid="memory-graph-reset-view"]');
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
      await expect(page.locator('[data-testid="memory-graph-body"]')).toBeVisible();
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
      await openMemoryGraph(page);
      await selectFirstResult(page);

      const neighbor = page.locator('[data-testid="memory-graph-neighbor"]').first();
      await expect(neighbor).toBeVisible();
      await expect(neighbor).not.toContainText('%');
      await expect(neighbor).toHaveAttribute('title', /Cosine similarity 0\.\d+/);
      // The section carries no subtitle. It used to read "Strongest first.
      // Exact, not read off the map.", which defended an implementation detail
      // the reader never asked about.
      await expect(page.locator('[data-testid="memory-graph-detail"]')).not.toContainText('Strongest first');
      await expect(page.locator('[data-testid="memory-graph-detail"]')).not.toContainText('read off the map');
      // Every one of the node's nearest conversations, not just those that
      // survived the mesh quantile - the fixture gives each node three.
      await expect(page.locator('[data-testid="memory-graph-neighbor"]')).toHaveCount(3);
    } finally {
      await browser.close();
    }
  });

  test('explores a neighbourhood and offers a way back', async () => {
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openMemoryGraph(page);
      await selectFirstResult(page);

      // doc-0 links to doc-1 in the fixture, so the action is enabled.
      const explore = page.locator('[data-testid="memory-graph-explore-from"]');
      await expect(explore).toBeEnabled();
      await explore.click();

      // The breadcrumb is what makes the narrowing explainable AND undoable.
      const chip = page.locator('[data-testid="memory-graph-explore-chip"]');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText('Conversation 0');

      await page.locator('[data-testid="memory-graph-explore-clear"]').click();
      await expect(chip).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('goes back to the answer after selecting a conversation', async () => {
    // Selecting a conversation replaced the answer with the detail panel and
    // left no way back to what you had just asked.
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openMemoryGraph(page);
      await selectFirstResult(page);
      await expect(page.locator('[data-testid="memory-graph-detail"]')).toBeVisible();

      const back = page.locator('[data-testid="memory-graph-detail-back"]');
      await expect(back).toContainText('the answer');
      await back.click();

      // The answer is showing again and the detail is gone.
      await expect(page.locator('[data-testid="memory-answer"]')).toBeVisible();
      await expect(page.locator('[data-testid="memory-graph-detail"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('goes back along a trail of followed neighbours', async () => {
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openMemoryGraph(page);
      await selectFirstResult(page);
      await expect(page.locator('[data-testid="memory-graph-detail"]')).toContainText('Conversation 0');

      // Hop to doc-0's only neighbour, doc-1.
      await page.locator('[data-testid="memory-graph-neighbor"]').first().click();
      await expect(page.locator('[data-testid="memory-graph-detail"]')).toContainText('Conversation 1');

      // Back now NAMES where it returns to, rather than being a bare arrow.
      const back = page.locator('[data-testid="memory-graph-detail-back"]');
      await expect(back).toContainText('Conversation 0');
      await back.click();
      await expect(page.locator('[data-testid="memory-graph-detail"]')).toContainText('Conversation 0');
    } finally {
      await browser.close();
    }
  });

  test('the index section is collapsed by default and opens on demand', async () => {
    // One left panel, two sections: Display is what you touch, Index is
    // reference. It used to be a second floating slab pinned to the bottom of
    // the left edge with a screen-height void between them.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openMemoryGraph(page);
      const panel = page.locator('[data-testid="memory-graph-controls"]');
      await expect(panel).toContainText('Display');
      await expect(panel).toContainText('Index');
      // Reference numbers, so the section rests collapsed. The full-width
      // coverage strip is NOT what opens here - that shape is for the states
      // with no map to draw; this panel renders its own aligned row list.
      await expect(page.locator('[data-testid="memory-graph-controls"]')).not.toContainText('Size on disk');
      await expect(page.locator('[data-testid="memory-coverage-strip"]')).toHaveCount(0);

      await page.locator('[data-testid="memory-graph-index-toggle"]').click();
      await expect(page.locator('[data-testid="memory-graph-controls"]')).toContainText('Size on disk');
      await expect(page.locator('[data-testid="memory-graph-controls"]')).toContainText('Chunks');
      await expect(page.locator('[data-testid="memory-coverage-strip"]')).toHaveCount(0);

      // It opens to the SIDE, and that is not cosmetic: Index is the last thing
      // in a column whose middle is a list of every region the index holds, so
      // downward there is nothing left and its rows ran off the bottom of the
      // window. Asserted as geometry because that IS the bug - the rows are in
      // the DOM either way.
      const panelBox = (await panel.boundingBox())!;
      const indexBox = (await page.locator('[data-testid="memory-graph-index-panel"]').boundingBox())!;
      expect(indexBox.x).toBeGreaterThanOrEqual(panelBox.x + panelBox.width - 2);
      expect(indexBox.y + indexBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    } finally {
      await browser.close();
    }
  });
});
