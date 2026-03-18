---
description: Run tests, audit coverage, or write missing tests
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(npm:*), Bash(npx:*), Bash(git:*)
argument-hint: [all|audit|write|unit|ui|e2e]
---

# Test — Unified Smart Test Runner

Unified command for running tests, auditing coverage, and writing missing tests.

**Usage:** `/test [mode]`

| Argument | Mode | Description |
|----------|------|-------------|
| *(none)* | **Smart Run** | Detect branch, select relevant tiers, typecheck, build (if needed), run tests |
| `all` | **Full Run** | Run all 3 tiers unconditionally |
| `audit` | **Coverage Audit** | Analyze changes and report coverage gaps — no test execution |
| `write` | **Write Tests** | Audit + implement missing tests |
| `unit` | **Unit Only** | Run unit tests only |
| `ui` | **UI Only** | Run UI tests only |
| `e2e` | **E2E Only** | Build + run E2E tests only |

**Selected mode:** $ARGUMENTS

---

## Mode: Smart Run (`/test`)

### Step 1 — Detect branch and changed files

All git commands below run from the **current working directory** (no `cd` needed). If the CWD is already a worktree, git will operate on it automatically.

1. Run `git rev-parse --abbrev-ref HEAD` to get the current branch.
2. If the branch is `main`, treat this as a **Full Run** — run ALL tiers and skip to Step 2 with tiers = `[unit, ui, e2e]`.
3. Otherwise, determine the base branch:
   - Run `git config kangentic.baseBranch` to get the stored base branch.
   - If not set, default to `main`.
4. Collect changed files (union of all three):
   - `git diff --name-only <base>...HEAD` (committed changes on branch)
   - `git diff --name-only` (unstaged changes)
   - `git diff --name-only --staged` (staged changes)

### Step 2 — Map changed files to tiers

Apply these rules to every changed file. Collect the **union** of all matched tiers:

| Changed file pattern | Tiers to run |
|---|---|
| `tests/unit/**` | unit |
| `tests/ui/**` | ui |
| `tests/e2e/**` | e2e |
| `src/main/**` | e2e |
| `src/preload/**` | e2e |
| `src/renderer/components/terminal/**`, `src/renderer/hooks/useTerminal*.ts`, `src/renderer/stores/session-store.ts` | ui + e2e |
| `src/renderer/**` (other) | ui |
| `src/shared/**` | Grep for imports of the changed file in `src/main/` (→ e2e), `src/renderer/` (→ ui), and test dirs (→ matching tier). Include all tiers that import it. |
| `package.json`, `tsconfig*.json`, `vite.*.ts`, `playwright.config.ts`, `vitest.config.ts`, `electron-builder.yml`, `scripts/**` | unit + ui + e2e |
| `.claude/**`, `*.md`, `.gitignore` | none (docs only — skip testing) |

If **no tiers** are selected (docs-only change), report "No testable changes detected" and stop.

### Step 3 — Plan summary

Before running anything, output a short summary so the user knows what will happen:

```
### Test Plan

Branch: `<branch>` | Base: `<base>` | Changed: N files
Selected tiers: Unit, UI, E2E (or whichever subset)

| Tier | Why |
|------|-----|
| Unit | tests/unit/foo.test.ts changed |
| UI   | src/renderer/components/Bar.tsx changed |
| E2E  | src/main/engine/baz.ts changed |
```

Keep the "Why" column to one short reason per tier (the most significant changed file or pattern that triggered it). Then proceed immediately — no need to wait for confirmation.

### Step 4 — Execute

1. **Typecheck first** — run `npm run typecheck`. If it fails, report type errors and **stop**. Do not proceed to build or tests.
2. Launch tiers in parallel, respecting dependencies:
   - **Unit tests** (`npm run test:unit`) — start immediately (no build needed).
   - **UI tests** (`npx playwright test --project=ui`) — start immediately (no build needed).
   - **Build** (`npm run build`) — start immediately, but **only if E2E is in the selected tiers**.
   - **E2E tests** (`npx playwright test --project=electron`) — wait for build to complete, then start.
3. If only unit and/or UI are selected, skip the build entirely.

### Step 5 — Coverage gap analysis

After all tests complete and results are reported, analyze changed files for test coverage gaps:

1. For each changed file from Step 1, identify new or modified functions/components/modules.
2. Search existing test files (`tests/unit/`, `tests/ui/`, `tests/e2e/`) for tests that reference those functions or components.
3. Use judgment to filter out changes that **don't warrant tests**:
   - Trivial one-line changes (renames, typo fixes, string changes)
   - Pure styling/CSS/Tailwind class changes
   - Type-only changes (interface additions, type narrowing) unless they affect runtime behavior
   - Config/constant changes with no branching logic
   - Boilerplate wiring (adding an IPC channel that just delegates to an existing function)
