# Run Tests

Run all test suites and report results.

## Instructions

1. **Build first** — run `npm run build` (required for Electron E2E tests).
2. Then run all three test projects **in parallel** since they are independent:
   - **Vitest unit tests** — `npm run test:unit`
   - **Playwright UI tests** — `npx playwright test --project=ui`
   - **Playwright Electron tests** — `npx playwright test --project=electron`

Launch all three test commands concurrently using background tasks or parallel tool calls. Do not wait for one to finish before starting the others.

## Reporting

After both complete, report:

### Per-project results
- **Unit tests (vitest):** pass/fail count, duration
- **Playwright UI tests:** pass/fail count, duration
- **Playwright Electron tests:** pass/fail count, duration

### Failure details
For each failing test, include:
- Test name and file path
- Error message or assertion failure
- Relevant code snippet if helpful

### Summary
- Overall status: **PASS** (all green) or **FAIL** (any failures)
- Total tests run across all projects

## Notes

- **No chained commands.** Do not use `cd ... && npm ...` or any `&&`, `||`, `|`, `;` chaining. Instead, pass the working directory to each Bash call separately (e.g., run `npm run test:unit` with cwd set to the project root).
- The build step must complete before launching the Electron tests.
- Playwright `ui` tests run against Vite dev server (auto-started by Playwright) — no build needed, so they can start alongside the build.
- If a test runner is not installed, report the error clearly rather than attempting to install it.

## Allowed Tools

Only use `Read`, `Bash` (for `npm` and `npx` commands) during this run. Always run commands from the project root directory — never chain with `cd`.
