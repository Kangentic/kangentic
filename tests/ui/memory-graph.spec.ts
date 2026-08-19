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
        "clusters: { coarse: 0, balanced: i % 2, fine: i % 3 },",
        'clusters: { coarse: i % 2, balanced: i % 2, fine: i % 2 },',
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
        agent: 'Claude Code',
        model: 'Opus 5',
        effort: 'high',
        lastActivityMs: 1700000000000 + i * 1000,
        outcome: i % 3 === 0 ? 'done' : (i % 3 === 1 ? 'active' : 'done'),
        // Every granularity, since the projection ships all three. The
        // fixture keeps them DIFFERENT so a test cannot pass by reading the
        // wrong one: coarse merges what balanced splits.
        clusters: { coarse: 0, balanced: i % 2, fine: i % 3 },
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
 * A graph plus one search hit resolving to node 0, plus a real transcript for
 * that node's session.
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
        memoryGraphQueryResult: {
          query: 'conversation', semantic: true,
          hits: [{ docKey: 'conversation::doc-0', sessionId: 'session-0', taskId: 'task-0', taskTitle: 'Conversation 0', agentName: 'claude', snippet: 'a snippet', score: 1, matchKind: 'hybrid', matchCount: 2, turnTs: null }],
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

/** Select node 0 through the search rail. Deterministic, unlike clicking canvas
 *  pixels - which this tier deliberately never does. */
async function selectFirstResult(page: Page): Promise<void> {
  await page.locator('[data-testid="memory-graph-search-input"]').fill('conversation');
  await page.locator('[data-testid="memory-graph-result-card"]').first().click();
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

  test('a query lights matching nodes and lists them as cards', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphQueryResult: {
            query: 'terminal resize',
            semantic: true,
            hits: [
              { docKey: 'conversation::doc-3', sessionId: 's-3', taskId: 't-3', taskTitle: 'Fix PTY resize', agentName: 'claude', snippet: 'the terminal resize debounce', score: 0.9, matchKind: 'hybrid', matchCount: 4, turnTs: null },
              { docKey: 'conversation::doc-7', sessionId: 's-7', taskId: null, taskTitle: null, agentName: 'claude', snippet: 'conpty width drift', score: 0.7, matchKind: 'semantic', matchCount: 1, turnTs: null }
            ],
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('terminal resize');
      await page.keyboard.press('Enter');

      const cards = page.locator('[data-testid="memory-graph-result-card"]');
      await expect(cards).toHaveCount(2);
      await expect(cards.first()).toContainText('Fix PTY resize');
      // A hit with no task still renders rather than being dropped.
      await expect(cards.nth(1)).toContainText('Untitled conversation');
      // The hit count is stated against the corpus size.
      await expect(page.locator('[data-testid="memory-graph-body"]')).toContainText('2 of 30');
    } finally {
      await browser.close();
    }
  });

  test('searches as you type, without pressing Enter', async () => {
    // The surface's premise is watching matches light up on the map, which a
    // submit-to-search box cannot do. Retrieval is local and free, so there is
    // no cost reason to gate it behind Enter.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(10) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphQueryResult: {
            query: 'x', semantic: true,
            hits: [{ docKey: 'conversation::doc-2', sessionId: 's-2', taskId: null, taskTitle: 'Typed match', agentName: null, snippet: 'y', score: 1, matchKind: 'hybrid', matchCount: 1, turnTs: null }],
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').pressSequentially('pty', { delay: 20 });
      await expect(page.locator('[data-testid="memory-graph-result-card"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="memory-graph-results"]')).toContainText('Typed match');
    } finally {
      await browser.close();
    }
  });

  test('says when a search was lexical-only', async () => {
    // Silently returning worse results would be the wrong failure mode.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(10) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphQueryResult: {
            query: 'x', semantic: false,
            hits: [{ docKey: 'conversation::doc-1', sessionId: 's-1', taskId: null, taskTitle: 'A', agentName: null, snippet: 'x', score: 1, matchKind: 'lexical', matchCount: 1, turnTs: null }],
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('x');
      await page.keyboard.press('Enter');
      // Attached to the SEARCH box rather than to the results list: it explains
      // the search that ran, not the hits it returned, and it must still show
      // when a lexical search returns nothing.
      await expect(page.locator('[data-testid="memory-graph-body"]')).toContainText('Searched text only');
    } finally {
      await browser.close();
    }
  });

  test('clearing the search removes the cards', async () => {
    const preConfig = `${snapshotScript({ projection: projectionLiteral(10) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphQueryResult: {
            query: 'x', semantic: true,
            hits: [{ docKey: 'conversation::doc-1', sessionId: 's-1', taskId: null, taskTitle: 'A', agentName: null, snippet: 'x', score: 1, matchKind: 'hybrid', matchCount: 1, turnTs: null }],
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('x');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="memory-graph-results"]')).toBeVisible();
      await page.locator('[data-testid="memory-graph-clear-search"]').click();
      await expect(page.locator('[data-testid="memory-graph-results"]')).toBeHidden();
    } finally {
      await browser.close();
    }
  });

  test('a result card selects the node and offers to open the conversation', async () => {
    // The point of the whole surface: a node has to lead somewhere. The first
    // version showed a raw hash and offered nothing to do with it.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphQueryResult: {
            query: 'x', semantic: true,
            hits: [{ docKey: 'conversation::doc-3', sessionId: 's-3', taskId: 't-3', taskTitle: 'Fix PTY resize', agentName: 'claude', snippet: 'resize debounce', score: 0.9, matchKind: 'hybrid', matchCount: 2, turnTs: null }],
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('x');
      await page.locator('[data-testid="memory-graph-result-card"]').click();

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
    const preConfig = `${snapshotScript({ projection: projectionLiteral(12) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphQueryResult: {
            query: 'x', semantic: true,
            hits: [{ docKey: 'conversation::doc-5', sessionId: 's-5', taskId: null, taskTitle: 'A', agentName: null, snippet: 'y', score: 1, matchKind: 'hybrid', matchCount: 1, turnTs: null }],
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('x');
      await page.locator('[data-testid="memory-graph-result-card"]').click();
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
        .toEqual(['conversation:session-5']);
    } finally {
      await browser.close();
    }
  });

  test('offers topic, recency, outcome and length colour modes', async () => {
    // "Length", not "Depth": the old name meant conversation length and
    // collided with the depth the user now flies through.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(20) }));
    try {
      await openMemoryGraph(page);
      // A Select, not a segmented control: four labels never fit the panel's
      // width, and `ui-conventions` names Select for exactly that case.
      const select = page.locator('[data-testid="memory-graph-color-mode"]');
      for (const [value, label] of [['cluster', 'Topic'], ['recency', 'Recency'], ['outcome', 'Outcome'], ['size', 'Length']]) {
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
      await expect(page.locator('[data-testid="memory-graph-filter-outcome"]')).toContainText('Reached Done');
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

  test('a filter narrows a search rather than replacing it', async () => {
    // Search asks "which conversations", a facet asks "which part of the index".
    // They have to compose, and the CARD LIST has to agree with the map - a
    // scoped map under an unfiltered list reads as a broken filter.
    // doc-3 is `active` in the fixture (3 % 3 === 0 is done, so 3 is done...);
    // the two hits below deliberately straddle the outcome split.
    const preConfig = `${snapshotScript({ projection: projectionLiteral(20) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphQueryResult: {
            query: 'terminal',
            semantic: true,
            hits: [
              { docKey: 'conversation::doc-3', sessionId: 's-3', taskId: null, taskTitle: 'Done one', agentName: null, snippet: 'x', score: 0.9, matchKind: 'hybrid', matchCount: 1, turnTs: null },
              { docKey: 'conversation::doc-4', sessionId: 's-4', taskId: null, taskTitle: 'Active one', agentName: null, snippet: 'y', score: 0.8, matchKind: 'hybrid', matchCount: 1, turnTs: null }
            ],
          },
        };
      });`;
    const { browser, page } = await launchWithState(preConfig);
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-search-input"]').fill('terminal');
      await expect(page.locator('[data-testid="memory-graph-result-card"]')).toHaveCount(2);

      // doc-3 reached Done (3 % 3 === 0), doc-4 is still active, so scoping to
      // Done must drop exactly one card AND the header count with it.
      await page.locator('[data-testid="memory-graph-filter-outcome"]').selectOption('done');
      await expect(page.locator('[data-testid="memory-graph-result-card"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="memory-graph-result-card"]')).toContainText('Done one');

      await page.locator('[data-testid="memory-graph-filter-outcome"]').selectOption('any');
      await expect(page.locator('[data-testid="memory-graph-result-card"]')).toHaveCount(2);
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
      await expect(outcome).toContainText('Reached Done');
      await expect(outcome).toContainText('Still on the board');
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
      await expect(page.locator('[data-testid="memory-graph-filter-outcome"]')).toContainText('Abandoned');
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

  test('says WHY the selected conversation matched the search', async () => {
    // The gap this closes: after filtering, selecting a node dropped the query
    // entirely - global neighbours, no mention of the search that got you here -
    // so the thread of "I am exploring X" broke on the first click.
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openMemoryGraph(page);
      await selectFirstResult(page);

      const why = page.locator('[data-testid="memory-graph-why-matched"]');
      await expect(why).toBeVisible();
      await expect(why).toContainText('Result 1 of 1');
      // The match KIND in plain language, which is the honest answer to "is this
      // really semantic search or just a text scan?"
      await expect(why).toContainText('wording and meaning');
      await expect(why).toContainText('a snippet');
    } finally {
      await browser.close();
    }
  });

  test('shows no "why" section when nothing was searched', async () => {
    // It answers a question the user did not ask if there is no query.
    const { browser, page } = await launchWithState(snapshotScript({ projection: projectionLiteral(30) }));
    try {
      await openMemoryGraph(page);
      await page.locator('[data-testid="memory-graph-canvas"]').waitFor({ state: 'visible' });
      await expect(page.locator('[data-testid="memory-graph-why-matched"]')).toHaveCount(0);
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

  test('marks neighbours that are also search results', async () => {
    // Ties the neighbourhood back to the query: which of these are ALSO answers
    // to what you asked, and which are merely near this one conversation.
    const bothHits = `${snapshotScript({ projection: projectionLiteral(30) })}
      window.__mockPreConfigure(function () {
        return {
          memoryGraphQueryResult: {
            query: 'conversation', semantic: true,
            hits: [
              { docKey: 'conversation::doc-0', sessionId: 'session-0', taskId: 't0', taskTitle: 'Conversation 0', agentName: 'claude', snippet: 's', score: 1, matchKind: 'semantic', matchCount: 1, turnTs: null },
              { docKey: 'conversation::doc-1', sessionId: 'session-1', taskId: 't1', taskTitle: 'Conversation 1', agentName: 'claude', snippet: 's', score: 0.9, matchKind: 'semantic', matchCount: 1, turnTs: null }
            ],
          },
        };
      });`;
    const { browser, page } = await launchWithState(bothHits);
    try {
      await openMemoryGraph(page);
      await selectFirstResult(page);
      // doc-0's only neighbour is doc-1, which is also hit 2.
      await expect(page.locator('[data-testid="memory-graph-neighbor-in-results"]')).toHaveCount(1);
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

  test('goes back to the results after selecting one', async () => {
    // Selecting a card replaced the results list with the detail panel and left
    // no way back to the search you had just run.
    const { browser, page } = await launchWithState(conversationFixture());
    try {
      await openMemoryGraph(page);
      await selectFirstResult(page);
      await expect(page.locator('[data-testid="memory-graph-detail"]')).toBeVisible();

      const back = page.locator('[data-testid="memory-graph-detail-back"]');
      await expect(back).toContainText('results');
      await back.click();

      // The results list is showing again and the detail is gone.
      await expect(page.locator('[data-testid="memory-graph-results"]')).toBeVisible();
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
    } finally {
      await browser.close();
    }
  });
});
