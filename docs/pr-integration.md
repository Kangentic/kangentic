# PR Integration

Kangentic links each task to its pull request and keeps that link fresh: it detects a PR from terminal scrollback, authoritatively resolves the PR's state through a hosting-provider CLI, and persists `pr_url` / `pr_number` / `pr_state` on the task so the board can show it. GitHub is the only provider wired today, but every provider is wrapped behind a common `PRConnector` interface so detection and resolution logic stays isolated to a single folder per platform.

This doc covers the connector system, the confidence ladder that picks the strongest anchor, the background refresh sweep, and how to add a new hosting provider.

## Layout

```
src/main/pr/
  shared/                 # PRConnector contract + platform-agnostic errors
    pr-connector.ts
    pr-errors.ts
  adapters/
    github/
      github-connector.ts # gitHubPRConnector (gh CLI)
  pr-registry.ts          # connector array + platform-agnostic dispatch API
  pr-linking.ts           # confidence ladder + persist (the backbone)
  pr-refresh.ts           # background refresh-and-discover sweep
  pr-refresh-scheduler.ts # per-project timer that arms the sweep
```

The pattern intentionally mirrors `src/main/boards/adapters/` and `src/main/agent/adapters/` (one folder per provider, a central registry, no provider-specific branching in shared code). See [Board Integration](board-integration.md) for the analogous board-import system.

## PRConnector Interface

`src/main/pr/shared/pr-connector.ts`

Every hosting provider implements this contract. The registry calls it without knowing which providers are registered.

| Member | Required | Purpose |
|--------|----------|---------|
| `name` | yes | Platform name for logging (e.g. `"GitHub"`). |
| `matchesCommand(commandDetail)` | yes | Whether a Bash command detail looks like a PR command for this platform (drives activity flagging). |
| `extract(scrollback)` | yes | Extract a PR URL + number from raw PTY scrollback text (no network). Returns the most recent match. |
| `resolveForBranch?(repoCwd, branchName, baseBranch?)` | optional | Authoritatively resolve the PR for a branch via the platform API, run inside the repo/worktree at `repoCwd`. Returns null when no PR matches the head ref; throws `PRResolverUnavailableError` when the CLI is unavailable. |
| `resolveByNumber?(repoCwd, prNumber)` | optional | Resolve a PR by its number, the most exact anchor and immune to branch renames. Used to refresh an already-linked PR's state. |
| `resolveByCommit?(repoCwd, commitSha, branchHint?)` | optional | Resolve the PR associated with a commit SHA, an immutable anchor that survives worktree deletion and branch renames. `branchHint` disambiguates when a commit belongs to several PRs. |

### Verb taxonomy

The subsystem uses a consistent verb prefix across modules:

- `detect*` - parse a PR reference from text / scrollback (no network).
- `resolve*` - authoritative provider lookup (CLI / API).
- `link*` - resolve then persist to a task (see `pr-linking.ts`).
- `refresh*` - bulk re-link across a project (see `pr-refresh.ts`).

### `DetectedPR`

Result of a no-network detection (`extract`).

| Field | Required | Purpose |
|-------|----------|---------|
| `url` | yes | The full PR URL parsed from text. |
| `number` | yes | The PR number parsed from the URL. |

### `ResolvedPR`

Result of an authoritative API resolve. Richer than `DetectedPR` because it comes from a structured query rather than scrollback text.

| Field | Required | Purpose |
|-------|----------|---------|
| `url` | yes | The PR URL. |
| `number` | yes | The PR number. |
| `state` | yes | Normalized `PRState` (`'open' \| 'draft' \| 'merged' \| 'closed'`). |
| `baseRefName` | optional | The PR's base branch, used to prefer a base-matching candidate during disambiguation. |
| `updatedAt` | optional | Last-updated timestamp, used as the final tiebreak when several PRs match. |

## Error Types

`src/main/pr/shared/pr-errors.ts`

