# Contributing to Kangentic

Thank you for your interest in contributing to Kangentic! This guide covers everything you need to know to get started.

## Contributor License Agreement (CLA)

**All contributors must sign a CLA before their first pull request can be merged.**

When you open your first PR, the CLA Assistant bot will post a comment asking you to sign. You sign by adding a comment to the PR. It takes about 30 seconds and only needs to be done once.

### Why we require a CLA

Kangentic is dual-licensed. The public open-source version uses the [AGPLv3 license](LICENSE), and we also offer commercial licenses for organizations that need proprietary modifications. The CLA ensures we can continue offering both licensing options as the project grows.

**What the CLA says (in plain language):**

- You grant VORPAHL LLC a perpetual, worldwide, non-exclusive, royalty-free license to use, modify, sublicense, and distribute your contribution under any license
- You retain full copyright to your contribution. You can use it however you want
- You confirm you have the right to make this grant (i.e., you wrote the code yourself or have permission)
- If your contribution includes third-party code, you must identify it and its license in the PR description

The CLA is modeled after the [Apache Individual Contributor License Agreement](https://www.apache.org/licenses/icla.pdf), which is widely used and well-understood in the open-source community. The full text is in [CLA.md](CLA.md).

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+ (building from source; CI runs on Node 22)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on PATH
- Git 2.25+

Native modules (`better-sqlite3`) are compiled on install, so you also need a C/C++ toolchain:
Visual Studio Build Tools on Windows, Xcode Command Line Tools on macOS, or `build-essential` and
`python3` on Linux. See [docs/developer-guide.md](docs/developer-guide.md) for the full setup.

### Setup

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

### Where the conventions live

The authoritative conventions for this codebase are [CLAUDE.md](CLAUDE.md) and the focused rule files
in [.claude/rules/](.claude/rules/). Each rule names how it is enforced (a CI test, an ESLint rule,
or code review). The sections below distill the human-relevant subset so you do not have to read all
of them before your first PR, but those files are the source of truth if anything here is ambiguous.

### Project Structure

```
src/
  main/           # Electron main process
  preload/        # Context bridge (preload.ts)
  renderer/       # React UI (React 19, Zustand, Tailwind CSS 4)
  shared/         # Types and IPC channel constants
tests/
  unit/           # Vitest unit tests (fast, pure logic)
  ui/             # Headless Playwright tests (no Electron)
  e2e/            # Real Electron tests (opens windows)
docs/             # Architecture, developer guide, subsystem docs
```

## Making Changes

### Branch Naming

Use descriptive branch names:
- `fix/session-resume-crash`
- `feature/multi-agent-support`
- `docs/update-architecture`

### Conventions

These are the conventions that most often need a maintainer follow-up when missed. Each notes how it
is enforced. The full set lives in [.claude/rules/](.claude/rules/).

- **Text formatting.** No em-dashes (U+2014) and no `--` used as punctuation in anything you author
  (code, comments, tests, docs, commit messages). Use a single dash for inline separators or
  restructure with a period. Em-dashes render as garbled characters on Windows consoles.
  (Enforced by a CI unit test plus review.)
- **TypeScript style.** Strict mode, no `any` types (use proper types from `src/shared/types.ts`,
  `unknown` with type guards, or generics), and full descriptive names (`currentIndex` not `curIdx`,
  `session` not `sess`). (Enforced by ESLint `no-explicit-any` and `tsc`; names by review.)
- **UI conventions.** Use the shared primitives (`Select`, not a raw `<select>`; `CountBadge`;
  `ConfirmDialog`) and Lucide React icons (no inline SVGs). Respect the font floor (default
  `text-xs`, never below `text-[11px]`). Avoid hover-only controls. Use theme-adaptive semantic
  tokens, not hardcoded colors, so the UI re-colors across all themes. Prefer visual subtraction
  over addition. Add `data-testid` attributes for test selectors. (Enforced by review.)
- **Cross-platform parity.** Code and tests must behave identically on Windows, macOS, and Linux.
  No hardcoded OS paths (use `path.join` and runtime-derived directories), pass `{ force: true }` to
  `fs.rmSync`/`fs.rm` (Windows file locking), have tests write only under `os.tmpdir()`, and avoid
  pixel-exact or bare-timeout assertions. (Enforced by a CI unit test, the Linux CI run, and review.)
- **No personal info.** The repo is public. Never hardcode usernames, emails, or home-directory
  paths; use generic placeholders like `C:\Users\dev` in tests and examples. (Enforced by review.)
- **Reuse before reimplement (DRY).** Search for an existing utility before adding a new one, and
  extract duplicated logic into a shared module instead of copying it. (Enforced by review.)
- **Bounded IPC payloads.** Cap large captured buffers (for example child-process stdout/stderr)
  before they cross IPC. Do not let an Error carry tens of megabytes; use a sensible per-stream cap.
  (Enforced by review.)
- **Docs stay in sync.** When you change an anchor source file (union types, IPC channels, DB
  migrations, adapter capabilities, or settings), update the matching docs under `docs/`.
  (Enforced by an automated doc-anchor check when the PR is opened and merged.)

### Testing

Tests run in three tiers. See [docs/developer-guide.md](docs/developer-guide.md) for the full
description of each tier and the headless mock.

- **Unit** (`tests/unit/`, Vitest, sub-second, pure logic): `npm run test:unit`
- **UI** (`tests/ui/`, headless Playwright, no Electron): `npx playwright test --project=ui`
- **E2E** (`tests/e2e/`, real Electron, opens windows): `npm run build` then
  `npx playwright test --project=electron`

Stay scoped to what you changed while iterating (run only the tests you added or touched). Before you
open a PR, the quick local pass is:

```bash
npm run lint
npm run typecheck
npm run test:unit
npx playwright test --project=ui
```

CI is the authoritative full gate (see "What to expect" below), so you do not need to run every tier
locally, especially the E2E tier.

### Commit Messages

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/): a
`commit-msg` git hook runs commitlint with `@commitlint/config-conventional` and rejects messages
that do not conform. The format is:

