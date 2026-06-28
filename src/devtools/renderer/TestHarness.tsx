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

import { useState } from 'react';
import { Plus, FolderPlus, FileDiff } from 'lucide-react';
import { useBoardStore } from '../../renderer/stores/board-store';
import { useProjectStore } from '../../renderer/stores/project-store';
import { useToastStore } from '../../renderer/stores/toast-store';

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
        message: `Seeded ${result.dir} into ${result.repos} repo${result.repos === 1 ? '' : 's'}: ${result.staged} staged, ${result.working} working, +1 commit`,
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

  return (
    <div
      className="fixed left-6 top-1/2 -translate-y-1/2 z-[2147483600] flex flex-col gap-1.5 rounded-lg border border-edge bg-surface-raised/95 p-1.5 shadow-2xl backdrop-blur"
      data-testid="dev-test-harness"
    >
      <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint select-none">Test Harness</span>
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
    </div>
  );
}
