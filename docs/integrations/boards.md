---
type: Reference
title: Board integration
description: The BoardAdapter contract for importing issues from GitHub, Azure DevOps, Asana, Jira, Linear, Trello and GitLab and notes from an Obsidian vault, safeStorage async-API behavior for stored credentials, Jira's per-site and GitLab's per-server sign-ins, Linear's API key and OAuth sign-in, the browser sign-ins for Jira and Trello through the kangentic.com token service, the daily check that the shipped Trello, Jira and Linear sign-ins still work, GitLab's own browser sign-in, Trello's Connect dialog, the folder-added Obsidian sources, the registry and URL parsers, and the steps to add a provider.
tags: [boards, import, adapters, credentials]
sources:
  - resource: src/main/boards/board-registry.ts
  - resource: src/main/boards/shared/
  - resource: src/shared/types.ts
    title: ExternalSource, FileAttachmentRef
  - resource: src/main/boards/adapters/
  - resource: src/renderer/utils/external-issue-link.ts
  - resource: scripts/check-integrations.mjs
  - resource: .github/workflows/integrations.yml
---
# Board integration

Kangentic imports issues from external boards (GitHub Issues, GitHub Projects, Azure DevOps, Asana, Jira, Linear, Trello, GitLab), and notes and checklist items from an Obsidian vault, into the backlog. Each provider is wrapped behind a common `BoardAdapter` interface so auth, fetching, mapping, and download logic stay isolated to a single folder per provider.

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
    rate-limit.ts        # withBackoff (maxAttempts, shouldRetry, retryAfterMs), retryAfterMsFrom, sleep
    network-error.ts     # networkCode: a failed fetch's cause code, for the probe and Connect refusals
    site-credential-store.ts  # per-site encrypted credential file: Jira, GitLab
    source-store.ts
    html-to-markdown.ts  # rich-text HTML to Markdown (ADO descriptions, Jira's rendered HTML)
    comments-section.ts  # the "## Comments" section ADO and Jira fold in at import
    loopback-sign-in.ts  # the one loopback server for a browser sign-in: Linear, Jira, Trello, GitLab
    pkce.ts              # createPkcePair: the PKCE verifier and S256 challenge Linear and GitLab use
    sealed-token.ts      # the sealed token a kangentic.com sign-in hands back: Jira, Trello
    index.ts             # barrel
  adapters/
    github-common/    # shared `gh` CLI client (not a BoardAdapter)
    github-issues/
    github-projects/
    azure-devops/
    asana/            # Personal Access Token auth, dedicated IPC group
    jira/             # Cloud and Data Center; per-site sign-ins, dedicated IPC group
    linear/           # API key or OAuth sign-in, GraphQL client, dedicated IPC group
    gitlab/           # gitlab.com and self-managed; per-server sign-ins, REST client, dedicated IPC group
    obsidian/         # a vault on this computer: two source types, added by folder
    trello/           # API key + user token, read-only, dedicated IPC group
  board-registry.ts   # BoardRegistry + boardRegistry singleton
  index.ts
