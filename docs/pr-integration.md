# PR Integration

Kangentic links each task to its pull request and keeps that link fresh: it detects a PR from terminal scrollback, authoritatively resolves the PR's state through a hosting-provider CLI, and persists `pr_url` / `pr_number` / `pr_state` on the task so the board can show it, plus `pr_merge_readiness` (would a Merge click succeed right now) where the provider can judge it. GitHub and Azure DevOps are wired today, and every provider is wrapped behind a common `PRConnector` interface so detection and resolution logic stays isolated to a single folder per platform.

Which connector answers is decided by the repository's git remote, not by array order: see [Ownership and dispatch](#ownership-and-dispatch), which is what lets a second provider exist without the first one pre-empting it.

This doc covers the connector system, the confidence ladder that picks the strongest anchor, the background refresh sweep, and how to add a new hosting provider.

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
  pr-refresh.ts           # background refresh-and-discover sweep
  pr-refresh-scheduler.ts # per-project timer that arms the sweep

src/main/git/git-remotes.ts  # cached `git remote -v` read (provider-agnostic)
src/shared/pr-url.ts         # PR number from a PR URL, shared with the renderer
```

The pattern intentionally mirrors `src/main/boards/adapters/` and `src/main/agent/adapters/` (one folder per provider, a central registry, no provider-specific branching in shared code). See [Board Integration](board-integration.md) for the analogous board-import system.

## PRConnector Interface

`src/main/pr/shared/pr-connector.ts`

Every hosting provider implements this contract. The registry calls it without knowing which providers are registered.

| Member | Required | Purpose |
|--------|----------|---------|
| `name` | yes | Platform name for logging (e.g. `"GitHub"`). |
| `matchesRemote(remoteUrls)` | yes | Whether this connector OWNS the repository behind these git remote fetch URLs (`origin` first). Pure: no subprocess, no network. Required rather than optional because a connector with no gate is eligible on every remote, and an everywhere-eligible connector that cleanly misses produces a clean `not-found` - which is exactly what makes the linker CLEAR a task's PR link. |
| `matchesCommand(commandDetail)` | yes | Whether a Bash command detail looks like a PR command for this platform (drives activity flagging). |
| `extract(scrollback)` | yes | Extract a PR URL + number from raw PTY scrollback text (no network). Returns the most recent match. |
| `resolveForBranch?(repoCwd, branchName, baseBranch?)` | optional | Authoritatively resolve the PR for a branch via the platform API, run inside the repo/worktree at `repoCwd`. Returns null when no PR matches the head ref; throws `PRResolverUnavailableError` when the CLI is unavailable. |
| `resolveByNumber?(repoCwd, prNumber)` | optional | Resolve a PR by its number, the most exact anchor and immune to branch renames. Used to refresh an already-linked PR's state. |
| `resolveByCommit?(repoCwd, commitSha, branchHint?)` | optional | Resolve the PR associated with a commit SHA, an immutable anchor that survives worktree deletion and branch renames. `branchHint` disambiguates when a commit belongs to several PRs. |
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
| `mergeReadiness` | optional | Normalized `PRMergeReadiness` (`'ready' \| 'blocked' \| 'conflicting' \| 'unknown'`) when this resolve could judge it. Omitted means the tier or connector cannot determine it and the linker keeps the stored verdict; it never means "not ready". `unknown` is a real answer (the platform has no verdict yet); see "Merge readiness" below for how the linker treats it. |

### Merge readiness

**Mergeable is not safe to merge.** GitHub `mergeable: MERGEABLE` and Azure `mergeStatus: succeeded` both mean "no merge conflicts" and nothing else; reviewer minimums and required checks live in a different field on GitHub (`mergeStateStatus`, `reviewDecision`) and a different API on Azure (policy evaluations). The normalized enum is pinned to one user-visible promise: **`ready` means clicking Merge right now would succeed.** It is a separate field from `PRState`, which stays the gate for every terminal-state short-circuit, and it is not a boolean: `unknown` ("we asked, the platform does not know yet") is distinct from a null column ("never checked").

Each connector folds its own platform vocabulary into the enum inside its adapter (`mapMergeReadiness`, beside `mapState`); the raw fields are fetched by the shared board clients (`PR_JSON_FIELDS` in `gh-client.ts`, `AZ_PR_FIELDS` in the Azure client) and carried raw on the item shapes, never mapped there, so the board importers carry no PR semantics. No platform enum value leaves its adapter folder, which `tests/unit/pr-connector-gate.test.ts` enforces over the real registry.

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
| `resolvePRForBranch(repoCwd, branchName, baseBranch?)` | Dispatch to the connectors that own this repo's remote. |
| `resolvePRByNumber(repoCwd, prNumber)` | Same, for an explicit PR number, except that it is refused the secondary-remote fallback (see step 2 below). |
| `resolvePRByCommit(repoCwd, commitSha, branchHint?)` | Same, for a commit SHA. |

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

## GitHub Connector

`src/main/pr/adapters/github/github-connector.ts`

`gitHubPRConnector` resolves PRs through the `gh` CLI and detects PR URLs from terminal output. It reuses the board importer's `gh` client (`GitHubImporter` from `boards/adapters/github-common/gh-client.ts`) so binary detection and auth plumbing are shared; a module-level singleton avoids re-probing `gh` per call.

**Detection.** `extract` strips ANSI escape sequences from the tail of scrollback (a 4096-byte scan window) and matches `https://github.com/<owner>/<repo>/pull/<number>`, returning the last (most recent) match. It handles `gh pr create` stdout, `gh pr view` TTY and non-TTY output, and `gh pr view --json`. It deliberately does not match `git push`'s `/pull/new/<branch>` output (no numeric id) or `gh pr merge`'s `owner/repo#123` short form (no full URL). Detection runs against terminal scrollback only: there is deliberately no scraper for authored text such as a task description (see "The confidence ladder" below).

**Resolution.** The three resolve methods call the shared `gh` client (`resolvePRByBranch`, `resolvePRByNumber`, `resolvePRByCommit`) and normalize the result. `resolveByCommit` additionally reads local git (see its two filters below); the other two are pure `gh`.

