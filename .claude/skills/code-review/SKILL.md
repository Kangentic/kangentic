---
description: Review git changes for quality and conventions via parallel reviewer subagents synthesized in the main agent (auto-fixes findings and fills red-green test-coverage holes by default)
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Agent
argument-hint: [base-ref] [review-only]
---

# Code Review

Review the changes that make up this branch's work - commits on the branch **plus** staged, unstaged, and new untracked files in the working tree (the diff from the base branch through the working tree) - for quality, correctness, and project conventions, then apply every safely-fixable finding.

## Modes

- **Default** (`/code-review`) - review, then immediately apply every safely-fixable finding, re-run typecheck, and report `Changes Applied` + `Skipped (with reason)`.
- **Review-only** (`/code-review review-only`) - findings table + Verdict footer only, no edits applied.

The skill reads `$ARGUMENTS`, which may carry up to two independent tokens in any order:
- `review-only` - skip the Apply Phase and Re-typecheck steps and emit the legacy Verdict footer instead of the Changes/Skipped report.
- a **base ref** (any token that is not `review-only`, e.g. `origin/main`, `develop`, or a commit SHA) - overrides the auto-detected base branch the diff is scoped against (see Step 3). Mirrors `claude ultrareview origin/main`. A base ref is diff-*scoping* metadata, not author intent - it never tells the reviewer what the change was "supposed" to do (see "Reviewer independence").

**User-provided arguments (if any):** $ARGUMENTS

**One uniform path.** This skill runs as a thin **driver** in the main loop. Every run - regardless of diff size - does the same thing: mechanical pre-flight, gather the diff, **fan out independent reviewer subagents in parallel** (via the `Agent` tool), then **synthesize and verify their findings in the main agent**, and (default mode) apply every safely-fixable finding. There is no size gate and no separate "heavy" path. The fan-out scales naturally with the change: the universal dimension finders always run, and the domain auditors are gated by changed-file type, so a one-file change fires few finders and a broad refactor fires many. This mirrors the recommended orchestrator-worker pattern (a lead agent fans out parallel review subagents and synthesizes their results).

### Reviewer independence

`/code-review` always runs in a **fresh, isolated session** with no prior conversation or generation history (the board spawns the review session `isolated` + `always_spawn_new`; see `.claude/rules/board-config-parity.md`). The reviewing agent therefore did not write the code under review and has no memory of intending anything by it, so it is an independent reviewer **by construction**. Judge the diff strictly on its own merits - correctness, conventions, and the criteria below - and do **not** assume the author's intent was correct; that a change exists is not evidence it is right. The parallel finder subagents each receive only the diff (not any generation reasoning) and re-derive expected behavior independently. The main agent then **verifies each finding against the actual code**: it reads the cited lines, confirms the issue is real, treats "the author clearly meant X" as inadmissible, and when uncertain **refutes** (drops) the finding rather than waving it through on assumed intent.

### Not the same as `/code-review ultra`

`ultra` is a Claude Code **built-in** that launches a multi-agent review in the **cloud** - user-initiated, billed, and not self-launchable by this skill. This project skill (`/code-review`) is an **in-session, local** reviewer: it fans out parallel read-only subagents via the `Agent` tool and synthesizes their findings in the main loop. Use `ultra` for a deep cloud audit on demand; this skill for the automatic, auto-fixing local pass. They are complementary, not unified - there is no attempt to share code between them.

## Instructions (driver)

The skill is a thin driver that runs in the main loop. All commands below run from the **current working directory** - never use `cd <path> && git ...` (triggers an unbypasable security prompt); use `git -C <path>` if you must target another directory. If the CWD is a worktree, git operates on it automatically.

