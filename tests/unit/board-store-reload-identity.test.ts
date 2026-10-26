/**
 * A board reload keeps the identity of the store's lists when the data did not change.
 *
 * Every IPC list call hands the renderer freshly deserialized objects, so a slice that
 * stored the payload as it arrived gave every subscriber a new array on every reload,
 * and every reload an agent's task update causes re-rendered the whole app. The slices
 * now keep the previous value (`keepIfUnchanged`, `keepIfSameJson`). The helpers have
 * their own tests in structural-sharing.test.ts; those stay green if a slice goes back
 * to a plain `set({ shortcuts })`. These tests drive the REAL board store through its
 * loaders, with a fake `window.electronAPI` that, like IPC, answers every call with a
 * fresh deep copy, and pin what a subscriber sees:
 *
 * - an equal reload leaves the same array in the store (`toBe`);
 * - a reload that changed one thing replaces the array and reads the new value, so the
 *   sharing never hides a real change.
 *
 * Two traps keep a case from passing vacuously, and every case guards against both:
 * - The fake serves a NEW copy per call and logs it, so a case asserts the second payload
 *   is a different object than the first and that the store does not hold it. A slice
 *   that reverted to storing the payload would hold the second payload and fail `toBe`.
 * - The loaders swallow errors, so a mis-shaped fake leaves the initial `[]` in place and
 *   `toBe` passes against itself. A case checks the first load populated the store.
 *
 * The task list is not asserted for identity: `applyTaskListPayload` returns a new outer
 * array on every reload by design, so the board's lane memos re-evaluate.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBoardStore } from '../../src/renderer/stores/board-store';
import type {
  BoardProfile,
  ColumnAutomation,
  ShortcutConfig,
  Swimlane,
  Task,
} from '../../src/shared/types';

type BoardStoreHandle = ReturnType<typeof createBoardStore>;
type ShortcutRow = ShortcutConfig & { source: 'team' | 'local' };

const CREATED_AT = '2026-10-01T00:00:00.000Z';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    display_id: 1,
    description: '',
    swimlane_id: 'lane-todo',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    worktree_folder: null,
    worktree_skip_reason: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_merge_readiness: null,
    head_sha: null,
    pushed_branch: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    run_mode: 'column_settings',
    automations_disabled: false,
    archived_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

function makeArchivedTask(id: string, title: string): Task {
  return makeTask({ id, title, swimlane_id: 'lane-done', archived_at: '2026-10-02T00:00:00.000Z' });
}

function makeLane(id: string, name: string, position: number, role: 'todo' | 'done'): Swimlane {
  return {
    id,
    name,
    description: null,
    role,
    position,
    color: '#336699',
    // Null on purpose: a name outside the core icon set makes the loader await a dynamic
    // import of lucide's full map, which has no place in a unit test of identity.
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: null,
    auto_command_mode: 'immediate',
    plan_exit_target_id: null,
    plan_approval: 'manual',
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: CREATED_AT,
  };
}

function makeShortcut(id: string, label: string, command: string, source: 'team' | 'local'): ShortcutRow {
  return { id, label, command, icon: 'zap', display: 'both', source };
}

function makeAutomation(id: string, swimlaneId: string, message: string): ColumnAutomation {
  return {
    id,
    swimlane_id: swimlaneId,
    name: `Automation ${id}`,
    type: 'send_message',
    trigger: 'enter',
    position: 0,
    enabled: true,
    config: { message },
    condition: null,
    final_line: null,
    max_runs: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function makeProfile(id: string, name: string, modelOverride: string): BoardProfile {
  return { id, name, columns: { 'lane-todo': { modelOverride } } };
}

/** What the fake main process currently answers. A case edits it between two loads. */
interface ServedData {
  tasks: Task[];
  swimlanes: Swimlane[];
  archivedPreview: Task[];
  archivedTotalCount: number;
  shortcuts: ShortcutRow[];
  automations: ColumnAutomation[];
  boardProfiles: BoardProfile[];
}

/** Every payload the fake handed out, per call, so a case can tell a kept value from a stored payload. */
interface PayloadLog {
  swimlanes: Swimlane[][];
  archivedPreview: Task[][];
  shortcuts: ShortcutRow[][];
  automations: ColumnAutomation[][];
  boardProfiles: BoardProfile[][];
}