- `mapState` maps GitHub's `OPEN` / `CLOSED` / `MERGED` plus `isDraft` to the normalized `PRState`.
- `mapMergeReadiness` folds `mergeStateStatus` (falling back to `mergeable` when it is absent or unrecognized) and `reviewDecision` into `PRMergeReadiness`: `CLEAN` / `HAS_HOOKS` / `UNSTABLE` are `ready` (the Merge button works with failing non-required checks; required ones report `BLOCKED`), `BLOCKED` / `BEHIND` / `DRAFT` are `blocked`, `DIRTY` is `conflicting`, `UNKNOWN` is `unknown`, and a `ready` verdict downgrades to `blocked` only when `reviewDecision` is `REVIEW_REQUIRED` (compared against that one value, since `gh` renders a null decision as an empty string). `CHANGES_REQUESTED` is deliberately not a downgrade: where reviews are required GitHub already reports `BLOCKED`, and where they are not the Merge button works, so the literal promise says `ready`. The three fields ride the same `gh pr list` / `gh pr view` call, so they cost nothing on the branch and number tiers; `statusCheckRollup` is deliberately not requested (a per-check-run array on every PR). The commit tier's REST payload (`repos/{owner}/{repo}/commits/{sha}/pulls`) carries none of the three, so those items omit the verdict and the linker preserves the stored one.
- `disambiguate` picks the best candidate for inferred (branch / commit) matches: it drops fork (cross-repository) PRs, restricts to PRs whose head ref matches `branchHint` (returning null rather than guessing when SEVERAL non-matching candidates remain, but keeping a LONE one), then prefers open/draft, then a matching base branch, then the most recently updated. `resolveByNumber` bypasses this guard because an explicit number is unambiguous.

  Keeping the lone non-matching candidate is deliberate, not an oversight in the hint rule. It is the anchor for a Done task whose branch was renamed and pushed under a different head ref, which is the case the commit tier exists for; the two filters below are what reject a wrong candidate.
- `resolveByCommit` filters the candidate pool twice before disambiguating, because `gh api commits/<sha>/pulls` returns every PR whose head branch contains the commit - including one that merely branched off the same base tip and therefore inherited it:
  - drop any PR whose merge commit IS the resolved commit, so a fresh worktree sitting on the base branch's tip is never magneted onto the last-merged sibling PR;
  - drop any remaining PR whose OWN base branch already contains the commit (`isShaContainedInRef` in `src/main/git/worktree-head.ts`, run against `origin/<baseRefName>` and falling back to the local ref). `baseRefName` already rides along on the REST response, so this costs a local `rev-list`, not an API call.

  The second filter exempts `MERGED` candidates: a merged PR's own commits ARE in its base afterwards, so containment cannot separate "this task's work, now merged" from "inherited base history" - the merge-commit filter covers that shape instead. When the base ref is not fetched locally the probe is undetermined and the candidate is kept, so on its own an unfetched ref costs a mislink guard rather than an existing badge.

  One caveat, currently unresolved. Because the filter runs BEFORE `disambiguate`, dropping a proven-contained sibling can leave a kept-undetermined candidate as the LONE survivor. It then slips past the hint rule's ambiguity guard, which only returns null when MORE than one non-matching candidate remains, so a candidate never verified as its own work can win a comparison that previously returned null. Whether an undetermined survivor should still count toward that ambiguity threshold is an open question, not a settled trade-off.

**Concurrency + error translation.** All resolves run through a global `p-queue` capped at `GH_CONCURRENCY = 3`, so a multi-card drag or board-load burst cannot fan out into dozens of concurrent `gh` processes. The `viaGh` wrapper translates `GhUnavailableError` into `PRResolverUnavailableError` and `GhTransientError` into `PRResolverTransientError`, keeping the generic layer free of provider-specific error types.

**Ownership.** `matchesRemote` claims any host label containing `github`, so `github.mycorp.com` (GitHub Enterprise) keeps resolving. KNOWN GAP: GHE hosted on a name with no `github` in it (`ghe.corp.example`) no longer resolves PRs. Before the ownership gate this connector ran on every remote and would at least have tried; the failure is now diagnosable, because the thrown message names the unmatched remote URL. A per-project list of extra hosts is the follow-up.

**Repo mismatch is not an auth failure.** In a non-GitHub repo `gh` exits 1 with "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`". That message ends with `gh auth login`, so `classifyGhError`'s auth pattern used to match it and the UI told the user to re-login while `gh` was working perfectly. `ghErrorToThrow` now tests for the mismatch FIRST (ordering is load-bearing) and reports the real reason. It stays classified `unavailable`, not `not-found`: with the ownership gate this is only reachable when our own remote read says GitHub owns the repo and `gh` disagrees (a submodule cwd, an `insteadOf` rewrite, a host alias), and `gh` did not run cleanly there, so a clean `not-found` would let the linker clear the link.

## Azure DevOps Connector

`src/main/pr/adapters/azure-devops/azure-devops-connector.ts`

`azureDevOpsPRConnector` resolves PRs through the `az` CLI (the `azure-devops` extension, plus one `az rest` call) and reuses the board importer's `az` client (`AzureDevOpsImporter` from `boards/adapters/azure-devops/client.ts`), exactly as the GitHub connector reuses `GitHubImporter`.

**Ownership and the self-gate.** `azure-remote.ts` parses an Azure git remote into `{ org, project, repo }`, covering the SSH `v3/{org}/{project}/{repo}` form (with `%20` in the project name), `ssh://...:22/v3/...`, `https://dev.azure.com/{org}/{project}/_git/{repo}`, the `{user}@dev.azure.com` variant (the org comes from the PATH, never the userinfo), and legacy `{org}.visualstudio.com` including `DefaultCollection`. A `null` parse is the connector's own provider gate: every resolver returns `null` rather than throwing on a non-Azure remote. That is independent of the registry gate and load-bearing on its own - a throw here would set `degradeStatus` for every GitHub task on any machine without `az`, permanently disabling the confident-not-found clear and reporting a resolver failure for tasks that simply have no PR.

**Detection.** `extract` matches `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}` and the legacy `visualstudio.com` spelling, over a 4096-byte tail window. `_git` is required, so a board or `_workitems` URL never matches, and the `/pullrequestcreate` compose page does not either. It uses the shared `stripAnsiControlCodes` (`src/shared/ansi-strip.ts`), deliberately NOT `stripAnsiEscapes`, whose whitespace normalization can join two lines and fuse a URL to its neighbour.

**Resolution.** All three tiers pass an explicit organization / project / repository plus `--detect false` rather than letting `az` sniff the cwd, so they work from any working directory - including after a task's worktree has been reclaimed.