1. **Pre-flight typecheck.** Run `npm run typecheck` to check for type errors. Any type errors are **highest-priority findings** - they represent potential runtime crashes. Include them in the review output even if they are in files not touched by the current diff.
2. **Pre-flight HMR vitest.** Run `npx vitest run tests/unit/hmr-resync.test.ts` (fast, ~150ms). This enforces the three mechanical HMR-parity invariants: every IPC-backed store has its `load*` / `sync*` registered in `App.tsx`'s `vite:afterUpdate` handler; every top-level mutable module state under `src/renderer/stores/` or `src/renderer/utils/` either preserves itself via `import.meta.hot.dispose(` or carries a `// hmr-safe:` directive; every `<DndContext>` has `key={...HmrGeneration}`. A failure here is a **Critical** finding (dev-mode regression that production users won't see but dogfooders will mistake for a real bug).
3. **Resolve the base branch.** Agents in this workflow sometimes commit during the working session, sometimes leave changes in the working tree, sometimes both - so the review scope is the full delta from the base branch through the working tree, the same surface `claude ultrareview` reviews. Resolve the base ref in this order, each its own Bash call, first hit wins:
   1. An explicit ref in `$ARGUMENTS` (the token that is not `review-only`), e.g. `origin/main` or a branch/SHA. Authoritative - use it verbatim.
   2. The repo default branch: `git symbolic-ref --short refs/remotes/origin/HEAD` (yields e.g. `origin/main`).
   3. Fallback locals: `git rev-parse --verify --quiet refs/heads/main`, then (if that fails) `git rev-parse --verify --quiet refs/heads/master`.
   If none resolve (no remote, no `main`/`master`), set base to empty and review the working tree only - note "base branch undetermined; reviewed working-tree changes only" in the Summary.
4. **Gather the diff (union; each command its own Bash call).** Capture all three layers - they are disjoint, so concatenating never double-counts:
   - **Committed-vs-base:** `git diff <base>...HEAD` and `git diff <base>...HEAD --stat` (three-dot = changes since the branch diverged from base). Skip when base is empty; an empty result otherwise just means no committed divergence, not an error.
   - **Uncommitted (staged + unstaged):** `git diff HEAD` and `git diff HEAD --stat` (`git diff HEAD` captures index + working tree in one command).
   - **Untracked new files:** `git ls-files --others --exclude-standard`. No diff shows these, but they are part of the change - `Read` each listed file in full and append it to `diffText` as a synthetic added-file block (`+++ b/<path>` header followed by the full contents) so the finders see it.
   If the committed diff, the uncommitted diff, **and** the untracked list are all empty, emit "No changes to review." and stop. Otherwise `diffText` = committed diff + uncommitted diff + the synthetic untracked blocks, and `changedFiles` = the deduped union of file paths across the committed `--stat`, the uncommitted `--stat`, and the untracked list. Also compute the compact **signature delta** from the diff alone (the integration finder consumes it; see "## Finders").
5. **Fan out reviewer subagents (the `Agent` tool, ALL in ONE message so they run concurrently).** Every finder is a **read-only** subagent in its own fresh context window; only the driver (main loop) mutates the working tree, in the Apply Phase. Give each finder the diff (or, when it is very large, the Step 4 gather commands so it reproduces the diff itself) plus the changed-file list, and instruct it to read the full changed files for surrounding context. See "## Finders" for the exact set, the gates, the per-finder criteria, and the required return shape. The universal dimension finders always run; the domain auditors run only when their changed-file glob matches.
6. **Synthesize + verify (main agent).** Collect every finder's findings. For each, **verify it against the actual code** - read the cited `file:line`, confirm the issue is real, and refute (drop) anything the code does not substantiate or that cannot be stated falsifiably (judge the code, not assumed intent). Dedup findings the same issue surfaced from multiple dimensions (e.g. an `any` flagged by both correctness and conventions), keeping the highest severity and clearest recommendation. Fold in the pre-flight signals: Step 1 type errors as Critical rows; a Step 2 vitest failure as a Critical row with the assertion message verbatim. Sort by severity. If a finder returned nothing usable (it errored or came back empty), note the dropped dimension in the Summary.
7. **Apply Phase + Re-typecheck** (skip both in `review-only` mode). Apply every safely-fixable finding with `Edit`/`Write` (each fix is its own atomic unit - skip-with-reason on failure, keep the others), then re-run `npm run typecheck` (and the Step 2 vitest if an HMR fix landed). If a fix introduces a new type error, revert that specific edit and move the finding to `Skipped` with reason `"Fix introduced type error: <message>"`; do not roll back unrelated fixes. The Apply Phase also **fills coverage holes**: for each red-green hole the coverage finder reports on diff-introduced behavior, delegate to the `test-builder` agent to author the test (unit/UI written and run scoped to green; E2E flagged, not written inline). See "## Apply Phase".
8. Emit the **Output Format** below.

