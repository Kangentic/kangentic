---
description: Plan and implement a full-stack feature
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(npm:*), Bash(npx:*)
argument-hint: <feature-name> <description>
---

# Scaffold Feature

Plan and implement a full-stack feature across all layers of the Kangentic architecture.

**Usage:** `/scaffold-feature <feature-name> <description>`

Example: `/scaffold-feature task-labels Add colored labels to tasks for categorization`

**Arguments:** $ARGUMENTS

## Instructions

### Phase 1 -- Analyze Scope

1. **Determine which layers are needed:**

   | Layer | Needed when... |
   |-------|---------------|
   | Database migration | Feature stores new persistent data |
   | Repository | New queries or CRUD operations |
   | IPC channel + handler | Renderer needs to communicate with main process |
   | Preload bridge | Always, if IPC is added |
   | Types | New data structures or API contracts |
   | Zustand store | Feature has client-side state |
   | Component(s) | Feature has UI |
   | Mock | Always, if IPC is added (UI tests depend on it) |
   | Tests | Always |

2. **Read existing files** that will be modified. Never propose changes to files you haven't read.

3. **Generate the implementation plan** as a numbered file-by-file list:

```
## Implementation Plan: <feature-name>

### Files to modify:
1. `src/shared/types.ts` -- Add <Type> interface, update ElectronAPI
2. `src/shared/ipc-channels.ts` -- Add RESOURCE_ACTION channels
3. `src/main/db/migrations.ts` -- Add <table/column>
4. `src/main/db/repositories/<domain>.ts` -- Add CRUD methods
5. `src/main/ipc/handlers/<domain>.ts` -- Add handlers
6. `src/preload/preload.ts` -- Add bridge entries
7. `src/renderer/stores/<domain>-store.ts` -- Add store methods
8. `src/renderer/components/<area>/<Component>.tsx` -- Add UI
9. `tests/ui/mock-electron-api.js` -- Add mock
10. `tests/ui/<feature>.spec.ts` -- Add UI tests

### New files (if any):
- `src/main/db/repositories/<new-domain>.ts`
- `src/renderer/components/<area>/<NewComponent>.tsx`
```

4. **Present the plan** and wait for user confirmation before implementing.

### Phase 2 -- Implement

Follow this order strictly (types first, UI last):

1. **Types** (`src/shared/types.ts`)
   - Data interfaces
   - Input/output types
   - `ElectronAPI` method signatures
   - No `any` types -- use proper types, `unknown` with type guards, or generics

2. **IPC channels** (`src/shared/ipc-channels.ts`)
   - Channel constants in the correct domain group

3. **Database** (`src/main/db/migrations.ts`)
   - Idempotent migration with `pragma table_info` or `sqlite_master` guard
   - Follow patterns from the `ipc-bridge-checklist` and migration conventions

4. **Repository** (`src/main/db/repositories/`)
   - CRUD methods matching the new schema

5. **IPC handlers** (`src/main/ipc/handlers/`)
   - `ipcMain.handle()` for invoke endpoints
   - Register in `src/main/ipc/register-all.ts` if new domain

6. **Preload bridge** (`src/preload/preload.ts`)
   - `ipcRenderer.invoke()` or `.send()` entries

7. **Zustand store** (`src/renderer/stores/`)
   - Actions call `window.electronAPI.*`
   - Follow existing IPC bridge pattern

8. **Components** (`src/renderer/components/`)
   - `data-testid` attributes on interactive elements
   - Lucide React icons only (import from `lucide-react`)
   - `useEffect` Escape key listener for any new dialog
   - No inline SVGs

9. **Mock** (`tests/ui/mock-electron-api.js`)
   - In-memory implementation matching the real handler behavior
   - Extend `__mockPreConfigure` state if new data type

10. **Tests** -- Choose the correct tier:

    | Behavior | Tier | Location |
    |----------|------|----------|
    | Pure logic (parsers, filters, state machines) | Unit | `tests/unit/` |
    | UI interactions (clicks, forms, drag-and-drop) | UI | `tests/ui/` |
    | PTY, terminal, session spawning, IPC with real Electron | E2E | `tests/e2e/` |

### Phase 3 -- Verify

1. Run `npm run typecheck` -- fix any errors
2. Run `npx playwright test --project=ui` -- fix any failures
3. Report summary of all files created/modified

## Project Conventions Checklist

Apply automatically during implementation:
- [ ] No `any` types
- [ ] No shorthand variable names (use `currentIndex` not `curIdx`)
- [ ] No Unicode em-dashes (use ASCII `--`)
- [ ] `data-testid` on interactive elements
- [ ] Lucide React icons only
- [ ] `useEffect` Escape listener on new dialogs
- [ ] Zustand IPC bridge pattern for store methods
- [ ] IPC channels in `src/shared/ipc-channels.ts`
- [ ] Mock updated in `tests/ui/mock-electron-api.js`
- [ ] Single-command bash calls only

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash` (for `npm run typecheck`, `npx playwright test --project=ui`), and `AskUserQuestion`.

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`.
