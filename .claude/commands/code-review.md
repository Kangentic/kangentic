# Code Review

Review the current git changes (staged and unstaged) for quality, correctness, and project conventions.

## Instructions

All commands below run from the **current working directory** — never use `cd <path> && git ...` (triggers an unbypasable security prompt). If the CWD is a worktree, git operates on it automatically.

1. Run `npm run typecheck` to check for type errors. Any type errors are **highest-priority findings** — they represent potential runtime crashes. Include them in the review output even if they are in files not touched by the current diff.
2. Run `git diff` and `git diff --staged` to identify all changed files and hunks.
3. For each changed file, read the full file to understand the surrounding context.
4. Analyze every change against the criteria below.
5. Output a structured review grouped by file, with `file:line` references for each finding.

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
- TypeScript strict mode compliance — **no `any` in new code**. Use proper types from `src/shared/types.ts`, `unknown` with type guards, or generic constraints. Flag any new `any` or `as any` cast as a finding.
- Security: injection risks, unsanitized input
- Proper error handling at system boundaries

### Project Conventions (from CLAUDE.md)
- Single-command bash calls only (no `&&`, `||`, `|`, `;` chaining)
- Lucide React icons only (no inline SVGs)
- `data-testid` and `data-swimlane-name` attributes for test selectors
- Zustand stores with IPC bridge pattern
- IPC channels defined in `src/shared/ipc-channels.ts`
- All dialogs use global `useEffect` Escape key listener

## Output Format

### Findings Table

Present all findings in a single table, sorted by severity (Critical first, then High, Medium, Low):

| # | Severity | Category | Location | Finding | Recommendation |
|---|----------|----------|----------|---------|----------------|
| 1 | Critical | Correctness | `src/main/foo.ts:42` | Brief description of the issue | **Must fix** — what to change and why |
| 2 | High | Best Practices | `src/renderer/Bar.tsx:15` | Brief description | **Should fix** — suggested change |
| 3 | Medium | Performance | `src/main/baz.ts:88` | Brief description | **Consider** — tradeoff explanation |
| 4 | Low | Maintainability | `src/shared/types.ts:10` | Brief description | **Optional** — nice-to-have improvement |

#### Severity levels

| Severity | Meaning | Action |
|----------|---------|--------|
| **Critical** | Type errors, runtime crashes, data loss, security vulnerabilities | **Must fix** before merging |
| **High** | Logic bugs, missing error handling, `any` types, race conditions | **Should fix** — real risk of breakage |
| **Medium** | Performance issues, convention violations, unclear code | **Consider** — improves quality but not blocking |
| **Low** | Style nits, minor duplication, optional improvements | **Optional** — fix if touching the area anyway |

### Summary

End with:
- **Files reviewed:** N
- **Findings:** N critical, N high, N medium, N low
- **Verdict:** one of:
  - **Ship it** — no findings, or only low-severity items
  - **Minor issues** — medium findings worth addressing, no blockers
  - **Needs revision** — critical or high-severity findings that should be resolved

## Allowed Tools

Only use `Read` and `Bash` (for git commands) during this review. Always run commands from the project root directory — no chained commands (`&&`, `||`, `|`, `;`).

**CRITICAL: Use `git -C <path>` for all git commands in other directories.** Never use `cd <path> && git ...` — the `cd && git` pattern triggers an unbypasable Claude Code security prompt.
