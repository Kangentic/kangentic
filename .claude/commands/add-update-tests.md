# Add / Update Tests

Analyze current git changes, classify what tests are needed and where they belong, then write them.

## Instructions

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
- Default to the **lightest tier** that can cover the behavior. A test that only needs DOM + mock API is a UI test, not E2E.
- Never put a pure-logic test in `tests/ui/` or `tests/e2e/` — use `tests/unit/`.
- Only use E2E when the test genuinely requires a real Electron window, PTY, or IPC.

### Phase 3 — Audit existing coverage

For each changed module:
- Check if tests already exist (search by filename, function name, component name).
- Flag **coverage gaps** — changed code with no corresponding test.
- Flag **misclassified tests** — e.g., a UI-only test sitting in `tests/e2e/`.

### Phase 4 — Output recommendations

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

### Phase 5 — Write tests (with confirmation)

After presenting the report, ask for confirmation before writing any files. Then implement the approved tests using the correct patterns:

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

## Key Reference Files

Read these files for context when writing tests:

| File | Purpose |
|------|---------|
| `tests/ui/helpers.ts` | UI test utilities (`launchPage`, `waitForBoard`, `createProject`, `createTask`) |
| `tests/e2e/helpers.ts` | E2E test utilities (`launchApp`, `createTempProject`, test data isolation) |
| `tests/ui/mock-electron-api.js` | Mock `window.electronAPI` shape — shows what's mockable |
| `playwright.config.ts` | Test project configuration (ui vs electron) |
| `vitest.config.ts` | Unit test configuration |
| `CLAUDE.md` | Project conventions and testing rules |

## Allowed Tools

`Read`, `Glob`, `Grep`, `Bash` (for `git diff`, `git diff --staged`, `git status`, `git log` only), `Edit`, `Write`.

Read-heavy during audit phases. `Edit`/`Write` only during the implementation phase after user confirmation.
