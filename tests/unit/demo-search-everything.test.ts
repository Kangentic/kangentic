/**
 * `window.electronAPI.search.everything` (tests/captures/helpers/demo-dataset.ts's generated
 * seed) answers Quick Find for the web demo: a keyword match over the sample install's tasks,
 * backlog, and session events, scoped the way the palette asks. The `demo` tier only ever types
 * "auth" against the default (this-project) scope (tests/captures/scenes.ts's
 * `quick-find-results` scene), which exercises exactly one project and one snippet field (a title
 * match). This file covers what that scene cannot reach without driving a real browser through
 * every combination: the `scope: 'all'` toggle, the backlog and session_event kinds, an archived
 * task hit, the description-only match, and the snippet's ellipsis/offset arithmetic.
 *
 * `buildDemoPreConfig` returns its seed as a template string meant to run inside a browser page,
 * not as an importable module (see its own top comment: no Node imports). This file reaches into
 * the raw .ts source the way demo-message-trail-replay.test.ts already does for `trailAt` and
 * `setMessageTrail`: it extracts the real function source and builds a callable with `new
 * Function` over synthetic closures. The .ts source is read directly rather than the generated
 * seed (demo-frame-fit.test.ts's route), because neither function under test contains a `\x1b`
 * escape that only materializes after template evaluation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DATASET_PATH = path.resolve(__dirname, '..', 'captures', 'helpers', 'demo-dataset.ts');
const DATASET_SOURCE = fs.readFileSync(DATASET_PATH, 'utf-8');

interface SearchSnippetMatch {
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

type SearchSnippetFunction = (text: string, query: string) => SearchSnippetMatch | null;

interface EverythingRequest {
  query?: string;
  scope?: string;
  currentProjectId?: string | null;
}

interface SearchHit {
  kind: 'task' | 'backlog' | 'session_event';
  projectId: string;
  projectName: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
  snippetField?: 'title' | 'description';
  archived?: boolean;
  taskId?: string;
  taskTitle?: string;
  backlogId?: string;
  backlogTitle?: string;
  sessionId?: string;
  agentName?: string;
  eventKey?: string;
  eventTs?: number;
  eventType?: string;
  displayId?: number;
}

type EverythingFunction = (request: EverythingRequest) => Promise<SearchHit[]>;

interface SyntheticTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  display_id: number;
  agent: string | null;
}

interface SyntheticBacklogItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
}

interface SyntheticSession {
  id: string;
  taskId: string | null;
  projectId: string;
}

interface SyntheticEvent {
  ts: number;
  type: string;
  tool: string;
  detail: string;
}

interface SyntheticMockState {
  tasks: SyntheticTask[];
  archivedTasks: SyntheticTask[];
  backlogTasks: SyntheticBacklogItem[];
  sessions: SyntheticSession[];
  eventCache: Record<string, SyntheticEvent[]>;
}

interface SyntheticProject {
  name: string;
  default_agent: string;
}

/**
 * The real source of `function <name>(...) { ... }` inside demo-dataset.ts's generated script,
 * brace-balanced from the first `{` after the marker. Throws rather than returning an empty
 * string when `name` is not found, so a rename cannot make every test below vacuously pass on an
 * empty function body (mirrors demo-message-trail-replay.test.ts's extractFunction).
 */