- `resolveForBranch` and `resolveByNumber` use `az repos pr list --source-branch` and `az repos pr show --id`.
- `resolveByCommit` posts to `_apis/git/repositories/{repo}/pullrequestquery` via `az rest`, because no `az repos pr` verb answers "which PR contains this commit". The repository resolves by NAME; no GUID lookup is needed.
- The browser URL is CONSTRUCTED, not read: Azure returns null for `_links.web.href`, `remoteUrl`, AND `repository.webUrl` on every tier.
- `updatedAt` is `closedDate ?? creationDate`, because Azure exposes no `updatedAt` anywhere. This only breaks ties WITHIN a state bucket, since `disambiguate` scores state first.
- `disambiguate` is ported from the GitHub connector unchanged, INCLUDING the rule that keeps a LONE candidate whose head ref does not match `branchHint` (see the GitHub section above). That half is what links a task whose stored branch is a worktree slug rather than the PR's real source branch, which is the common shape once a worktree has been reclaimed. A port that required a hint match would leave such a task blank forever. The only change is the score gate: Azure's `active` covers open and draft, where GitHub's `OPEN` does.
- State maps `completed` to `merged`, `abandoned` to `closed`, and otherwise `isDraft` to `draft` or `open`.
- Merge readiness maps `mergeStatus` (Azure's `PullRequestAsyncStatus`, projected as `merge:mergeStatus` on the branch and number tiers) only: `conflicts` to `conflicting`, `rejectedByPolicy` / `failure` to `blocked`, and `succeeded` / `queued` / `notSet` / null / anything unrecognized to `unknown`. `succeeded` cannot honestly claim `ready`: it says the preview merge applied cleanly, and branch policies (reviewer minimums, required builds) are not evaluated this pass. Evaluating them needs a second call per PR to `_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}`, which rejects `api-version=7.0` (`VssInvalidPreviewVersionException`; `7.0-preview.1` works), needs the project GUID (`repository.project.id`, available on the `az repos pr show` response), and costs roughly 1 to 1.8 s of `az` cold start per PR through `AZ_CONCURRENCY`, so it is a deliberate follow-up gated behind a setting rather than part of every sweep. The commit tier's projection (`AZ_PR_FIELDS_NO_FORK`) omits `mergeStatus`, since `pullrequestquery` matches completed PRs only, so those items omit the verdict.
- Concurrency is capped at `AZ_CONCURRENCY = 2`, lower than GitHub's 3: `az` is a Python CLI with a roughly one-second cold start where `gh` is a Go binary that starts in milliseconds.
- Two argument guards mirror `isShaContainedInRef`'s option-shaped-ref rejection: an empty or `-`-leading branch name and a non-hex SHA are both refused without running `az`. The SHA guard is also the injection guard for the JSON request body.

**LIMITATION - the commit tier sees completed PRs only.** Azure records a PR's commit associations at completion, so `pullrequestquery` returns nothing for an active or abandoned PR (verified against eight real PRs). Consequences:

- A task with an ACTIVE Azure PR whose stored branch is not the PR's source branch gets nothing from the commit tier. Tier 2 needs the live worktree branch to BE the PR's source branch, Tier 4 needs the stored branch to match, and Tier 3 cannot see the PR at all. This is a property of the Azure API rather than of this code. An earlier version of this note called the gap narrow "because active PRs normally still have a live worktree", which was wrong twice: a live worktree only rescues Tier 2 when the live branch is the PR's source branch, and a task reaches Done with an open PR routinely, since `deleteTaskWorktree` nulls `worktree_path` on that move while `isEligibleForRefresh` keeps sweeping it. Tiers 5 and 6 now cover most of the gap, because they resolve BY BRANCH, which Azure supports.
- It is also why the GitHub connector's two commit-tier filters have no Azure counterpart. `gh api commits/<sha>/pulls` returns every PR whose head branch CONTAINS the commit, including a sibling that merely branched off the same base tip; Azure's query matches only a PR's own source commits. Probed against a merge product and against a base tip it returns nothing, and an open sibling can never appear at all. Both filters would be dead weight, so neither is ported.

**Fork guard, wired but unverified in the positive direction.** `isCrossRepository` is derived from `forkSource`, which is present on the branch and number tiers only; the commit-tier payload has no such field, so those candidates stay `undefined` and pass the falsy filter exactly as GitHub's optional field does. `forkSource: null` on non-fork PRs is confirmed; that a real fork PR populates it is not (no fork PR was available to test). If it does not, the failure mode is "no filtering", identical to having no guard, never a wrong rejection.

## PR Linking

`src/main/pr/pr-linking.ts`

`linkPRForTask` is the single backbone every trigger funnels through. It resolves a task's PR via a confidence ladder, short-circuiting on the first hit, and writes only on change. It is wrapped in `withTaskLock` because it crosses an await boundary and mutates per-task state (see `.claude/rules/task-lifecycle-lock.md`).

### The confidence ladder

`resolvePRViaLadder` tries the strongest available anchor first:

| Tier | Anchor | Why |
|------|--------|-----|
| 1 | `pr_number` | Exact and branch-independent, best for refreshing an existing link's state. Also how a review task names the PR it is about. |
| 2 | Worktree HEAD branch | The real branch while the task is actively worked. |
| 3 | Commit SHA | Immutable, survives Done / worktree deletion and branch renames. Guarded three ways: a cheap commits-ahead-of-base check here skips the tier outright for a fresh worktree on base's tip, the owning connector must declare `verifiesCommitOwnership` or the tier does not run at all, and the connector then rejects any individual candidate whose own base already contains the commit. After all three, the answer is refused when another task on this board already holds that PR (see "Inferred tiers never take a PR or branch another task holds" below). |
| 4 | Stored `branch_name` with no worktree | A reclaimed worktree whose live branch `deleteTaskWorktree` captured on the Done move, or a no-worktree task created with a `customBranchName`. |
| 5 | Stored `pushed_branch` | The branch the work was actually pushed to: recorded from the agent's own `git push` the moment that call ends (see "Recording `pushed_branch` from the agent's own push" below), handed in through `kangentic_link_pr`'s `branch`, or inferred by Tier 6 on an earlier pass. Free (no git read), needs no worktree, and unlike Tier 6 it keeps working after the task commits past what it pushed and after the remote branch is deleted, because a PR keeps its source branch name. For a task created with `useWorktree: false` this is the only anchor the app can record. |
| 6 | Remote branch at the HEAD tip | Infers that name when nothing recorded it. One local `for-each-ref --points-at` names every remote branch whose TIP is exactly the task's HEAD commit; each survivor is resolved with the ordinary branch resolver. A hit is refused when another task on this board already holds the PR, or holds the candidate branch as its `branch_name` or `pushed_branch`, and a refused hit records no `pushed_branch`. |

Tiers 5 and 6 exist for one shape that every tier above misses: the task's local branch is the Kangentic slug, but the branch PUSHED as the PR source has a different name and nothing reconciled the two. Tiers 2 and 4 query the slug and miss; Tier 3 is gated off once the PR merges into base, because `rev-list --count <base>..<sha>` is 0 by then. It is platform-agnostic (GitHub fails at 2 and 4 identically), and Tier 6 is the only tier that can DISCOVER an ACTIVE Azure PR in this shape, since it resolves by branch rather than by commit. Tier 5 resolves by branch too and rescues the same PR on every later pass, but only once Tier 6 has recorded the name for it.

Tier 6 is LAST on purpose, and not because a tip match is weak. It is strictly more selective than Tier 3's containment match, but it is far less DEFENDED: `resolvePRForBranch` hands `disambiguate` a `branchHint` that every returned item already matches by construction, so its ambiguity escape hatch can never fire, and there is no per-candidate base-history filter like the commit tier's. A hit at any tier suppresses the confident-not-found clear permanently, so the least-guarded tier is the one that must only ever turn a not-found into a link, never displace a stronger tier's answer.

**Tier 6's guards, and the one shape they do not cover.** It bails outright when the base branch is among the refs pointing at that sha, checking `refs/heads/<base>`, `refs/remotes/*/<base>`, and any remote's `HEAD` symref: a fresh worktree sits on the base tip, and every branch there belongs to whatever last landed on base. Unlike the commits-ahead-of-base guard this keeps working after the PR merges, because it asks "is my sha base's TIP" rather than "is my sha contained in base". Local refs are read for that signal but are never candidates, since linked worktrees share the ref store and several sibling task slugs routinely sit on the same tip. It also requires a known base, excludes the branch tiers 2/4/5 already tried, drops option-shaped names, dedupes across remotes, caps survivors at two, returns null rather than guessing when survivors resolve to different PRs, and refuses a survivor whose PR or whose branch another task on this board already holds (the two holder refusals below).

The bail measures against `task.base_branch ?? task.resolved_base_branch ?? git.defaultBaseBranch ?? 'main'`. `resolved_base_branch` is what makes that sound: `base_branch` holds only a base the user named explicitly, which is NULL for most tasks, so before it was recorded every base-relative guard fell back to the project default and a worktree cut from a long-lived integration branch was compared against the wrong branch. `WorktreeManager.createWorktree` already resolves the real base against the repo's refs, and `recordWorktree` persists it whenever the worktree was actually CUT from that base. Two creations do not qualify, and both are covered below: `ensureWorktree` returns `reused` and records nothing when the directory is already on disk, and `createWorktree` reports no base at all when it attached to a branch that already existed.

Two residuals remain. A task whose worktree was created before that column existed still has neither base recorded, and so does one whose worktree attached to a pre-existing branch: `createWorktree`'s `branchExists` path passes no start point to `git worktree add`, so it reports `baseBranch: null` rather than the base it resolved, and nothing is persisted. Withholding it there is deliberate. The resolved value would describe a cut that never happened, and recording a guess is worse than recording nothing, because `resolved_base_branch` is exactly what promotes a base from a guess to a KNOWN one: a task attached to a long-lived `feature/x` and stamped with `main` sits on `feature/x`'s tip, fails the base-tip bail against the wrong branch, and magnets onto `feature/x`'s own PR. For both residuals, a zero-commit task cut from a long-lived branch has that branch's tip as its HEAD, and there is no purely local git predicate that separates it from the legitimate case, because both are the identical git state. `git config kangentic.baseBranch` is NOT a way out: `WorktreeManager` writes it to the SHARED `.git/config`, not a per-worktree config, so it is last-writer-wins across every worktree in the project. What separates the two is the board, not git: when that branch's PR, or the branch itself, is already linked to another task here, the holder refusals below decline it. The tier stays last and narrow all the same, because the refusals only see what the board recorded. What remains is a sibling whose push was never captured (a bare `git push`, or an adapter that forwards the tool name rather than the command) and whose PR does not exist yet: nothing on the board names that branch, so a follower on its tip can still have it recorded as `pushed_branch`, and Tier 5 links the PR to the follower once it appears.

**Inferred tiers never take a PR or branch another task holds.** On 2026-09-11 a task fast-forwarded its worktree onto a sibling's PR branch (`git merge --ff-only origin/<sibling branch>`) to build on that work, with no commits of its own, and the linker stamped the sibling's PR onto it. Tier 2 missed (the follower's slug has no PR), the commits-ahead-of-base guard counted the sibling's two unmerged commits as the follower's own, `gh api commits/<sha>/pulls` answered the sibling's PR, and `disambiguate` kept that lone candidate, which it does on purpose for a Done task whose branch was pushed under another name. The two shapes are byte-identical in git. The board tells them apart: the sibling links first in the normal flow (`/pull-request` writes its number explicitly before anyone can merge its branch), and its push was captured as `pushed_branch` before its PR even existed. So the two INFERRED tiers, 3 and 6, check two board facts before they answer, through `TaskRepository.listByPRNumber` and `listByBranchOrPushedBranch` (archived rows included, since a Done task keeps its link). Tier 3 refuses a PR another task holds by number. Tier 6 refuses a hit whose PR another task holds or whose candidate branch another task holds as its `branch_name` or `pushed_branch`, on its link path and on its record-only path alike, so a refused candidate is never written to `pushed_branch`. The refusal lives in `pr-linking.ts` rather than a connector because it is a board fact, not a provider fact; Azure gets it identically. A refusal is a plain miss: the ladder keeps descending (a refused commit hit still lets Tier 5 link the task's own PR from its own `pushed_branch`), the confident-not-found clear applies as it would to any miss, and `preserveLinkOnNotFound` keeps its meaning. Tiers 1, 2, 4 and 5 are per-task anchors and are never refused, so two tasks that legitimately share a PR (a review task and its author) both link through Tier 1. Each refusal logs one line naming both tasks. The row already stamped before this guard existed is not repaired by it: Tier 1 re-confirms an explicit number forever, so such a link is cleared by hand (the task-detail edit form or `kangentic_update_task`), after which the next resolve refuses the inference and writes nothing.

`resolved_base_branch` is deliberately a separate column rather than a backfill of `base_branch`. `ensureTaskBranchCheckout` (`ipc/helpers/task-git.ts`) treats a NULL `base_branch` as "nothing to check out" and returns early, so populating that column would push non-worktree spawns into a fetch-and-checkout path they skip today, and into `assertNoOtherAgentInDirectory`, which throws `BranchCheckoutBlockedError`. The two columns answer different questions: the user's choice, and the observed resolution.

Tier 6 also stops firing once a task commits past what it pushed, since `head_sha` is then a tip no remote ref matches. That is what Tier 5 exists for, and it is the main reason Tier 6's provider cost stays near zero on a sweep: a fresh worktree bails, an unpushed worktree finds nothing, and a branch pushed under its own name was already resolved by Tier 2.

**The anchor gate.** Before any tier runs, `linkPRForTask` returns `no-anchor` when the task has no `pr_number`, no branch (live worktree HEAD or stored `branch_name`), no sha (live or stored `head_sha`), and no `pushed_branch`. `autoLinkPRForTask` applies the same gate to every implicit trigger. `no-anchor` means nothing was searched, and both reporting paths say so: the task-detail toast reads "Nothing to search by" rather than "No PR found", and `kangentic_link_pr` returns it as a refusal (`isError: true`) naming the remedies, so an agent can self-correct instead of reading `linked: false` as "no PR exists".

**Recording `pushed_branch` from the agent's own push.** A task created with `useWorktree: false` runs in the shared checkout, and every other anchor is written from a worktree read: `branch_name` by worktree creation, `head_sha` by a worktree HEAD read, the Tier 6 inference from a sha. So the shape could never link, however plainly the agent printed its PR number. Reading the shared checkout's live HEAD at resolve time is not the fix: every concurrent no-worktree task shares that HEAD, and three tasks that happened to sit on one branch would all resolve to its PR. The anchor has to be captured per task, at a moment that belongs to that task, and the agent's own `git push` is that moment. The hook pipeline already forwards each Bash command as the `detail` of a `tool_start` event (capped at 2000 characters by the bridge's `FIELD_CAP`, raised from 200 for exactly this reader: a chained `git commit -m "..." && git push -u origin <branch>` lost its push at the old cap, and `tests/unit/hook-detail-cap-parity.test.ts` keeps the parser's copy of the value equal); `PushCommandDetector` (`src/main/activity-engine/push-command-detector.ts`) parses it with `parsePushedBranch` (`src/main/git/push-command.ts`), remembers the destination, and reports it when that call's `tool_end` arrives (paired by `toolId` when both events carry one, so a parallel or subagent Bash call ending first does not report the push early; cleared without reporting on an interrupt). `SessionTelemetry` raises it as `onBranchPushed`, `SessionManager` emits `branch-pushed`, and the listener in `src/main/ipc/handlers/sessions.ts` calls `recordPushedBranchForSession`, which patches only `{ id, pushed_branch }` on the row re-read under the task lock. Only an explicit destination counts: `git push -u origin <branch>`, `git push origin HEAD:<branch>` (the project's own `/pull-request` form), `+<branch>`, `refs/heads/<branch>`. A bare `git push` or `git push -u origin HEAD` pushes whatever is checked out, which is the shared state the anchor exists to avoid, so both parse as unknown. A refspec that runs to the very end of an input at the bridge's cap is refused too, because it may be a prefix of the real name (a heredoc commit message can still push a chained command past 2000 characters). Three names are never recorded: the task's own `branch_name`, the value already stored, and the task's effective base (`base_branch || resolved_base_branch || default`), since a merge-back's `git push origin HEAD:develop` would otherwise let Tier 5 answer with the base branch's own PR. Nothing resolves from the push itself: the PR does not exist yet, and a non-force resolve would stamp the 60s per-task throttle that the `pr-candidate` resolve seconds later would then be coalesced by. The same write is available on demand as `kangentic_link_pr`'s `branch` argument, for an agent whose push the capture did not see. Two shapes still leave a no-worktree task with nothing to search by: a push with no explicit destination, and an agent whose adapter forwards the tool name rather than the command (only the Claude hook bridge forwards the command today).

**Recording `pushed_branch` from Tier 6.** Tier 6 writes the branch it established into `tasks.pushed_branch`, alongside the `head_sha` backfill. It records even when no PR resolved from that branch, because an agent pushes the branch BEFORE opening the PR, and waiting for a PR to appear loses the identity once the task commits past the pushed tip. Recording unconditionally would be wrong in the follow-on shape (a task cut from another task's branch with zero commits sits on that branch's tip), so the no-PR case also requires the task to have commits of its own beyond base. That check is base-relative, so it only covers a neighbour that has MERGED: a follower fast-forwarded onto a sibling's unmerged branch counts the sibling's commits as its own, which is why the branch refusal above gates this path too and declines a candidate another task already holds as its `branch_name` or `pushed_branch`. It is deliberately NOT written to `branch_name`: that column names the LOCAL branch a restore re-attaches to, and `WorktreeManager.createWorktree` verifies it with `rev-parse --verify`, which does not resolve a remote-only branch, so a pushed-only name there would fork a fresh branch off base and orphan the work.

**`pushed_branch` outlives the checkout.** It is a remote fact and a PR anchor, like `pr_number`, which already survives every reset. So no cleanup path nulls it: a To Do reset, a delete, the `cleanup_worktree` action, the Backlog sweep, and the two startup fallbacks for a missing worktree directory all drop `branch_name` and `resolved_base_branch` (checkout facts) and keep `pushed_branch`. The same paths capture `head_sha` before discarding the checkout wherever it can still be read: from the worktree HEAD while the directory exists (`cleanupTaskResources`, `executeCleanupWorktree`, as `deleteTaskWorktree` always did), or from the surviving local branch ref through `readLocalBranchSha` when only the directory is gone (`demoteMissingWorktree` in `session-startup/missing-worktree.ts`, the Backlog sweep). This used to be the opposite invariant, nulling `pushed_branch` wherever `branch_name` was nulled on the theory that a reset task "no longer has any work"; since `pr_number` survived those paths the reset never actually forgot the PR, and the nulling only stranded a task whose PR had not linked yet when the reset ran. `tests/unit/pushed-branch-cleanup-parity.test.ts` enforces both halves: every `branch_name: null` write also nulls `resolved_base_branch`, and `pushed_branch: null` appears nowhere under `src/main` but the row insert.

"Even when no PR resolved" includes the case where the resolver could not CHECK. The ladder rethrows a deferred degrade when no tier resolved, and a throw carries no return value, so the branch is reported through a `recordPushedBranch` callback at the moment Tier 6 establishes it rather than on the way out. Nothing about that identity depends on the provider: a remote tip equal to HEAD, that tip not being base's, and commits of the task's own are all local git state. Dropping it on a degrade would lose it in the exact window the capture rule exists for, since `gh` typically comes back after the task has committed past the pushed tip, and by then no remote ref matches `head_sha` any more.

A recorded name is corrected only when Tier 6 actually runs. If the work is re-pushed under a NEW name while the OLD branch still carries a resolvable PR, Tier 5 answers from the stale name and returns before Tier 6 ever reads the refs, so the row keeps pointing at the old PR. That is the same staleness `pr_number` has at Tier 1 and is cleared the same way, by an explicit refresh once the old PR stops resolving. Tier 5 is not self-correcting on its own.

A tier that could not CHECK (a `PRResolverUnavailableError` / `PRResolverTransientError`) does NOT abort the ladder: the error is remembered and the remaining tiers still run, and it is rethrown unchanged only if no tier resolved anything. That deferral is a consequence of the ownership gate, not an optimization - the registry now throws when no connector owns the repo's remote or when the owner has no resolver of that kind, and without the deferral one such throw would kill every later tier, including the slug tier that is the last chance for a task with no worktree. An UNEXPECTED exception (anything that is not a `PRResolver*` error) is different again: it sets an internal `resolveFailed` flag that suppresses the confident-not-found clear below, because "an owning connector ran cleanly" is false in that case.

**A PR URL in the task description is not an anchor.** Every tier above is git state or an explicitly stored number. Scraping the description was tried and removed: a URL cited as background ("this follows on from `<url>`") is textually identical to one naming the task's own PR, so the linker stamped a sibling task's PR onto unrelated tasks - and because that tier always produced a link, the confident-not-found clear could never fire, so the wrong link was permanent. A review task names its PR through the structured `pr_url` / `pr_number` fields (the task-detail edit form, `kangentic_create_task`'s `prUrl` / `prNumber`, or `kangentic_update_task`), which lands on Tier 1. Tier 3's two guards independently cover the base-tip case the description tier was originally written for. One trade-off follows from the holder refusals above: an explicit number is never refused, so the review task links whether or not the authoring task holds the same number, but the AUTHORING task, if its own explicit link write failed and a review task holds the number, is refused by inference at Tiers 3 and 6 and needs an explicit `prNumber` of its own (its Tier 2 branch anchor still links it while its worktree is alive).

**Commit ownership is the connector's claim, not the linker's.** `PRConnector.verifiesCommitOwnership` declares whether a `resolveByCommit` hit proves the commit is that PR's OWN work rather than history it inherited from its base. The linker cannot answer that: its commits-ahead-of-base check measures against a base the task may never have recorded, and it cannot see the difference at all. So `commitAnchorSelfVerifies` (`pr-registry.ts`) requires every owning, commit-capable connector to declare it, and the tier does not run otherwise. That can only TIGHTEN the existing gate, never loosen it: a connector that omits the flag loses the commit tier rather than falling back on a check that cannot catch its mislinks. Both shipped connectors declare `true`, for different reasons - GitHub establishes it client-side with the `mergeCommitOid` check plus `dropCandidatesSharingBaseHistory`, while Azure gets it free because `pullrequestquery` matches only a PR's own source commits server-side, which is the same finding that makes porting GitHub's two filters dead weight there. `tests/unit/pr-connector-gate.test.ts` fails on a commit-capable connector that declares neither way, so the choice cannot be made by omission. Ownership is the connector's claim; holding is the board's. A connector can prove a commit is a PR's own work and that PR can still be another task's, which is the fast-forward-onto-a-sibling shape above, so the linker checks that second fact itself before accepting a commit-tier answer.

Relaxing the commits-ahead-of-base gate was considered and rejected. The obvious loosening (run the tier when the sha is contained in base but is not its TIP, which the Tier-6 ref read already knows) is strictly weaker than what it replaces: a fresh worktree whose base has since advanced sits on an ancestor commit, passes that test, and can then magnet onto the merged PR that last landed on base. Recording `resolved_base_branch` also removed most of the reason to want the loosening, since the guard measures against the base the worktree was actually cut from wherever that base was observed. Not everywhere: the two shapes above still record none, and for those the guard falls back to the project default and stays exactly as unsound as it was.

The commits-ahead-of-base guard alone is not enough for that, which is why the connector-side filter exists. It measures against `task.base_branch ?? task.resolved_base_branch ?? git.defaultBaseBranch ?? 'main'`, and before the resolution was recorded a worktree cut from a long-lived integration branch had no base at all, so the guard compared a HEAD sitting on `feature/x`'s tip against `main`, found hundreds of commits, and let the tier run. It is kept as a cheap early-out that skips a `gh api` round-trip on the common fresh-worktree-off-`main` case; the per-candidate check is the sound one, so only the guard's fail-open direction needed closing.

Its false negatives are NOT all harmless, and saying so plainly matters, because the opposite claim is exactly what invites a relaxation here. Once a task's own work merges into base, `rev-list --count <base>..<sha>` is 0 and this guard skips Tier 3 on a commit that IS the task's work. That is half the interlock in the bug Tiers 5 and 6 were written for, and it is closed by adding branch tiers rather than by widening this one, for the reason in the paragraph above.

### Persist and degrade behavior

- **Auto triggers** (non-force) skip terminal `merged` / `closed` PRs (they cannot change) and coalesce rapid re-resolves through a per-task 60s throttle (`RESOLVE_TTL_MS`, a bounded `Map` pruned on each run). Explicit user/agent actions pass `force: true` to bypass both. The `pr-candidate` signal passes `bypassThrottle: true` to skip only the coalesce: the agent's own PR command just finished, which is the strongest hint there is, and it routinely lands inside the window an idle resolve stamped after the push that preceded it (push, turn ends, `gh pr create`); coalescing it away left the card unlinked until the next idle or sweep. A merged or closed PR is still left alone, since a `gh pr view` on a finished PR is not news.
- **Degradation.** When the resolver throws `PRResolverUnavailableError` or `PRResolverTransientError`, the linker records a `resolver-unavailable` / `transient-error` status, falls back to `detectPR` on any provided scrollback (url+number only), preserves a known state when the URL is unchanged, and logs a hint. A degraded resolve never clears an existing link.

  The hint is logged once per distinct REASON, not once per run: `resolverUnavailableHintsShown` is a bounded `Set` keyed on the error message, capped at 32, evicting the single oldest entry when full (`Set` preserves insertion order). A single process-lifetime boolean was wrong once a repo could be unowned - the first sweep over a project no connector claims burned the latch and permanently suppressed a genuinely different later hint, such as "gh is not installed", for every other project. Eviction is one entry rather than a wholesale clear because clearing discards every already-warned message at once, so the next sweep re-warns all of them and a workspace that keeps crossing the cap settles into a clear-then-restorm cycle.
- **Confident not-found.** When the resolver ran cleanly and matched no PR yet the task still carries a link, the linker clears `pr_url` / `pr_number` / `pr_state` / `pr_merge_readiness` atomically so a stale `merged` never lingers. A link-time resolve (`preserveLinkOnNotFound`) is the one exception: a resolve fired BY a link write must never undo that write, so a URL that matches nothing (typo, cross-repo, private) keeps its link with a null state. The non-force sweep clears it on a later pass, but only once the task leaves a To Do lane AND still carries one of the sweep's own anchors: `isEligibleForRefresh` checks the lane first, then requires a `pr_number`, a live `worktree_path`, or a `pushed_branch` outside a Done lane (the Done gate keeps the sweep bounded, since `pushed_branch` survives Done and a Done task that never linked would otherwise be swept forever). A preserved link that has none of these (a URL naming no PR number, on a task with no worktree and no recorded push) is never eligible, so in that shape only an explicit refresh clears it. An explicit refresh (kebab, `link_pr`) leaves the flag unset and still clears.
- **SHA backfill.** It opportunistically persists the freshly-read worktree HEAD SHA so the commit anchor (Tier 3) and the remote-tip anchor (Tier 6) are available later, after the worktree is reclaimed on Done. The same write carries any `pushed_branch` Tier 6 established.
- **Merge readiness is preserved on undetermined, and held through a pending answer.** `pr_state` never needed either rule because every tier can determine a state; readiness cannot be determined by the commit tier on either provider or by the scrollback scraper. A resolve whose connector omits `ResolvedPR.mergeReadiness` keeps the stored `pr_merge_readiness` while rewriting the other three columns, exactly as a resolve that never reached Tier 6 keeps `pushed_branch`; the scrape fallback keeps it only when the scraped URL equals the stored one, like `pr_state`, and a link that moved to a different PR starts from null. A platform `unknown` on a determined verdict of the same open PR is HELD rather than written: GitHub answers `UNKNOWN` for a few seconds after every push while it recomputes, and Azure's `succeeded` is `unknown` until policies are evaluated, so writing it on first sight would blank the card's chip for a sweep interval and then restore it. The linker keeps the stored value and re-polls (`PENDING_VERDICT_RETRY_DELAYS_MS`, 5 s then 20 s, forced so the 60 s throttle does not swallow it, one timer in flight per task, `unref()`'d, and cleared by the scheduler on project switch and shutdown); only when that budget is spent does `unknown` land, which is what lets an Azure PR that left `conflicting` clear its chip. A terminal PR is never held, since the chip does not render readiness there. `unknown` over null writes immediately, so "asked, no verdict yet" is recorded and distinguishable from never checked. A readiness-only change counts as a link change: it writes, notifies the renderer on `TASK_PR_LINK_CHANGED`, and returns `linked`.

### Entry points

- `linkPR(context, options)` is the IPC-side wrapper: it resolves the project + task (by id, else live session, else branch name) and wires the `TASK_PR_LINK_CHANGED` renderer notification. Mapping by branch/session means exited or suspended sessions and human-created PRs still link.
- `autoLinkPRForTask(context, taskId, projectId)` is the fire-and-forget entry for implicit triggers. It gates on a non-To Do lane (To Do resets the task) and on having some anchor, then calls `linkPR` non-force so the 60s throttle coalesces bursts. It is called from inside `handleTaskMove`'s own post-move announce block (success-only), which covers every move origin: a renderer drag, an agent's MCP `move_task`, a phone move over the mobile bridge, and the plan-exit auto-move. Agent and mobile moves reach it for the first time this way; it previously lived at two of the call sites, so those two never linked a PR for the lane they landed in. It also runs when a session goes idle (a PR was likely just created). A `pr-candidate` session event (scrollback carrying a PR command) also routes through `linkPR` by session id, with the 60s coalesce bypassed (see "Persist and degrade behavior").
- `recordPushedBranchForSession(context, sessionId, branch)` is the write behind the `branch-pushed` session event (the agent's own `git push` finished, see "Recording `pushed_branch` from the agent's own push" above). It records and returns; it never resolves.
- **Link-time resolve.** Every path that WRITES a PR link fires a forced resolve immediately after the write, so the card shows its state chip on save instead of waiting for a sweep. The three write sites are `handleCreateTask` and `handleUpdateTask` (`src/main/agent/commands/task-commands.ts`, via `linkPRForTask` since a `CommandContext` has no `IpcContext`) and the `TASK_UPDATE` IPC handler (`src/main/ipc/handlers/task-crud.ts`, the sink for the task-detail edit form, via `linkPR`). All three are fire-and-forget outside any lock, pass `force: true` because a non-force resolve inside the 60s throttle is exactly what a PR-creating flow hits, and pass `preserveLinkOnNotFound`. Each is gated on the write SETTING a link, never on clearing one: the branch and commit tiers would otherwise re-resolve a just-cleared task and bounce the clear straight back. The resolve announces on the toast-free `TASK_PR_LINK_CHANGED`, not `TASK_UPDATED_BY_AGENT`: the write that triggered it already notified, and the resolve usually just restores the `pr_state` that write cleared.
- **No-op link writes short-circuit.** `handleUpdateTask` skips both the `pr_state = null` and the link-time resolve when the incoming URL and number already match the stored row AND that row has a non-null `pr_state`. A `/pull-request` flow routinely re-writes the link a sweep already found, and without this the chip blanked until a forced `gh` round-trip restored it. The check requires both fields to be PRESENT and equal, never inferring a match from an omitted field: a `prNumber`-only write naming a different PR must still clear and re-resolve.

## PR Refresh and Scheduler

`src/main/pr/pr-refresh.ts`, `src/main/pr/pr-refresh-scheduler.ts`

### The sweep

`refreshProjectPRs` re-resolves every eligible task through the `linkPR` backbone (unchanged, non-force). This both refreshes an already-linked PR's state and merge readiness (so an off-app merge/close, a review, or a failed check shows on the board) and discovers a PR for a still-unlinked task with a live worktree (e.g. an agent created the PR mid-session on a renamed branch and no other trigger caught it). Readiness changes far more often than state (every base push, review, and CI run), so a `ready` chip is only as fresh as the last sweep or the task menu's "Refresh PR"; the chip's tooltip says so, and the hold-and-re-poll rule above keeps it from blanking between sweeps.

A task is eligible when its PR can still change or be found: a non-terminal linked PR (`pr_number`), a live worktree (`worktree_path`), or a recorded `pushed_branch` outside a Done lane (the sweep resolves the Done lane ids alongside the To Do ones for that gate; `pushed_branch` survives Done, so without it a Done task that never linked would be swept forever). Terminal `merged` / `closed` PRs are skipped first, as are tasks in a To Do lane (To Do resets the task, so there is no PR to link there - the same gate `autoLinkPRForTask` applies to every implicit trigger). Both gates are for IMPLICIT triggers only: the link-time resolve applies neither, since a caller that just wrote a PR link has named the PR explicitly, whatever lane the task sits in. `head_sha` is deliberately not an anchor here (nearly every historical task has one, which would make the sweep unbounded), and neither is a PR URL in the description (see the ladder above). The sweep is sequential and best-effort: a per-task failure is swallowed, and the backbone's `onLinked` pushes `TASK_PR_LINK_CHANGED` so cards update live without toasting (a pass that finds N changed PRs would otherwise raise N "Task updated by agent" toasts for work no agent did).

### The scheduler

`prRefreshScheduler` keeps a single active timer (Kangentic focuses one project at a time):

- `startForProject(context, project)` tears down any prior timer, defers an immediate sweep off the IPC critical path (`setImmediate`), then arms a periodic `setInterval` from the per-project `git.prRefreshIntervalMinutes` config (null / `<= 0` means on-load sweep only, no timer). It is called on every `PROJECT_OPEN` (cold restart and warm switch-back) and after a config change (`CONFIG_SET_PROJECT_BY_PATH`). There is no system-resume caller: `powerMonitor`'s suspend handler only tracks the heartbeat.
- `stop(projectId?)` clears the active timer. With a `projectId` it no-ops unless that project owns the active timer; with no argument it always stops (shutdown / unconditional). Called on project switch/delete and on shutdown.

Timer-leak safety: the interval is created outside `runWithProjectLogContext` (each tick wraps its own work inside it), is `.unref()`'d so it never blocks a clean quit, and is explicitly cleared on switch/delete/shutdown. A stale-switch guard skips a sweep whose project is no longer focused.

The background remote-fetch scheduler (`src/main/git/git-fetch-scheduler.ts`, documented under [Background remote refresh](worktree-strategy.md#background-remote-refresh)) mirrors this lifecycle exactly and is started, re-armed, and stopped at the same four sites.

## Where PR State Is Persisted

PR state lives on four columns of the per-project `tasks` table (`src/main/db/migrations/project-schema.ts`; `pr_state` and `pr_merge_readiness` were added by later idempotent migrations):

| Column | Type | Purpose |
|--------|------|---------|
| `pr_number` | INTEGER | The PR number, the exact branch-independent anchor. |
| `pr_url` | TEXT | The full PR URL. |
| `pr_state` | TEXT | Normalized `PRState` (`open` / `draft` / `merged` / `closed`), null when no PR is linked or it predates state tracking. |
| `pr_merge_readiness` | TEXT | Normalized `PRMergeReadiness` (`ready` / `blocked` / `conflicting` / `unknown`), null when no PR is linked or no resolve has yet been able to judge it. Orthogonal to `pr_state`; only rendered while the PR is open. |

The companion `head_sha` column stores the last-captured worktree HEAD commit as the immutable anchor for both commit-based tiers, Tier 3 and Tier 6. `pushed_branch` stores the branch the work was actually pushed to when that differs from the local `branch_name`, and is the Tier 5 anchor (see "The confidence ladder" above for why it is a separate column rather than a correction to `branch_name`).

**The four PR columns move together**, with one deliberate asymmetry: a resolving tier that cannot judge readiness rewrites `pr_url` / `pr_number` / `pr_state` and keeps `pr_merge_readiness` as it was (see "Merge readiness is preserved on undetermined" above), but every WRITER that nulls `pr_state` nulls `pr_merge_readiness` in the same write. The linker (on link and on the confident-not-found clear) and the task-detail edit form (`buildPrFields` in `useTaskActions.ts`) write all four in one update; MCP `create_task` writes `pr_url` + `pr_number` with `pr_state` and `pr_merge_readiness` already null from `TaskRepository.create`, and MCP `update_task` writes `pr_url` + `pr_number` and nulls both `pr_state` and `pr_merge_readiness` - unless the write re-points nothing (same URL and number, on a row with a non-null stored state), which short-circuits both the null and the resolve (see "No-op link writes short-circuit" above). The guard lives only in `handleUpdateTask`; a create has no prior link to compare against, so it is unconditional there. The one writer that can briefly leave them disagreeing is a number-only `update_task`: it sets `pr_number` and leaves the previous `pr_url` in place, and the link-time resolve fired immediately after the write re-points the URL from the number it was given (Tier 1). Setting or clearing a URL without its state leaves the inconsistent row the linker forbids, and a stranded terminal `merged` / `closed` short-circuits every non-force resolve, so the task can never recover from a wrong link. A manual write leaves `pr_state` null; the link-time resolve that fires immediately after the write (see "Entry points" above) fills it back in without waiting for a sweep.

`pr_url` and `pr_number` must name the same PR, because Tier 1 treats `pr_number` as authoritative: a row whose URL was re-pointed while the old number survived resolves the old PR and silently reverts the URL. So every writer that accepts a URL derives the number from it when one is not supplied - `buildPrFields` in the renderer, `prNumberFromUrl` in the MCP handlers.

Both go through one shared helper, `prNumberFromUrl` in `src/shared/pr-url.ts`, which matches `/pull/<n>` (GitHub, GitLab) and `/pullrequest/<n>` (Azure DevOps). It lives in `src/shared/` because the renderer cannot import the main-process registry without pulling `p-queue`, `which`, and `node:child_process` into its bundle, and routing a pure regex through IPC would mean a whole 7-layer endpoint for a string operation. They previously carried separate `/pull/(\d+)` regexes, which silently produced a null number for every Azure DevOps PR URL - and a null number is an anchor Tier 1 can never use, so a pasted Azure link could not be confirmed at all.

### IPC channel

`task:resolvePr` (`IPC.TASK_RESOLVE_PR`) is the renderer-facing, on-demand resolver behind the task detail header's "Link / refresh PR" control. Per `.claude/rules/project-scoped-ipc.md` it forwards an explicit interaction-time `projectId`. The handler (in `src/main/ipc/handlers/sessions.ts`) calls `linkPR` with `force: true` and returns a `TaskResolvePrResult`:

| Field | Purpose |
|-------|---------|
| `task` | The task after resolution (latest `pr_url` / `pr_number` / `pr_state` / `pr_merge_readiness`), or null if not found. |
| `linked` | True when the task now has a linked PR (`linked` or `unchanged` status). |
| `reason` | The `PRLinkStatus` outcome, so the UI/MCP can show an accurate message. |
| `message` | Detail for `resolver-unavailable` / `transient-error`. |

`PRLinkStatus` is `'linked' | 'unchanged' | 'not-found' | 'no-anchor' | 'resolver-unavailable' | 'transient-error'`. `not-found` and `no-anchor` are different answers: the first searched and matched nothing, the second had nothing to search by (no PR number, worktree, branch, commit, or pushed branch), and the header toasts them differently. The handler's own no-project early return reports `resolver-unavailable` with a message, so `no-anchor` keeps that one meaning. The kebab entry is shown for any of those anchors, so a no-worktree task whose push was recorded, or one that names its PR by number, gets the control too.

## Connector Status

| Provider | Status | CLI dependency | Notes |
|----------|--------|----------------|-------|
| GitHub | stable | `gh` | PRs via `gh pr` / `gh api`, reusing the board importer's `gh` client. |
| Azure DevOps | stable | `az` + the `azure-devops` extension | PRs via `az repos pr` plus one `az rest` call for the commit tier, reusing the board importer's `az` client. The commit tier sees completed PRs only (see above). |
| GitLab | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |
| Bitbucket | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |

The planned providers are a source comment, not stub folders. Adding one means implementing the `PRConnector` contract under `adapters/<provider>/` and appending it to the array.

That used to come with "no changes to the platform-agnostic registry API or its callers", which the Azure DevOps connector disproved: the dispatch loops had no `try`/`catch`, so the first connector whose CLI was missing threw and aborted before any later connector ran, and registering a second adapter changed nothing until the dispatch layer grew the ownership gate. A third provider does now drop in cleanly - but implement `matchesRemote` honestly, and make the connector's own resolvers return `null` rather than throw on a remote it does not own.

## See Also

- [Board Integration](board-integration.md) - the analogous adapter system for importing board issues.
- [Agent Integration](agent-integration.md) - the adapter system for AI coding agents that both patterns mirror.
- [Architecture](architecture.md) - the `task:resolvePr` IPC channel and task schema in the main architecture doc.
