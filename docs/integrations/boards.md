---
type: Reference
title: Board integration
description: The BoardAdapter contract for importing issues from GitHub, Azure DevOps and Asana, the Jira, Linear and Trello stubs, safeStorage async-API behavior for stored credentials, the registry and URL parsers, and the steps to add a provider.
tags: [boards, import, adapters, credentials]
sources:
  - resource: src/main/boards/board-registry.ts
  - resource: src/main/boards/shared/
  - resource: src/shared/types.ts
    title: ExternalSource, FileAttachmentRef
---
# Board integration

Kangentic imports issues from external boards (GitHub Issues, GitHub Projects, Azure DevOps, Asana) into the backlog, and is being extended to three more providers (Jira, Linear, Trello). Each provider is wrapped behind a common `BoardAdapter` interface so auth, fetching, mapping, and download logic stay isolated to a single folder per provider.

This doc covers the adapter system and how to add a new board provider.

## Layout

```
src/main/boards/
  shared/             # BoardAdapter interface + cross-provider helpers
    types.ts
    auth.ts
    encrypted-secret-file.ts
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

The pattern intentionally mirrors `src/main/agent/adapters/` (one folder per CLI agent, central registry, no provider-specific branching in shared handlers). See [Agent Integration](agents/index.md) for the analogous agent system.

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
| `fetch(input, findAlreadyImported)` | yes | Fetch a page of issues. `input.since` (optional) is an ISO 8601 watermark for incremental reconcile; adapters that support it return only items changed at or after that instant. The callback returns the set of external IDs already imported so the UI can mark duplicates. |
| `hydrateForImport(repository, issues)` | optional | Fetch deferred per-item detail for the SELECTED import set and fold it into each body, called at import time only. Lets a provider keep the list fetch cheap. Implemented by Azure DevOps to fetch work item comments (one `az rest` per item) for just the items being imported instead of every listed one. |
| `listExternalIds(input)` | optional | Cheap, id-only listing of every current remote item, used by the reconcile to prune cache rows the remote no longer has. Implemented by Azure DevOps as an ids-only WIQL. Providers without a cheap listing omit it; their deletions clear on a full reconcile, which the reconcile escalates to on its own once their cache goes a day without one. An empty result must mean the remote genuinely has no items, so an adapter that cannot answer THROWS rather than returning `[]`: the reconcile prunes against whatever this resolves to, and an empty list claims the remote is empty. |
| `downloadImages(markdownBody)` | yes | Download inline markdown images referenced in an issue body. |
| `downloadFileAttachments(...)` | optional | Download authenticated file attachments. Takes `Array<FileAttachmentRef>` (see below). Implemented by Azure DevOps for `AttachedFile` relations and by Asana for inline images and uploaded attachments. |
| `resolveLabel(repository)` | optional | Resolve a human-readable display label from a repository identifier, called by the backlog handler after a source is added (Asana: project GID to project name). Best-effort: returning `null`, or throwing, keeps the label the URL parser built. |
| `authenticate(input)` | optional | Future: PAT / OAuth flow. Not wired to any IPC handler yet. |
| `listProjects(credentials)` | optional | Future: list boards/projects the user can pick from. |
| `listIssues(credentials, ref, filter?)` | optional | Future: discovery method paired with `listProjects`. |
| `pushUpdates(tasks, credentials)` | optional | Future: write task updates back to the remote. |

Not every adapter honours `input.since`. Azure DevOps maps it to a WIQL `[System.ChangedDate] >= ...` clause and GitHub Issues to the REST `since=` parameter (rewound one second, because GitHub documents its boundary as exclusive where the WIQL one is inclusive, and both feed the same watermark). Asana and GitHub Projects ignore it and re-fetch in full on every reconcile: results stay correct, but an incremental pass costs the same as a full one. Adding `since` support to either is a contained change in that adapter's `fetch`.

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

Credential helpers in `shared/auth.ts` use Electron's `safeStorage` through its ASYNC API only
(`encryptStringAsync` / `decryptStringAsync` / `isAsyncEncryptionAvailable`), so all three
helpers return promises. The sync API is deprecated in Electron 45 and removed in 46, and nothing
under `src/` calls it; `tests/unit/boards-auth.test.ts` fails if anything does.

- All helpers must be called **after** `app.whenReady()` resolves.
- macOS: Keychain Access (per-app key).
- Windows: DPAPI (per-user protection).
- Linux: the async API asks the Secret portal, or the Secret Service (gnome-keyring, KeePassXC) or
  KWallet on KDE, on any desktop. The sync API searched only Chromium's fixed desktop list, so on
  sway, i3 or WSLg it reported `basic_text` even with a keyring running. With no secret store at
  all, the async API still encrypts, under a hardcoded fallback key that protects nothing.
  The sync API's `getSelectedStorageBackend()`, which no code calls now, described only the sync
  backend and could not see this, so `isGenuineEncryptionAvailable()` reads Chromium's tag on a probe ciphertext instead: `v10` is the
  fallback key, `v11` the Secret Service or KWallet, `v12` the portal. `encryptSecret` picks a real
  key, then the fallback key, then plaintext.
- The async API reads what the sync API wrote. Electron 45's breaking-changes entry says the two
  use the same per-platform key stores. Windows was measured: on 44.5.1 and again on 45.0.0 a
  sync-written blob decrypted through the async API. macOS and KDE were not measured. For them the
  evidence is Electron's `CreateOSCryptAsync` with Chromium 156: the macOS Keychain provider is on
  by default and reads the sync API's Keychain item and `v10` key, and on KDE the Freedesktop
  provider opens the sync API's KWallet folder and entry under `v11`. Earlier builds kept the sync
  API as a fallback for macOS and KWallet; it was removed with the move to Electron 45. A mobile
  bridge identity that still fails to read is moved aside by the next pairing, never overwritten.
- The stored format did not change: `'e'` + base64 for encrypted, `'p'` + base64 for plaintext (only
  when no encryption is available). Credentials older builds wrote through the sync API read
  through the async one. `decryptSecret` reports when a blob should be written again: a key
  rotation, or plaintext once genuine encryption exists.
- The Asana store and the mobile bridge identity both store their secret through
  `shared/encrypted-secret-file.ts` (`readEncryptedSecretFile`, `writeEncryptedSecretFile`,
  `rewriteEncryptedSecretFile`). The read reports `shouldRewrite`, and each store calls the rewrite
  on load when it is set; the identity also requires `isGenuineEncryptionAvailable()` first, the
  same bar creating one has to clear. A rewrite writes only if the file still holds the ciphertext
  it read, so a clear or a new save that lands during the awaits wins. A failed rewrite is logged,
  and the next read tries again.

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

The registry enumerates all 7 providers. Stable providers dispatch normally. Stub providers (`jira`, `linear`, `trello`) are not offered in the import UI (`src/renderer/components/backlog/import-providers.tsx` lists only the stable ones), and IPC handlers short-circuit them before any throwing method runs.

## See Also

- [Agent Integration](agents/index.md) - the analogous adapter system for AI coding agents.
- [Architecture - Board Adapters](../architecture.md#board-adapters) - high-level overview in the main architecture doc.