function extractFunction(name: string): string {
  const marker = `function ${name}(`;
  const start = DATASET_SOURCE.indexOf(marker);
  if (start === -1) throw new Error(`no "${marker}" found in demo-dataset.ts`);
  const open = DATASET_SOURCE.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < DATASET_SOURCE.length; index += 1) {
    if (DATASET_SOURCE[index] === '{') depth += 1;
    if (DATASET_SOURCE[index] === '}') {
      depth -= 1;
      if (depth === 0) return DATASET_SOURCE.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced function ${name} in demo-dataset.ts`);
}

/**
 * The real source of the `window.electronAPI.search.everything = function (request) { ... }`
 * assignment's function EXPRESSION (excluding the trailing `;`), brace-balanced from the marker's
 * own closing `{`. The marker is the literal prefix up to and including that brace, so a rename of
 * the assignment target or the parameter name throws here rather than silently extracting nothing.
 */
function extractEverythingFunctionExpression(): string {
  const prefix = 'window.electronAPI.search.everything = ';
  const marker = `${prefix}function (request) {`;
  const start = DATASET_SOURCE.indexOf(marker);
  if (start === -1) throw new Error(`no "${marker}" found in demo-dataset.ts`);
  const functionStart = start + prefix.length;
  const open = start + marker.length - 1;
  let depth = 0;
  for (let index = open; index < DATASET_SOURCE.length; index += 1) {
    if (DATASET_SOURCE[index] === '{') depth += 1;
    if (DATASET_SOURCE[index] === '}') {
      depth -= 1;
      if (depth === 0) return DATASET_SOURCE.slice(functionStart, index + 1);
    }
  }
  throw new Error('unbalanced window.electronAPI.search.everything function in demo-dataset.ts');
}

function buildSearchSnippet(): SearchSnippetFunction {
  const factory = new Function(`${extractFunction('searchSnippet')}\nreturn searchSnippet;`) as () => SearchSnippetFunction;
  return factory();
}

/**
 * Builds the real `window.electronAPI.search.everything` handler over synthetic `mockState` /
 * `projectsById` / `tasksById` closures (the only three the extracted body reads besides
 * `searchSnippet`, which is declared alongside it so hoisting resolves it, as
 * demo-message-trail-replay.test.ts's buildSetMessageTrail does).
 */
function buildEverything(
  mockState: SyntheticMockState | null,
  projectsById: Record<string, SyntheticProject>,
  tasksById: Record<string, SyntheticTask>,
): EverythingFunction {
  const factory = new Function(
    'mockState',
    'projectsById',
    'tasksById',
    `${extractFunction('searchSnippet')}\nreturn (${extractEverythingFunctionExpression()});`,
  ) as (
    injectedMockState: SyntheticMockState | null,
    injectedProjectsById: Record<string, SyntheticProject>,
    injectedTasksById: Record<string, SyntheticTask>,
  ) => EverythingFunction;
  return factory(mockState, projectsById, tasksById);
}

describe('searchSnippet() extracted from buildDemoPreConfig\'s generated script', () => {
  it('reports no ellipsis and a matchStart/matchEnd that slice the raw query back out, when the match is near the start', () => {
    const searchSnippet = buildSearchSnippet();
    const text = 'Add user auth flow';
    const match = searchSnippet(text, 'auth');
    expect(match).not.toBeNull();
    expect(match?.snippet.startsWith('…')).toBe(false);
    expect(text.slice(match!.matchStart, match!.matchEnd)).toBe('auth');
  });

  it('prepends an ellipsis and shifts matchStart/matchEnd by one to account for its width, once the match sits past the 40-character lookback', () => {
    const searchSnippet = buildSearchSnippet();
    const text = `${'A'.repeat(50)}MATCHTOKEN${'B'.repeat(50)}`;
    const match = searchSnippet(text, 'matchtoken');
    expect(match).not.toBeNull();
    expect(match?.snippet.startsWith('…')).toBe(true);
    // The `+ (start > 0 ? 1 : 0)` in `offset = at - start + (start > 0 ? 1 : 0)` is exactly the
    // ellipsis character's own width; drop it and this slice comes back one character short.
    expect(match?.snippet.slice(match!.matchStart, match!.matchEnd)).toBe('MATCHTOKEN');
  });

  it('returns null when the query is not present', () => {
    const searchSnippet = buildSearchSnippet();
    expect(searchSnippet('Add user auth flow', 'nope')).toBeNull();
  });
});

describe('window.electronAPI.search.everything() extracted from buildDemoPreConfig\'s generated script', () => {
  const PROJECT_A = 'proj-a';
  const PROJECT_B = 'proj-b';

  function emptyMockState(): SyntheticMockState {
    return { tasks: [], archivedTasks: [], backlogTasks: [], sessions: [], eventCache: {} };
  }

  const projectsById: Record<string, SyntheticProject> = {
    [PROJECT_A]: { name: 'project-a', default_agent: 'claude' },
    [PROJECT_B]: { name: 'project-b', default_agent: 'codex' },
  };

  it('scopes hits to the current project by default, and returns every project\'s hits when scope is "all"', async () => {
    const mockState = emptyMockState();
    mockState.tasks.push(
      { id: 'task-a', projectId: PROJECT_A, title: 'Fix auth redirect', description: '', display_id: 1, agent: null },
      { id: 'task-b', projectId: PROJECT_B, title: 'Rewrite auth guard', description: '', display_id: 1, agent: null },
    );
    const everything = buildEverything(mockState, projectsById, {});

    const scoped = await everything({ query: 'auth', currentProjectId: PROJECT_A });
    expect(scoped.map((hit) => hit.projectId)).toEqual([PROJECT_A]);

    const all = await everything({ query: 'auth', scope: 'all', currentProjectId: PROJECT_A });
    expect(all.map((hit) => hit.projectId).sort()).toEqual([PROJECT_A, PROJECT_B]);
  });

  it('reports snippetField "title" for a title match and "description" for a description-only match', async () => {
    const mockState = emptyMockState();
    mockState.tasks.push(
      { id: 'task-title', projectId: PROJECT_A, title: 'Fix auth redirect', description: 'nothing relevant here', display_id: 1, agent: null },
      { id: 'task-description', projectId: PROJECT_A, title: 'Unrelated title', description: 'the auth flow needs a retry', display_id: 2, agent: null },
    );
    const everything = buildEverything(mockState, projectsById, {});
    const hits = await everything({ query: 'auth', currentProjectId: PROJECT_A });
    const byTaskId = new Map(hits.map((hit) => [hit.taskId, hit]));
    expect(byTaskId.get('task-title')?.snippetField).toBe('title');
    expect(byTaskId.get('task-description')?.snippetField).toBe('description');
  });

  it('classifies a backlog hit and an archived task hit with its archived flag set', async () => {
    const mockState = emptyMockState();
    mockState.archivedTasks.push({ id: 'task-archived', projectId: PROJECT_A, title: 'Old auth cleanup', description: '', display_id: 3, agent: null });
    mockState.backlogTasks.push({ id: 'backlog-1', projectId: PROJECT_A, title: 'Backlog auth item', description: '' });
    const everything = buildEverything(mockState, projectsById, {});
    const hits = await everything({ query: 'auth', currentProjectId: PROJECT_A });

    const backlogHit = hits.find((hit) => hit.kind === 'backlog');
    expect(backlogHit?.backlogId).toBe('backlog-1');

    const archivedHit = hits.find((hit) => hit.kind === 'task' && hit.taskId === 'task-archived');
    expect(archivedHit?.archived).toBe(true);
  });

  it('classifies a session_event hit with its own eventKey and falls back to the project default agent', async () => {
    const mockState = emptyMockState();
    const task: SyntheticTask = { id: 'task-with-session', projectId: PROJECT_A, title: 'Unrelated', description: '', display_id: 4, agent: null };
    mockState.tasks.push(task);
    mockState.sessions.push({ id: 'sess-1', taskId: task.id, projectId: PROJECT_A });
    mockState.eventCache['sess-1'] = [{ ts: 12345, type: 'tool_start', tool: 'Edit', detail: 'src/auth.ts' }];
    const everything = buildEverything(mockState, projectsById, { [task.id]: task });

    const hits = await everything({ query: 'auth', currentProjectId: PROJECT_A });
    const eventHit = hits.find((hit) => hit.kind === 'session_event');
    expect(eventHit?.eventKey).toBe('sess-1:12345');
    // task.agent is null on the seeded task, so the hit falls back to the project's own
    // default_agent rather than reporting no agent at all.
    expect(eventHit?.agentName).toBe('claude');
  });

  it('returns no hits for an empty query, and no hits when mockState has not been seeded yet', async () => {
    const everythingWithState = buildEverything(emptyMockState(), projectsById, {});
    expect(await everythingWithState({ query: '', currentProjectId: PROJECT_A })).toEqual([]);

    const everythingWithoutState = buildEverything(null, projectsById, {});
    expect(await everythingWithoutState({ query: 'auth', currentProjectId: PROJECT_A })).toEqual([]);
  });
});