function buildServed(): ServedData {
  return {
    tasks: [
      makeTask({ id: 'task-a', title: 'First task', position: 0 }),
      makeTask({ id: 'task-b', title: 'Second task', position: 1 }),
    ],
    swimlanes: [
      makeLane('lane-todo', 'To Do', 0, 'todo'),
      makeLane('lane-done', 'Done', 1, 'done'),
    ],
    archivedPreview: [
      makeArchivedTask('archived-a', 'Archived first'),
      makeArchivedTask('archived-b', 'Archived second'),
    ],
    archivedTotalCount: 2,
    shortcuts: [
      makeShortcut('shortcut-a', 'Open in editor', 'code "{{cwd}}"', 'team'),
      makeShortcut('shortcut-b', 'Run tests', 'npm test', 'local'),
    ],
    automations: [
      makeAutomation('automation-a', 'lane-todo', 'Start on the plan'),
      makeAutomation('automation-b', 'lane-done', 'Summarize the work'),
    ],
    boardProfiles: [
      makeProfile('profile-a', 'Fast', 'sonnet'),
      makeProfile('profile-b', 'Careful', 'opus'),
    ],
  };
}

/**
 * A fresh store over a fake `window.electronAPI` that answers like IPC: a new deep copy of
 * the served data on every call. The store is a new instance, not the module singleton,
 * so no case inherits another's lists.
 */
function harness(): { served: ServedData; log: PayloadLog; store: BoardStoreHandle } {
  const served = buildServed();
  const log: PayloadLog = {
    swimlanes: [],
    archivedPreview: [],
    shortcuts: [],
    automations: [],
    boardProfiles: [],
  };
  function serve<Row>(rows: Row[], bucket: Row[][]): Row[] {
    const copy = structuredClone(rows);
    bucket.push(copy);
    return copy;
  }
  vi.stubGlobal('window', {
    electronAPI: {
      tasks: {
        list: async () => structuredClone(served.tasks),
        listArchivedPreview: async () => ({
          tasks: serve(served.archivedPreview, log.archivedPreview),
          totalCount: served.archivedTotalCount,
        }),
      },
      swimlanes: { list: async () => serve(served.swimlanes, log.swimlanes) },
      boardConfig: {
        getShortcuts: async () => serve(served.shortcuts, log.shortcuts),
        getBoardProfiles: async () => serve(served.boardProfiles, log.boardProfiles),
      },
      automations: { list: async () => serve(served.automations, log.automations) },
    },
  });
  return { served, log, store: createBoardStore() };
}

/**
 * `loadBoard` starts the profile, automation and shortcut loads without awaiting them. They
 * answer from an already-resolved fake, so one macrotask lets every one of them land.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadBoardAndSettle(store: BoardStoreHandle): Promise<void> {
  await store.getState().loadBoard();
  await settle();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The three lists a load replaces whole, compared by their JSON: shortcuts, automations and
 * board profiles. They share a contract, so they share these cases.
 */
interface JsonSliceConfig<Row> {
  sliceName: string;
  /** The lists the fake serves before the case changes anything. Two rows. */
  rows: (served: ServedData) => Row[];
  setRows: (served: ServedData, rows: Row[]) => void;
  payloads: (log: PayloadLog) => Row[][];
  load: (store: BoardStoreHandle) => Promise<void>;
  read: (store: BoardStoreHandle) => Row[];
  /** Changes one nested field of the SECOND row, in place. */
  editSecondRow: (rows: Row[]) => void;
  /** Reads the field `editSecondRow` changed. */
  readEditedField: (rows: Row[]) => unknown;
  editedValue: unknown;
}

