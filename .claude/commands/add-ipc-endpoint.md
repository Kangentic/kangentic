---
description: Scaffold a new IPC endpoint across all 7 layers
allowed-tools: Read, Glob, Grep, Edit, Bash(npm:*)
argument-hint: <channel-name> <description>
---

# Add IPC Endpoint

Scaffold a new IPC endpoint across all 7 layers of the IPC bridge.

**Usage:** `/add-ipc-endpoint <channel-name> <description>`

Example: `/add-ipc-endpoint TASK_DUPLICATE Duplicate an existing task with a new ID`

**Arguments:** $ARGUMENTS

## Instructions

1. **Parse arguments:**
   - `<channel-name>` -- the constant name (e.g., `TASK_DUPLICATE`). Must be `UPPER_SNAKE_CASE`.
   - `<description>` -- what the endpoint does.
   - Derive the channel string value: lowercase with colon separator (e.g., `TASK_DUPLICATE` -> `task:duplicate`).
   - Derive the domain from the prefix (e.g., `TASK_*` -> tasks domain).

2. **Read current state** of all 7 layers:
   - `src/shared/ipc-channels.ts`
   - `src/shared/types.ts` (find the `ElectronAPI` interface)
   - `src/preload/preload.ts`
   - The appropriate handler file under `src/main/ipc/handlers/` (based on domain)
   - `tests/ui/mock-electron-api.js`

3. **Add channel constant** to `src/shared/ipc-channels.ts`:
   - Place in the correct domain group (Projects, Tasks, Sessions, etc.)
   - Follow existing naming: `CHANNEL_NAME: 'domain:action'`

4. **Add types** to `src/shared/types.ts`:
   - Add input type if the endpoint accepts parameters (name it `<Resource><Action>Input`)
   - Add return type if it returns data
   - Add method to the appropriate namespace in `ElectronAPI` interface
   - Invoke endpoints return `Promise<T>`, send endpoints return `void`, event subscriptions return `() => void`

5. **Add preload bridge** entry in `src/preload/preload.ts`:
   - Invoke: `methodName: (args) => ipcRenderer.invoke(IPC.CHANNEL_NAME, args)`
   - Send: `methodName: (args) => ipcRenderer.send(IPC.CHANNEL_NAME, args)`
   - Event: `onEventName: (callback) => { const handler = (_event, ...args) => callback(...args); ipcRenderer.on(IPC.CHANNEL_NAME, handler); return () => ipcRenderer.removeListener(IPC.CHANNEL_NAME, handler); }`

6. **Add handler** in `src/main/ipc/handlers/<domain>.ts`:
   - Invoke: `ipcMain.handle(IPC.CHANNEL_NAME, (_, arg1, arg2) => { ... })`
   - Send: `ipcMain.on(IPC.CHANNEL_NAME, (_, arg1) => { ... })`
   - Use `getProjectRepos(context)` for database access
   - Add service/repository method if business logic is needed

7. **Add mock** in `tests/ui/mock-electron-api.js`:
   - Implement the method with in-memory state operations
   - Follow existing patterns (async functions for invoke, sync for send)
   - Event subscriptions return `noop` function

8. **Run typecheck:**
   - `npm run typecheck`
   - Fix any type errors before proceeding

9. **Report what was created:**
   - List all files modified with the changes made
   - Suggest next steps:
     - Add Zustand store method in `src/renderer/stores/<domain>-store.ts`
     - Add component usage
     - Add tests (UI tier for most, E2E only if PTY/session involved)

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Edit`, `Bash` (for `npm run typecheck`).

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`.