```

`shared/index.ts` is the barrel most adapters import from. `withBackoff` retries what the adapter's
`shouldRetry` allows (GitLab: a 429 or 5xx). An adapter that passes `retryAfterMs` waits out the
server's `Retry-After`, capped at `maxDelayMs`, and otherwise the delay doubles from 500 ms.

The pattern intentionally mirrors `src/main/agent/adapters/` (one folder per CLI agent, central registry, no provider-specific branching in shared handlers). See [Agent adapter interface](agents/adapter-interface.md) for the analogous agent system.

## BoardAdapter Interface

`src/main/boards/shared/types.ts`

| Field | Required | Purpose |
|-------|----------|---------|
| `id` | yes | Unique provider id, matching the `ExternalSource` union (e.g. `'github_issues'`, `'linear'`) |
| `displayName` | yes | Human-readable product name shown in the settings UI |
| `icon` | yes | lucide-react icon name for the picker |
| `status` | yes | `'stable'` for working providers, `'stub'` for placeholder folders. IPC handlers short-circuit stubs before dispatch. |
| `checkPrerequisites(repository?)` | yes | Structured check of CLI availability + auth state. Returns `{ cliOk, authOk, message? }`. `repository` scopes the check for a provider whose sign-ins are per site (Jira); others ignore it. |
| `checkCli(repository?)` | yes | Legacy wrapper for the import IPC flow. Returns the older `{ available, authenticated, error? }` shape. Implementations can delegate to `prerequisiteToCheckCli(await this.checkPrerequisites())`. The Import dialog passes the saved source's `repository` (`importCheckCli(source, repository)`), so a provider whose sign-ins are per site (Jira) checks the right one, and one whose source can disappear on its own says so before the list loads (Obsidian answers "Folder not found" here). An `authenticated: false` from a provider whose sign-in Kangentic holds makes the Import dialog's banner offer that provider's Connect. Providers that check only a CLI ignore the repository. |
| `prepareSource(repository)` | optional | Validate a parsed source against the remote before it is saved and return its label (and a completed repository: typed JQL gains its site, a GitLab link its server's real base and canonical path). It may also return `scopeKind` (`project` or `group`) and `host`, which the saved source keeps for its subtitle ("GitLab Group on git.example.com"). A `RefusalError` thrown here is the Add Source popover's error line, and nothing is saved. Implemented by Jira and GitLab; other providers keep `resolveLabel`. |
| `workItemTypeIsItemType` | optional | True when `ExternalIssue.workItemType` is the item's type, so the import stores it as the backlog item's type. Set by Azure DevOps, Jira and GitLab; Asana uses the field for its section and leaves it off. |
| `fetch(input, findAlreadyImported)` | yes | Fetch a page of issues. `input.since` (optional) is an ISO 8601 watermark for incremental reconcile; adapters that support it return only items changed at or after that instant. The callback returns the set of external IDs already imported so the UI can mark duplicates. |
| `hydrateForImport(repository, issues)` | optional | Fetch deferred per-item detail for the SELECTED import set and fold it into each body, called at import time only. Lets a provider keep the list fetch cheap. Implemented by Azure DevOps to fetch work item comments (one `az rest` per item) for just the items being imported instead of every listed one, and by Jira to fetch each issue's comments, four issues at a time. |
| `listExternalIds(input)` | optional | Cheap, id-only listing of every current remote item, used by the reconcile to prune cache rows the remote no longer has. Implemented by Azure DevOps as an ids-only WIQL, by Jira as an ids-only search or board listing, and by Obsidian as a vault walk that shares the fetch's read (see Obsidian below). Providers without a cheap listing omit it; their deletions clear on a full reconcile, which the reconcile escalates to on its own once their cache goes a day without one. An empty result must mean the remote genuinely has no items, so an adapter that cannot answer THROWS rather than returning `[]`: the reconcile prunes against whatever this resolves to, and an empty list claims the remote is empty. |
| `downloadImages(markdownBody)` | yes | Download inline markdown images referenced in an issue body. |
| `downloadFileAttachments(...)` | optional | Download authenticated file attachments. Takes `Array<FileAttachmentRef>` (see below). Implemented by Azure DevOps for `AttachedFile` relations, by Asana for inline images and uploaded attachments, by Trello for uploaded attachments (the OAuth header goes only to Trello's own download address), and by Obsidian for files embedded in a note (copied from the vault on disk). |
| `resolveLabel(repository)` | optional | Resolve a human-readable display label from a repository identifier, called by the backlog handler after a source is added (Asana: project GID to project name; Linear: team key to team name; Trello: board short link to board name). Best-effort: returning `null`, or throwing, keeps the label the URL parser built. |
| `authenticate(input)` | optional | Future: PAT / OAuth flow. Not wired to any IPC handler yet. |
| `listProjects(credentials)` | optional | Future: list boards/projects the user can pick from. |
| `listIssues(credentials, ref, filter?)` | optional | Future: discovery method paired with `listProjects`. |
| `pushUpdates(tasks, credentials)` | optional | Future: write task updates back to the remote. |

Not every adapter honours `input.since`. Jira adds `updated >= "yyyy/MM/dd HH:mm"` to the source's JQL (before any `ORDER BY`), formatted in the signed-in user's Jira time zone from `/myself` and rewound five minutes, because JQL compares to the minute and Cloud's search is eventually consistent. Azure DevOps maps it to a WIQL `[System.ChangedDate] >= ...` clause, Linear to an inclusive `updatedAt: { gte }` issue filter, GitLab to the issues API's `updated_after`, and GitHub Issues to the REST `since=` parameter (rewound one second, because GitHub documents its boundary as exclusive where the WIQL one is inclusive, and both feed the same watermark). Asana, GitHub Projects and Obsidian ignore it and re-fetch in full on every reconcile: results stay correct, but an incremental pass costs the same as a full one. Adding `since` support to either is a contained change in that adapter's `fetch`.

### `FileAttachmentRef`

Reference to an attachment to download. Defined in `src/shared/types.ts`:

| Field | Required | Purpose |
|-------|----------|---------|
| `url` | yes | The time-of-fetch URL. Adequate for providers whose URLs do not expire. |
| `filename` | yes | Display name for the saved attachment. |
| `sizeBytes` | yes | Used for skipping oversize files before download. `0` if unknown. |
| `externalRef` | optional | Adapter-specific identifier for re-resolving a fresh URL at download time. Asana sets this to the attachment GID because Asana's `download_url` expires within ~2 minutes of being returned by the API. The Asana client calls `/attachments/{gid}` to refresh the URL just before downloading. |

A download that carries a sign-in (`downloadFile` in `src/main/boards/shared/download-file.ts`, with an `Authorization` header) keeps that header across a redirect only when the new URL has the same scheme and host. A redirect to another host, or from https to http on the same host, drops it and follows the rest. Jira sends its sign-in only to URLs on its own site, or Atlassian's gateway for a scoped Cloud token, and only over the site's own scheme.

### `Credentials`

Opaque per-adapter credential bag (`Record<string, string>`). Each adapter owns its own stored shape. There is no shared discriminated union - GitHub stores `gh` CLI session pointers, Asana one Personal Access Token, Linear either an API key or an OAuth token pair (its own `kind`-tagged union in `linear/credential-store.ts`), Jira one sign-in per site (`jira/credential-store.ts`: the site's base URL, Cloud or Data Center, the method, an email or username, the secret, for a scoped Cloud token or a browser sign-in its `cloudId` and `viaGateway`, and for a browser sign-in its `refreshToken` and `expiresAt`), Trello `{kind, apiKey, token, savedAt}` in `trello-credentials.json` under the config directory, and GitLab one sign-in per server (`gitlab/credential-store.ts`: the server's base URL with any path prefix, `token` or `oauth`, the secret, and for a browser sign-in its refresh token and expiry). Jira and GitLab both keep their per-site file through `shared/site-credential-store.ts`, which serializes saves and copies an unreadable file aside before a save overwrites it. Keep adapter-specific shapes inside each adapter folder.

A `jira-credentials.json` (or `gitlab-credentials.json`) that exists but cannot be read (the OS keychain refused the decrypt, or the file is damaged) is copied aside to `jira-credentials.json.unreadable-<timestamp>` before the next save would write over it, so one failed read cannot sign every other Jira site out. If that copy fails, the save fails and the file stays as it was.

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
- The Asana, Jira, Linear, Trello and GitLab stores and the mobile bridge identity all store their secret through
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
// ... 9 more
```

