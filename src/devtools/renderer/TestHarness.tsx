/**
 * Preview/dev-only test harness: a small floating toolbar for quickly seeding
 * board state while iterating on a feature. The preview board starts empty on
 * every `/preview` launch, so this is the fast path to "give me tasks to test
 * with" without hand-filling the New Task dialog each time.
 *
 * Dev-only: rendered behind `{__KANGENTIC_DEV__ && <TestHarness />}` in App.tsx,
 * so production builds drop both the import and this module via dead-code
 * elimination + Vite tree-shaking (mirrors DevtoolsBootstrap). It deliberately
 * uses the SAME `useBoardStore.createTask` path the New Task dialog uses (which
 * forwards the project id and persists through IPC), so a seeded task is
 * identical to a hand-created one - labels, priority, and real attachments.
 *
 * Today it has one button (Create Task). It is shaped as a vertical stack so
 * future harness affordances slot in below.
 */

import { useRef, useState } from 'react';
import { Plus, FolderPlus, FileDiff, Database, MessagesSquare, ChartColumn, GripVertical } from 'lucide-react';
import { useBoardStore } from '../../renderer/stores/board-store';
import { useProjectStore } from '../../renderer/stores/project-store';
import { useToastStore } from '../../renderer/stores/toast-store';
import { useSessionStore } from '../../renderer/stores/session-store';
import { useUsageDashboardStore } from '../../renderer/stores/usage-dashboard-store';

/** Default seed count for "Seed Embedding Backlog": large enough to force
 *  hundreds of real drain-loop round-robin iterations against the live embed
 *  worker (a multi-minute soak test, not an instant no-op), in the same
 *  ballpark as a real one-time model-switch backfill, while staying well
 *  short of a full multi-hour history backfill. */
/** The app title bar's height (`top-10`). It is an OS drag region, so the panel
 *  must never be draggable into it - see handleDragPointerMove. */
const TITLE_BAR_HEIGHT_PX = 40;

const EMBEDDING_BACKLOG_SEED_COUNT = 3000;

/** Turns written per click of "Seed Large Conversation": large enough to
 *  stress the Conversation viewer's virtualization/scrolling/search on a
 *  huge file, without hanging the UI for many seconds on a single click. */
const LARGE_CONVERSATION_SEED_TURNS = 3000;

/** Days of history written per click of "Seed Usage Data": enough that every
 *  range has a production-like shape - Month is full, and All Time exercises
 *  the adaptive daily granularity (spans <= ~90 days render per-day) with
 *  weekend dips, idle days, spike days, and a multi-agent mix - while keeping
 *  a click near-instant. Re-clicks append another batch, so the open
 *  dashboard visibly animates to the new totals. */
const USAGE_DATA_SEED_DAYS = 60;

// Lorem source. Titles/descriptions are deliberately meaningless so that
// dragging a seeded task to an executing column gives the agent nothing real to
// act on (it is scaffolding, not a task).
const LOREM_WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
  + 'incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud '
  + 'exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute '
  + 'irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur'
).split(' ');

const LABEL_POOL = ['frontend', 'backend', 'bug', 'feature', 'docs', 'test', 'chore', 'refactor', 'urgent', 'design', 'infra', 'ux'];

