---
description: IPC bridge checklist for adding or modifying endpoints across all 7 layers
---

# IPC Bridge Checklist

Contextual knowledge for adding or modifying IPC endpoints. Every IPC endpoint spans 7 layers that must stay in sync. Missing a layer causes silent failures or test crashes.

## The 7-Layer IPC Stack

Every IPC endpoint must have an entry in each of these files, in order:

| # | Layer | File | What to add |
|---|-------|------|-------------|
| 1 | Channel constant | `src/shared/ipc-channels.ts` | `RESOURCE_ACTION: 'resource:action'` |
| 2 | Types | `src/shared/types.ts` | Input type, return type, method in `ElectronAPI` interface |
| 3 | Preload bridge | `src/preload/preload.ts` | `contextBridge` entry calling `ipcRenderer.invoke()` or `.send()` |
| 4 | Handler | `src/main/ipc/handlers/<domain>.ts` | `ipcMain.handle()` implementation |
| 5 | Service/repo | `src/main/db/repositories/<domain>.ts` or service file | Business logic |
| 6 | Store | `src/renderer/stores/<domain>-store.ts` | Zustand action calling `window.electronAPI.*` |
| 7 | Mock | `tests/ui/mock-electron-api.js` | In-memory mock implementation |

**If you skip layer 7, ALL UI tests will crash** -- the mock throws on unknown method calls.

## Channel Naming Convention

Channel constants in `src/shared/ipc-channels.ts` follow `RESOURCE_ACTION` naming:

```typescript
export const IPC = {
  // Projects
  PROJECT_LIST: 'project:list',
  PROJECT_CREATE: 'project:create',
  // Tasks
  TASK_LIST: 'task:list',
  TASK_MOVE: 'task:move',
  // ...
} as const;
```

Group new channels with their domain. The string value uses `resource:action` format with a colon separator.

## Invoke vs Send/On Patterns

### Invoke (request-response)

Use for operations that return data. Renderer awaits the response.

```typescript
// types.ts -- ElectronAPI
tasks: {
  list: (projectId: string) => Promise<Task[]>;
};

// preload.ts
tasks: {
  list: (projectId) => ipcRenderer.invoke(IPC.TASK_LIST, projectId),
},

// handler
ipcMain.handle(IPC.TASK_LIST, (_, projectId: string) => {
  return taskRepo.list(projectId);
});
```

### Send (fire-and-forget)

Use for actions with no return value (window controls, notifications).

```typescript
// types.ts -- ElectronAPI
window: {
  minimize: () => void;
};

// preload.ts
window: {
  minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
},

// handler
ipcMain.on(IPC.WINDOW_MINIMIZE, () => {
  mainWindow.minimize();
});
```

### Push Events (main -> renderer)

Use for real-time updates pushed from main process. Always return an unsubscribe function.

```typescript
// types.ts -- ElectronAPI
sessions: {
  onData: (callback: (sessionId: string, data: string, projectId?: string) => void) => () => void;
};

// preload.ts
onData: (callback) => {
  const handler = (_event, sessionId, data, projectId) => callback(sessionId, data, projectId);
  ipcRenderer.on(IPC.SESSION_DATA, handler);
  return () => ipcRenderer.removeListener(IPC.SESSION_DATA, handler);
},

// handler (broadcast from service)
context.sessionManager.on('data', (sessionId, data) => {
  if (!context.mainWindow.isDestroyed()) {
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    context.mainWindow.webContents.send(IPC.SESSION_DATA, sessionId, data, projectId);
  }
});
```

**Critical:** Always guard broadcasts with `!context.mainWindow.isDestroyed()` to prevent crashes during shutdown.

## Push Event Cleanup

Stores subscribing to push events MUST clean up on project switch or unmount:

```typescript
// In store or component
const unsubscribe = window.electronAPI.sessions.onData((sessionId, data, projectId) => {
  if (projectId && projectId !== currentProjectId) return; // scope by project
  // handle data
});

// On cleanup
unsubscribe();
```

**Scope by projectId:** Push events fire for ALL projects. Filter in the callback.

## Handler Registration

Handlers are registered in domain-specific files called from `src/main/ipc/register-all.ts`:

```typescript
export function registerAllIpc(mainWindow: BrowserWindow): void {
  // Create shared context (dependency injection)
  context = { mainWindow, projectRepo, sessionManager, ... };

  // Register by domain
  registerProjectHandlers(context);
  registerTaskCrudHandlers(context);
  registerTaskArchiveHandlers(context);
  registerTaskMoveHandlers(context);
  registerTaskBranchHandlers(context);
  registerSessionHandlers(context);
  registerBoardHandlers(context);
  registerSystemHandlers(context);
}
```

New domains get their own handler file under `src/main/ipc/handlers/` and a registration call in `registerAllIpc()`.

## Mock Implementation Pattern

`tests/ui/mock-electron-api.js` provides a complete in-memory implementation. It uses plain JavaScript (no TypeScript) and maintains its own state arrays:

```javascript
// State
let tasks = [];
let projects = [];
// ...

// Mock implementation
tasks: {
  list: async function (projectId) {
    return tasks.filter(t => t.project_id === projectId);
  },
  create: async function (input) {
    var task = { id: uuid(), ...input };
    tasks.push(task);
    return task;
  },
},
```

**Pre-configuration hook** for tests:
```javascript
window.__mockPreConfigure = function (fn) {
  var result = fn({ projects, tasks, swimlanes, sessions, ... });
  if (result && result.currentProjectId !== undefined) {
    currentProjectId = result.currentProjectId;
  }
};
```

## Common Pitfalls

1. **Forgetting `mock-electron-api.js`** -- Crashes ALL UI tests, not just tests for the new feature.
2. **Mismatched types** -- `ElectronAPI` interface says `Promise<Foo[]>` but handler returns `Foo` (not an array). TypeScript catches this in the store but not in the mock.
3. **Missing preload entry** -- Renderer calls `window.electronAPI.domain.method()` and gets `undefined is not a function`. No compile-time error because `contextBridge` is dynamic.
4. **Wrong IPC method** -- Using `ipcMain.on` when you need `ipcMain.handle` (or vice versa). `invoke` requires `handle`; `send` requires `on`.
5. **Push event leaks** -- Subscribing in a store without storing the unsubscribe function. Causes duplicate event processing after project switch.
6. **Forgotten projectId scope** -- Push events fire for all projects. Without filtering, a session event from Project A updates Project B's store.

## Electron Security Rules

- `contextIsolation: true` -- renderer cannot access Node.js APIs directly
- `nodeIntegration: false` -- no `require()` in renderer
- All IPC inputs validated in main process handlers (never trust renderer data)
- `contextBridge.exposeInMainWorld()` is the ONLY bridge between renderer and main
