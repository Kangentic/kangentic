# Description Peek Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Description" toggle pill to the task detail header so users can peek at the task description while the terminal is active, without tearing down the running PTY session.

**Architecture:** A plain `useState(false)` in `TaskDetailWindow` owns `descriptionPeekOpen`. When true (and the task has content), a height-capped scrollable description strip renders above the terminal - the same strip that already exists for non-session views, now made conditional on the new state. The pill follows the existing Changes/Browser pill pattern exactly: it registers in the header's `pillSpecs` array, collapses into the kebab on narrow windows, and has a keybinding.

**Tech Stack:** React 19, TypeScript strict, Tailwind CSS 4, Zustand (no new store slice), Lucide React icons, Playwright UI tests.

## Global Constraints

- No `any` types. Full descriptive variable names (no shorthand).
- No em-dashes (U+2014) in any authored text.
- All icons from Lucide React - no inline SVGs.
- `data-testid` attributes on all new interactive elements.
- No hover-only controls for important actions.
- No `addEventListener('keydown')` - use `useKeybinding` hook.
- New keybinding id must be in `KEYBINDINGS` before `useKeybinding` references it (registry test enforces this).
- UI test assertions: use `waitFor` / `toBeVisible` / `toBeHidden` - never `waitForTimeout` or pixel-exact layout assertions.
- No cross-test state leakage: each test opens its own dialog from a known state.
- No machine-specific paths in test fixtures - use `/mock/...`.

---

### Task 1: Register the keybinding

**Files:**
- Modify: `src/shared/keybindings.ts` (after the `taskDetail.toggleChanges` entry, ~line 242)

**Interfaces:**
- Produces: `'taskDetail.toggleDescription'` as a valid keybinding id - required by `useKeybinding` in Task 4 and by `useFormattedCombo` in Task 3.

- [ ] **Step 1: Insert the new entry**

In `src/shared/keybindings.ts`, find the closing `},` of the `taskDetail.toggleChanges` entry (currently ends at line 242). Insert the new entry immediately after it, before the `// Changes panel review navigation.` comment:

```ts
  {
    id: 'taskDetail.toggleDescription',
    label: 'Toggle Description Peek',
    description: 'Show or hide the description strip above the terminal in the task detail dialog.',
    group: 'Task Detail',
    scope: 'task-dialog',
    defaultCombo: 'Mod+Shift+K',
    rebindable: true,
  },
```

- [ ] **Step 2: Run typecheck**

