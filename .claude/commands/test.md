# Test — Unified Smart Test Runner

Unified command for running tests, auditing coverage, and writing missing tests.

**Usage:** `/test [mode]`

| Argument | Mode | Description |
|----------|------|-------------|
| *(none)* | **Smart Run** | Detect branch, select relevant tiers, typecheck, build (if needed), run tests |
| `all` | **Full Run** | Run all 3 tiers unconditionally |
| `audit` | **Coverage Audit** | Analyze changes and report coverage gaps — no test execution |
| `write` | **Write Tests** | Audit + implement missing tests (with user confirmation) |
| `unit` | **Unit Only** | Run unit tests only |
| `ui` | **UI Only** | Run UI tests only |
| `e2e` | **E2E Only** | Build + run E2E tests only |

---

## Mode: Smart Run (`/test`)

### Step 1 — Detect branch and changed files

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
| `package.json`, `tsconfig*.json`, `vite.*.ts`, `playwright.config.ts`, `vitest.config.ts`, `forge.config.ts`, `scripts/**` | unit + ui + e2e |
| `.claude/**`, `*.md`, `.gitignore` | none (docs only — skip testing) |

If **no tiers** are selected (docs-only change), report "No testable changes detected" and stop.

### Step 3 — Execute

1. **Typecheck first** — run `npm run typecheck`. If it fails, report type errors and **stop**. Do not proceed to build or tests.
2. Launch tiers in parallel, respecting dependencies:
   - **Unit tests** (`npm run test:unit`) — start immediately (no build needed).
   - **UI tests** (`npx playwright test --project=ui`) — start immediately (no build needed).
   - **Build** (`npm run build`) — start immediately, but **only if E2E is in the selected tiers**.
   - **E2E tests** (`npx playwright test --project=electron`) — wait for build to complete, then start.
3. If only unit and/or UI are selected, skip the build entirely.

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

Run the full Coverage Audit (above), then **ask for confirmation** before writing any test files.

After confirmation, implement the approved tests using correct project patterns:

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

After test execution, present results in this format:

```
## Test Results

### Branch Context
- Branch: `<branch-name>`
- Base: `<base-branch>`
- Changed files: <N> files
- Selected tiers: <list> (skipped <tier> — <reason>)

### Per-Tier Results

#### Unit Tests
- Status: PASS / FAIL / SKIPPED
- Passed: N | Failed: N | Skipped: N
- Duration: Xs

#### UI Tests
- Status: PASS / FAIL / SKIPPED
- Passed: N | Failed: N | Skipped: N
- Duration: Xs

#### E2E Tests
- Status: PASS / FAIL / SKIPPED
- Passed: N | Failed: N | Skipped: N
- Duration: Xs

### Failure Details
(For each failure: file:line, test name, error message, likely cause based on changed files)

### Summary Table
| Tier | Status | Passed | Failed | Skipped | Duration |
|------|--------|--------|--------|---------|----------|
| Unit | ✅/❌ | N | N | N | Xs |
| UI | ✅/❌ | N | N | N | Xs |
| E2E | ✅/❌/⏭️ | N | N | N | Xs |

### Fix Recommendations
(For each failure: which changed file to investigate, what the error indicates)
```

---

## Rules

- **No chained commands.** Do not use `&&`, `||`, `|`, `;`, or stderr redirection. Each command runs in its own Bash tool call.
- **Parallel execution.** Launch independent tiers concurrently using parallel tool calls or background tasks. Unit and UI tests never depend on the build step.
- **Build only when needed.** Only run `npm run build` when E2E tests are selected.
- **Typecheck is a gate.** Always typecheck first. If it fails, stop immediately.
- **Use dedicated tools.** Use `Read`, `Glob`, `Grep` for file operations. Reserve `Bash` for `npm`, `npx`, and `git` commands only.

## Allowed Tools

- `Read`, `Glob`, `Grep` — for file exploration and audit phases
- `Bash` — for `npm`, `npx`, and `git` commands only
- `Edit`, `Write` — only during `write` mode, after user confirmation