/** Inclusive random integer in [min, max]. */
function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function loremWords(count: number): string {
  const words: string[] = [];
  for (let index = 0; index < count; index += 1) {
    words.push(LOREM_WORDS[randomInt(0, LOREM_WORDS.length - 1)]);
  }
  return words.join(' ');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Long by default: build past ~260 chars so the title overflows the header at any
// window size - even maximized (~1920px is ~240 chars wide) - and ALWAYS truncates.
// That is the common mode the header's title-floor / pill-overflow behavior is built
// for, so a seeded task exercises it without hand-crafting a long title each time.
function loremTitle(): string {
  const words: string[] = [];
  let length = 0;
  while (length < 260) {
    const word = LOREM_WORDS[randomInt(0, LOREM_WORDS.length - 1)];
    words.push(word);
    length += word.length + 1;
  }
  return capitalize(words.join(' '));
}

// A short-circuit directive appended to every seeded description. Without it the
// agent treats the lorem ipsum as a real (garbled) task and goes spelunking
// through the repo to guess the intent; this tells it to stop immediately.
const TEST_TASK_DIRECTIVE =
  'IMPORTANT: This is an automated UI test fixture, not a real task. Do nothing. '
  + 'Do not read files, run any tools, or make any changes, and do not ask questions. '
  + 'Respond with only "Test task acknowledged, no action taken." and then stop.';

function loremDescription(): string {
  const sentenceCount = randomInt(2, 4);
  const sentences: string[] = [];
  for (let index = 0; index < sentenceCount; index += 1) {
    sentences.push(`${capitalize(loremWords(randomInt(6, 14)))}.`);
  }
  return `${sentences.join(' ')}\n\n${TEST_TASK_DIRECTIVE}`;
}

function randomLabels(): string[] {
  const shuffled = [...LABEL_POOL].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, randomInt(1, 3));
}

/** A real PNG attachment generated on a canvas: a colored card with a caption,
 *  returned as the base64 `pendingAttachments` shape `tasks.create` expects. */
function makeTestAttachment(caption: string): { filename: string; data: string; media_type: string } | null {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 140;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = `hsl(${randomInt(0, 359)}, 55%, 45%)`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(255, 255, 255, 0.94)';
  context.font = 'bold 20px sans-serif';
  context.fillText(caption, 16, 78);
  const dataUrl = canvas.toDataURL('image/png');
  return { filename: `${caption}.png`, data: dataUrl.split(',')[1], media_type: 'image/png' };
}