The registry is a singleton populated at module import time. Adapters self-register their URL parsers via `registerSourceUrlParser()` so user-pasted URLs route to the right provider. Status check (`adapter.status === 'stub'`) is the single gate that prevents stub providers from reaching their throwing method bodies.

### IPC channels

Backlog Import group (7 channels): `backlog:importCheckCli`, `backlog:importGetCached`, `backlog:importReconcile`, `backlog:importExecute`, `backlog:importSourcesList`, `backlog:importSourcesAdd`, `backlog:importSourcesRemove`. The fetch/import channels dispatch through `boardRegistry.requireStable(source)` in `src/main/ipc/handlers/backlog.ts`. `importGetCached` reads the per-project `remote_item_cache` table with no network; `importReconcile` fetches only items changed since the cache high-water mark, merges them, and auto-prunes items the remote no longer has.

A provider that signs in through Kangentic declares `Provider.auth` in `import-providers.tsx`: a `getStatus` that asks its own `boards:<provider>:authStatus` channel, and the `SetupDialog` that connects it. The Add Source popover asks `getStatus` when an account-wide provider is picked (Asana, Linear). Jira's sign-ins are per site and GitLab's per server, so both set `checksPastedLink`: the popover asks with the pasted link when Connect is clicked, shows the refusal `getStatus` throws as its error line (Jira's "Paste a search link so the site is known." for typed JQL with several sites connected, GitLab's "<host> is not a GitLab instance."), and continues the add once the dialog saves. The Import dialog's error banner offers the same dialog as a Connect button, prefilled with Jira's site and email.

Asana ships an additional `boards:asana:*` group (3 channels: `authStatus`, `setPat`, `clearCredential`) for its Personal Access Token lifecycle, Jira a `boards:jira:*` group (6 channels: `authStatus`, which takes the pasted link because sign-ins are per site and says whether this build offers Sign in with Atlassian; `detectSite`, which normalizes a site and asks its anonymous `serverInfo` whether it runs Cloud or Data Center; `connect`, which checks a credential against `/myself` and saves it, returning an error code the renderer turns into its line; and `signIn`, `reopenSignIn` and `cancelSignIn` for the browser sign-in), Linear its `boards:linear:*` group, and Trello a `boards:trello:*` group (8 channels: `authStatus`, `connect`, `openApproval`, `signIn`, `reopenSignIn`, `cancelSignIn`, `listBoards`, `clearCredential`). Handlers live in each adapter's `ipc-handlers.ts` and are registered from the backlog handler. Keeping the surface adapter-local means provider specifics never leak into the generic backlog handler.

Linear ships a `boards:linear:*` group (6 channels: `authStatus`, `setApiKey`, `signIn`, `reopenSignIn`, `cancelSignIn`, `listTeams`), registered by `registerLinearIpcHandlers()` the same way, and GitLab a `boards:gitlab:*` group (6 channels: `authStatus`, which takes the pasted link; `detectServer`; `connectToken`; `signIn`, `reopenSignIn` and `cancelSignIn`), registered by `registerGitLabIpcHandlers()`. The renderer reaches either group only through its provider's `auth` entry in `import-providers.tsx` (`getStatus` plus a `SetupDialog`), so the popover and the Import dialog's **Connect** button never branch on a provider name.

## Linear

`src/main/boards/adapters/linear/`. A source is one team, and the repository is its key (`ENG`). The
team picker saves `https://linear.app/<workspace>/team/<KEY>/all`, which the URL parser reads back;
a team whose key is renamed in Linear stops matching its saved source.

- **Two ways in.** A personal API key is sent as `Authorization: <key>` with no `Bearer`. The browser
  sign-in is OAuth 2.0 with PKCE (S256, no client secret, `read` scope): `oauth.ts` runs the shared
  loopback listener (`shared/loopback-sign-in.ts`) on the first free registered port
  (`LINEAR_OAUTH_REDIRECT_PORTS`, `http://127.0.0.1:<port>/callback`, matched exactly by Linear),
  opens the authorize page in the system browser, refuses a callback whose `state` does not match,
  and gives up after five minutes. An empty `LINEAR_OAUTH_CLIENT_ID` hides the sign-in choice.
- **Tokens.** Access tokens last 24 hours and refresh tokens 30 days, and Linear rotates the refresh
  token on every refresh. The client renews five minutes before expiry and after a 401, one refresh at
  a time across every client, and saves the new pair at once. A caller holding a refresh token another
  refresh already spent takes the saved pair instead of asking Linear. A refused API key, or a refresh
  token Linear refuses (a 400 or 401), clears the credential, so the next open shows **Connect Linear**.
  A rate-limited or failed refresh keeps it, and a credential a Connect saved meanwhile is never cleared.
- **Errors.** GraphQL reports failures inside a 200 as `errors[]`; the client throws `LinearError` with
  Linear's own message for those and for any non-2xx. A 429 is retried after its `Retry-After`.
- **Pruning.** Linear has no `listExternalIds`: an id walk costs one request per 250 issues on every
  open. An issue deleted or archived in Linear leaves the cache on the next full reconcile, which the
  reconcile runs on its own once the cache goes a day without one.
