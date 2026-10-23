---
type: Reference
title: PR connector model
description: The PRConnector contract, the DetectedPR and ResolvedPR shapes, PRResolveOptions, the viewer-relative merge readiness values, the two resolver error types, and the registry's remote-ownership dispatch that stops a missing CLI from wiping a PR link.
tags: [pull-requests, connectors, registry, merge-readiness]
sources:
  - resource: src/main/pr/shared/pr-connector.ts
  - resource: src/main/pr/shared/pr-errors.ts
  - resource: src/main/pr/shared/pr-dispatch.ts
  - resource: src/main/pr/pr-registry.ts
  - resource: src/main/git/git-remotes.ts
  - resource: src/shared/types.ts
    title: PRState, PRMergeReadiness, PR_MERGE_READINESS_VALUES
---
# PR connector model

Kangentic links each task to its pull request and keeps that link fresh: it detects a PR from terminal scrollback, authoritatively resolves the PR's state through a hosting-provider CLI, and persists `pr_url` / `pr_number` / `pr_state` on the task so the board can show it, plus `pr_merge_readiness` (would a Merge click succeed right now) where the provider can judge it. GitHub and Azure DevOps are wired today, and every provider is wrapped behind a common `PRConnector` interface so detection and resolution logic stays isolated to a single folder per platform.

Which connector answers is decided by the repository's git remote, not by array order: see [Ownership and dispatch](#ownership-and-dispatch), which is what lets a second provider exist without the first one pre-empting it.

This doc covers the connector system, the confidence ladder that picks the strongest anchor, the background refresh (an on-open sweep, then a per-PR queue), and how to add a new hosting provider.

## Layout

```
src/main/pr/
  shared/                 # PRConnector contract + platform-agnostic errors
    pr-connector.ts
    pr-errors.ts
    pr-dispatch.ts        # ownership gate + degrade deferral (the dispatch rules)
  adapters/
    github/
      github-connector.ts # gitHubPRConnector (gh CLI)
    azure-devops/
      azure-devops-connector.ts # azureDevOpsPRConnector (az CLI)
      azure-remote.ts     # org/project/repo from a git remote; the provider gate
  pr-registry.ts          # connector array + platform-agnostic dispatch API
  pr-linking.ts           # confidence ladder + persist (the backbone)
  pr-link-reset.ts        # a To Do move forgets the task's PR
  pr-identity.ts          # the six PR identity columns and holdsPRIdentity (the To Do reset and the Backlog sweep share it)
  pr-refresh.ts           # on-open sweep, eligibility, and the queue's due-PR picker
  pr-refresh-scheduler.ts # per-project queue: each PR 2 min after its last check

src/main/git/git-remotes.ts  # cached `git remote -v` read (provider-agnostic)
src/shared/pr-url.ts         # PR number from a PR URL, shared with the renderer
```

The pattern intentionally mirrors `src/main/boards/adapters/` and `src/main/agent/adapters/` (one folder per provider, a central registry, no provider-specific branching in shared code). See [Board Integration](../boards.md) for the analogous board-import system.

## PRConnector Interface

`src/main/pr/shared/pr-connector.ts`

Every hosting provider implements this contract. The registry calls it without knowing which providers are registered.

| Member | Required | Purpose |
|--------|----------|---------|
| `name` | yes | Platform name for logging (e.g. `"GitHub"`). |
| `matchesRemote(remoteUrls)` | yes | Whether this connector OWNS the repository behind these git remote fetch URLs (`origin` first). Pure: no subprocess, no network. Required rather than optional because a connector with no gate is eligible on every remote, and an everywhere-eligible connector that cleanly misses produces a clean `not-found` - which is exactly what makes the linker CLEAR a task's PR link. |
| `matchesCommand(commandDetail)` | yes | Whether a Bash command detail looks like a PR command for this platform (drives activity flagging). |
| `extract(scrollback)` | yes | Extract a PR URL + number from raw PTY scrollback text (no network). Returns the most recent match. |
| `resolveForBranch?(repoCwd, branchName, baseBranch?, options?)` | optional | Authoritatively resolve the PR for a branch via the platform API, run inside the repo/worktree at `repoCwd`. Returns null when no PR matches the head ref; throws `PRResolverUnavailableError` when the CLI is unavailable. `options` is the `PRResolveOptions` below. |
| `resolveByNumber?(repoCwd, prNumber, options?)` | optional | Resolve a PR by its number, the most exact anchor and immune to branch renames. Used to refresh an already-linked PR's state. `options` is the `PRResolveOptions` below. |
| `resolveByCommit?(repoCwd, commitSha, branchHint?)` | optional | Resolve the PR associated with a commit SHA, an immutable anchor that survives worktree deletion and branch renames. `branchHint` disambiguates when a commit belongs to several PRs. Takes no `options`, deliberately: the commit tier cannot judge merge readiness on any shipped connector, so there is nothing an option could change there. |
| `verifiesCommitOwnership?: boolean` | required WITH `resolveByCommit` | A property, not a method: the only non-callable row in this table. Declares that a `resolveByCommit` hit proves the commit is that PR's OWN work rather than history it inherited from its base. Optional in TypeScript, but `commitAnchorSelfVerifies` requires `=== true` from every commit-capable owning connector, so omitting it switches the commit tier OFF for that repo rather than defaulting it on. Declare it only if the connector establishes ownership itself (see the commit-ownership section below); `tests/unit/pr-connector-gate.test.ts` fails a commit-capable connector that declares neither way. |

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
| `mergeReadiness` | optional | Normalized `PRMergeReadiness` (`'ready' \| 'blocked' \| 'conflicting' \| 'queued' \| 'running' \| 'unknown'`) when this resolve could judge it. Omitted means the tier or connector cannot determine it and the linker keeps the stored verdict; it never means "not ready". `unknown` is a real answer (the platform has no verdict yet); see "Merge readiness" below for how the linker treats it. |

