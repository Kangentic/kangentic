# Code Review

Review the current git changes (staged and unstaged) for quality, correctness, and project conventions.

## Instructions

1. Run `git diff` and `git diff --staged` to identify all changed files and hunks.
2. For each changed file, read the full file to understand the surrounding context.
3. Analyze every change against the criteria below.
4. Output a structured review grouped by file, with `file:line` references for each finding.

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
- TypeScript strict mode compliance (no `any` unless justified)
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

For each file with findings, use this structure:

### `<file-path>`

- **[Category]** `file:line` — Description of the issue and suggested fix.

If there are no findings for a file, skip it. End with a summary: total files reviewed, total findings, and an overall assessment (looks good / minor issues / needs revision).

## Allowed Tools

Only use `Read` and `Bash` (for git commands) during this review. Always run commands from the project root directory — no chained commands (`&&`, `||`, `|`, `;`).