Both errors are platform-agnostic (a leaf module with no connector imports) so `pr-linking.ts` can catch them without importing any provider-specific error type. Connectors translate their own errors (e.g. GitHub's `GhUnavailableError`) into these.

| Error | Meaning | Caller behavior |
|-------|---------|-----------------|
| `PRResolverUnavailableError` | The platform resolver cannot run at all (CLI missing / unauthenticated, or no connector matches the remote). | Degrade to `detectPR` scrollback scraping; preserve any existing link; log a one-time hint. |
| `PRResolverTransientError` | Resolution failed transiently (network / 5xx / rate-limit / timeout) rather than because there is no PR. | Preserve the existing link and report `transient-error` instead of `not-found`. |

## Registry

`src/main/pr/pr-registry.ts`

The registry holds a plain `connectors` array populated at module import time, and exposes a platform-agnostic API that iterates connectors and returns the first match. There is no provider-name branching here (mirrors `.claude/rules/agent-adapters-boundary.md`).

```ts
const connectors: PRConnector[] = [
  gitHubPRConnector,
  // Future: gitLabMRConnector, bitbucketPRConnector, azureDevOpsPRConnector
];
```

| Function | Purpose |
|----------|---------|
| `matchesPRCommand(commandDetail)` | True if any connector recognizes the Bash command as a PR command. |
| `detectPR(scrollback)` | Try every connector's `extract` against scrollback; return the first match. |
| `resolvePRForBranch(repoCwd, branchName, baseBranch?)` | First connector that supports `resolveForBranch` and returns a match. |
| `resolvePRByNumber(repoCwd, prNumber)` | First connector that supports `resolveByNumber`. |
| `resolvePRByCommit(repoCwd, commitSha, branchHint?)` | First connector that supports `resolveByCommit`. |

The registry also re-exports the contract types and both error classes, so consumers have a single import surface.

## GitHub Connector

`src/main/pr/adapters/github/github-connector.ts`

`gitHubPRConnector` resolves PRs through the `gh` CLI and detects PR URLs from terminal output. It reuses the board importer's `gh` client (`GitHubImporter` from `boards/adapters/github-common/gh-client.ts`) so binary detection and auth plumbing are shared; a module-level singleton avoids re-probing `gh` per call.

**Detection.** `extract` strips ANSI escape sequences from the tail of scrollback (a 4096-byte scan window) and matches `https://github.com/<owner>/<repo>/pull/<number>`, returning the last (most recent) match. It handles `gh pr create` stdout, `gh pr view` TTY and non-TTY output, and `gh pr view --json`. It deliberately does not match `git push`'s `/pull/new/<branch>` output (no numeric id) or `gh pr merge`'s `owner/repo#123` short form (no full URL). Detection runs against terminal scrollback only: there is deliberately no scraper for authored text such as a task description (see "The confidence ladder" below).

**Resolution.** The three resolve methods call the shared `gh` client (`resolvePRByBranch`, `resolvePRByNumber`, `resolvePRByCommit`) and normalize the result. `resolveByCommit` additionally reads local git (see its two filters below); the other two are pure `gh`.

- `mapState` maps GitHub's `OPEN` / `CLOSED` / `MERGED` plus `isDraft` to the normalized `PRState`.
- `disambiguate` picks the best candidate for inferred (branch / commit) matches: it drops fork (cross-repository) PRs, restricts to PRs whose head ref matches `branchHint` (returning null rather than guessing when SEVERAL non-matching candidates remain, but keeping a LONE one), then prefers open/draft, then a matching base branch, then the most recently updated. `resolveByNumber` bypasses this guard because an explicit number is unambiguous.

  Keeping the lone non-matching candidate is deliberate, not an oversight in the hint rule. It is the anchor for a Done task whose branch was renamed and pushed under a different head ref, which is the case the commit tier exists for; the two filters below are what reject a wrong candidate.
- `resolveByCommit` filters the candidate pool twice before disambiguating, because `gh api commits/<sha>/pulls` returns every PR whose head branch contains the commit - including one that merely branched off the same base tip and therefore inherited it:
  - drop any PR whose merge commit IS the resolved commit, so a fresh worktree sitting on the base branch's tip is never magneted onto the last-merged sibling PR;
  - drop any remaining PR whose OWN base branch already contains the commit (`isShaContainedInRef` in `src/main/git/worktree-head.ts`, run against `origin/<baseRefName>` and falling back to the local ref). `baseRefName` already rides along on the REST response, so this costs a local `rev-list`, not an API call.

  The second filter exempts `MERGED` candidates: a merged PR's own commits ARE in its base afterwards, so containment cannot separate "this task's work, now merged" from "inherited base history" - the merge-commit filter covers that shape instead. When the base ref is not fetched locally the probe is undetermined and the candidate is kept, so on its own an unfetched ref costs a mislink guard rather than an existing badge.

  One caveat, currently unresolved. Because the filter runs BEFORE `disambiguate`, dropping a proven-contained sibling can leave a kept-undetermined candidate as the LONE survivor. It then slips past the hint rule's ambiguity guard, which only returns null when MORE than one non-matching candidate remains, so a candidate never verified as its own work can win a comparison that previously returned null. Whether an undetermined survivor should still count toward that ambiguity threshold is an open question, not a settled trade-off.

**Concurrency + error translation.** All resolves run through a global `p-queue` capped at `GH_CONCURRENCY = 3`, so a multi-card drag or board-load burst cannot fan out into dozens of concurrent `gh` processes. The `viaGh` wrapper translates `GhUnavailableError` into `PRResolverUnavailableError` and `GhTransientError` into `PRResolverTransientError`, keeping the generic layer free of provider-specific error types.

## PR Linking

`src/main/pr/pr-linking.ts`

`linkPRForTask` is the single backbone every trigger funnels through. It resolves a task's PR via a confidence ladder, short-circuiting on the first hit, and writes only on change. It is wrapped in `withTaskLock` because it crosses an await boundary and mutates per-task state (see `.claude/rules/task-lifecycle-lock.md`).

### The confidence ladder

`resolvePRViaLadder` tries the strongest available anchor first:

| Tier | Anchor | Why |
|------|--------|-----|
| 1 | `pr_number` | Exact and branch-independent, best for refreshing an existing link's state. Also how a review task names the PR it is about. |
| 2 | Worktree HEAD branch | The real branch while the task is actively worked. |
| 3 | Commit SHA | Immutable, survives Done / worktree deletion and branch renames. Guarded twice: a cheap commits-ahead-of-base check here skips the tier outright for a fresh worktree on base's tip, and the connector then rejects any individual candidate whose own base already contains the commit. |
| 4 | Stored slug branch | Weak last resort when there is no worktree. |

A `PRResolverUnavailableError` from any tier propagates so the caller can degrade.

**A PR URL in the task description is not an anchor.** Every tier above is git state or an explicitly stored number. Scraping the description was tried and removed: a URL cited as background ("this follows on from `<url>`") is textually identical to one naming the task's own PR, so the linker stamped a sibling task's PR onto unrelated tasks - and because that tier always produced a link, the confident-not-found clear could never fire, so the wrong link was permanent. A review task names its PR through the structured `pr_url` / `pr_number` fields (the task-detail edit form, `kangentic_create_task`'s `prUrl` / `prNumber`, or `kangentic_update_task`), which lands on Tier 1. Tier 3's two guards independently cover the base-tip case the description tier was originally written for.

The commits-ahead-of-base guard alone is not enough for that, which is why the connector-side filter exists. It measures against `task.base_branch ?? git.defaultBaseBranch ?? 'main'`, and a worktree cut from a long-lived integration branch records no base, so the guard compared a HEAD sitting on `feature/x`'s tip against `main`, found hundreds of commits, and let the tier run. It is kept as a cheap early-out that skips a `gh api` round-trip on the common fresh-worktree-off-`main` case; the per-candidate check is the sound one. Its false negatives are safe (a commit contained in `main` is genuinely not the task's work), so only its fail-open direction needed closing.

### Persist and degrade behavior

- **Auto triggers** (non-force) skip terminal `merged` / `closed` PRs (they cannot change) and coalesce rapid re-resolves through a per-task 60s throttle (`RESOLVE_TTL_MS`, a bounded `Map` pruned on each run). Explicit user/agent actions pass `force: true` to bypass both.
- **Degradation.** When the resolver throws `PRResolverUnavailableError` or `PRResolverTransientError`, the linker records a `resolver-unavailable` / `transient-error` status, falls back to `detectPR` on any provided scrollback (url+number only), preserves a known state when the URL is unchanged, and logs a one-time hint. A degraded resolve never clears an existing link.
- **Confident not-found.** When the resolver ran cleanly and matched no PR yet the task still carries a link, the linker clears `pr_url` / `pr_number` / `pr_state` atomically so a stale `merged` never lingers.
- **SHA backfill.** It opportunistically persists the freshly-read worktree HEAD SHA so the commit anchor (Tier 3) is available later, after the worktree is reclaimed on Done.

### Entry points

- `linkPR(context, options)` is the IPC-side wrapper: it resolves the project + task (by id, else live session, else branch name) and wires the `TASK_UPDATED_BY_AGENT` renderer notification. Mapping by branch/session means exited or suspended sessions and human-created PRs still link.
- `autoLinkPRForTask(context, taskId, projectId)` is the fire-and-forget entry for implicit triggers. It gates on a non-To Do lane (To Do resets the task) and on having some anchor, then calls `linkPR` non-force so the 60s throttle coalesces bursts. It is called after a task-move returns, on the plan-exit auto-move, and when a session goes idle (a PR was likely just created). A `pr-candidate` session event (scrollback carrying a PR command) also routes through `linkPR` by session id.

## PR Refresh and Scheduler

`src/main/pr/pr-refresh.ts`, `src/main/pr/pr-refresh-scheduler.ts`

### The sweep

`refreshProjectPRs` re-resolves every eligible task through the `linkPR` backbone (unchanged, non-force). This both refreshes an already-linked PR's state (so an off-app merge/close shows on the board) and discovers a PR for a still-unlinked task with a live worktree (e.g. an agent created the PR mid-session on a renamed branch and no other trigger caught it).

A task is eligible when its PR can still change or be found: a non-terminal linked PR (`pr_number`) or a live worktree (`worktree_path`). Terminal `merged` / `closed` PRs are skipped first, as are tasks in a To Do lane (To Do resets the task, so there is no PR to link there - the same gate `autoLinkPRForTask` applies to every implicit trigger). `head_sha` is deliberately not an anchor here (nearly every historical task has one, which would make the sweep unbounded), and neither is a PR URL in the description (see the ladder above). The sweep is sequential and best-effort: a per-task failure is swallowed, and the backbone's `onLinked` pushes `TASK_UPDATED_BY_AGENT` so cards update live.

### The scheduler

`prRefreshScheduler` keeps a single active timer (Kangentic focuses one project at a time):

- `startForProject(context, project)` tears down any prior timer, defers an immediate sweep off the IPC critical path (`setImmediate`), then arms a periodic `setInterval` from the per-project `git.prRefreshIntervalMinutes` config (null / `<= 0` means on-load sweep only, no timer). It is called on every `PROJECT_OPEN` (cold restart and warm switch-back), after a config change, and on system resume.
- `stop(projectId?)` clears the active timer. With a `projectId` it no-ops unless that project owns the active timer; with no argument it always stops (shutdown / unconditional). Called on project switch/delete and on shutdown.

Timer-leak safety: the interval is created outside `runWithProjectLogContext` (each tick wraps its own work inside it), is `.unref()`'d so it never blocks a clean quit, and is explicitly cleared on switch/delete/shutdown. A stale-switch guard skips a sweep whose project is no longer focused.

## Where PR State Is Persisted

PR state lives on three columns of the per-project `tasks` table (`src/main/db/migrations/project-schema.ts`; `pr_state` was added by a later idempotent migration):

| Column | Type | Purpose |
|--------|------|---------|
| `pr_number` | INTEGER | The PR number, the exact branch-independent anchor. |
| `pr_url` | TEXT | The full PR URL. |
| `pr_state` | TEXT | Normalized `PRState` (`open` / `draft` / `merged` / `closed`), null when no PR is linked or it predates state tracking. |

The companion `head_sha` column stores the last-captured worktree HEAD commit as the immutable Tier-3 anchor.

**The three PR columns always move together.** Every writer leaves all three agreeing: the linker (on link and on the confident-not-found clear) and the task-detail edit form (`buildPrFields` in `useTaskActions.ts`) write all three in one update; MCP `update_task` / `create_task` write `pr_url` + `pr_number` and null `pr_state` (on create it is already null from `TaskRepository.create`). Setting or clearing a URL without its state leaves the inconsistent row the linker forbids, and a stranded terminal `merged` / `closed` short-circuits every non-force resolve, so the task can never recover from a wrong link. A manual write leaves `pr_state` null and lets the next resolve fill it in.

`pr_url` and `pr_number` must name the same PR, because Tier 1 treats `pr_number` as authoritative: a row whose URL was re-pointed while the old number survived resolves the old PR and silently reverts the URL. So every writer that accepts a URL derives the number from it when one is not supplied - `buildPrFields` in the renderer, `prNumberFromUrl` in the MCP handlers.

### IPC channel

`task:resolvePr` (`IPC.TASK_RESOLVE_PR`) is the renderer-facing, on-demand resolver behind the task detail header's "Link / refresh PR" control. Per `.claude/rules/project-scoped-ipc.md` it forwards an explicit interaction-time `projectId`. The handler (in `src/main/ipc/handlers/sessions.ts`) calls `linkPR` with `force: true` and returns a `TaskResolvePrResult`:

| Field | Purpose |
|-------|---------|
| `task` | The task after resolution (latest `pr_url` / `pr_number` / `pr_state`), or null if not found. |
| `linked` | True when the task now has a linked PR (`linked` or `unchanged` status). |
| `reason` | The `PRLinkStatus` outcome, so the UI/MCP can show an accurate message. |
| `message` | Detail for `resolver-unavailable` / `transient-error`. |

`PRLinkStatus` is `'linked' | 'unchanged' | 'not-found' | 'no-anchor' | 'resolver-unavailable' | 'transient-error'`.

## Connector Status

| Provider | Status | CLI dependency | Notes |
|----------|--------|----------------|-------|
| GitHub | stable | `gh` | PRs via `gh pr` / `gh api`, reusing the board importer's `gh` client. The only registered connector. |
| GitLab | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |
| Bitbucket | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |
| Azure DevOps | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |

Only `gitHubPRConnector` is in the `connectors` array today. The planned providers are a source comment, not stub folders: adding one means implementing the `PRConnector` contract under `adapters/<provider>/` and appending it to the array, with no changes to the platform-agnostic registry API or its callers.

## See Also

- [Board Integration](board-integration.md) - the analogous adapter system for importing board issues.
- [Agent Integration](agent-integration.md) - the adapter system for AI coding agents that both patterns mirror.
- [Architecture](architecture.md) - the `task:resolvePr` IPC channel and task schema in the main architecture doc.