function describeJsonSlice<Row>(config: JsonSliceConfig<Row>): void {
  describe(config.sliceName, () => {
    it('keeps the same array when a reload returns equal data', async () => {
      const { log, store } = harness();

      await config.load(store);
      const afterFirstLoad = config.read(store);
      // The loader populated the store, so the identity check below is not a no-op on `[]`.
      expect(afterFirstLoad).toHaveLength(2);
      expect(afterFirstLoad).toEqual(config.payloads(log)[0]);

      await config.load(store);
      const [firstPayload, secondPayload] = config.payloads(log);

      expect(config.payloads(log)).toHaveLength(2);
      // The fake gave the store a different object the second time, equal in content.
      expect(secondPayload).not.toBe(firstPayload);
      expect(secondPayload).toEqual(firstPayload);
      // A slice that stored what arrived would hold secondPayload here.
      expect(config.read(store)).not.toBe(secondPayload);
      expect(config.read(store)).toBe(afterFirstLoad);
    });

    it('replaces the array and reads the new value when one nested field changed', async () => {
      const { served, log, store } = harness();

      await config.load(store);
      const afterFirstLoad = config.read(store);
      expect(afterFirstLoad).toHaveLength(2);

      const edited = structuredClone(config.rows(served));
      config.editSecondRow(edited);
      // The case is only meaningful when the edit really changes the row.
      expect(config.readEditedField(edited)).toBe(config.editedValue);
      expect(config.readEditedField(afterFirstLoad)).not.toBe(config.editedValue);
      config.setRows(served, edited);

      await config.load(store);

      const afterSecondLoad = config.read(store);
      expect(config.payloads(log)).toHaveLength(2);
      expect(afterSecondLoad).not.toBe(afterFirstLoad);
      expect(config.readEditedField(afterSecondLoad)).toBe(config.editedValue);
      // The row nobody touched still reads the same.
      expect(afterSecondLoad[0]).toEqual(afterFirstLoad[0]);
    });

    it('replaces the array when a row was removed', async () => {
      const { served, store } = harness();

      await config.load(store);
      const afterFirstLoad = config.read(store);
      expect(afterFirstLoad).toHaveLength(2);

      config.setRows(served, config.rows(served).slice(0, 1));
      await config.load(store);

      const afterSecondLoad = config.read(store);
      expect(afterSecondLoad).not.toBe(afterFirstLoad);
      expect(afterSecondLoad).toHaveLength(1);
      expect(afterSecondLoad[0]).toEqual(afterFirstLoad[0]);
    });

    it('keeps the same array across reloads of an empty list', async () => {
      const { served, log, store } = harness();
      config.setRows(served, []);
      const initial = config.read(store);

      await config.load(store);
      await config.load(store);

      // Both loads reached the fake and each got its own empty array, which is what a
      // project with no entries of this kind receives on every board load.
      const [firstPayload, secondPayload] = config.payloads(log);
      expect(config.payloads(log)).toHaveLength(2);
      expect(firstPayload).toEqual([]);
      expect(secondPayload).not.toBe(firstPayload);
      expect(config.read(store)).not.toBe(firstPayload);
      expect(config.read(store)).not.toBe(secondPayload);
      expect(config.read(store)).toBe(initial);
    });
  });
}