```
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```
git add src/shared/keybindings.ts
git commit -m "feat: register taskDetail.toggleDescription keybinding"
```

---

### Task 2: Write the failing UI test

**Files:**
- Create: `tests/ui/task-detail-description-peek.spec.ts`

**Interfaces:**
- Consumes: `data-testid="description-peek-toggle"` (produced by Task 3), `data-testid="task-detail-dialog"` (existing).
- Produces: a test that passes once Tasks 3-4 are implemented.

- [ ] **Step 1: Create the test file**

Create `tests/ui/task-detail-description-peek.spec.ts` with the following content:

```ts
/**
 * UI tests for the description peek pill in the task detail header.
 *
 * Opens a dialog on a task with an active session and a description, verifies
 * the "Description" pill appears, toggles the description strip on/off, and
 * confirms the kebab menu item does the same.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-desc-peek';
const TASK_ID = 'task-desc-peek';
const SESSION_ID = 'sess-desc-peek';
const TASK_DESCRIPTION = 'Implement the OAuth login flow with PKCE';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Description Peek Test',
      path: '/mock/desc-peek-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so displayState.kind === 'running' -> hasSessionContext is true.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/desc-peek-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Description Peek Task',
      description: '${TASK_DESCRIPTION}',
      swimlane_id: laneIds['Executing'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/desc-peek',
      branch_name: 'feature/desc-peek',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Task Detail description peek', () => {
  test('pill toggles description strip on and off', async () => {
    // Open the task detail dialog
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Description Peek Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Description peek pill is visible (task has a description and a running session)
    const descriptionPill = page.locator('[data-testid="description-peek-toggle"]');
    await expect(descriptionPill).toBeVisible({ timeout: 8000 });

    // Description text is not yet visible (peek is closed by default)
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible();

    // Open peek -> description text appears
    await descriptionPill.click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });

    // Pill shows active state when open
    await expect(descriptionPill).toBeVisible();

    // Close peek -> description text hides again
    await descriptionPill.click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible({ timeout: 8000 });

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('kebab menu item toggles description strip', async () => {
    // Open the task detail dialog fresh for this test (cross-test state isolation)
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Description Peek Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Description not visible initially
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible();

    // Open kebab and click "Show description"
    await dialog.locator('[title="Actions"]').click();
    await page.locator('text=Show description').click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });

    // Open kebab again -> item now reads "Hide description"
    await dialog.locator('[title="Actions"]').click();
    await expect(page.locator('text=Hide description')).toBeVisible({ timeout: 5000 });
    await page.locator('text=Hide description').click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible({ timeout: 8000 });

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails for the right reason**

```
npx playwright test tests/ui/task-detail-description-peek.spec.ts
```

Expected: FAIL. Both tests should fail with a timeout waiting for `[data-testid="description-peek-toggle"]` - the pill doesn't exist yet. If the failure is for a different reason, investigate before proceeding.

- [ ] **Step 3: Commit the failing test**

```
git add tests/ui/task-detail-description-peek.spec.ts
git commit -m "test(ui): add failing test for description peek pill"
```

---

### Task 3: Implement TaskDetailBody changes

**Files:**
- Modify: `src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx`

**Interfaces:**
- Consumes: `descriptionPeekOpen?: boolean` (new optional prop, defaults to `false`).
- Produces: a description strip that appears above the terminal when `descriptionPeekOpen` is `true` during an active session, height-capped at `max-h-[25vh]` with scroll.

- [ ] **Step 1: Add the new prop to TaskDetailBodyProps**

In `src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx`, find the `TaskDetailBodyProps` interface (currently around line 23). Add `descriptionPeekOpen` after `browserOpen`:

```ts
interface TaskDetailBodyProps {
  task: Task;
  isFocused: boolean;
  isArchived: boolean;
  isInTodo: boolean;
  hasSessionContext: boolean;
  sessionId: string | null;
  displayKind: SessionDisplayState['kind'];
  isSuspended: boolean;
  toggling: boolean;
  pendingAction: null | 'pausing' | 'resuming';
  pendingCommandLabel: string | null;
  savedAttachments: AttachmentWithPreview[];
  handlePreview: (attachment: AttachmentWithPreview) => void;
  handleOpenExternal: (attachment: AttachmentWithPreview) => void;
  removeAttachment: (id: string) => void;
  handleToggle: () => void;
  changesOpen: boolean;
  projectPath: string;
  resumeFailed?: boolean;
  resumeError?: string;
  onResetSession?: () => void;
  browserOpen: boolean;
  /** Whether the description peek is open (only relevant when hasSessionContext is true). */
  descriptionPeekOpen?: boolean;
}
```

- [ ] **Step 2: Destructure the new prop in the function signature**

In the `TaskDetailBody` function (currently around line 49), add `descriptionPeekOpen = false` to the destructuring:

```ts
export function TaskDetailBody({
  task,
  isFocused,
  isArchived,
  isInTodo,
  hasSessionContext,
  sessionId,
  displayKind,
  isSuspended,
  toggling,
  pendingAction,
  pendingCommandLabel,
  savedAttachments,
  handlePreview,
  handleOpenExternal,
  removeAttachment,
  handleToggle,
  changesOpen,
  projectPath,
  resumeFailed,
  resumeError,
  onResetSession,
  browserOpen,
  descriptionPeekOpen = false,
}: TaskDetailBodyProps) {
```

- [ ] **Step 3: Update the descriptionBar constant**

Find the `descriptionBar` constant (currently around line 123). Replace it with:

```ts
  const descriptionBar = !isArchived && (task.description || savedAttachments.length > 0 || hasLabelsOrPriority) && (!hasSessionContext || descriptionPeekOpen) && (
    <div className={`px-4 py-3 border-b border-edge flex-shrink-0 space-y-2${hasSessionContext ? ' max-h-[25vh] overflow-y-auto' : ''}`}>
      {task.description && (
        <MarkdownRenderer content={task.description} />
      )}
      {labelsAndPriorityRow}
      {thumbnailStrip}
    </div>
  );
```

- [ ] **Step 4: Run typecheck**

```
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```
git add src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx
git commit -m "feat: extend TaskDetailBody with descriptionPeekOpen prop"
```

---

### Task 4: Implement TaskDetailHeader changes

**Files:**
- Modify: `src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx`

**Interfaces:**
- Consumes: `canShowDescription?: boolean`, `descriptionPeekOpen?: boolean`, `onToggleDescription?: () => void` (new optional props on both `TaskDetailHeaderProps` and `TaskDetailKebabItemsProps`).
- Produces: a "Description" pill (`data-testid="description-peek-toggle"`) and a kebab item ("Show description" / "Hide description").

- [ ] **Step 1: Add AlignLeft to the lucide import**

Find the lucide-react import at line 3. Add `AlignLeft` to the list:

```ts
import { X, Trash2, Pencil, Loader2, Circle, FolderGit2, FolderOpen, GitPullRequest, GitCompare, ArrowRightLeft, ChevronRight, ChevronLeft, CirclePause, CirclePlay, Clock, SquareChevronRight, Zap, Archive, Inbox, Copy, Check, Globe, RefreshCw, PictureInPicture2, AlignLeft } from 'lucide-react';
```

- [ ] **Step 2: Add new props to TaskDetailHeaderProps**

Find `TaskDetailHeaderProps` (around line 104). Add three new props after `browserOpen` / `onToggleBrowser`:

```ts
  canShowDescription?: boolean;
  descriptionPeekOpen?: boolean;
  onToggleDescription?: () => void;
```

- [ ] **Step 3: Destructure new props in TaskDetailHeader**

Find the `TaskDetailHeader` function signature (around line 148). Add the three new props to the destructuring after `onToggleBrowser`:

```ts
  canShowDescription = false,
  descriptionPeekOpen = false,
  onToggleDescription,
```

- [ ] **Step 4: Add the descriptionCombo hook call**

In the `TaskDetailHeader` function body, after the `changesCombo` line (around line 196), add:

```ts
  const descriptionCombo = useFormattedCombo('taskDetail.toggleDescription');
```

- [ ] **Step 5: Add description to pillSpecs**

Find the `pillSpecs` useMemo (around line 205). Add the description entry (priority 45, between Commands=50 and Folder=40) and add `canShowDescription` to the dependency array:

```ts
  const pillSpecs = useMemo<HeaderPillSpec[]>(() => {
    const specs: HeaderPillSpec[] = [];
    if (!isEditing) specs.push({ id: 'commands', priority: 50 });
    if (canShowDescription) specs.push({ id: 'description', priority: 45 });
    if (task.worktree_path || projectPath) specs.push({ id: 'folder', priority: 40 });
    if (canShowChanges) specs.push({ id: 'changes', priority: 30 });
    if (task.pr_url) specs.push({ id: 'pr', priority: 25 });
    if (canShowBrowser) specs.push({ id: 'browser', priority: 20 });
    for (const action of headerShortcuts) {
      specs.push({ id: `shortcut:${action.id ?? action.label}`, priority: 10 });
    }
    return specs;
  }, [isEditing, task.worktree_path, task.pr_url, projectPath, canShowChanges, canShowBrowser, headerShortcuts, canShowDescription]);
```

- [ ] **Step 6: Add the Description pill JSX**

In the pills `<div ref={pillsRef}>` (around line 314), add the Description pill immediately after the Commands pill block and before the Folder pill block:

```tsx
          {/* Description peek toggle */}
          {showPill('description') && canShowDescription && onToggleDescription && (
            <div data-pill-id="description" className="flex-shrink-0">
              <Pill
                shape="square"
                onClick={onToggleDescription}
                className={`flex-shrink-0 transition-colors border ${
                  descriptionPeekOpen
                    ? 'bg-accent/15 text-accent-fg border-accent/30'
                    : 'bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover border-transparent'
                }`}
                title={`${descriptionPeekOpen ? 'Hide' : 'Show'} description (${descriptionCombo})`}
                data-testid="description-peek-toggle"
              >
                <AlignLeft size={14} />
                Description
              </Pill>
            </div>
          )}
```

- [ ] **Step 7: Add new props to TaskDetailKebabItemsProps**

Find `TaskDetailKebabItemsProps` (around line 517). Add three new props after `onToggleBrowser`:

```ts
  canShowDescription?: boolean;
  descriptionPeekOpen?: boolean;
  onToggleDescription?: () => void;
```

- [ ] **Step 8: Destructure new props in TaskDetailKebabItems**

Find the `TaskDetailKebabItems` function (around line 543). Add to the destructuring after `onToggleBrowser`:

```ts
  canShowDescription = false,
  descriptionPeekOpen = false,
  onToggleDescription,
```

- [ ] **Step 9: Pass new props from TaskDetailHeader to TaskDetailKebabItems**

In `TaskDetailHeader`'s JSX, find the `<TaskDetailKebabItems ...>` render (around line 451). Add the three new props:

```tsx
              <TaskDetailKebabItems
                task={task}
                close={close}
                setIsEditing={setIsEditing}
                canToggle={canToggle}
                isSessionActive={isSessionActive}
                isArchived={isArchived}
                toggling={toggling}
                onToggle={onToggle}
                onCommandSelect={onCommandSelect}
                onArchive={onArchive}
                onSendToBacklog={onSendToBacklog}
                onDelete={onDelete}
                onMoveTo={onMoveTo}
                moveTargets={moveTargets}
                menuShortcuts={overflowMenuShortcuts}
                executeShortcut={executeShortcut}
                projectPath={projectPath}
                canShowChanges={canShowChanges}
                changesOpen={changesOpen}
                onToggleChanges={onToggleChanges}
                canShowBrowser={canShowBrowser}
                browserOpen={browserOpen}
                onToggleBrowser={onToggleBrowser}
                canShowDescription={canShowDescription}
                descriptionPeekOpen={descriptionPeekOpen}
                onToggleDescription={onToggleDescription}
              />
```

- [ ] **Step 10: Add the kebab item in TaskDetailKebabItems**

In `TaskDetailKebabItems`'s JSX, find the Browser kebab item block (around line 647). Add the Description item between Changes and Browser:

```tsx
      {/* Description peek */}
      {canShowDescription && onToggleDescription && (
        <KebabMenuItem
          icon={<AlignLeft size={14} />}
          label={descriptionPeekOpen ? 'Hide description' : 'Show description'}
          onClick={() => { closeAll(); onToggleDescription(); }}
        />
      )}
```

- [ ] **Step 11: Run typecheck**

```
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 12: Commit**

```
git add src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx
git commit -m "feat: add Description peek pill and kebab item to task detail header"
```

---

### Task 5: Wire state and keybinding in TaskDetailWindow

**Files:**
- Modify: `src/renderer/window-manager/components/TaskDetailWindow.tsx`

**Interfaces:**
- Consumes: `descriptionPeekOpen` (local state), `canShowDescription` (derived), `handleToggleDescription` (callback), `useKeybinding('taskDetail.toggleDescription', ...)`.
- Produces: props passed to `TaskDetailHeader` and `TaskDetailBody` that make the pill functional.

- [ ] **Step 1: Add descriptionPeekOpen state**

In `TaskDetailWindow.tsx`, find the block of `useState` declarations (around line 115). Add `descriptionPeekOpen` after `isEditing`:

```ts
  const [descriptionPeekOpen, setDescriptionPeekOpen] = useState(false);
```

- [ ] **Step 2: Derive canShowDescription**

Find the `hasSessionContext` derivation (around line 189):

```ts
  const hasSessionContext = sessionState.hasSessionContext || actions.toggling;
```

Immediately after it, add:

```ts
  const hasDescriptionContent = !!(
    task.description
    || attachments.savedAttachments.length > 0
    || (task.priority ?? 0) > 0
    || (task.labels ?? []).length > 0
  );
  const canShowDescription = hasSessionContext && hasDescriptionContent;
```

- [ ] **Step 3: Add the toggle callback**

Find `handleToggleBrowser` (around line 267). Add `handleToggleDescription` before it:

```ts
  const handleToggleDescription = useCallback(
    () => setDescriptionPeekOpen((open) => !open),
    [],
  );
```

- [ ] **Step 4: Add the keybinding**

Find the block of `useKeybinding` calls (around line 348). Add the description binding after `taskDetail.toggleChanges`:

```ts
  useKeybinding('taskDetail.toggleDescription', handleToggleDescription, { capture: true, enabled: isFocused && canShowDescription });
```

- [ ] **Step 5: Pass props to TaskDetailHeader**

Find the `<TaskDetailHeader ...>` JSX (around line 424). Add three new props after `onToggleBrowser`:

```tsx
      canShowDescription={canShowDescription}
      descriptionPeekOpen={descriptionPeekOpen}
      onToggleDescription={handleToggleDescription}
```

- [ ] **Step 6: Pass descriptionPeekOpen to TaskDetailBody**

Find the `<TaskDetailBody ...>` JSX (around line 577). Add one new prop after `browserOpen`:

```tsx
      descriptionPeekOpen={descriptionPeekOpen}
```

- [ ] **Step 7: Run typecheck**

```
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 8: Run the UI test**

```
npx playwright test tests/ui/task-detail-description-peek.spec.ts
```

Expected: both tests PASS. If either fails, investigate - do not move to the commit until both pass.

- [ ] **Step 9: Commit**

```
git add src/renderer/window-manager/components/TaskDetailWindow.tsx
git commit -m "feat: wire description peek state and keybinding in TaskDetailWindow"
```

---

### Task 6: Final validation

**Files:** None modified - validation only.

- [ ] **Step 1: Run typecheck**

```
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 2: Run keybindings unit test**

```
npx vitest run tests/unit/keybindings-registry.test.ts
```

Expected: all tests PASS. This confirms `taskDetail.toggleDescription` is registered, has a canonical combo (`Mod+Shift+K`), and that the `useKeybinding` call in `TaskDetailWindow` references a known id.

- [ ] **Step 3: Run the UI test suite one more time**

```
npx playwright test tests/ui/task-detail-description-peek.spec.ts
```

Expected: both tests PASS.

- [ ] **Step 4: Final commit message for PR**

If all checks pass, the branch is ready for `/pull-request`. The three feature commits are:
1. `feat: register taskDetail.toggleDescription keybinding`
2. `feat: extend TaskDetailBody with descriptionPeekOpen prop`
3. `feat: add Description peek pill and kebab item to task detail header`
4. `feat: wire description peek state and keybinding in TaskDetailWindow`

Plus the test commit:
- `test(ui): add failing test for description peek pill`