### `PRResolveOptions`

The per-resolve settings the generic layer forwards from project config, read once per resolve in `linkPR` (`resolveProjectLinkSettings`, off the same effective-config read as the default base branch) and handed unchanged to every readiness-capable tier. The generic layer never inspects them and a connector never reads config itself.

| Field | Purpose |
|-------|---------|
| `bypassCountsAsReady?` | `git.prBypassCountsAsReady`, default on. Count the viewer's own merge bypass as `ready`. GitHub is the connector that pays for it: one `gh api graphql` probe per PR still waiting on a required review, whether GitHub calls that `BLOCKED` or `BEHIND` (every check settled green), never one per open PR per check, and the answer folds that PR to `ready`. The same probe reads the base branch's required checks, so a failed, in-flight, or not-yet-reported one still reads `blocked` whatever the bypass says. Azure DevOps ignores it. |

The key comes out of one mapper, `prResolveOptionsFromGitConfig` in `pr-linking.ts`, which the linker's own sweep and the MCP command context (`mcp-project-context.ts`) share, as an explicit boolean. The mapper is the reason a background sweep and an agent-triggered resolve can never write different verdicts for the same PR. The `{}` fallbacks (no project path, an unreadable config) leave even the default-on `bypassCountsAsReady` off, which is the safe direction: the PR reads `blocked`, GitHub's own answer.

Branch policies are not an option. It was once `git.prEvaluateBranchPolicies`, off by default for its cost, and with it off an Azure PR never read `ready` at all, only `unknown`, so a chip that meant "Merge would succeed" on GitHub meant nothing on Azure. A connector whose verdict needs a call of its own to include policy (Azure DevOps) now always makes it, and the refresh queue's pacing bounds what that costs. The retired key is dropped from saved configs on load (`legacy-git-keys.ts`).

### Merge readiness

**Mergeable is not safe to merge.** GitHub `mergeable: MERGEABLE` and Azure `mergeStatus: succeeded` both mean "no merge conflicts" and nothing else; reviewer minimums and required checks live in a different field on GitHub (`mergeStateStatus`, `reviewDecision`) and a different API on Azure (policy evaluations). The normalized enum is pinned to one user-visible promise: **`ready` means clicking Merge right now would succeed.** It is a separate field from `PRState`, which stays the gate for every terminal-state short-circuit, and it is not a boolean: `unknown` ("we asked, the platform does not know yet") is distinct from a null column ("never checked").

Two values name a merge that would not succeed YET because a blocking check has not finished: `queued` (waiting for a runner, or on GitHub for a required check to report at all) and `running`. They keep the promise (Complete or Merge is disabled right now) while telling the user why in a way `blocked` cannot, and the precedence is the same on both hosts: a failed check or a rejected policy is `blocked`; else a blocking check in flight is `running` (any running) or `queued`, EVEN IF a review is still required, so the chip tracks CI while it runs and flips to `blocked` when only the review remains; else a waiting or required review is `blocked`; else `ready`. Only blocking checks count: Azure filters on `isBlocking`, and GitHub reads its check rollup only where the answer can change the verdict, meaning `mergeStateStatus` is `BLOCKED` or `BEHIND`, or a review is still required on a PR that would otherwise read `ready`. "Waiting for reviewers" reads `blocked` on both hosts (GitHub's `REVIEW_REQUIRED`; Azure's two reviewer policy types, matched by type id).