function makeTestAttachments(): Array<{ filename: string; data: string; media_type: string }> {
  const count = randomInt(1, 2);
  const attachments: Array<{ filename: string; data: string; media_type: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const attachment = makeTestAttachment(`attachment-${randomInt(1000, 9999)}-${index + 1}`);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

export function TestHarness() {
  const [creating, setCreating] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedingBacklog, setSeedingBacklog] = useState(false);
  const [seedingConversation, setSeedingConversation] = useState(false);
  const [seedingUsage, setSeedingUsage] = useState(false);

  // Draggable so the panel can be moved off whatever it is covering. Position
  // is session-only BY DESIGN (never persisted): every launch starts at the
  // same fixed spot on the left edge. Dragging is header-handle-only so the
  // buttons stay plainly clickable; pointer capture keeps the drag alive when
  // the cursor outruns the handle, and the position clamps to the viewport so
  // the panel cannot be lost offscreen - INCLUDING under the title bar, which is
  // an OS drag region that would otherwise strand the panel permanently.
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const [draggedPosition, setDraggedPosition] = useState<{ x: number; y: number } | null>(null);

  const handleDragPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragOffsetRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleDragPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const dragOffset = dragOffsetRef.current;
    const panel = panelRef.current;
    if (!dragOffset || !panel) return;
    const x = Math.min(Math.max(event.clientX - dragOffset.dx, 0), Math.max(window.innerWidth - panel.offsetWidth, 0));
    // Floor at the title bar, not 0. The app's title bar is an OS drag region
    // (`-webkit-app-region: drag`), so a panel dragged up into it becomes
    // un-draggable: its own handle's pointerdown is consumed by the window move
    // instead, and the panel is stranded there for good with no way back.
    const y = Math.min(
      Math.max(event.clientY - dragOffset.dy, TITLE_BAR_HEIGHT_PX),
      Math.max(window.innerHeight - panel.offsetHeight, TITLE_BAR_HEIGHT_PX),
    );
    setDraggedPosition({ x, y });
  };

  const handleDragPointerEnd = (event: React.PointerEvent<HTMLElement>) => {
    dragOffsetRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleCreateTask = async () => {
    const todoSwimlane = useBoardStore.getState().swimlanes.find((lane) => lane.role === 'todo');
    if (!todoSwimlane) {
      useToastStore.getState().addToast({ message: 'No To Do column to create a test task in', variant: 'warning' });
      return;
    }
    setCreating(true);
    try {
      const task = await useBoardStore.getState().createTask({
        title: loremTitle(),
        description: loremDescription(),
        swimlane_id: todoSwimlane.id,
        labels: randomLabels(),
        priority: randomInt(0, 4),
        pendingAttachments: makeTestAttachments(),
      });
      useToastStore.getState().addToast({ message: `Created test task #${task.display_id}`, variant: 'success' });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Failed to create test task: ${error instanceof Error ? error.message : 'unknown error'}`,
        variant: 'error',
      });
    } finally {
      setCreating(false);
    }
  };

  // Dev-only: spawn another ephemeral project (and switch to it) so project-switch
  // behavior can be exercised against the real app. Backed by the dev IPC; the
  // `dev` API is absent in production builds.
  const handleCreateProject = async () => {
    setCreatingProject(true);
    try {
      const project = await window.electronAPI.dev?.createEphemeralProject();
      if (!project) {
        useToastStore.getState().addToast({ message: 'Ephemeral projects are dev-preview only', variant: 'warning' });
        return;
      }
      await useProjectStore.getState().loadProjects();
      await useProjectStore.getState().openProject(project.id);
      useToastStore.getState().addToast({ message: `Created + opened ${project.name}`, variant: 'success' });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Failed to create project: ${error instanceof Error ? error.message : 'unknown error'}`,
        variant: 'error',
      });
    } finally {
      setCreatingProject(false);
    }
  };

  // Dev-only: seed a realistic all-scopes/all-statuses git changeset so the
  // Changes tab has something to review. The panel's fs.watch picks it up live.
  // Backed by dev IPC, guarded main-side to the preview-projects root so it can
  // never dirty a real repo.
  //
  // Seed EVERY active task's worktree (an executing task diffs its worktree, not
  // the project root) plus the project repo (which a no-worktree task diffs), so
  // wherever you look there is a fixture - no need to pick the right task.
  const handleSeedChanges = async () => {
    const project = useProjectStore.getState().currentProject;
    if (!project) {
      useToastStore.getState().addToast({ message: 'Open a project first to seed changes', variant: 'warning' });
      return;
    }
    const worktreePaths = useBoardStore.getState().tasks
      .map((task) => task.worktree_path)
      .filter((worktreePath): worktreePath is string => Boolean(worktreePath));
    const targets = Array.from(new Set([project.path, ...worktreePaths]));
    setSeeding(true);
    try {
      const result = await window.electronAPI.dev?.seedGitChanges(targets);
      if (!result) {
        useToastStore.getState().addToast({ message: 'Seeding changes is dev-preview only', variant: 'warning' });
        return;
      }
      useToastStore.getState().addToast({
        message: `Seeded ${result.dir} into ${result.repos} repo${result.repos === 1 ? '' : 's'}: ${result.commits} commits, ${result.staged} staged, ${result.working} working`,
        variant: 'success',
      });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Failed to seed changes: ${error instanceof Error ? error.message : 'unknown error'}`,
        variant: 'error',
      });
    } finally {
      setSeeding(false);
    }
  };

  // Dev-only: seed a realistic embedding backlog (thousands of pending chunks)
  // into the current project so the central embedding engine's drain loop can
  // be exercised under sustained real-worker load. The engine only cares
  // about memory_chunks.embedded_model IS NULL, not where the row came from,
  // so this needs no real tasks or agent sessions to reach that scale.
  const handleSeedEmbeddingBacklog = async () => {
    const project = useProjectStore.getState().currentProject;
    if (!project) {
      useToastStore.getState().addToast({ message: 'Open a project first to seed an embedding backlog', variant: 'warning' });
      return;
    }
    setSeedingBacklog(true);
    try {
      const result = await window.electronAPI.dev?.seedEmbeddingBacklog(EMBEDDING_BACKLOG_SEED_COUNT);
      if (!result) {
        useToastStore.getState().addToast({ message: 'Seeding an embedding backlog is dev-preview only', variant: 'warning' });
        return;
      }
      useToastStore.getState().addToast({
        message: `Seeded ${result.seeded} pending chunks - enable Semantic search (Settings > Memory) to watch the drain`,
        variant: 'success',
      });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Failed to seed embedding backlog: ${error instanceof Error ? error.message : 'unknown error'}`,
        variant: 'error',
      });
    } finally {
      setSeedingBacklog(false);
    }
  };

  // Dev-only: seed (or, on a re-click for the same project, append to) a
  // throwaway task + session backed by a real synthetic multi-thousand-turn
  // Claude session JSONL transcript file, so the Conversation viewer can be
  // exercised on a huge transcript without running a real agent for hours.
  // Opens the seeded conversation immediately so there is no need to hunt
  // for the throwaway task on the board.
  const handleSeedLargeConversation = async () => {
    const project = useProjectStore.getState().currentProject;
    if (!project) {
      useToastStore.getState().addToast({ message: 'Open a project first to seed a large conversation', variant: 'warning' });
      return;
    }
    setSeedingConversation(true);
    try {
      const result = await window.electronAPI.dev?.seedLargeConversation(LARGE_CONVERSATION_SEED_TURNS);
      if (!result) {
        useToastStore.getState().addToast({ message: 'Seeding a large conversation is dev-preview only', variant: 'warning' });
        return;
      }
      useSessionStore.getState().setConversationSessionId(result.sessionId);
      useToastStore.getState().addToast({
        message: `Seeded ${result.turnsAdded} turns (${result.totalTurns} total) into ${result.filePath}`,
        variant: 'success',
      });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Failed to seed large conversation: ${error instanceof Error ? error.message : 'unknown error'}`,
        variant: 'error',
      });
    } finally {
      setSeedingConversation(false);
    }
  };

  // Dev-only: seed days of realistic multi-agent usage into EVERY registered
  // project's usage ledgers (via the real capture repositories, main-side) at
  // descending volume per project, so This Project vs All Projects differ and
  // the per-project table reconciles. Force-refreshes the dashboard
  // afterwards: with it open, a click visibly animates the charts to the new
  // totals - a live demo of the streaming-update path.
  const handleSeedUsageData = async () => {
    setSeedingUsage(true);
    try {
      const result = await window.electronAPI.dev?.seedUsageData(USAGE_DATA_SEED_DAYS);
      if (!result) {
        useToastStore.getState().addToast({ message: 'Seeding usage data is dev-preview only', variant: 'warning' });
        return;
      }
      void useUsageDashboardStore.getState().loadDashboardStats({ force: true });
      useToastStore.getState().addToast({
        message: `Seeded ${result.sessions} sessions / ${result.turns} turns over ${result.days} days across ${result.projects} project${result.projects === 1 ? '' : 's'}`,
        variant: 'success',
      });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Failed to seed usage data: ${error instanceof Error ? error.message : 'unknown error'}`,
        variant: 'error',
      });
    } finally {
      setSeedingUsage(false);
    }
  };

  return (
    <div
      ref={panelRef}
      className={`fixed z-[2147483600] flex flex-col gap-1.5 rounded-lg border border-edge bg-surface-raised/95 p-1.5 shadow-2xl backdrop-blur ${
        draggedPosition ? '' : 'left-6 top-1/2 -translate-y-1/2'
      }`}
      // Belt to the clamp's braces: even if the panel ends up overlapping an OS
      // drag region, its own surface stays interactive rather than becoming a
      // window-move handle.
      style={{
        WebkitAppRegion: 'no-drag',
        ...(draggedPosition ? { left: draggedPosition.x, top: draggedPosition.y } : {}),
      } as React.CSSProperties}
      data-testid="dev-test-harness"
    >
      <span
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerEnd}
        onPointerCancel={handleDragPointerEnd}
        className="flex items-center gap-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint select-none cursor-grab active:cursor-grabbing touch-none"
        title="Drag to move (position resets on relaunch)"
        data-testid="dev-test-harness-drag-handle"
      >
        <GripVertical size={12} aria-hidden />
        Test Harness
      </span>
      <button
        type="button"
        onClick={handleCreateTask}
        disabled={creating}
        className="flex items-center gap-1.5 rounded-md bg-accent-emphasis px-3.5 py-2 text-[13px] font-medium text-accent-on hover:bg-accent disabled:opacity-50 transition-colors"
        data-testid="dev-create-task"
      >
        <Plus size={16} />
        {creating ? 'Creating...' : 'Create Task'}
      </button>
      <button
        type="button"
        onClick={handleCreateProject}
        disabled={creatingProject}
        className="flex items-center gap-1.5 rounded-md border border-edge bg-surface-raised px-3.5 py-2 text-[13px] font-medium text-fg hover:bg-surface disabled:opacity-50 transition-colors"
        data-testid="dev-create-project"
      >
        <FolderPlus size={16} />
        {creatingProject ? 'Creating...' : 'Create Project'}
      </button>
      <button
        type="button"
        onClick={handleSeedChanges}
        disabled={seeding}
        className="flex items-center gap-1.5 rounded-md border border-edge bg-surface-raised px-3.5 py-2 text-[13px] font-medium text-fg hover:bg-surface disabled:opacity-50 transition-colors"
        data-testid="dev-seed-changes"
        title="Seed the active project repo with working + staged + committed changes to test the Changes tab"
      >
        <FileDiff size={16} />
        {seeding ? 'Seeding...' : 'Seed File Changes'}
      </button>
      <button
        type="button"
        onClick={handleSeedEmbeddingBacklog}
        disabled={seedingBacklog}
        className="flex items-center gap-1.5 rounded-md border border-edge bg-surface-raised px-3.5 py-2 text-[13px] font-medium text-fg hover:bg-surface disabled:opacity-50 transition-colors"
        data-testid="dev-seed-embedding-backlog"
        title={`Seed ${EMBEDDING_BACKLOG_SEED_COUNT} synthetic pending chunks to stress-test the background embedding engine's drain loop`}
      >
        <Database size={16} />
        {seedingBacklog ? 'Seeding...' : 'Seed Embedding Backlog'}
      </button>
      <button
        type="button"
        onClick={handleSeedLargeConversation}
        disabled={seedingConversation}
        className="flex items-center gap-1.5 rounded-md border border-edge bg-surface-raised px-3.5 py-2 text-[13px] font-medium text-fg hover:bg-surface disabled:opacity-50 transition-colors"
        data-testid="dev-seed-large-conversation"
        title={`Seed ${LARGE_CONVERSATION_SEED_TURNS} synthetic transcript turns (append on re-click) and open it in the Conversation viewer`}
      >
        <MessagesSquare size={16} />
        {seedingConversation ? 'Seeding...' : 'Seed Large Conversation'}
      </button>
      <button
        type="button"
        onClick={handleSeedUsageData}
        disabled={seedingUsage}
        className="flex items-center gap-1.5 rounded-md border border-edge bg-surface-raised px-3.5 py-2 text-[13px] font-medium text-fg hover:bg-surface disabled:opacity-50 transition-colors"
        data-testid="dev-seed-usage-data"
        title={`Seed ${USAGE_DATA_SEED_DAYS} days of realistic multi-agent usage into the usage dashboard's ledgers (re-click appends another batch and the open dashboard animates to it)`}
      >
        <ChartColumn size={16} />
        {seedingUsage ? 'Seeding...' : 'Seed Usage Data'}
      </button>
    </div>
  );
}
