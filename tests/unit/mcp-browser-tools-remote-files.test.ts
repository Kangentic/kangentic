/**
 * The browser tools hand files between the Browser pane (this computer) and an agent on a host through two injected
 * dependencies, `fetchDroppedFiles` and `deliverCapture`. mcp-remote-browser-files.test.ts runs what those do; this runs
 * what the tools do with their answers, through the real registered tools (`registerBrowserTools`):
 *
 * - `browser_drop_files` refuses with `drop-files-unavailable` when a file could not be fetched, and drops this
 *   computer's copies, never the host's paths, when it could.
 * - `saveToFile` on the DOM and eval tools reports the delivered host path and `location`, not the local file.
 *
 * `withGuest` runs the tool body against a stub guest, so the CDP calls are the only thing replaced.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  webContents: { fromId: () => null },
  app: { getPath: () => '/tmp', isPackaged: false },
}));
vi.mock('../../src/main/browser/browser-pane-driver', () => ({
  withGuest: vi.fn(async (_request: unknown, body: (guest: unknown, entry: unknown) => Promise<unknown>) => ({ ok: true, data: await body({}, {}) })),
  validateNavigationUrl: vi.fn((url: string) => ({ ok: true, url })),
  navigateGuest: vi.fn(),
}));
vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    list: vi.fn(() => []),
    listForProject: vi.fn(() => ({ panes: [], otherProjectPaneCount: 0, unknownProjectPaneCount: 0 })),
  },
}));
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  getNetworkEntries: vi.fn(() => []),
  dropFilesOnSelector: vi.fn(async () => true),
  getOuterHtml: vi.fn(async () => '<p>hello</p>'),
  runtimeEvaluate: vi.fn(async () => ({ value: 'page text', error: null })),
}));
// The capture file writer shares this module's pruning helper, so only the CDP captures are replaced.
vi.mock('../../src/main/browser/cdp/screenshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/browser/cdp/screenshot')>()),
  captureScreenshotWithBudget: vi.fn(),
  captureElementClip: vi.fn(),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { dropFilesOnSelector } from '../../src/main/browser/cdp/cdp';
import { withGuest } from '../../src/main/browser/browser-pane-driver';
import { registerBrowserTools, type BrowserToolDependencies } from '../../src/main/agent/mcp-http/browser-tools';
import type { DeliveredCapture } from '../../src/main/agent/mcp-http/browser-capture-file';

const HOST_FILE = '/home/dev/proj/a.png';
const LOCAL_COPY = path.join(os.tmpdir(), 'kangentic-fetched', 'a.png');

let scratch: string;
let client: Client;

async function connect(dependencies: Partial<BrowserToolDependencies>): Promise<void> {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerBrowserTools(
    server,
    () => ({ enabled: true, allowInteraction: true, allowNavigation: true, allowEval: true, restrictNavigationToLocalhost: false }),
    { projectId: 'p1', captureDirectory: () => scratch, ...dependencies },
    undefined,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}

beforeEach(() => {
  vi.clearAllMocks();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-browser-remote-files-'));
});

afterEach(async () => {
  await client.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('kangentic_browser_drop_files on a remote project', () => {
  // Without the refusal the pane gets an empty drop and the agent is told it worked.
  it('refuses with drop-files-unavailable when a file could not be fetched, and drops nothing', async () => {
    await connect({ fetchDroppedFiles: async () => ({ localPaths: [], failures: [`${HOST_FILE}: no such file on the host`] }) });

    const result = await client.callTool({ name: 'kangentic_browser_drop_files', arguments: { selector: '#zone', paths: [HOST_FILE] } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: 'drop-files-unavailable' } });
    expect(JSON.stringify(result.content)).toContain('no such file on the host');
    expect(dropFilesOnSelector).not.toHaveBeenCalled();
  });

  // Without it the pane (on this computer) is asked to open a path that exists only on the host.
  it('drops this computer\'s copies, not the host paths', async () => {
    const fetch = vi.fn(async () => ({ localPaths: [LOCAL_COPY], failures: [] }));
    await connect({ fetchDroppedFiles: fetch });

    const result = await client.callTool({ name: 'kangentic_browser_drop_files', arguments: { selector: '#zone', paths: [HOST_FILE] } });

    expect(result.isError).toBeFalsy();
    expect(fetch).toHaveBeenCalledWith([HOST_FILE], scratch);
    expect(dropFilesOnSelector).toHaveBeenCalledWith(expect.anything(), '#zone', [LOCAL_COPY]);
  });

  // Without it a local project's drop would be sent through a host fetch that returns nothing.
  it('drops the named paths as they are when no host is involved', async () => {
    await connect({ fetchDroppedFiles: async () => null });

    await client.callTool({ name: 'kangentic_browser_drop_files', arguments: { selector: '#zone', paths: ['/tmp/x.txt'] } });

    expect(dropFilesOnSelector).toHaveBeenCalledWith(expect.anything(), '#zone', ['/tmp/x.txt']);
  });
});

// The pane is on this computer wherever the agent runs, so `localhost` in a pane URL is the user's computer. Without
// the label an agent on a host reads it as its own machine and reports its dev server unreachable or reachable wrongly.
describe('a pane URL result is labeled as this computer\'s', () => {
  it('navigate says location local', async () => {
    await connect({});

    const result = await client.callTool({ name: 'kangentic_browser_navigate', arguments: { url: 'http://localhost:5173/' } });

    expect(result.structuredContent).toMatchObject({ url: 'http://localhost:5173/', location: 'local' });
  });

  it('history back says location local', async () => {
    await connect({});
    vi.mocked(withGuest).mockImplementationOnce((async (_request: unknown, body: (guest: unknown, entry: unknown) => Promise<unknown>) => ({
      ok: true,
      data: await body({
        navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
        once: (_event: string, listener: () => void) => listener(),
        off: vi.fn(),
        getURL: () => 'http://localhost:5173/previous',
      }, {}),
    })) as never);

    const result = await client.callTool({ name: 'kangentic_browser_history', arguments: { direction: 'back' } });

    expect(result.structuredContent).toMatchObject({ url: 'http://localhost:5173/previous', location: 'local' });
  });

  it('the network log says location local', async () => {
    await connect({});

    const result = await client.callTool({ name: 'kangentic_browser_network', arguments: {} });

    expect(result.structuredContent).toMatchObject({ returned: 0, location: 'local' });
  });

  it('list_panes says location local, so a pane URL is not read as the host\'s', async () => {
    await connect({});

    const result = await client.callTool({ name: 'kangentic_browser_list_panes', arguments: {} });

    expect(result.structuredContent).toMatchObject({ projectId: 'p1', location: 'local' });
  });
});

describe('saveToFile on a remote project', () => {
  const delivered: DeliveredCapture = {
    filePath: '/home/dev/proj/.kangentic/captures/shared/dom-1.html',
    fileUri: 'file:///home/dev/proj/.kangentic/captures/shared/dom-1.html',
    bytes: 12,
    location: 'host',
    localFilePath: path.join(os.tmpdir(), 'shell', 'dom-1.html'),
  };

  // Without it the agent is handed a Windows path on this computer to read back from the host.
  it('query_dom returns the delivered host path and its location, with the HTML left out of the reply', async () => {
    const deliverCapture = vi.fn(async () => delivered);
    await connect({ deliverCapture });

    const result = await client.callTool({ name: 'kangentic_browser_query_dom', arguments: { selector: 'p', saveToFile: true } });

    expect(deliverCapture).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ filePath: delivered.filePath, location: 'host', localFilePath: delivered.localFilePath });
    expect(JSON.stringify(result.content)).not.toContain('<p>hello</p>');
  });

  it('eval returns the delivered host path and its location', async () => {
    await connect({ deliverCapture: async () => delivered });

    const result = await client.callTool({ name: 'kangentic_browser_eval', arguments: { expression: 'document.title', saveToFile: true } });

    expect(result.structuredContent).toMatchObject({ filePath: delivered.filePath, location: 'host', localFilePath: delivered.localFilePath });
  });

  // Without the failure reaching the agent, a path that was never copied is named as if it had been.
  it('reports save-failed when the delivery to the host fails', async () => {
    await connect({ deliverCapture: async () => { throw new Error('the link is down'); } });

    const result = await client.callTool({ name: 'kangentic_browser_eval', arguments: { expression: '1', saveToFile: true } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: 'save-failed' } });
    expect(JSON.stringify(result.content)).toContain('the link is down');
  });
});