4. Only recommend tests for changes that have **meaningful logic, branching, error handling, or user-facing behavior** worth validating.
5. Append a **Coverage Gaps** section after the results table:

```
### Coverage Gaps

| File | What to test | Tier | Existing coverage |
|------|-------------|------|-------------------|
| src/renderer/components/Foo.tsx | FooDialog open/close + validation | UI | None |
| src/main/engine/bar.ts | executeAction error path | Unit | Partial (happy path only) |

Run `/test write` to auto-generate these.
```

If all changes are covered or don't warrant new tests, output: `No coverage gaps — all changes are tested or trivial.`

---

## Mode: Full Run (`/test all`)

Same as Smart Run Step 3, but with all three tiers selected unconditionally. Always typecheck → build → run all three tiers.

---

## Mode: Unit Only (`/test unit`)

1. Run `npm run typecheck`. Stop on failure.
2. Run `npm run test:unit`.

## Mode: UI Only (`/test ui`)

1. Run `npm run typecheck`. Stop on failure.
2. Run `npx playwright test --project=ui`.

## Mode: E2E Only (`/test e2e`)

1. Run `npm run typecheck`. Stop on failure.
2. Run `npm run build`.
3. Run `npx playwright test --project=electron`.

---

## Mode: Coverage Audit (`/test audit`)

Analyze changes and report coverage gaps. **Do not run any tests.**

### Phase 1 — Gather context

1. Run `git diff --staged` to see staged changes.
2. Run `git diff` to see unstaged changes.
3. Run `git status` to identify new/deleted files.
4. Read each changed or added file in full to understand the surrounding context.
5. Scan existing test files that cover the changed modules:
   - `tests/unit/` — vitest unit tests
   - `tests/ui/` — Playwright headless UI tests
   - `tests/e2e/` — Playwright Electron E2E tests

### Phase 2 — Classify each change

For every modified function, component, or module, apply this decision tree:

| Signal | Tier | Location | Runner |
|--------|------|----------|--------|
| Pure function, parser, state machine, utility, no DOM or IPC | Unit | `tests/unit/*.test.ts` | vitest (`npm run test:unit`) |
| React component, dialog, form, board interaction, drag-and-drop — needs DOM but only mock `electronAPI` | UI | `tests/ui/*.spec.ts` | Playwright headless (`npx playwright test --project=ui`) |
| PTY session, terminal rendering, real shell, real IPC, config persistence, session spawning | E2E | `tests/e2e/*.spec.ts` | Playwright Electron (`npx playwright test --project=electron`) |

**Rules:**
- Default to the **lightest tier** that can cover the behavior.
- Never put a pure-logic test in `tests/ui/` or `tests/e2e/`.
- Only use E2E when the test genuinely requires a real Electron window, PTY, or IPC.

### Phase 3 — Audit existing coverage

For each changed module:
- Check if tests already exist (search by filename, function name, component name).
- Flag **coverage gaps** — changed code with no corresponding test.
- Flag **misclassified tests** — e.g., a UI-only test sitting in `tests/e2e/`.

### Phase 4 — Report

Present a structured report:

#### Per-file summary

For each changed file:

```
### `<file-path>`

**Classification:** Unit / UI / E2E
**Existing tests:** <list of test files, or "None">
**Recommendation:** <what to add/update>
```

#### Proposed test cases

For each recommended test:
- Test name and description
- Which test file to add it to (existing file preferred, or suggest a new one)
- Which helpers/mocks to use
- Any mock extensions needed (new methods in `mock-electron-api.js`)

---

## Mode: Write Tests (`/test write`)

Run the full Coverage Audit (above), then immediately implement the identified tests. Do not ask for confirmation.

Implement the tests using correct project patterns:

**Unit tests (`tests/unit/`):**
- Use vitest (`describe`, `it`, `expect`)
- File naming: `*.test.ts`
- Config: `vitest.config.ts` includes `tests/unit/**/*.test.ts`

**UI tests (`tests/ui/`):**
- Use `launchPage()` from `tests/ui/helpers.ts` for browser setup
- Use `waitForBoard()`, `createProject()`, `createTask()` helpers as needed
- Mock API is injected via `tests/ui/mock-electron-api.js` — extend it if new API methods are needed
- Use `data-testid` and `data-swimlane-name` selectors
- File naming: `*.spec.ts`