**The verdict is read for the viewer.** With `git.prBypassCountsAsReady` on (the default), a GitHub PR still waiting on a required review, which GitHub reports as `BLOCKED` or as `BEHIND` once a sibling PR lands and leaves it behind the base, is `ready` when the resolving user's own bypass would merge it (`viewerCanMergeAsAdmin`), because the board's Merge column merges exactly those states with `gh pr merge --admin` once every check is green. The outstanding review is required in both: a `BEHIND` PR that is already approved does not fold, for the same reason an approved `BLOCKED` one does not. Unlike `pr_state`, `pr_merge_readiness` is therefore VIEWER-RELATIVE: two people running Kangentic against the same repository can correctly see different chips on the same PR, and that is not a bug. The fold never reaches past a check: a failed, in-flight, absent, or inconclusive rollup keeps `blocked`, and so does a rollup missing any check the base branch requires, since the bypass is a capability that reads `true` on a red PR too (observed live against a PR with a `FAILURE` check run).

Each connector folds its own platform vocabulary into the enum inside its adapter (`mapMergeReadiness`, beside `mapState`); the raw fields are fetched by the shared board clients (`PR_JSON_FIELDS` and `resolveMergeBypass` in `gh-client.ts`, `AZ_PR_FIELDS` and `resolvePolicyEvaluations` in the Azure client) and carried raw on the item shapes, typed as unions of the values this code knows and never mapped there, so the board importers carry no PR semantics. No platform enum value leaves its adapter folder, which `tests/unit/pr-connector-gate.test.ts` enforces over the real registry; the same suite also fails a connector that cannot reach every enum value from some input, so an unreachable chip word cannot ship silently.

## Error Types

`src/main/pr/shared/pr-errors.ts`

