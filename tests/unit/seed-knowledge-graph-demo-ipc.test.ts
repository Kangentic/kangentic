/**
 * `registerSeedKnowledgeGraphDemoDevIpc` (src/devtools/main/seed-knowledge-graph-demo.ts) is the one
 * line between the preview's renderer and the seeder: it answers `dev:seedKnowledgeGraphDemo`, which
 * scripts/capture-demo-knowledge-graph.mjs calls through `window.electronAPI.dev`. The seeder's own
 * behavior is pinned in seed-knowledge-graph-demo.test.ts against real databases. This file pins the
 * registration around it, which nothing else exercised: the channel it answers, that registering twice
 * answers once, that a handler asked before the IPC context exists says so, and that a call reaches the
 * seeder with the context's `projectRepo` and the plan it was sent.
 *
 * It is its own file because `vi.mock('electron')` applies to a whole file, and the seeder suite needs
 * the real modules under it. The registration guard is a module-level flag, so each test loads a fresh
 * copy of the module (`vi.resetModules`) and gets a fresh flag.
 *
 * Delegation is proven without writing a database row. The fake context lists one project at path P, and
 * the plan puts one project at P, so the seeder's own "already registered at P" refusal fires only if both
 * the context and the plan reached it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { DevSeedKnowledgeGraphDemoPlan } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

type Handler = (event: unknown, plan: DevSeedKnowledgeGraphDemoPlan) => unknown;

const registeredChannels = vi.hoisted(() => [] as string[]);
const handlersByChannel = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/tmp'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredChannels.push(channel);
      handlersByChannel.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

const PLANNED_PATH = '/kg-demo-ipc-test/already-registered';

/** A context whose project list holds one project at PLANNED_PATH. Only `projectRepo.list` is read. */
function contextWithProjectAt(projectPath: string): IpcContext {
  return { projectRepo: { list: () => [{ path: projectPath }] } } as unknown as IpcContext;
}

/** One planned project at `projectPath` that carries no rows, so a refusal is the only thing it can produce. */
function planAt(projectPath: string): DevSeedKnowledgeGraphDemoPlan {
  return {
    projects: [{ key: 'ipc-project', name: 'Sample ipc', path: projectPath, defaultAgent: 'claude', tasks: [], backlog: [], sessions: [] }],
  };
}

async function loadFreshModule(): Promise<typeof import('../../src/devtools/main/seed-knowledge-graph-demo')> {
  vi.resetModules();
  return import('../../src/devtools/main/seed-knowledge-graph-demo');
}

function handlerFor(channel: string): Handler {
  const handler = handlersByChannel.get(channel);
  if (!handler) throw new Error(`nothing is registered on ${channel}`);
  return handler as Handler;
}

describe('registerSeedKnowledgeGraphDemoDevIpc', () => {
  beforeEach(() => {
    registeredChannels.length = 0;
    handlersByChannel.clear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('answers on dev:seedKnowledgeGraphDemo, and on no other channel', async () => {
    const { registerSeedKnowledgeGraphDemoDevIpc } = await loadFreshModule();

    registerSeedKnowledgeGraphDemoDevIpc(() => null);

    expect(registeredChannels).toEqual([IPC.DEV_SEED_KNOWLEDGE_GRAPH_DEMO]);
    expect(IPC.DEV_SEED_KNOWLEDGE_GRAPH_DEMO).toBe('dev:seedKnowledgeGraphDemo');
  });

  it('answers once however many times it is registered, since a second handle on a channel throws in Electron', async () => {
    const { registerSeedKnowledgeGraphDemoDevIpc } = await loadFreshModule();

    registerSeedKnowledgeGraphDemoDevIpc(() => null);
    registerSeedKnowledgeGraphDemoDevIpc(() => contextWithProjectAt(PLANNED_PATH));

    expect(registeredChannels).toEqual([IPC.DEV_SEED_KNOWLEDGE_GRAPH_DEMO]);
    // The first registration's context getter is the one that answers: the second call changed nothing.
    expect(() => handlerFor(IPC.DEV_SEED_KNOWLEDGE_GRAPH_DEMO)({}, planAt(PLANNED_PATH))).toThrow('IPC not initialized');
  });

  it('says the IPC is not initialized when it is asked before the context exists', async () => {
    const { registerSeedKnowledgeGraphDemoDevIpc } = await loadFreshModule();
    registerSeedKnowledgeGraphDemoDevIpc(() => null);

    expect(() => handlerFor(IPC.DEV_SEED_KNOWLEDGE_GRAPH_DEMO)({}, planAt(PLANNED_PATH))).toThrow('IPC not initialized');
  });

  it('reads the context when the handler runs, not when it is registered', async () => {
    const { registerSeedKnowledgeGraphDemoDevIpc } = await loadFreshModule();
    let context: IpcContext | null = null;
    registerSeedKnowledgeGraphDemoDevIpc(() => context);
    const handler = handlerFor(IPC.DEV_SEED_KNOWLEDGE_GRAPH_DEMO);

    expect(() => handler({}, planAt(PLANNED_PATH))).toThrow('IPC not initialized');
    // The context comes up after registration, as it does in the preview, and the same handler now reaches the seeder.
    context = contextWithProjectAt(PLANNED_PATH);
    expect(() => handler({}, planAt(PLANNED_PATH))).toThrow(`A project is already registered at ${PLANNED_PATH}`);
  });

  it('hands the context\'s project list and the sent plan to the seeder', async () => {
    const { registerSeedKnowledgeGraphDemoDevIpc } = await loadFreshModule();
    registerSeedKnowledgeGraphDemoDevIpc(() => contextWithProjectAt(PLANNED_PATH));

    // The refusal names the planned path, so it is the plan this call sent that reached the seeder.
    expect(() => handlerFor(IPC.DEV_SEED_KNOWLEDGE_GRAPH_DEMO)({}, planAt(PLANNED_PATH))).toThrow(`A project is already registered at ${PLANNED_PATH}`);
  });

  it('refuses a plan with no projects array through the handler, as a script could send one', async () => {
    const { registerSeedKnowledgeGraphDemoDevIpc } = await loadFreshModule();
    registerSeedKnowledgeGraphDemoDevIpc(() => contextWithProjectAt(PLANNED_PATH));

    expect(() => handlerFor(IPC.DEV_SEED_KNOWLEDGE_GRAPH_DEMO)({}, {} as DevSeedKnowledgeGraphDemoPlan)).toThrow('The demo graph plan carries no projects array');
  });
});
