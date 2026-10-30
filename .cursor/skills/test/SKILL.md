---
name: test
description: Run tests, audit coverage, or write missing tests
disable-model-invocation: true
---

# Test - Local Test Gate

A fast, predictable, comprehensive local gate (run before commit/merge). **The skill runs tests
directly but delegates all test-writing and coverage analysis to the `test-builder` agent**
(`.cursor/agents/test-builder.md`) - the single source of truth for tier classification,
anti-flake patterns, the 10-second E2E rule, and canonical helpers. This skill does not
re-implement any of that knowledge inline.

There is no affected-test selection. The gate runs ALL tests in fixed tier sets - predictable by
design, with no import-graph guessing and no domain map to maintain.

**Usage:** `/test [mode]`

| Argument | Mode | Description |
|----------|------|-------------|
| *(none)* | **Full gate** | typecheck -> build + unit + ui (parallel) -> e2e -> coverage audit |
| `quick` | **Quick** | typecheck -> unit + ui (parallel). No build, no E2E. Fast inner loop. |
| `unit` | **Unit only** | typecheck -> unit |
| `ui` | **UI only** | typecheck -> ui |
| `e2e` | **E2E only** | typecheck -> build -> e2e |
| `audit` | **Coverage audit** | Delegate to `test-builder` (audit-only). No test execution. |
| `write` | **Write tests** | Delegate to `test-builder` to audit and implement missing tests. |

**Selected mode:** $ARGUMENTS

---

## Mode: Full gate (`/test`)

The comprehensive pre-commit/merge gate. Runs every tier.

1. **Typecheck (gate).** Run `npm run typecheck`. If it fails, report and **stop**. Do not proceed.
2. **Launch in parallel** (each command in its own Bash tool call - no `&&`, no `;`, no piping):
   - `npm run build` (required only for E2E).
   - `npx vitest run tests/unit` (unit tier - does not need the build).
   - `npx playwright test --project=ui` (UI tier - does not need the build).
3. **E2E after build.** Once `npm run build` finishes, run `npx playwright test --project=electron`.
   E2E is the only long pole; unit + UI run concurrently with the build and usually finish first.
4. **Coverage audit.** After all tiers report, gather `git diff` context and launch a single
   `test-builder` agent in audit-only mode (see "Coverage delegation"). Relay its report.
5. Present results in the Reporting Format below.

---

## Mode: Quick (`/test quick`)

Fast inner loop during active work. No build, no E2E.

1. Run `npm run typecheck`. Stop on failure.
2. In parallel (separate Bash calls): `npx vitest run tests/unit` and
   `npx playwright test --project=ui`.

---

## Mode: Unit only (`/test unit`)

1. `npm run typecheck`. Stop on failure.
2. `npm run test:unit`.

## Mode: UI only (`/test ui`)

1. `npm run typecheck`. Stop on failure.
2. `npx playwright test --project=ui`.

## Mode: E2E only (`/test e2e`)

1. `npm run typecheck`. Stop on failure.
2. `npm run build`.
3. `npx playwright test --project=electron`.

---

## Mode: Coverage audit (`/test audit`)

Audit coverage without running tests. Do not classify or recommend tests yourself - that is
`test-builder`'s job.

1. Gather context locally (each in its own Bash call): `git diff --staged`, `git diff`,
   `git status`.
2. Launch a single `test-builder` agent in audit-only mode (see "Coverage delegation").
3. Relay the report verbatim.

## Mode: Write tests (`/test write`)

Audit AND implement the missing tests via the `test-builder` agent. This skill never writes
tests inline.

1. Gather context locally (each in its own Bash call): `git diff --staged`, `git diff`,
   `git status`.
2. Launch a single `test-builder` agent in write mode (see "Coverage delegation"), passing the
   diff and any extra arguments the user gave `/test write`.
3. Relay the agent's summary. Flag any gaps it could not fill.

---

## Coverage delegation

All coverage analysis and test writing go to one `test-builder` agent (`subagent_type:
"test-builder"`). The skill gathers `git diff` context and hands it off; it does not duplicate
the agent's tier decision tree.

- **Audit-only** (full-gate Step 4, `/test audit`): prompt includes the changed files / diff and
  the current test results, plus the explicit instruction: **"Audit-only mode. Read each changed
  file, apply your tier decision tree, and return the standard Coverage Gaps report. Do NOT write
  any tests."** If the agent reports gaps, end with: `Run /test write to implement these.` If
  none: `No coverage gaps - all changes are tested or trivial.`
- **Write** (`/test write`): prompt includes the diff and: **"Write mode. Audit coverage, then
  implement the missing tests following your tier rules, anti-flake patterns, and the 10-second
  E2E gate. Derive expected behavior from the task/PR intent, red-green verify each new test, and
  validate with multi-run stability checks. Report tier chosen per file, files modified, helpers
  reused vs added, and red-green + stability results."**

---

## Reporting Format (run modes only)

After test execution, present results in this format. **Never use emojis** - they render as
broken boxes in the terminal. Use plain text only.

```
## Test Results

| Tier | Status  | Passed | Failed | Duration |
|------|---------|--------|--------|----------|
| Unit | PASS    | 120    | 0      | 1.2s     |
| UI   | PASS    | 80     | 0      | 13s      |
| E2E  | PASS    | 40     | 0      | 3m10s    |

All green. No regressions.
```

- Only include tiers that ran. Use `PASS`, `FAIL`, or `skipped` - never emojis. Skipped tiers
  show `-` for numeric columns.
- Passed counts come from the runner summary (`Test Files N passed` from vitest, `N passed (Xs)`
  from playwright).
- If all selected tiers pass, end with: `All green. No regressions.`

On failures, add after the table:

```
### Failures

1. tests/ui/app.spec.ts:42 - "can create a task in Backlog"
   Error: expected 'visible' but got 'hidden'
   Likely cause: TaskCard render change in src/renderer/components/TaskCard.tsx

### Recommendations
- Investigate <file> - <what the error indicates>
```

---

## Rules

- **Model selection.** The `test-builder` agent runs on **Sonnet** (set in its frontmatter), not
  the session's top-tier model - test authoring and gap auditing are within Sonnet's range. Run
  `/test` at medium reasoning effort. Test execution is model-independent. For a no-expense-spared
  pass on genuinely hard test design, override the spawn with `model: opus`.
- **Test implementation is delegated to `test-builder`.** This skill runs tests and presents
  results; it does not write tests inline. The only exception is a trivial, single-line addition
  to an existing passing test. Any new file, new describe block, or >3-line change goes through
  the agent.
- **No chained commands.** No `&&`, `||`, `|`, `;`, or stderr redirection. Each command runs in
  its own Bash tool call.
- **No `cd && git`.** Never `cd <path> && git ...` (triggers an unbypassable security prompt).
  Git commands run from the current working directory; use `git -C <path>` to target another.
- **Parallel execution.** Launch independent tiers concurrently. Unit and UI never depend on the
  build step; only E2E waits for the build.
- **Build only when E2E runs.** `npm run build` is needed only for the E2E tier.
- **Typecheck is a gate.** Always typecheck first; stop immediately on failure.
- **Use dedicated tools.** Use `Read`, `Glob`, `Grep` for file operations. Reserve `Bash` for
  `npm`, `npx`, and `git` only.

## Allowed Tools

- `Read`, `Glob`, `Grep` - file exploration (changed-file detection, diff context).
- `Bash` - `npm`, `npx`, and `git` only.
- `Task` - delegating to the `test-builder` agent (audit / write / full-gate coverage pass).
