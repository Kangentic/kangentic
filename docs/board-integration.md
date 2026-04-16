# Board Integration

Kangentic imports issues from external boards (GitHub Issues, GitHub Projects, Azure DevOps, Asana) into the backlog, and is being extended to three more providers (Jira, Linear, Trello). Each provider is wrapped behind a common `BoardAdapter` interface so auth, fetching, mapping, and download logic stay isolated to a single folder per provider.

This doc covers the adapter system and how to add a new board provider.

## Layout

```
src/main/boards/
  shared/             # BoardAdapter interface + cross-provider helpers
    types.ts
    auth.ts
    mapping.ts
    download-file.ts
    rate-limit.ts
    source-store.ts
  adapters/
    github-common/    # shared `gh` CLI client (not a BoardAdapter)
    github-issues/
    github-projects/
    azure-devops/
    asana/            # Personal Access Token auth, dedicated IPC group
    jira/             # stub
    linear/           # stub
    trello/           # stub
  board-registry.ts   # BoardRegistry + boardRegistry singleton
  index.ts
```

The pattern intentionally mirrors `src/main/agent/adapters/` (one folder per CLI agent, central registry, no provider-specific branching in shared handlers). See [Agent Integration](agent-integration.md) for the analogous agent system.

## BoardAdapter Interface

`src/main/boards/shared/types.ts`

| Field | Required | Purpose |
|-------|----------|---------|
| `id` | yes | Unique provider id, matching the `ExternalSource` union (e.g. `'github_issues'`, `'linear'`) |
| `displayName` | yes | Human-readable product name shown in the settings UI |
| `icon` | yes | lucide-react icon name for the picker |
| `status` | yes | `'stable'` for working providers, `'stub'` for placeholder folders. IPC handlers short-circuit stubs before dispatch. |
| `checkPrerequisites()` | yes | Structured check of CLI availability + auth state. Returns `{ cliOk, authOk, message? }`. |
| `checkCli()` | yes | Legacy wrapper for the import IPC flow. Returns the older `{ available, authenticated, error? }` shape. Implementations can delegate to `prerequisiteToCheckCli(await this.checkPrerequisites())`. |
| `fetch(input, findAlreadyImported)` | yes | Fetch a page of issues. The callback returns the set of external IDs already imported so the UI can mark duplicates. |
| `downloadImages(markdownBody)` | yes | Download inline markdown images referenced in an issue body. |
| `downloadFileAttachments(...)` | optional | Download authenticated file attachments. Takes `Array<FileAttachmentRef>` (see below). Implemented by Azure DevOps for `AttachedFile` relations and by Asana for inline images and uploaded attachments. |
| `authenticate(input)` | optional | Future: PAT / OAuth flow. Not wired to any IPC handler yet. |
| `listProjects(credentials)` | optional | Future: list boards/projects the user can pick from. |
| `listIssues(credentials, ref, filter?)` | optional | Future: discovery method paired with `listProjects`. |
| `pushUpdates(tasks, credentials)` | optional | Future: write task updates back to the remote. |

### `FileAttachmentRef`

Reference to an attachment to download. Defined in `src/shared/types.ts`:

| Field | Required | Purpose |
|-------|----------|---------|
| `url` | yes | The time-of-fetch URL. Adequate for providers whose URLs do not expire. |
| `filename` | yes | Display name for the saved attachment. |
| `sizeBytes` | yes | Used for skipping oversize files before download. `0` if unknown. |
| `externalRef` | optional | Adapter-specific identifier for re-resolving a fresh URL at download time. Asana sets this to the attachment GID because Asana's `download_url` expires within ~2 minutes of being returned by the API. The Asana client calls `/attachments/{gid}` to refresh the URL just before downloading. |

### `Credentials`

Opaque per-adapter credential bag (`Record<string, string>`). Each adapter's `auth.ts` owns serialization. There is no shared discriminated union - GitHub stores `gh` CLI session pointers, Linear stores an API key, Jira stores `{email, apiToken}`, Trello stores `{apiKey, userToken}`. Keep adapter-specific shapes inside each adapter folder.

### `safeStorage` semantics

Credential helpers in `shared/auth.ts` use Electron's `safeStorage`:

- All helpers must be called **after** `app.whenReady()` resolves.
- macOS: Keychain Access (per-app key).
- Windows: DPAPI (per-user protection).
- Linux: depends on the secret store. If none is available, `getSelectedStorageBackend()` returns `'basic_text'` and we log a warning, then persist unencrypted (matching Electron's documented contract).

## Registry

`src/main/boards/board-registry.ts`

```ts
class BoardRegistry {
  register(adapter: BoardAdapter): void;
  get(id: ExternalSource): BoardAdapter | undefined;
  getOrThrow(id: ExternalSource): BoardAdapter;
  has(id: ExternalSource): boolean;
  list(): BoardAdapter[];
}

export const boardRegistry = new BoardRegistry();
boardRegistry.register(new GitHubIssuesAdapter());
// ... 6 more
```

The registry is a singleton populated at module import time. Adapters self-register their URL parsers via `registerSourceUrlParser()` so user-pasted URLs route to the right provider. Status check (`adapter.status === 'stub'`) is the single gate that prevents stub providers from reaching their throwing method bodies.

## Adding a New Provider

1. **Folder.** Create `src/main/boards/adapters/<provider>/` with at minimum `adapter.ts` (implementing `BoardAdapter`) and `index.ts` (exporting the class).
2. **Union.** Extend `ExternalSource` in `src/shared/types.ts`. Use snake_case for back-compat with existing DB rows, plain lowercase for new providers.
3. **Register.** Import the new adapter in `src/main/boards/board-registry.ts` and call `boardRegistry.register(new <Provider>Adapter())`.
4. **URL parser** (optional). If the provider has user-pasted URLs, call `registerSourceUrlParser('<provider>', { parse, buildLabel })` at module load time so the import-source store knows how to handle them.
5. **No IPC changes.** Dispatch goes through `boardRegistry.getOrThrow(source)` in `src/main/ipc/handlers/backlog.ts`. Adding a provider does not touch this file.

The contract is locked in by `tests/unit/board-registry.test.ts`, which fails if a new provider is added to the union but not registered, or if any adapter is missing a required field.

## Adapter Status

| Provider | Status | CLI dependency | Notes |
|----------|--------|----------------|-------|
| GitHub Issues | stable | `gh` | Issues API via `gh api`. |
| GitHub Projects | stable | `gh` | Projects v2 via `gh project item-list`. Requires `project` scope. |
| Azure DevOps | stable | `az` | Work items via `az boards`. Requires `azure-devops` extension. |
| Asana | stable | none | Personal Access Token. User creates the token at `app.asana.com/0/my-apps`, pastes it into the setup dialog; the token is validated against `/users/me` and stored encrypted via `safeStorage`. Ships its own `boards:asana:*` IPC group. |
| Jira | stub | - | Tracked in #481. |
| Linear | stub | - | Tracked in #482. |
| Trello | stub | - | Tracked in #483. |

The registry enumerates all 7 providers. Stable providers dispatch normally; stub providers (`jira`, `linear`, `trello`) are rendered as "coming soon" in the settings UI, and IPC handlers short-circuit them before any throwing method runs.

## See Also

- [Agent Integration](agent-integration.md) - the analogous adapter system for AI coding agents.
- [Architecture - Board Adapters](architecture.md#board-adapters) - high-level overview in the main architecture doc.
