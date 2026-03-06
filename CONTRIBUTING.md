# Contributing to Kangentic

Thank you for your interest in contributing to Kangentic! This guide covers everything you need to know to get started.

## Contributor License Agreement (CLA)

**All contributors must sign a CLA before their first pull request can be merged.**

When you open your first PR, the CLA Assistant bot will post a comment asking you to sign. You sign by adding a comment to the PR -- it takes about 30 seconds and only needs to be done once.

### Why we require a CLA

Kangentic is dual-licensed. The public open-source version uses the [AGPLv3 license](LICENSE), and we also offer commercial licenses for organizations that need proprietary modifications. The CLA ensures we can continue offering both licensing options as the project grows.

**What the CLA says (in plain language):**

- You grant VORPAHL LLC a perpetual, worldwide, non-exclusive, royalty-free license to use, modify, sublicense, and distribute your contribution under any license
- You retain full copyright to your contribution -- you can use it however you want
- You confirm you have the right to make this grant (i.e., you wrote the code yourself or have permission)

The CLA is modeled after the [Apache Individual Contributor License Agreement](https://www.apache.org/licenses/icla.pdf), which is widely used and well-understood in the open-source community.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on PATH
- Git

### Setup

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm run dev
```

### Project Structure

```
src/
  main/           # Electron main process
  renderer/       # React UI (React 19, Zustand, Tailwind CSS 4)
  shared/         # Types and IPC channel constants
tests/
  ui/             # Headless Playwright tests (fast, no Electron)
  e2e/            # Real Electron tests (opens windows)
  unit/           # Vitest unit tests
```

## Making Changes

### Branch Naming

Use descriptive branch names:
- `fix/session-resume-crash`
- `feature/multi-agent-support`
- `docs/update-architecture`

### Code Style

- TypeScript strict mode
- No `any` types -- use proper types from `src/shared/types.ts`, `unknown` with type guards, or generic constraints
- No shorthand variable names -- use `currentIndex` not `curIdx`, `previousValue` not `prev`
- Icons use Lucide React -- no inline SVGs
- Use `data-testid` attributes for test selectors

### Testing

Run the UI tests before submitting a PR:

```bash
npx playwright test --project=ui
```

For changes that affect the Electron main process, also run the E2E tests:

```bash
npm run build
npx playwright test --project=electron
```

### Commit Messages

Write clear, concise commit messages that explain *why* the change was made:

- `Fix session resume failing when worktree branch is deleted`
- `Add keyboard shortcut for moving tasks between columns`
- `Update transition engine to support webhook actions`

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes and ensure all tests pass
3. Sign the CLA when prompted on your first PR
4. Write a clear PR description explaining what changed and why
5. Link any related issues

### What to Expect

- PRs are reviewed as time permits -- this is a small project
- Small, focused PRs are easier to review and more likely to be merged quickly
- If your PR includes new UI, consider adding a screenshot

## Finding Work

Look for issues labeled **good first issue** for approachable tasks. If you want to take on something larger, open an issue first to discuss the approach.

## Code of Conduct

Be respectful, constructive, and collaborative. We're all here to build something useful.

## Questions?

Open a [discussion](https://github.com/Kangentic/kangentic/discussions) or comment on the relevant issue.