- **Mapping.** `externalId` is the issue UUID and `displayId` its identifier (`ENG-214`). `state` is
  the workflow state's name; completed, canceled and duplicate states are closed. `stateOrder` is the
  state's rank on the team's board (by state type, then `position`), which orders the Status filter.
  `priority` is Urgent, High, Medium or Low (Linear's 1 to 4), which the executor matches by name
  against the project's scale. Project, cycle, estimate and due date go into a `## Linear` section
  after the description.
- **Images.** Files on `uploads.linear.app` are downloaded with the same Authorization header; no
  other host gets it.
- **Known limits.** The team list is sorted by name, since the API exposes no user ordering. Each
  cached issue carries its `stateOrder` from the fetch that last saw it, so reordering a team's states
  in Linear reorders the Status filter only after a full sync (the all-imported state's Refresh) or as
  issues change.

## Browser sign-ins through kangentic.com

Jira's Sign in with Atlassian and Trello's Sign in with Trello cannot return to the desktop
directly. Atlassian's OAuth 2.0 (3LO) has no PKCE for a public client, so the code exchange and
every refresh need a client secret, and Trello only returns a token to an origin listed on the key.
Both go through kangentic.com, which holds the Atlassian secret (`functions/oauth/jira/` in the
kangentic.com repo) and serves Trello's return page, and both hand the token back the same way.

- **The listener.** `shared/loopback-sign-in.ts` is the one loopback server for Linear, Jira,
  Trello and GitLab. It binds the literal `127.0.0.1`, on a registered port (Linear) or any free port
  of at least 1024 (Jira, Trello, GitLab), keeps one pending sign-in per provider, and waits for the callback path,
  a cancel or the five-minute timeout. A request it does not recognize, or whose target the URL
  parser refuses (`//`), gets a 400 and the wait goes on. A cancel that lands while the port is
  still binding ends the attempt before the browser opens. The work after the callback (`finish`) runs while the sign-in is still pending, so a cancel
  that lands during it still wins and nothing is saved.
- **The handoff.** `shared/sealed-token.ts` makes a P-256 key pair and a 32-byte nonce per attempt.
  The `state` the provider carries to kangentic.com is base64url JSON with exactly `port`, `pub` and
  `nonce`, under 1024 characters; the service refuses any other shape with a plain 400. The service
  redirects to `http://127.0.0.1:<port>/<provider>/callback` with `payload` (the token sealed to that
  key: ECDH, HKDF-SHA256 salted with the nonce's bytes, AES-256-GCM, `ephemeralPub || iv ||
  ciphertext`) or `error`, and the nonce. The listener checks the nonce first, on an error too, so a
  forged `error=access_denied` cannot end the attempt. No token crosses a URL in the clear. The info
  strings are `kangentic-jira-oauth-v1` and `kangentic-trello-oauth-v1`, so one provider's payload
  never opens as the other's.
- **Jira.** `jira/oauth.ts` opens `auth.atlassian.com/authorize` with `audience=api.atlassian.com`,
  the client id, `read:jira-work read:jira-user offline_access` and the Jira Software board read
  scopes, `redirect_uri=https://kangentic.com/oauth/jira/callback` and `prompt=consent`. The payload
  is Atlassian's token answer as sent, read loosely; one with no refresh token fails, since it would
  die within the hour. The site maps to a cloud id from
  `api.atlassian.com/oauth/token/accessible-resources`: the site's own `_edge/tenant_info` id, then
  its host. A site the grant does not cover shows "This sign-in can't open <site>." Every call goes
  through `api.atlassian.com/ex/jira/{cloudId}`. An `error` shows Atlassian's `error_description`
  when there is one (the service cuts it to 300 characters), otherwise a line for the code
  (`access_denied`, `temporarily_unavailable`, `server_error`) or the code itself.
- **Jira tokens.** `jira/oauth-tokens.ts` renews five minutes before expiry and once after a 401, by
  `POST https://kangentic.com/oauth/jira/refresh` with `{ "refresh_token" }`. Atlassian rotates the
  refresh token, so the new pair is saved before the new access token is used, one refresh runs per
  site across every client, and a client holding a spent pair takes the saved one. Each site holds
  its own grant from its own sign-in, so one site's rotation never spends another's. A 4xx (other
  than 408 and 429) is a refusal: the client throws a 401, the Import dialog shows "Jira rejected
  the saved token." with the **Connect Jira** button, and the credential is kept so that button
  knows to start the browser sign-in again. A refresh token unused for 90 days lapses this way. A 5xx, a 408, a 429 or
  no answer (`JiraRefreshUnavailableError`, an expected failure) keeps the sign-in and offers Retry.
  So kangentic.com sees Atlassian's token answer before it seals it, and every refresh token on its
  way to Atlassian; `docs/user-guide/backlog.md` tells the user so. A refresh that lands after a
  Reconnect saved a new sign-in for the site saves nothing, and a rotated pair whose save failed is
  kept in memory for the next refresh, since Atlassian already spent the token the store holds.
  An empty `JIRA_OAUTH_CLIENT_ID` (`jira/constants.ts`) hides the choice, and Cloud opens straight on
  the API token steps.
- **Trello.** With Kangentic's key, `buildAuthorizeUrl` adds
  `return_url=https://kangentic.com/oauth/trello/return?state=...` and `callback_method=fragment`.
  The return page reads the token from the fragment, which never reaches a server, seals
  `{ "token" }`, and redirects to `/trello/callback`. `trello/oauth.ts` checks the token with Trello
  before the handler saves it as `kind: 'kangentic-key'`. `buildTrelloReturnUrl` is the one place
  the state rides, so moving it from the query to the path is a change there alone. The page sends
  `access_denied` with Trello's own message as the description (shown as it is), `invalid_request`
  for a fragment with no usable token and `server_error` when the browser could not seal it (both
  shown as "Kangentic's sign-in page failed."). A user signed out of Trello who clicks Deny never
  comes back to the page, so the waiting screen's Back and Cancel and the five-minute timeout are
  the way out. The user's own key stays paste-only: its allowed origins are not kangentic.com.
- **Owner steps.** Both need an app registered before they work. The whole list, for all four
  browser sign-ins, is in [Owner steps for the browser sign-ins](#owner-steps-for-the-browser-sign-ins).
  The [daily sign-in check](#daily-sign-in-check) reports each sign-in as `pending` until its id
  is committed.

## Owner steps for the browser sign-ins

Four sign-ins ship switched off. Jira, Trello, Linear and GitLab each have an empty client id or key
(`JIRA_OAUTH_CLIENT_ID`, `TRELLO_API_KEY`, `LINEAR_OAUTH_CLIENT_ID`, `GITLAB_COM_OAUTH_CLIENT_ID`), and
an empty value hides that sign-in and leaves the token or key as the way in. Each needs an app
registered under an account the team owns, and then its id committed. This is the whole list. As of
2026-11-17 none is registered.

| Sign-in | Register | With | Then |
|---|---|---|---|
| Trello | A Power-Up in the Power-Up admin portal (`trello.com/power-ups/admin`), then its API key | Allowed origins: `https://kangentic.com`. With no allowed origin Trello refuses every `return_url` | `TRELLO_API_KEY` in `trello/constants.ts` |
| Linear | An OAuth application (Settings, API) | Callback URLs `http://127.0.0.1:37421/callback`, `http://127.0.0.1:37422/callback` and `http://127.0.0.1:37423/callback`, which Linear matches exactly. Public on, or only the workspace that made it can sign in | `LINEAR_OAUTH_CLIENT_ID` in `linear/constants.ts`. Linear also shows a client secret, which nothing uses: the exchange is PKCE |
| GitLab | An application on gitlab.com, a group's or a user's | Redirect URI `http://127.0.0.1/callback`, Confidential off, scope `read_api` | `GITLAB_COM_OAUTH_CLIENT_ID` in `gitlab/constants.ts`. Its secret is not used either |
| Jira | An OAuth 2.0 integration in the Atlassian developer console | The Jira API scopes `read:jira-work`, `read:jira-user`, `read:board-scope:jira-software` and `read:board-scope.admin:jira-software`. Callback URL `https://kangentic.com/oauth/jira/callback`. Distribution set to Sharing, because a new app is private and only its owner can sign in | The client id and secret as the `JIRA_OAUTH_CLIENT_ID` and `JIRA_OAUTH_CLIENT_SECRET` Pages secrets on kangentic.com, then a redeploy of the site, then `JIRA_OAUTH_CLIENT_ID` in `jira/constants.ts`. Until the secrets are live the callback answers `error=server_error` |

After each registration, run one real sign-in in the system browser. That is the only run of the hop
from the public site to `127.0.0.1`, which no test reaches. Where the token expires (Jira, Linear,
GitLab), also see one refresh save a new pair.

Three answers are read from documentation or source and not yet seen from a real client:

- **Atlassian, for a refresh token it does not know.** Its guide gives 403 `invalid_grant`. Forum
  reports show 403 `unauthorized_client` with "refresh_token is invalid" for the same case. The
  desktop is right either way, since it reads any 4xx but 408 and 429 as a refusal. A check that
  tells a refused client from a refused token has to know which one a healthy client gets.
- **Linear, for a made-up code and a client it knows.** `invalid_grant` is expected. `invalid_client`
  for a client it does not know was seen on 2026-11-17.
- **gitlab.com, for a loopback redirect on a port that was never registered.** See
  [GitLab](#gitlab). If gitlab.com refuses it, GitLab moves to three registered ports, as Linear has.

**Asana has no browser sign-in, by decision (2026-11-17).** Asana's OAuth documentation describes
the code exchange with the app's client secret, and PKCE as an addition to it. It documents no
exchange without the secret. A sign-in would need a third kangentic.com Function holding that
secret, as Jira's does. A personal access token is one paste and does not expire, so that cost buys
little. Revisit it if Asana documents a public client.

## Daily sign-in check

The three browser sign-ins can break with no code change. Someone deletes or regenerates the Trello
key, drops `https://kangentic.com` from its allowed origins, revokes the Atlassian or Linear app, or
the kangentic.com pages stop serving. `.github/workflows/integrations.yml` runs
`scripts/check-integrations.mjs` every day, on demand, and on a pull request that changes a file
the script reads, the script itself or the workflow. `npm run check:integrations` runs it by hand.
The script holds no secret and needs no install. Every probe is a request a stranger could make,
and none signs anyone in.

| Check | What it asks | Passes on | Fails on |
|-------|--------------|-----------|----------|
| Trello API key | `GET api.trello.com/1/members/me?key=<TRELLO_API_KEY>` with no token | 400 `invalid token`, which only a live key gets | 401 `invalid key` |
| Trello allowed origin | Trello's approval page, signed out, with the `return_url` the desktop sends | 200 | 400 `Invalid return_url` (the key does not list kangentic.com), 404 (a key Trello does not know) |
| Trello return page | `kangentic.com/oauth/trello/return` with a valid state, then a bad one | The served `<script>` and `<style>` hash to the values in the page's own `Content-Security-Policy`, and the bad state gets a 400 | A hash that no longer matches. Browsers then run nothing and the sign-in waits until it times out |
| Jira callback | `kangentic.com/oauth/jira/callback` with a bad state, then a valid state and no code | A 400, then a 302 to `http://127.0.0.1:<port>/jira/callback?error=invalid_request&nonce=<nonce>`, with the port and nonce the probe's own state carried | A bad state that is not refused, or a redirect anywhere else |
| Jira token service | A made-up refresh token posted to `kangentic.com/oauth/jira/refresh` | `invalid_grant`, which means Atlassian accepted the client | 500 `server_error` (the Pages secrets are unset), `unauthorized_client`, `invalid_client`, `access_denied` |
| Linear client | A made-up authorization code exchanged at `api.linear.app/oauth/token` for `LINEAR_OAUTH_CLIENT_ID`, with the first registered redirect URI | `invalid_grant`, which means Linear knows the client | `invalid_client` |

The Fails on column names the answers the check knows the cause of. Any other answer fails its
check too, and so does no answer at all.

- **Pending.** An empty `TRELLO_API_KEY`, `JIRA_OAUTH_CLIENT_ID` or `LINEAR_OAUTH_CLIENT_ID` means
  that sign-in is not shipped. Its checks report `pending` and do not fail the run, so the run's
  summary is also the list of owner steps left. The Trello and Linear checks send nothing while
  their id is empty. The Jira token service still sends its request, and a service that is not
  ready is `pending` only until the id ships. An answer that check does not know fails it even
  before then. A non-empty id that fails is a red run. The return page and the callback are
  checked on every run.
- **Values.** The script reads the ids, the site (`DOCS_BASE_URL`), the page paths and Linear's
  redirect URI from the source text of the checkout, so a pull request checks its own values. It
  cannot import them, because it runs before any install. A constant that is gone or written another
  way fails the run. `tests/unit/check-integrations.test.ts` holds every value it reads equal to the
  real export, its approval URL equal to `buildAuthorizeUrl`'s, and each answer to its verdict. It
  replays the answers a stranger can get today from
  `tests/fixtures/sign-in-check-live-answers.json`, which was recorded from the live services.
- **Overrides.** An environment variable named `TRELLO_API_KEY`, `JIRA_OAUTH_CLIENT_ID`,
  `LINEAR_OAUTH_CLIENT_ID` or `DOCS_BASE_URL` replaces the shipped value. That checks a new key
  before it is committed, or points the page checks at a preview deployment. An empty variable counts
  as unset, so it cannot turn a shipped id's checks into pending ones.
- **Answers not yet seen.** Two passing answers have never been seen with a real client: Atlassian's
  `invalid_grant`, which its docs give for a refresh token it will not take, and Linear's
  `invalid_grant` for a client it knows. The pull request that commits each id runs this check, so
  that run confirms the answer or shows the real one. The check never uses Linear's refresh grant,
  which answers `invalid_grant` for a made-up client too.
- **Who hears.** A run writes the table to its summary, one error annotation per failure and one
  notice per pending check. A failed scheduled run emails the person who last changed the
  workflow's schedule (its `cron` line), or who re-enabled the workflow after that, under that
  person's own GitHub Actions notification settings. `/release` reads the last scheduled run
  before a tag and stops when it did not succeed, is older than 48 hours, or is missing. It is not
  a required check, because an outage at Trello, Linear or kangentic.com must not block an
  unrelated merge.

## GitLab

`src/main/boards/adapters/gitlab/`. gitlab.com and self-managed servers. A source is a project or a
group, pasted as any GitLab link (a project, `/groups/<path>`, an issue list, one issue or work item,
or `/-/boards/<id>`). The repository is `<server base>|<full path>`, plus `|board=<id>` for a board
link. Import is read-only; nothing is written back.

- **Which server.** The URL parser reads the link lexically. `getAuthStatus` (behind
  `boards:gitlab:authStatus`) asks a server Kangentic holds no sign-in for whether it runs GitLab:
  `instance.ts` sends an unauthenticated `GET /api/v4/version`, which GitLab answers with 401 and
  `{"message":"401 Unauthorized"}` (or 200 with a `version`), and GitHub and the rest answer 404. A
  server that is not GitLab is refused with "<host> is not a GitLab instance." in the popover. An
  instance served under a path prefix is found by trying each prefix from the left. gitlab.com is
  never asked.
- **Two ways in on gitlab.com, one elsewhere.** A personal access token (`read_api`) works on every
  server; Connect's step 1 opens `<base>/-/user_settings/personal_access_tokens?name=Kangentic&scopes=read_api`.
  The browser sign-in is gitlab.com only, since a self-managed server would need an OAuth app its own
  admin registers: OAuth with PKCE (`read_api`), handed back to `http://127.0.0.1:<free port>/callback`
  through `shared/loopback-sign-in.ts`. Doorkeeper, GitLab's OAuth server, drops the port of a
  loopback IP redirect on both sides before comparing (RFC 8252 section 7.3), but not of `localhost`.
  This is read from Doorkeeper's `uri_checker.rb`; nobody has tried it on gitlab.com yet, because the
  OAuth app is not registered.
  An empty `GITLAB_COM_OAUTH_CLIENT_ID` hides it. Access tokens last 2 hours; `fresh-credential.ts`
  renews one five minutes before expiry, once for overlapping callers, and saves the new pair before
  using it, because GitLab revokes the old refresh token. Every personal access token expires (365
  days at most), so a token user reaches the Import dialog's Connect banner when it does.
- **Sign-in header.** Both a token and a sign-in go as `Authorization: Bearer`, not `PRIVATE-TOKEN`:
  `fetch` and the shared download drop `Authorization` on a redirect to another host, and would carry
  a custom header along.
- **Errors.** GitLab's own text is shown as sent: `401 Unauthorized` for a wrong or revoked token, the
  `invalid_token` description for an expired one, the `insufficient_scope` description for a token
  without `read_api`. A 429 waits out its `Retry-After`; a 429 or 5xx is tried three times.
- **Status.** A source's board is the one a board link named, else GitLab's default (first by name,
  then id). A closed issue is Closed; an open one sits on the leftmost label list it carries, else
  Open. `stateOrder` puts Open first, the lists by `position`, Closed last. Assignee, milestone and
  iteration lists carry no label and are skipped.
- **Mapping.** `externalId` is `<host>:<global issue id>`, so projects and servers never collide.
  `displayId` is `#<iid>` for a project source and GitLab's `references.relative` (`web#214`) for a
  group source. `workItemType` is Issue, Task, Incident or Test case. Priority is left empty. A
  project-relative `/uploads/<secret>/<file>` link becomes a full link on its project, GitLab's
  `{width=...}` image marks are dropped, and milestone, iteration, weight, due date and assignees go
  into a `## GitLab` section, leaving out lines with no value.
- **Images.** The plain upload link refuses a token, so an upload on a server Kangentic holds a sign-in
  for downloads through `GET /api/v4/projects/<id>/uploads/<secret>/<file>` (GitLab 17.4 and later)
  with that server's sign-in only. On an older server the download fails, the link stays in the
  description, and it counts as skipped.
- **Group sources.** `GET /groups/:id/issues` covers subgroups and leaves out projects GitLab has
  archived (`non_archived` defaults to true), the same set GitLab's own group issue list shows.
- **Pruning.** No `listExternalIds`; deletions clear on a full reconcile.
- **Merge requests.** `client.ts` keeps `request` and `paginate` generic so a later merge request
  connector can share it. Nothing here reads merge requests.

## Obsidian

`src/main/boards/adapters/obsidian/`. Two adapters, `obsidian_notes` (one note per task) and
`obsidian_checklist` (one `- [ ]` line per task), share one vault reader. Nothing here writes to the
vault, and the vault is read on this computer even for a remote project.

- **Added by folder.** The source type's `folder` entry in `import-providers.tsx` makes the popover
  open the system folder dialog instead of a URL field, so the chosen path is the source's URL. The
  URL parser walks up from it to the nearest folder holding `.obsidian` (the vault) and refuses a
  folder in no vault. The repository is the chosen folder, which is the scope. The label is the
  vault's name, then the folder's (`Work: Projects`).
- **The check.** With no sign-in or CLI, `checkCli(repository)` is a folder check: "Folder not found"
  when the folder is gone, "Not in a vault" when `.obsidian` is. The Import dialog shows it in place of
  the list with **Choose folder**, which adds the new folder and removes the old source. Choosing
  the same folder again re-runs the check in place.
- **Fetch.** One pass reads the whole folder and returns every item on page 1; `since` is ignored. The
  walk skips dot folders and the Templates core plugin's folder, and yields every 200 files. A
  reconcile's `fetch` and `listExternalIds` share one read through a five-second reuse window.
- **Properties.** A small parser in `frontmatter.ts` reads the YAML subset Obsidian's Properties
  editor writes (scalars, quoted strings, flow and block lists, block scalars), so the import carries
  no YAML library. A block it cannot split reads as no properties.
- **Mapping.** Only named properties and markers are read: `title`, `tags` (plus inline `#tags`),
  `priority` and `status` for a note (`tag` is read like `tags`); the Tasks plugin's status and priority markers for a line.
  `displayId` is a note's folder or a line's note, `priority` is a name the executor matches against
  the project's scale, and `stateOrder` orders the checkbox states, or a Kanban plugin board's lanes.
- **Ids.** A note's id is its vault-relative path. A line's id is the note's path plus its block id,
  or its words when it has none, with repeats told apart by order. A renamed note reads as new.
- **Files.** Embeds resolve the way Obsidian resolves a link and become `FileAttachmentRef`s with a
  `file:` URL and the vault path as `externalRef`. `downloadFileAttachments` reads each from disk only
  when it is a local file (no network host) that resolves inside a vault, sits under no dot folder,
  is a regular file, and is within `MAX_ATTACHMENT_SIZE`. Web images take `downloadImages`.
- **Link.** `externalUrl` is the note's `file:` URL. The backlog's link icon opens it through
  `openExternalIssueLink` (`src/renderer/utils/external-issue-link.ts`), which sends a local `.md`
  file to `shell.openPath`, since `shell.openExternal` refuses `file:` by design. A `file:` URL that
  does not decode is not a local file, so the icon opens nothing.

## Adding a New Provider

1. **Folder.** Create `src/main/boards/adapters/<provider>/` with at minimum `adapter.ts` (implementing `BoardAdapter`) and `index.ts` (exporting the class).
2. **Union.** Extend `ExternalSource` in `src/shared/types.ts`. Use snake_case for back-compat with existing DB rows, plain lowercase for new providers.
3. **Register.** Import the new adapter in `src/main/boards/board-registry.ts` and call `boardRegistry.register(new <Provider>Adapter())`.
4. **URL parser** (optional). If the provider has user-pasted URLs, call `registerSourceUrlParser('<provider>', { parse, buildLabel })` at module load time so the import-source store knows how to handle them.
5. **No IPC changes.** Dispatch goes through the registry in `src/main/ipc/handlers/backlog.ts`: `boardRegistry.requireStable(source)` for the reconcile and the import, `boardRegistry.get(source)` for the check and for adding a source. Adding a provider does not touch this file.

The contract is locked in by `tests/unit/board-registry.test.ts`, which fails if a new provider is added to the union but not registered, or if any adapter is missing a required field.

## Adapter Status

| Provider | Status | CLI dependency | Notes |
|----------|--------|----------------|-------|
| GitHub Issues | stable | `gh` | Issues API via `gh api`. |
| GitHub Projects | stable | `gh` | Projects v2 via `gh project item-list`. Requires `project` scope. |
| Azure DevOps | stable | `az` | Work items via `az boards`. Requires `azure-devops` extension. |
| Asana | stable | none | Personal Access Token. User creates the token at `app.asana.com/0/my-apps`, pastes it into the setup dialog; the token is validated against `/users/me` and stored encrypted via `safeStorage`. Ships its own `boards:asana:*` IPC group. |
| Jira | stable | none | Cloud and Data Center. A source is a board, a project, a saved filter or a JQL query (`repository` is `<site base>::<kind>::<value>`). Cloud signs in with an Atlassian API token and email (Basic), always over `https` (a typed `http://` on a Cloud host is upgraded before the first request), retried through `api.atlassian.com/ex/jira/{cloudId}` for a scoped token; Data Center with a personal access token (Bearer) or a username and password. Sign-ins are per site, so its `boards:jira:authStatus` takes the pasted link and the popover checks it when Connect is clicked (`ProviderAuth.checksPastedLink`). Descriptions and comments come from `renderedFields` HTML, so one path reads Cloud's ADF and Data Center's wiki markup. A board source shows its column names, in board order, from `/rest/agile/1.0/board/{id}/configuration`. Ships its own `boards:jira:*` IPC group. Cloud also offers Sign in with Atlassian (Bearer, through the gateway), see [Browser sign-ins through kangentic.com](#browser-sign-ins-through-kangenticcom). |
| Linear | stable | none | Personal API key or OAuth sign-in in the browser, both stored encrypted via `safeStorage`. Teams are picked from a list. Ships its own `boards:linear:*` IPC group. |
| GitLab | stable | none | gitlab.com and self-managed. A personal access token on any server, or a browser sign-in on gitlab.com, stored encrypted per server via `safeStorage`. A source is a project or a group from a pasted link. Ships its own `boards:gitlab:*` IPC group. |
| Obsidian Notes | stable | none | A vault folder on this computer, chosen in the folder dialog. Each note is a task. |
| Obsidian Checklist items | stable | none | Same folder source. Each task line (`- [ ]`, `- [x]`, `- [/]`, `- [-]`) is a task, with the Tasks plugin's markers and Kanban plugin lanes. |
| Trello | stable | none | API key plus user token, sent only in an `Authorization: OAuth` header and stored encrypted in `trello-credentials.json` under the config directory. Kangentic's own key also signs in through the browser, with nothing to paste (see Trello's Connect dialog). Read-only: a board is read whole (lists and cards, archived ones included), and Closed means an archived card or a card on an archived list. Boards are picked from a list under their Workspace. Ships its own `boards:trello:*` IPC group. |

The registry enumerates all 10 providers, and every one is stable. Stable providers dispatch normally. A provider still marked `stub` would not be offered in the import UI (`src/renderer/components/backlog/import-providers.tsx` lists only the stable ones), and IPC handlers would short-circuit it before any throwing method runs.

### Trello's Connect dialog

**Connect Trello** offers two ways in. **Use your own API key** walks the user through making a
Trello app at `trello.com/apps/admin`, pasting its key, and opening Trello's approval page for it
(`scope=read`, `expiration=never`, no `return_url`), where Trello shows the token to paste. **Sign in
with Trello** opens the approval page for Kangentic's own key, `TRELLO_API_KEY` in
`trello/constants.ts`, and waits while kangentic.com's return page hands the token back (see
[Browser sign-ins through kangentic.com](#browser-sign-ins-through-kangenticcom)); there is nothing
to paste. A declined approval, a page that fails or a timeout goes back to the two choices with the
reason. The choice shows only when that constant is set. It is empty until the team makes its Trello
app, so a build without it opens straight on the own-key steps. The key never crosses to the
renderer: `boards:trello:signIn` reads it in main.

Every key Trello issues shares one rate limit across all of its tokens (300 requests per 10
seconds, 100 per token), so the shipped key is one budget for every install, and the user's own key
never touches it.

Connect checks the key and token through `/members/me/boards` before saving. That call does not
count against Trello's separate `/members` limit of 100 requests per 15 minutes, and its 401 text
(`invalid key`, `invalid token`) is shown under the field it blames. A stored token is cleared only
when Trello says it is dead (`invalid token`, `invalid key`, `expired token`); any other 401, such as
a board the token cannot read, keeps it. In the board picker, only that kind of refusal reopens
Connect. A rate limit, an outage or an answer that is not JSON shows in the picker instead, so a
token that still works is never sent back through Connect. The registry's adapter keeps
one `TrelloClient` for the app's life, so the credential store bumps a version on every save and
clear, and a client holding an older credential reloads it.

## See Also

- [Agents](agents/index.md) - the analogous adapter system for AI coding agents.