```
type(scope): subject
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`. The scope is optional. Keep the subject short and in the imperative mood. Examples:

- `fix(session): resume when worktree branch is deleted`
- `feat(board): add keyboard shortcut for moving tasks between columns`
- `docs: clarify the E2E test setup`

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes and add or update tests for them
3. Run the quick local pass above (`lint`, `typecheck`, unit, UI)
4. Sign the CLA when prompted on your first PR
5. Open the PR. The template prompts you for What / Why / How / Tests and a short checklist
6. Link any related issues

### What to expect

- Your PR must be green on all of the CI checks before it can merge: **Lint (ESLint)**,
  **Type check (tsc)**, **Unit tests (Vitest)**, **Build (production bundle)**, **UI tests
  (Playwright)**, and **E2E tests (Electron)**. The lint check runs with `--max-warnings 0`, so any
  warning fails it.
- A maintainer may push follow-up commits to your branch for design polish or hardening before
  merging. This is normal and not a reflection on your work; it is how we keep the bar consistent.
- Small, focused PRs are easier to review and merge faster.

### UI contributions

UI changes get a maintainer design review against the UI conventions above (shared primitives, font
floor, theme-adaptive colors, no hover-only controls, visual subtraction over addition). Including a
screenshot or short clip in the PR makes that review much faster and is always appreciated.

### How maintainers land your PR

You do not need to run any of this; it is just so the flow is not a mystery. Maintainers drive a PR
to green and merge it through an internal Kanban board: a Tests column runs `/pull-request` (which
pushes the branch and drives the CI checks to green, auto-fixing and de-flaking along the way), and a
Ship It column runs `/merge-pull-request` (which merges the green PR). The internal board mechanics,
git worktrees, and agent skills are documented in [CLAUDE.md](CLAUDE.md) and are not something a
contributor is expected to set up.

## Finding Work

Look for issues labeled **good first issue** for approachable tasks. If you want to take on something larger, open an issue first to discuss the approach.

## Code of Conduct

Be respectful, constructive, and collaborative. We're all here to build something useful.

## Questions?

Open a [discussion](https://github.com/Kangentic/kangentic/discussions) or comment on the relevant issue.