Both errors are platform-agnostic (a leaf module with no connector imports) so `pr-linking.ts` can catch them without importing any provider-specific error type. Connectors translate their own errors (e.g. GitHub's `GhUnavailableError`) into these.

| Error | Meaning | Caller behavior |
|-------|---------|-----------------|
| `PRResolverUnavailableError` | The resolver could not CHECK. Four paths reach it for every provider: the CLI is missing or unauthenticated; no connector matches the remote; the remotes could not be read at all; an owning connector implements no resolver of that kind. The Azure connector adds a fifth (see the asymmetry below). | Degrade to `detectPR` scrollback scraping; preserve any existing link; log a hint (see below). |
| `PRResolverTransientError` | Resolution failed transiently (network / 5xx / rate-limit / timeout) rather than because there is no PR. | Preserve the existing link and report `transient-error` instead of `not-found`. |

**Known asymmetry: an unreadable CLI answer.** `classifyAzError` treats a `SyntaxError` or `TypeError` raised while parsing `az`'s own output as `unavailable`, so a malformed answer degrades instead of reporting a clean miss. That branch is load-bearing rather than defensive: the throw is absorbed inside the connector and never escapes the ladder, so `resolveFailed` cannot see it, and the `not-found` default would clear the task's link.

`classifyGhError` has no equivalent branch, so a malformed `gh` answer still falls through to `not-found`. The exposure is much smaller (`gh` is a Go binary emitting structured `--json`, where `az` is a Python CLI that can interleave warnings into stdout), and the gap predates the ownership gate. It is written down here rather than fixed silently: giving `gh` the same branch is a small, self-contained follow-up.

## Registry

`src/main/pr/pr-registry.ts`

The registry holds a plain `connectors` array populated at module import time, and exposes a platform-agnostic API. There is no provider-name branching here (mirrors `.claude/rules/agent-adapters-boundary.md`).

```ts
const connectors: PRConnector[] = [
  gitHubPRConnector,
  azureDevOpsPRConnector,
  // Future: gitLabMRConnector, bitbucketPRConnector
];
```

| Function | Purpose |
|----------|---------|
| `matchesPRCommand(commandDetail)` | True if any connector recognizes the Bash command as a PR command. |
| `detectPR(scrollback)` | Try every connector's `extract` against scrollback; return the first match. |
| `resolvePRForBranch(repoCwd, branchName, baseBranch?, options?)` | Dispatch to the connectors that own this repo's remote, forwarding `options` (`PRResolveOptions`) untouched. |
| `resolvePRByNumber(repoCwd, prNumber, options?)` | Same, for an explicit PR number, except that it is refused the secondary-remote fallback (see step 2 below). A caller that only needs the PR's state (`local-only-commits.ts`) omits `options`. |
| `resolvePRByCommit(repoCwd, commitSha, branchHint?)` | Same, for a commit SHA. |
| `commitAnchorSelfVerifies(repoCwd)` | True only when every commit-capable connector that owns this repo's remote verifies commit ownership itself. Picks owners the way `resolvePRByCommit` does, answers false on any uncertain path, and never throws. |

The registry also re-exports the contract types and both error classes, so consumers have a single import surface.

### Ownership and dispatch

`shared/pr-dispatch.ts` holds the rules. The invariant it exists to protect:

> A clean `not-found` may only be reported when a connector that actually OWNS this remote ran cleanly. Any path where an unavailable connector is skipped and the surviving connectors all miss must still return a degraded status, never a clean miss.

This matters because a clean miss is destructive: the linker reads `null` with no degrade as "confidently no PR" and clears `pr_url` / `pr_number` / `pr_state` / `pr_merge_readiness`. Catch-and-continue alone would therefore wipe a manually pasted PR link the moment the owning connector's CLI was missing.

Each `resolvePR*` call reads the repo's remotes once (`src/main/git/git-remotes.ts`, cached, and it never rejects), then:

1. Remotes unreadable, or no connector claims them, and the call **throws** `PRResolverUnavailableError`. Degraded, never a clean miss.
2. Ownership is narrowed to the **primary** remote (`origin` first), falling back to the full list when nothing claims the primary. With an Azure `origin` and a GitHub `upstream` both connectors would otherwise claim, array order would decide, and `resolvePRByNumber(42)` could return upstream's PR 42 - a mislink, which is worse than a miss.

   That fallback is itself a guess, so `resolveByNumber` is refused it entirely: if the primary remote belongs to an unregistered host, a claimed `upstream` is not evidence that THIS repo's PRs live there. The inferred tiers can take the guess because `disambiguate` guards them (branch hint, fork drop, base match); the number tier bypasses every guard by design, because an explicit number is unambiguous WITHIN one repo. So a repo whose primary remote no connector claims resolves by branch and commit, but never by number.
3. An owner that implements no resolver of that kind **throws**: nothing ran, so "there is no PR" was never established.
4. Owning connectors run in order. A degrade error is remembered and the next owner still gets its turn; any other exception propagates unchanged, since an unknown error is not the registry's to classify or swallow.
5. All owners ran cleanly and matched nothing, and only then is `null` returned.
6. Otherwise the remembered error is rethrown **unchanged**. Rethrowing the original instance is load-bearing: `pr-linking.ts` recognizes a degrade by `instanceof`, and a wrapped copy would fall into the generic error branch, leave `degradeStatus` unset, and arm the very link wipe this machinery prevents. The first *transient* outranks the first *unavailable*, because a transient proves a real owning connector reached the network.

`matchesPRCommand` and `detectPR` are deliberately NOT gated: they take no cwd, `detectPR` is the degradation fallback used precisely when the remotes may be unreadable, and it only ever ADDS a link. Connectors' URL patterns are host-specific and disjoint, so first-match is unambiguous.

Being required is not the same as being safe: a connector can still write `matchesRemote: () => true` and type-check. What holds the invariant is the throw in step 1 and the tier deferral in the ladder (`tests/unit/pr-dispatch.test.ts`, `tests/unit/pr-remote-gate-no-wipe.test.ts`), plus `tests/unit/pr-connector-gate.test.ts`, which asserts over the REAL `connectors` array that no connector claims another provider's remote or a foreign one. That last test is the CI backstop for exactly the `() => true` hazard: appending a third connector with a lazy gate fails there rather than in production.

## Connector Status

| Provider | Status | CLI dependency | Notes |
|----------|--------|----------------|-------|
| GitHub | stable | `gh` | PRs via `gh pr` / `gh api` (the commit tier's REST commit-pulls, and the merge-bypass GraphQL probe behind `git.prBypassCountsAsReady`), reusing the board importer's `gh` client. |
| Azure DevOps | stable | `az` + the `azure-devops` extension | PRs via `az repos pr` plus two `az rest` calls (the commit tier's `pullrequestquery`, and the branch-policy evaluations for a PR whose preview merge succeeded), reusing the board importer's `az` client. The commit tier sees completed PRs only (see above). |
| GitLab | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |
| Bitbucket | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |

The planned providers are a source comment, not stub folders. Adding one means implementing the `PRConnector` contract under `adapters/<provider>/` and appending it to the array.

That used to come with "no changes to the platform-agnostic registry API or its callers", which the Azure DevOps connector disproved: the dispatch loops had no `try`/`catch`, so the first connector whose CLI was missing threw and aborted before any later connector ran, and registering a second adapter changed nothing until the dispatch layer grew the ownership gate. A third provider does now drop in cleanly - but implement `matchesRemote` honestly, and make the connector's own resolvers return `null` rather than throw on a remote it does not own.

## See Also

- [Board Integration](../boards.md) - the analogous adapter system for importing board issues.
- [Agent Integration](../agents/index.md) - the adapter system for AI coding agents that both patterns mirror.
- [Architecture](../../architecture.md) - the `task:resolvePr` IPC channel and task schema in the main architecture doc.