**E2E tests (`tests/e2e/`):**
- Use `launchApp()` from `tests/e2e/helpers.ts` for Electron setup
- Use `createTempProject()` / `cleanupTempProject()` for test isolation
- Use `getTestDataDir()` / `cleanupTestDataDir()` for data isolation
- Requires `npm run build` before running
- File naming: `*.spec.ts`

---

## Key Reference Files

Read these for context when auditing or writing tests:

| File | Purpose |
|------|---------|
| `tests/ui/helpers.ts` | UI test utilities (`launchPage`, `waitForBoard`, `createProject`, `createTask`) |
| `tests/e2e/helpers.ts` | E2E test utilities (`launchApp`, `createTempProject`, test data isolation) |
| `tests/ui/mock-electron-api.js` | Mock `window.electronAPI` shape — shows what's mockable |
| `playwright.config.ts` | Test project configuration (ui vs electron) |
| `vitest.config.ts` | Unit test configuration |
| `CLAUDE.md` | Project conventions and testing rules |

---

## Reporting Format

After test execution, present results in this format. **Never use emojis** — they render as broken boxes in the terminal. Use plain text only.

```
## Test Results

Branch: `<branch-name>` | Base: `<base-branch>` | Changed: N files
Selected: Unit, UI (skipped E2E — no main process changes)

| Tier | Status  | Passed | Failed | Duration |
|------|---------|--------|--------|----------|
| Unit | PASS    | 92     | 0      | 3.9s     |
| UI   | PASS    | 72     | 0      | 20.1s    |
| E2E  | skipped | —      | —      | —        |

All green. No regressions.
```

**Rules for the table:**
- Only include tiers that were selected or explicitly skipped. Use `PASS`, `FAIL`, or `skipped` in the Status column — never emojis.
- Skipped tiers show `—` for numeric columns.
- Omit the Skipped count column (Playwright skips are rare and noisy).
- If all tiers pass, end with: `All green. No regressions.`

**On failures, add after the table:**

```
### Failures

1. `tests/ui/app.spec.ts:42` — "can create a task in Backlog"
   Error: expected 'visible' but got 'hidden'
   Likely cause: TaskCard render change in src/renderer/components/TaskCard.tsx

### Recommendations
- Investigate <file> — <what the error indicates>
```

---

## Rules

- **No chained commands.** Do not use `&&`, `||`, `|`, `;`, or stderr redirection. Each command runs in its own Bash tool call.
- **No `cd && git`.** Never use `cd <path> && git ...` — this triggers an unbypasable Claude Code security prompt. All git commands run from the current working directory (which is already the correct repo/worktree). If you must target a different directory, use `git -C <path>`.
- **Parallel execution.** Launch independent tiers concurrently using parallel tool calls or background tasks. Unit and UI tests never depend on the build step.
- **Build only when needed.** Only run `npm run build` when E2E tests are selected.
- **Typecheck is a gate.** Always typecheck first. If it fails, stop immediately.
- **Use dedicated tools.** Use `Read`, `Glob`, `Grep` for file operations. Reserve `Bash` for `npm`, `npx`, and `git` commands only.
- **Cross-platform safe tests (CI runs on Linux).** All unit and UI tests must pass on Linux. Follow these rules when writing or reviewing tests:
  - **Never use `path.normalize()`, `path.dirname()`, `path.basename()`, or `path.join()` on hardcoded Windows backslash paths.** Node's `path` module is platform-dependent -- on Linux, backslashes are treated as literal filename characters, not separators. Instead, normalize slashes manually: `myPath.replace(/\\/g, '/')` before splitting or comparing.
  - **Never assert a specific quote character (`"` or `'`) from `quoteArg()`.** The function uses double quotes on Windows and single quotes on POSIX. Use `/^["'].*["']$/` or check `process.platform` if the test needs to verify quoting.
  - **Never hardcode `process.platform === 'win32'` expectations without a `runIf` guard.** Use `describe.runIf(process.platform === 'win32')` for Windows-only tests and `describe.runIf(process.platform !== 'win32')` for POSIX-only tests.
  - **Prefer forward-slash paths in test fixtures.** Forward slashes work on all platforms. Only use backslash paths when explicitly testing Windows path handling, and guard those tests with `runIf`.

## Allowed Tools

- `Read`, `Glob`, `Grep` — for file exploration and audit phases
- `Bash` — for `npm`, `npx`, and `git` commands only
- `Edit`, `Write` — only during `write` mode