## Finders

The driver spawns all finders as **read-only** `Agent` subagents **in a single message** so they run in parallel (the orchestrator-worker fan-out). The universal dimension finders always run; the domain auditors are **gated by changed-file globs** and each is its own registered auditor agent, spawned via `subagent_type` - it loads its own domain skill and runs its checklist, so do not duplicate that checklist in the prompt. Findings come back as **text** (the `Agent` tool returns the subagent's final message, so there is no enforced schema): each finder MUST return a structured list, one block per finding with `severity`, `category`, `location` (`file:line`), `finding`, and `recommendation`, plus the falsifiable triple (`triggeringInput`, `codePath`, `testGap`) for every Correctness/Critical finding.

| Finder | `subagent_type` | Run | Gate (changed-file glob / hunk) |
|---|---|---|---|
| Correctness / Performance / Maintainability / Best-Practices+Conventions | `general-purpose` (seed with the matching Review Criteria slice, incl. the "no agent-specific code outside `adapters/`" rule, `any`, shorthand, external-parser fixture) | ALWAYS (one finder per dimension) | - |
| Cross-file integration (signatures only) | `general-purpose` (special prompt below) | ALWAYS when `changedFiles > 1` | - |
| Test coverage (red-green) | `general-purpose` (seed with the red-green coverage criteria below) | ALWAYS when the diff changes behavioral source under `src/` (self-skips docs-only / test-only / pure-styling diffs) | - |
| IPC consistency | `ipc-auditor` | GATED | `ipc-channels.ts`, `types.ts`, `preload.ts`, `src/main/ipc/handlers/**`, `tests/ui/mock-electron-api.js`, `src/renderer/stores/*-store.ts` |
| HMR parity | `hmr-parity` | GATED | `src/renderer/stores/**`, `src/renderer/utils/**`, `src/renderer/App.tsx`, or any hunk with `<DndContext`/`import.meta.hot`/a new top-level renderer `let` |
| Cross-platform | `platform-guard` | GATED | `src/main/pty/**`, `src/main/agent/**`, `src/main/git/**`, `shell-resolver.ts`, `command-builder.ts`, `worktree-manager.ts`, `paths.ts`, `useTerminal.ts`, or any hunk using `path.join`/`fs.rmSync`/`child_process`/an em-dash |
| Session/PTY lifecycle | `session-debugger` | GATED | `session-manager.ts`, `session-queue.ts`, `transition-engine.ts`, `tasks.ts` (handleTaskMove), `session-store.ts`, `TerminalPanel.tsx`, `TaskDetailDialog.tsx` |
| Migration/schema | `migration-safety` | GATED | `src/main/db/migrations.ts`, `src/main/db/repositories/**`, `src/shared/types.ts` (schema interfaces), `src/main/db/database.ts` |

**Explicit, falsifiable criteria (this is the point of splitting).** Each finder prompt must enumerate concrete, falsifiable criteria - never a vague lens like "review for performance." Embed the matching Review Criteria sub-bullets verbatim for the universal finders; the gated finders inherit their auditor's explicit checklist. Every finding must carry a specific `location` (`file:line`) and a concrete `recommendation`. **Correctness / Critical findings must supply the falsifiable triple:** `triggeringInput` (the specific input that triggers the failure), `codePath` (the failing path), and `testGap` (why existing tests miss it). A finding that cannot be stated falsifiably should not be raised.

**Cross-file integration pass - signatures only (stays cheap).** The single-file finders cannot see interactions. The driver computes a compact "diff interface delta" from the gathered union diff alone (Step 4) - **no file bodies** - and passes only that to the integration finder:

- `changedExports` - added/changed/removed exported signatures
- `typeDeltas` - interface/type member changes (e.g. a field becoming required)
- `newIpcChannels` - new channel constants in `ipc-channels.ts`
- `importChanges` - added/removed import edges between changed files
- `storeShapeMutations` - new/removed Zustand store fields

It answers questions the per-file finders structurally cannot: a new IPC channel constant with no handler/preload/mock layer touched (7-layer drift); `Task` gained a required field but no migration changed; an export's signature changed but a caller in another changed file still passes the old shape. Input is O(signatures) - a few hundred tokens regardless of diff size - so this pass is roughly constant cost and does not reintroduce long-context degradation.

**Removed / renamed surface (correctness + integration finders).** When the diff **deletes or renames** an exported symbol, a string constant, a wire-format token, an enum member, or a config key, a repo-wide search is the only way to catch survivors: the type checker cannot see string-keyed contracts, references in non-typechecked `.js`, or test files that reconstruct the old form as string literals. So for each removed/renamed identifier in the signature delta, the correctness and integration finders must `Grep` the **whole repo (including `tests/`, `docs/`, and `.js`)** and flag any surviving reference outside the diff as a finding. (This class produced the only blocking findings in a recent review - two test files outside the diff still emitted a removed directive format that `tsc` happily passed.)

**Test coverage - the red-green pass.** A dedicated coverage finder runs in the same parallel fan-out whenever the diff changes behavioral source under `src/` (it self-skips docs-only, test-only, and pure-styling diffs). It is **read-only** like every other finder; the tests it identifies are written in the Apply Phase by the `test-builder` agent (see "## Apply Phase"). Its single falsifiable question, asked per behaviorally-significant change in the diff:

> Is there a test that would **fail if this change were reverted**?

If not, it reports a **coverage hole**: the `location`, the specific behavior left unverified, why the existing tests miss it (commonly: the line is executed but its effect is never asserted - the exact gap that let an activity-engine seed ship untested), and a **suggested tier** (unit / UI / E2E) as a hint only. It does NOT re-derive the tier rules or write anything: the authoritative tier classification and the authoring belong to `test-builder` in the Apply Phase, so there is one source of truth for tiering. Scope holes to behavior the diff **introduced or changed** - pre-existing untested code is a separate `/test write` task. Pure refactors with no behavior change, styling, and docs produce no holes.

If a finder errors or returns nothing usable, the review proceeds on the surviving dimensions; note any dropped dimension in the Summary.

## Review Criteria

### Correctness
- Logic errors, off-by-one mistakes, null/undefined risks
- Missing error handling or unhandled promise rejections
- Race conditions or incorrect async/await usage

### Performance
- Unnecessary allocations, re-renders, or repeated work
- Missing memoization where expensive computation occurs
- Inefficient data structures or algorithms

### Maintainability
- Readability: unclear naming, overly complex expressions
- Duplication that should be extracted
- Premature abstractions or over-engineering

### Best Practices
- TypeScript strict mode compliance - **no `any` in new code**. Use proper types from `src/shared/types.ts`, `unknown` with type guards, or generic constraints. Flag any new `any` or `as any` cast as a finding.
- **External-input parsers need a real-shape fixture test.** When code parses input from outside the TypeScript boundary (`JSON.parse` of file contents, IPC payloads from external CLIs, network responses, child-process stdout) and dispatches on string-literal field comparisons, flag it as a finding unless there is a regression test that replays a real (sanitized) sample of the external format. Type-safety stops at the parse boundary. TypeScript will happily narrow `unknown` to a union you declared, even when the runtime shape has drifted. Runtime fixtures are the type system on the other side. See `tests/fixtures/codex-rollout-event-msg.jsonl` + `tests/unit/codex-session-history-parser.test.ts` for the canonical pattern.
- **No shorthand variable names** in new or changed code. Use full, descriptive names: `session` not `sess`, `currentIndex` not `curIdx`, `previousValue` not `prev`. Applies to variables, parameters, callback args, refs.
- Security: injection risks, unsanitized input
- Proper error handling at system boundaries

### Project Conventions (source of truth: `.claude/rules/`)

These are summarized for review convenience; the authoritative, enforced versions live in `.claude/rules/*.md` (each names its test and/or auditor agent).

- Single-command bash calls only (no `&&`, `||`, `|`, `;` chaining) - see `.claude/rules/bash-single-command.md`
- Lucide React icons only (no inline SVGs)
- `data-testid` and `data-swimlane-name` attributes for test selectors
- Zustand stores with IPC bridge pattern
- IPC channels defined in `src/shared/ipc-channels.ts`
- All dialogs use global `useEffect` Escape key listener
- Shared UI primitives: use `Select` (no raw `<select>`), `CountBadge` for counts, `ConfirmDialog` for confirmations; min font `text-[11px]`; avoid hover-only controls; brief accurate settings/UI copy (purpose + distinguishing behavior, no raw hex/byte literals, no platform-specific justification for a universal default) - see `.claude/rules/ui-conventions.md`
- No personal info / machine paths in committed code (repo is public) - see `.claude/rules/no-personal-info.md`
- Dev tooling build-time excluded via `__KANGENTIC_DEV__`, not runtime-toggled - see `.claude/rules/dev-tooling-build-exclusion.md`
- **No agent-specific code outside `src/main/agent/adapters/`.** Flag any branch on agent name (`agent === 'claude'`, `agent === 'droid'`, `taskAgent === '<x>'`, `switch (adapter.name)`, etc.) found in renderer code, IPC handlers, shared utilities, stores, or tests outside the `adapters/` tree. Adapter-specific copy, tooltips, capability decisions, and behavior must live with the adapter and surface through generic capability fields (e.g. `AgentAdapter.liveTelemetryUnsupported`, `AdapterRuntimeStrategy`, `AgentDetectionInfo` extensions). Suggested grep: `agent === '|taskAgent ===|adapter\.name ===` under `src/renderer/`, `src/shared/`, and `src/main/ipc/`.

### Domain-Specific Checks

Each domain below is owned by a dedicated **gated auditor finder** (see "## Finders"): when a changed file matches the gate, the driver spawns that auditor as a `subagent_type`, and the auditor loads its own skill and runs the checklist. The detail is kept here for reference and so the driver knows what each gated finder covers - the auditor agent, not the driver, performs the check.

**IPC files** (`ipc-channels.ts`, `types.ts`, `preload.ts`, `handlers/`, `mock-electron-api.js`) -> `ipc-auditor`:
- Reads `.claude/skills/ipc-bridge/SKILL.md` for these changes
- Verify all 7 IPC layers are consistent: channel constant, types, preload, handler, service, store, mock
- Check push event subscriptions return unsubscribe functions
- Check push event callbacks filter by `projectId`
- Check `!mainWindow.isDestroyed()` guard on broadcasts

**Session/PTY/terminal files** (`session-manager.ts`, `session-queue.ts`, `transition-engine.ts`, `tasks.ts` handleTaskMove, `session-store.ts`, `TerminalPanel.tsx`) -> `session-debugger`:
- Reads `.claude/skills/session-lifecycle/SKILL.md` for these changes
- Verify state transitions follow the legal state machine
- Check `commandInjector.cancel()` is called before session state changes in handleTaskMove
- Check generation counter / reference comparison guards are preserved
- Check terminal ownership handoff: one xterm per session, `dialogSessionIds` exclusion
- Check `status` is not overwritten after suspend (exit handler must check current status)

**Shell/agent/path files** (`shell-resolver.ts`, `command-builder.ts`, `worktree-manager.ts`, `paths.ts`, `useTerminal.ts`) -> `platform-guard`:
- Reads `.claude/skills/cross-platform/SKILL.md` for these changes
- Check for em-dashes (U+2014) and `--` double-dashes used as punctuation (must use a single ASCII `-`); see `.claude/rules/text-formatting.md`
- Check PowerShell quoting: prompts replace `"` with `'` before `quoteArg()`
- Check Windows file ops use `{ force: true }` on `rmSync`
- Check `git -C <path>` instead of `cd && git`
- Check xterm WebGL context loss handling
- Check PTY resize debouncing is preserved

**HMR-sensitive files** -> `hmr-parity`. Gate fires whenever the diff matches ANY of: a file under `src/renderer/stores/`, a file under `src/renderer/utils/`, `src/renderer/App.tsx`, or a hunk containing `<DndContext`, `import.meta.hot`, or a new top-level `let` declaration in the renderer:
- The auditor reads `.claude/agents/hmr-parity.md` / `.claude/rules/hmr-patterns.md` - the source of truth for the four HMR primitives (A: Preserve, B: Re-sync, C: Re-key, D: Cleanup).
- It classifies what new HMR-sensitive surface was added (new `<DndContext>`, new IPC-backed store method, new module-scope mutable state, new IPC subscription, new imperative DOM mutation, new code in the `vite:afterUpdate` handler) and verifies the correct pattern is used.
- It flags anti-patterns: mixing A and C on the same state; a fifth ad-hoc HMR workaround; `process.env.NODE_ENV` gating around `import.meta.hot` (redundant, since `hot` is `undefined` in production); module-scope `addEventListener` registered at import time; reassigning `import.meta.hot.data = {...}` instead of mutating `data.x = value`.
- The Step 2 vitest run already catches the mechanical violations (missing store re-sync, missing dispose block, missing DndContext key); it focuses on semantic mismatches the test cannot detect.
- A missing HMR pattern is a **High**-severity finding (visible dogfooding regression). An anti-pattern is **Medium**. A redundant `NODE_ENV` guard is **Low**.

## Model selection

- **Finders** (every parallel subagent, universal and gated): **Sonnet** (`model: "sonnet"`). Sonnet is the analysis workhorse; the review's depth and safety come from the **structure** - many independent finders plus main-agent verification and dedup - not from each finder being a frontier reasoner. The gated auditor agents already carry `model: sonnet` in their own frontmatter; pass `model: "sonnet"` on the universal finders too.
- **Synthesis + verification + Apply Phase** (the driver / main loop): the **session model at its configured effort** - the most capable agent in the system. Findings are verified against the code, deduped, and turned into edits here, so the strong model is spent on the one bounded synthesis context rather than across the fan-out. Because `/code-review` runs in a fresh isolated session, this synthesis agent is an independent reviewer (see "Reviewer independence").

For a deep, no-expense-spared cloud audit, use the `ultra` built-in instead (see "Not the same as `/code-review ultra`").

## Apply Phase

Default mode applies fixes immediately after the findings table. Fixes land in the working tree only - **never commit**; the user runs `/commit` (then `/pull-request` or `/merge-back`) for that.

### What gets auto-fixed

Local, mechanical, single-file or tightly-scoped edits:

- TypeScript `any` / `as any` casts -> proper type from `src/shared/types.ts`, `unknown` + type guard, or generic constraint
- Shorthand variable names -> expanded (`sess` -> `session`, `prev` -> `previousValue`, `curIdx` -> `currentIndex`)
- Em-dashes (U+2014) and `--` used as punctuation -> single dash `-` or restructured sentence
- Missing `data-testid` / `data-swimlane-name` on test selectors that the convention requires
- Single-command bash chain violations in skills/docs (`&&`, `||`, `|`, `;`) -> split into separate Bash blocks
- `cd <path> && git ...` -> `git -C <path> ...`
- Missing `{ force: true }` on Windows `fs.rmSync` in cleanup paths
- Missing `!mainWindow.isDestroyed()` guard on IPC broadcasts
- Inline SVGs -> Lucide React icon (when an obvious match exists)
- Mechanical agent-specific moves (move a string constant or capability flag into `src/main/agent/adapters/`); non-mechanical splits are skipped with reason
- One-file type fixes (narrow a return type, add a missing annotation)

### What gets skipped (with reason)

- **Architectural refactors** spanning multiple modules or changing public APIs
- **Missing test coverage on pre-existing code the diff did not touch** -> reason: `"Outside diff scope; run /test write to add"`. Coverage holes on behavior **this diff introduced** are NOT skipped - they are auto-written via `test-builder` (see "Auto-adding missing tests" below).
- **Deletion of code the human just added** -> ask first
- **Conflicting findings** -> reason: `"Conflicts with finding #N; pick one and re-run"`
- **Ambiguous renames at >5 call sites** -> reason: `"Ambiguous rename; suggest manual review"`
- **Stakeholder-input findings** (security policy choices, UX copy, log-level changes)
- **Type errors in untouched files** -> reason: `"Outside current diff scope; flag for separate task"`
- **Findings that would trip a hook the user opted out of**
- **Any fix that introduces a new type error** (auto-reverted by the re-typecheck step)

For every skip, the report includes: finding number, `file:line`, reason, and a concrete next step (run `/test write`, manual review, defer to follow-up task, etc.).

### Auto-adding missing tests (coverage holes)

When the coverage finder reports a red-green hole on behavior **this diff** introduced, the Apply Phase fills it. This is **advisory, never a hard gate**: it writes what it safely can and flags the rest; the board human still drives the column move, and `/pull-request` remains the hard CI gate behind it.

1. **Delegate to `test-builder`** (the `Agent` tool, `subagent_type: "test-builder"`) - one call per hole, or one batched call for several holes in the same area. Pass the hole's `location`, the behavior to pin, and the red-green rationale. `test-builder` owns the authoritative tier choice and the Windows/CI flake discipline, so do not pre-bake the tier - hand it the behavior and let it classify.
2. **Unit and UI tiers are written inline.** `test-builder` authors the test and runs ONLY that new file scoped (`npx vitest run <file>` or `npx playwright test <spec>`) to confirm green. Never run the full suite - that is `/pull-request`'s job on CI.
3. **E2E holes are flagged, not written inline** (a real PTY/app run is slow and flake-prone in this pass). Report them under Skipped with `"E2E coverage hole; add via /test write"`.
4. **Red-green standard.** The test must assert the post-fix behavior such that reverting the change fails it. Where the change is localized, `test-builder` may briefly toggle the fix to confirm the test goes red, then restore it.
5. If `test-builder` cannot produce a green test (ambiguous behavior, missing fixture), move the hole to Skipped with its reason. Never leave a red or `.skip` test behind.

Tests land in the working tree only - never commit.

## Output Format

### Findings Table

Present all findings in a single table, sorted by severity (Critical first, then High, Medium, Low):

| # | Severity | Category | Location | Finding | Recommendation |
|---|----------|----------|----------|---------|----------------|
| 1 | Critical | Correctness | `src/main/foo.ts:42` | Brief description of the issue | **Must fix** - what to change and why |
| 2 | High | Best Practices | `src/renderer/Bar.tsx:15` | Brief description | **Should fix** - suggested change |
| 3 | Medium | Performance | `src/main/baz.ts:88` | Brief description | **Consider** - tradeoff explanation |
| 4 | Low | Maintainability | `src/shared/types.ts:10` | Brief description | **Optional** - nice-to-have improvement |

#### Severity levels

| Severity | Meaning | Action |
|----------|---------|--------|
| **Critical** | Type errors, runtime crashes, data loss, security vulnerabilities | **Must fix** before merging |
| **High** | Logic bugs, missing error handling, `any` types, race conditions | **Should fix** - real risk of breakage |
| **Medium** | Performance issues, convention violations, unclear code | **Consider** - improves quality but not blocking |
| **Low** | Style nits, minor duplication, optional improvements | **Optional** - fix if touching the area anyway |

### Default-mode footer

After the findings table, run the Apply Phase and then emit:

```
### Changes Applied (N)

| # | File:Line | What changed |
|---|-----------|--------------|
| 1 | src/main/foo.ts:42 | Replaced `any` cast with `Task` type |
| 2 | src/renderer/Bar.tsx:15 | Renamed `sess` -> `session` (3 sites) |

Re-typecheck: PASS

### Tests Added (K)

| # | Test file | Tier | Behavior pinned (red-green) |
|---|-----------|------|------------------------------|
| 1 | tests/unit/activity-engine.test.ts | unit | seeded 'thinking' spawn is reclaimed to idle by the stale-thinking watchdog |

Scoped run: PASS

### Skipped (M)

| # | File:Line | Why | Next step |
|---|-----------|-----|-----------|
| 5 | src/main/baz.ts:88 | Architectural refactor - splits handler across 3 files | Design review |
| 7 | tests/e2e/Qux.spec.ts | E2E coverage hole (real PTY) - not written inline | Run `/test write` |

### Summary
- Files reviewed: N
- Findings: A critical, B high, C medium, D low
- Auto-fixed: N
- Tests added: K (plus E E2E coverage holes flagged)
- Skipped: M
- Verdict: **Clean** (or **Needs revision** - M skipped findings require human judgment)
```

Edge cases the footer must handle cleanly:
- No diff at all (committed-vs-base, uncommitted, and untracked all empty) -> short-circuit at the diff-gather step (Step 4) with `"No changes to review."`
- Diff exists, zero quality findings -> skip the fix step, but STILL run the coverage pass; if it reports holes on diff-introduced behavior, write them (Tests Added) and report. Only when there are also no coverage holes, emit `"No findings, nothing to fix."`
- Re-typecheck FAILS -> show the error block, list which fix was reverted, mark Verdict as **Needs revision**
- Step 2 hmr-resync vitest FAILS -> the failure output is itself a Critical finding. Include the failing assertion's message verbatim in the findings table, attempt the auto-fix in the Apply Phase (e.g. add the missing store re-sync call to `App.tsx`, add the missing `key={hmrGeneration}` to the new `<DndContext>`, add a `// hmr-safe:` directive or `dispose` block to the new module-scope state), then re-run the vitest in addition to typecheck during the Re-typecheck step. If the test still fails after the fix attempt, mark Verdict as **Needs revision**.

### Review-only-mode footer

When `review-only` is in `$ARGUMENTS`, skip the Apply Phase and emit the legacy footer:

- **Files reviewed:** N
- **Findings:** N critical, N high, N medium, N low
- **Verdict:** one of:
  - **Ship it** - no findings, or only low-severity items
  - **Minor issues** - medium findings worth addressing, no blockers
  - **Needs revision** - critical or high-severity findings that should be resolved

## Allowed Tools

The driver uses `Bash` (git/npm/npx only) for pre-flight + diff gathering, the `Agent` tool to fan out the read-only finder subagents, and owns `Read`, `Edit`, `Write`, `Glob`, `Grep` for verification and the Apply Phase. `review-only` mode performs no edits (the finders are read-only regardless). Always run commands from the project root - no chained commands (`&&`, `||`, `|`, `;`).

**No headless `claude`, no `Workflow`.** All orchestration is in-session via the `Agent` tool. Never invoke `claude -p`, `claude --print`, `git diff | claude ...`, or any other headless `claude` shell pipeline, and do not use the `Workflow` tool - the finders are spawned directly as parallel `Agent` subagents and synthesized in the main loop.

**CRITICAL: Use `git -C <path>` for all git commands in other directories.** Never use `cd <path> && git ...` - the `cd && git` pattern triggers an unbypasable Claude Code security prompt.

**Do not commit.** The skill applies fixes to the working tree only. The user runs `/commit` to commit locally, then lands via the board PR flow (`/pull-request`) or `/merge-back` for a direct quick-push.