describe('board store reload identity', () => {
  describeJsonSlice<ShortcutRow>({
    sliceName: 'loadShortcuts',
    rows: (served) => served.shortcuts,
    setRows: (served, rows) => { served.shortcuts = rows; },
    payloads: (log) => log.shortcuts,
    load: (store) => store.getState().loadShortcuts(),
    read: (store) => store.getState().shortcuts,
    editSecondRow: (rows) => { rows[1].command = 'npm run test:unit'; },
    readEditedField: (rows) => rows[1].command,
    editedValue: 'npm run test:unit',
  });

  // The nested edit is the point for these two: a compare of the top-level keys only would
  // call the lists equal, and a column's glyph or a profile pill would keep the old value.
  describeJsonSlice<ColumnAutomation>({
    sliceName: 'loadAutomations',
    rows: (served) => served.automations,
    setRows: (served, rows) => { served.automations = rows; },
    payloads: (log) => log.automations,
    load: (store) => store.getState().loadAutomations(),
    read: (store) => store.getState().automations,
    editSecondRow: (rows) => { rows[1].config.message = 'Summarize and hand off'; },
    readEditedField: (rows) => rows[1].config.message,
    editedValue: 'Summarize and hand off',
  });

  describeJsonSlice<BoardProfile>({
    sliceName: 'loadBoardProfiles',
    rows: (served) => served.boardProfiles,
    setRows: (served, rows) => { served.boardProfiles = rows; },
    payloads: (log) => log.boardProfiles,
    load: (store) => store.getState().loadBoardProfiles(),
    read: (store) => store.getState().boardProfiles,
    editSecondRow: (rows) => { rows[1].columns['lane-todo'].modelOverride = 'haiku'; },
    readEditedField: (rows) => rows[1].columns['lane-todo'].modelOverride,
    editedValue: 'haiku',
  });

  describe('loadAutomations flag', () => {
    it('marks the list loaded even when an empty list is kept', async () => {
      const { served, store } = harness();
      served.automations = [];
      expect(store.getState().automationsLoaded).toBe(false);

      await store.getState().loadAutomations();

      // The list is equal to the initial one, so the value is kept. The flag is a separate
      // field of the same write, and a project with no automations needs it to flip.
      expect(store.getState().automations).toEqual([]);
      expect(store.getState().automationsLoaded).toBe(true);
    });
  });

  describe('loadBoard swimlanes', () => {
    it('keeps the same swimlanes array when a reload returns equal columns', async () => {
      const { log, store } = harness();

      await loadBoardAndSettle(store);
      const afterFirstLoad = store.getState().swimlanes;
      expect(store.getState().hydrated).toBe(true);
      expect(afterFirstLoad.map((lane) => lane.name)).toEqual(['To Do', 'Done']);

      await loadBoardAndSettle(store);
      const [firstPayload, secondPayload] = log.swimlanes;

      expect(log.swimlanes).toHaveLength(2);
      expect(secondPayload).not.toBe(firstPayload);
      expect(secondPayload).toEqual(firstPayload);
      expect(store.getState().swimlanes).not.toBe(secondPayload);
      expect(store.getState().swimlanes).toBe(afterFirstLoad);
      // The elements are the first load's too, not the second payload's copies.
      expect(store.getState().swimlanes[0]).toBe(afterFirstLoad[0]);
    });

    it('replaces the array when one column was renamed and keeps the other column object', async () => {
      const { served, store } = harness();

      await loadBoardAndSettle(store);
      const afterFirstLoad = store.getState().swimlanes;
      expect(afterFirstLoad.map((lane) => lane.name)).toEqual(['To Do', 'Done']);

      served.swimlanes = structuredClone(served.swimlanes);
      served.swimlanes[1].name = 'Shipped';
      await loadBoardAndSettle(store);

      const afterSecondLoad = store.getState().swimlanes;
      expect(afterSecondLoad).not.toBe(afterFirstLoad);
      expect(afterSecondLoad.map((lane) => lane.name)).toEqual(['To Do', 'Shipped']);
      // Structural sharing still reuses the column nobody touched.
      expect(afterSecondLoad[0]).toBe(afterFirstLoad[0]);
      expect(afterSecondLoad[1]).not.toBe(afterFirstLoad[1]);
    });

    it('replaces the array when a column was removed', async () => {
      const { served, store } = harness();

      await loadBoardAndSettle(store);
      const afterFirstLoad = store.getState().swimlanes;
      expect(afterFirstLoad).toHaveLength(2);

      served.swimlanes = served.swimlanes.slice(0, 1);
      await loadBoardAndSettle(store);

      const afterSecondLoad = store.getState().swimlanes;
      expect(afterSecondLoad).not.toBe(afterFirstLoad);
      expect(afterSecondLoad.map((lane) => lane.name)).toEqual(['To Do']);
    });

    it('keeps the same swimlanes array across reloads of an empty board', async () => {
      const { served, log, store } = harness();
      served.swimlanes = [];
      const initial = store.getState().swimlanes;

      await loadBoardAndSettle(store);
      await loadBoardAndSettle(store);

      expect(store.getState().hydrated).toBe(true);
      expect(log.swimlanes).toHaveLength(2);
      expect(log.swimlanes[1]).not.toBe(log.swimlanes[0]);
      expect(store.getState().swimlanes).not.toBe(log.swimlanes[0]);
      expect(store.getState().swimlanes).not.toBe(log.swimlanes[1]);
      expect(store.getState().swimlanes).toBe(initial);
    });
  });

  describe('loadBoard archived preview', () => {
    it('keeps the same archivedTasks array when a reload returns an equal preview', async () => {
      const { log, store } = harness();

      await loadBoardAndSettle(store);
      const afterFirstLoad = store.getState().archivedTasks;
      expect(afterFirstLoad.map((task) => task.title)).toEqual(['Archived first', 'Archived second']);

      await loadBoardAndSettle(store);
      const [firstPayload, secondPayload] = log.archivedPreview;

      expect(log.archivedPreview).toHaveLength(2);
      expect(secondPayload).not.toBe(firstPayload);
      expect(secondPayload).toEqual(firstPayload);
      expect(store.getState().archivedTasks).not.toBe(secondPayload);
      expect(store.getState().archivedTasks).toBe(afterFirstLoad);
    });

    it('replaces the array when one archived task changed and keeps the other task object', async () => {
      const { served, store } = harness();

      await loadBoardAndSettle(store);
      const afterFirstLoad = store.getState().archivedTasks;
      expect(afterFirstLoad).toHaveLength(2);

      served.archivedPreview = structuredClone(served.archivedPreview);
      served.archivedPreview[1].title = 'Archived second, renamed';
      await loadBoardAndSettle(store);

      const afterSecondLoad = store.getState().archivedTasks;
      expect(afterSecondLoad).not.toBe(afterFirstLoad);
      expect(afterSecondLoad.map((task) => task.title)).toEqual(['Archived first', 'Archived second, renamed']);
      expect(afterSecondLoad[0]).toBe(afterFirstLoad[0]);
    });

    it('replaces the array when a newly archived task enters the preview', async () => {
      const { served, store } = harness();

      await loadBoardAndSettle(store);
      const afterFirstLoad = store.getState().archivedTasks;
      expect(afterFirstLoad).toHaveLength(2);

      served.archivedPreview = [makeArchivedTask('archived-c', 'Archived newest'), ...structuredClone(served.archivedPreview)];
      served.archivedTotalCount = 3;
      await loadBoardAndSettle(store);

      const afterSecondLoad = store.getState().archivedTasks;
      expect(afterSecondLoad).not.toBe(afterFirstLoad);
      expect(afterSecondLoad.map((task) => task.id)).toEqual(['archived-c', 'archived-a', 'archived-b']);
      expect(store.getState().archivedTotalCount).toBe(3);
    });

    it('keeps the archivedTasks array but still reads a new total when only the count changed', async () => {
      const { served, store } = harness();

      await loadBoardAndSettle(store);
      const afterFirstLoad = store.getState().archivedTasks;
      expect(afterFirstLoad).toHaveLength(2);
      expect(store.getState().archivedTotalCount).toBe(2);

      // The preview is the newest N, so an older task being archived or deleted can move
      // the total without touching the rows it shows.
      served.archivedTotalCount = 40;
      await loadBoardAndSettle(store);

      expect(store.getState().archivedTasks).toBe(afterFirstLoad);
      expect(store.getState().archivedTotalCount).toBe(40);
    });

    it('keeps the same archivedTasks array across reloads of an empty archive', async () => {
      const { served, log, store } = harness();
      served.archivedPreview = [];
      served.archivedTotalCount = 0;
      const initial = store.getState().archivedTasks;

      await loadBoardAndSettle(store);
      await loadBoardAndSettle(store);

      expect(store.getState().hydrated).toBe(true);
      expect(log.archivedPreview).toHaveLength(2);
      expect(log.archivedPreview[1]).not.toBe(log.archivedPreview[0]);
      expect(store.getState().archivedTasks).not.toBe(log.archivedPreview[0]);
      expect(store.getState().archivedTasks).not.toBe(log.archivedPreview[1]);
      expect(store.getState().archivedTasks).toBe(initial);
    });
  });

  describe('loadBoard after an agent updates one task', () => {
    it('takes the task change and keeps the identity of every other list', async () => {
      const { served, store } = harness();

      await loadBoardAndSettle(store);
      const before = store.getState();
      // Every list is populated, so a kept identity below is a kept value and not an empty `[]`.
      expect(before.hydrated).toBe(true);
      expect(before.tasks).toHaveLength(2);
      expect(before.swimlanes).toHaveLength(2);
      expect(before.archivedTasks).toHaveLength(2);
      expect(before.shortcuts).toHaveLength(2);
      expect(before.automations).toHaveLength(2);
      expect(before.boardProfiles).toHaveLength(2);

      served.tasks = structuredClone(served.tasks);
      served.tasks[0].title = 'First task, updated by the agent';
      served.tasks[0].updated_at = '2026-10-03T00:00:00.000Z';
      await loadBoardAndSettle(store);

      const after = store.getState();
      expect(after.tasks[0].title).toBe('First task, updated by the agent');
      // The task the agent did not touch keeps its object.
      expect(after.tasks[1]).toBe(before.tasks[1]);
      expect(after.swimlanes).toBe(before.swimlanes);
      expect(after.archivedTasks).toBe(before.archivedTasks);
      expect(after.shortcuts).toBe(before.shortcuts);
      expect(after.automations).toBe(before.automations);
      expect(after.boardProfiles).toBe(before.boardProfiles);
    });
  });
});
