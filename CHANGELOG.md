# Changelog

All notable changes to Kangentic will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

<!-- releases -->

## [v0.38.0] - 2026-08-30

### Features

- Rebuild the Changes review surface around the diff (a43b3a04)
- Add a word-wrap toggle for long diff lines (94a74429)
- Keep the Changes panel closed after its pop-out closes (55c642b5)
- Stable browser surface handles, own-task resolution, park-on-close and hold-on-hide (9b1f3f04)
- Close a task's browser to free its memory (5a2b1f33)
- Adopt Sentry error reporting and expand the event set (ee1159f5)
- Print the authoritative changed-file list from the review pack builder (2bf78a0b)

### Fixes

- Key the PTY geometry re-assert on alt-screen entry, not first output (9c7b6fd9)
- Re-assert geometry after first output to close the spawn-window resize race (54d08caa)
- Stop a deleted directory's fs.watch from pinning a CPU core (6225eb82)
- Stop a clickable activity mark from dropping the click (9e899135)
- Keep Browser pane guests alive across a store-slice edit (9aab627d)
- Park a window only when there is a guest to preserve (7215826c)
- Never dock a window into a dormant one (636c5541)
- Stop the sort menu's Escape from closing the task window (5364e583)
- Rename the hook-shaped inlineWhenNarrow local (a60d4e18)
- Derive changedFiles from the review pack, not --stat or the summary line (3e35c2cd)
- Correct the cycle claim and harden the two new HMR guards (afb1c482)
- Shorten the review checks context and close two gaps it exposed (de466ed4)
- Parity-rule scope gap and stale SpawnFlowContext test mock (408de9bf)

### Other

- One checks job, 11 UI shards, drop the redundant npm cache (6eab61ae)
- Gather-once review pack, medium-effort finders, floor trims (3b1b154a)
- Isolated pipeline to measure a consolidated + 11-shard CI shape (62f44911)
- Delete the temporary CI measurement pipeline (125b88e8)
- Wrap icon slots once and correct the claims around them (16f7a1aa)
- Read isWindowDormant at the task-detail window (f8f19929)
- Describe the rebuilt Changes review surface in the user guide (237d18bf)
- Correct two false claims in the Changes Panel section (976a45c0)
- Close the anchor and prose gaps left by the browser pane work (45318761)
- List window-parking.ts in the embedded-browser Files tree (f7977a35)
- Correct the E2E wave claim and close out the UI shard-count lever (e8f3e942)
- De-flake the two Changes resizer drag tests (967c36ef)
- Cover the KebabMenu Escape guard and the empty-commit message (a632ba3f)
- Read `transition-transform` in the composited-fill scan (0922551d)
- Pin onAltScreenEnter transition detection at the buffer-manager tier (2213d39e)
- Cover cancelSync, the one value the dispose stash still carries (3a1538bb)
- Pin the decision points of the telemetry instrumentation sites (8bf3a0ca)
- Pin telemetry call sites, add COUNT(*) task count (8014b578)
- Cover the reassert restore-leg failure path (ba3df797)
- Pin TOC line accuracy and the 200KB body-cap omission path (fac979bf)
- Pin the review-pack header and rename-churn contracts (332c56ad)
- Close the settings panel without waiting on an exit animation (c37a8aec)
- Scope the special-modes activity waits to their own session (5063bfd9)
- Pin the setChangesOpen idempotence guard and widen the HMR scan (e4119415)
- Pin workflow job names against main's required status checks (05487fd4)
- Fix three CI failures the hold-and-park behavior exposed (381e7115)
- Cover the park-or-drop decision and the panel-change terminal refit (8032cc94)

## [v0.37.0] - 2026-08-28

### Features

- Mark dev builds as "Kangentic (dev)" in the wordmark and OS title (31334d0f)
- Answer four task-tool questions at call time instead of making the caller probe (0141261b)
- Task-keyed cookie jars with project-wide IdP login sharing (b218ed6a)
- Never start a task from a stale base branch (64bb4d70)
- Multi-select project scope filter in the toolbar (f9908b96)
- Double-click a file row to pop out a single-file diff window (a4ae190a)

### Fixes

- Paste engine observes data-tap so unfocused sessions settle on real output (44cc2766)
- Warn loudly when npm start loses the single-instance lock (9ccc8298)
- Give mouse motion a self-superseding paced lane (2efc1b08)
- Bound the paced wheel-report queue with a lane cap and reversal supersede (ee5cf400)
- Replay geometry-spanning non-alt sessions via the parsed grid (7701505a)
- Complete the shared/paths mock in session-exit-intentional (34a8dd18)
- Abort-vs-timeout close race, resume projectId, coverage tests (ca7a8836)
- Value-compare the pop-out monitor's config re-hydrate guard (5f213906)
- Activate Unicode 11 emoji widths in every terminal parser (1a87ffff)

### Other

- Record why COLORTERM and TERM_PROGRAM are not defaulted (4b5f6956)
- Extract computeWindowTitle so the OS title logic is tested (9d04b81f)
- Document the single-instance lock warning in the dev guide (94c8d2b2)
- Pin the evidence phase's data-tap path for unfocused sessions (654201d2)
- Drop the paste-engine subscription caller contract (c80f1f05)
- Record the audited worst-case bounds at their sites (8159c816)
- Cover the override-validation ladder rungs with real values (e5f3e151)
- Pin that flush empties a saturated wheel lane (6d1e0cef)
- Gate the task-prompt readiness poll on mock output, task-scoped (a8bef53f)
- Assert plan mode via a mock-printed marker, not the shell echo (f55b63d6)
- De-flake the panel re-expand arrival-focus spec (58f71b4b)
- Cover the cookie-jar route dispatch gate and the ensureJar degrade path (a895b8a2)
- Pin the jar-seeding surface; sync stale cookie-jar docs (5da00b5b)
- Pin the chunk-split takeover-clear and OSC-title paths (88c6b122)
- Correct the Tasks channel count and the checkout-guard prose (b455ddf0)
- Align two main-side scans with the stale-base branch work (a8d852e8)
- Pin the Update-from-base kebab flow and the mount-only remote refresh (523951a0)
- De-flake width-drift selfheal's rogue-frame precondition (ac7f09c4)
- Pin the trigger's representable-selection intersection (893702cf)
- Pin the exact-fit boundary of VirtualScreen's wide-glyph wrap (d91aa268)
- Pin the shared window-frame Escape guard chain (698678cd)
- Pin pop-out manager, git-diff subscription handler, and title-anchor contracts (d68444a5)

## [v0.36.0] - 2026-08-23

### Features

- Find tasks by ticket number with `#<number>` (f4e5c31d)
- Make the dev-port ledger report the machine, not just its own records (622fd08d)
- Make the ledger answer for ports instead of assigning them (7d5f3612)
- Report a task's own dev-server port through the ledger (02d98efd)
- Default a task's pane to its own leased dev-server port (7a690da3)
- Keep an agent's browser alive when the task window closes (db92ab2a)
- Give each concurrent agent its own offscreen browser lane (0528a6c0)
- Report a dev-server build error instead of screenshotting it (4a28d928)
- Record the caller on every CDP drive so contention is visible (a90154a0)
- Serialize CDP drives per guest so concurrent agents stop interleaving (56d3332b)
- Lease a dev-server port per task from a global registry (44661e71)
- Enable auto-update on Linux (05b3f068)
- Rename the Tests and Ship It columns, relabel auto-command as a message (e1b5bad2)
- Target the focused text field for dictation, not only the agent terminal (c95d3f1e)
- Bring the backlog edit dialog up to the board's visual treatment (23788681)
- Reject a branchName already checked out, and stop spawn failures being silent (4df24791)
- Allow OAuth popups, and show the agent's focus move instead of hiding it (141b17c3)
- Retire a session whose agent CLI exited under a live shell (53c0e9b5)

### Fixes

- Pace mouse reports as individual PTY writes; keeplist scroll-speed env (527db292)
- Announce every move from handleTaskMove, keyed on an origin (836287af)
- Describe the `#<number>` ticket syntax on the MCP tool schemas (0d0e8d02)
- Classify the dev-port tools for mobile, and teach one mock the registry (9a8ec007)
- Never let the port ledger take a task operation down with it (64f38940)
- An isolated lane never got its task's cookie jar (2ed1888e)
- Stop a browser lane from blocking the app's own shutdown (67e66832)
- The probe could not see Vite, the most common dev server (ab94e366)
- Move the default lease range off every framework default (fef00c01)
- Wire the cleanup paths that were written but never called (4e597e04)
- Report a lane teardown as its own unregister reason (f8394bf7)
- Let a backgrounded project's agent open an isolated lane (95bd61c8)
- Destroy a session's browser lanes when the session exits (670ebf6d)
- Raise the lane frame rate to 10fps, measured (654fe588)
- Let an agent drive its retained pane while its project is backgrounded (6786e970)
- Give the PR-link path a toast-free channel (0ba2ee07)
- Make every adapter's entry uuid absolute and session-scoped (cde9567b)
- Publish one release per tag, and locate renderer errors (c9aaa604)
- Stop sending channelId on the Android Expo push (40420b32)
- Bound transcript reads so a large one cannot OOM the main process (f09fbce6)
- Stop double-rendering Android alerts and settle-debounce the idle signal (dacbe10f)
- Put the antigravity mock in raw mode so its double Ctrl+C lands (1dfca1fd)
- Keep an exited agent's terminal, and re-resolve a downgraded resume (1b979209)
- Read archived_at by truthiness, not `!== null` (0e3ee167)
- Debounce finalize indexing per session (30b67b72)
- Unarchive on a move out of Done, and announce suspend immediately (6456f43f)
- Show a restore from Done as in progress, not as Paused (c82422b7)
- Never resume a conversation the agent never wrote (29a23fca)
- Refuse SESSION_RESUME for Done and archived tasks (e4eba4a5)

### Other

- Pin batcher clock-jump clamp, timer bookkeeping, and X10 fallback (07411aa8)
- Cover the announce block's failure guard (8aebdd8e)
- Correct autoLinkPRForTask's documented trigger set (f0012139)
- Name conversations in the search:everything channel row (fcd0ce65)
- Cover ticket-search budget cap and backlog-scope short-circuit (86982591)
- Document the mobile dev-port exclusions, and drop a comment that lied (4bb42faa)
- Renumber this branch's decision-log entries after the rebase (8a5c94e4)
- Document the dev-port ledger and close the anchor gaps this branch left (35798e0d)
- Prove the idle reclaim spares lanes that are in use (6a802148)
- Prove lanes die with their session, on the production spawn path (7f8c5e2c)
- Confirm the browser lane hand-off end to end (9516b90e)
- Reproduce the browser contention end to end, at zero quota (63db07d5)
- Say what the DROP INDEX branch actually protects (be673824)
- Rename list_dev_ports to check_dev_ports, and measure the probe (1c02000c)
- Name the probe's wall-clock arithmetic on describeDevPorts (c0d6334d)
- The ledger is instance-wide, not machine-wide (deea6353)
- Cover the reserve/list handlers and drop the dead URL seam (314cdc18)
- List the ipc/ modules the structure tree had drifted from (c9a40a16)
- Pin that an explicit link_pr still notifies loudly (d8d39118)
- De-flake the reveal grid-width spec's container control (51e16254)
- Correct two comments the Linux change invalidated (81662411)
- Retire the "Linux has no auto-update" claim left in five files (d88f9750)
- Cover a present-but-empty record id, not just a missing one (f4077fb6)
- Correct the packaging docs anchored to electron-builder.yml (b5a75e6f)
- Cover the preload hop that carries renderer error context (cd8fa675)
- Refresh a stale template-var scan comment (666e2ca1)
- De-flake the backlog dialog pending-attachment discard-confirm test (d035d19a)
- De-flake the in-sync echo test with the gate its siblings already use (cc819c16)
- Cover the truncated read path for the remaining five adapters (a138b6ee)
- Pin the truncation notice, the wire downgrade, and the stitch memo budget (7ad46113)
- Stop describing dictation as terminal-only (70f97bf0)
- Keep the activity-state marker adjacent to its comparison (bfe72131)
- Cover the sink, the guest bridge, and the mouse-release wiring (6c65b79a)
- De-flake createTempProject's transient ENOENT on the git template copy (00da1ab2)
- Cover Enter behind the delete confirm not reaching handleSubmit (3a88f9bf)
- Record that stale cleanup spares a custom branch (b356cc32)
- Pin the step literal at every notifySpawnBlocked call site (93afef3e)
- Correct the spawn-blocked trigger set in architecture and worktree docs (d652e20b)
- Pin the iOS input-required placeholder copy (5976e98d)
- Pin the idle-settle guards and correct the re-check rationale (ec0c8b44)
- Cover the drive dim, the download toast, and the guest permission policy (38985b3a)
- Say the watcher's root is the shell, not the agent CLI (1af708ce)
- Correct the resume-downgrade section for the hook fallback (43530f28)
- Exercise the resume downgrade and clearArchived, not just their source text (a147c003)
- Close the anchor and prose gaps this branch opened (a0afe610)
- Document the resume refusals and the restore progress contract (a2476c23)
- Classify session display kinds with a compile-enforced table (59b69bd7)

## [v0.35.0] - 2026-08-17

### Features

- Announce revocation and act on the phone's unpair (82643898)
- Add Antigravity CLI adapter with full Claude-parity harness (4624a624)
- Add Grok Build (xAI) as the thirteenth agent adapter (1bb609f8)
- Megaphone access point, unread badge, browsable history (a66f2c31)
- Verified auto_command delivery for six more agents (1d815c4d)

### Fixes

- Drop the duplicate qwen entry the rebase auto-merge left in the agents mock (f17b74a5)
- Hide adapter runtime files from git via shared info/exclude seeding (cec1f2a3)
- Harden grok/antigravity adapters, drain seam, and bridge (e24e68a8)
- Keep subagent depth across a live turn_retrying hold (64d3c48c)
- Correct engine docs the retry-hold depth fix falsified (92b3b55e)
- Floor the history panel, and stop /preview relighting the badge (023bd2cc)
- Default TERM and drop the leaked NO_COLOR so agent TUIs render in color (13223407)
- Close the drain/quoting/caching findings from the adapter-branch review (2a6535f2)
- Align agent enumerations left stale by the Antigravity adapter (0e76844b)
- Convert single-quoted CLI paths for unix-like shells and spawn WSL as wsl.exe (fc0ea2f1)
- Align WSL exe replicas and the platform-guard rubric with wsl.exe (1501ef3f)
- Report replay-drained bytes to data-tap via a dedicated onDrain seam (f042cf45)
- Update the data-tap contract comment for its second feeder (be03479b)
- Wire the Kangentic MCP server into Codex, Gemini, and Droid (97d81e0b)
- Gate the project model default on the startup spawn path (0407ef45)
- Cap at the measured clamp, prune the clipboard temp dir (6e38c1e4)
- Bound the OpenCode part scan and pin the confirm-only escalation gate (d6e7afde)
- Detect Cursor by cursor-agent, not the shared agent shim (d6e2a2f9)

### Other

- Close the coverage gaps the branch audit found (d66dc3c1)
- Enumerate stuck-subagent in the synthetic-events list (416232b2)
- Pin the heartbeat-forced disjunct of watchdogBaseTime (c30cf80c)
- Close the enumeration gaps the Grok/Antigravity rebase merge left (e0cf0690)
- Cover the Antigravity detector and handoff display label (696e98e9)
- Pin wsl.exe shell-spec conversion and guard the hardened exe-path regexes (85c38db5)
- Cover GrokAdapter.probeAuth's exec branches (cc56deed)
- Record the worktree-removal trust cleanup where it was still missing (e233d5d1)
- Cover the adapter trust wiring, and drop Gemini trust on worktree removal (a5ef5e56)
- Cover the two store branches the UI tier cannot observe (0f67b62e)
- Cover the paste handler's degrade-to-null failure path (bece4001)
- Pin the clipboard-image handler wiring, refresh stale cap references (38c17952)
- Correct when a second project gets an onboarding baseline (e0e63622)
- Cover the reset-before-open ordering of the Restart trigger (8312c0ed)
- Move the dev-only onboarding trigger into the Developer tab (bbb6f7d6)
- Fix the session-history paths and two comments this branch left behind (216c1cde)
- Pin the injection verifier's part-query bound (37357d1d)
- Correct five claims the verifier work made stale (922460ac)
- Route contributors to the agent-parity gaps (aa180ead)
- Pin every injection extractor to a real captured history file (59f45f3a)

## [v0.34.0] - 2026-08-09

### Features

- Drive every dock from the pointer, drop the tile-layout menu (d8f03adc)
- Let agents place and reorder tasks within a column (a1ef7bc4)
- Let an agent open and close its own task's Browser pane via MCP (24a04884)
- Invert click-outside polarity to a denylist (f9903725)
- Unify control fill and setting text into shared components (6adcd030)
- Rebuild auto_command delivery for verified, observable injection (b37039c6)
- Close the task detail window when its session is paused (33b39b77)

### Fixes

- Let a background shell opt out of holding the session active (da7db01a)
- Classify reorder_tasks in the mobile board-tool allowlist (7234a5fd)
- Arbitrate which terminal takes focus on arrival (b9189d71)
- Export the browser capability gate and pin the pane setters (d9dc2ff8)
- Give the control fill a visible step against its ground (fe915d18)
- Keep the description preview readable on the retuned control fill (7d5a0cea)
- Migrate a persisted windowLightDismiss 'single' to 'focused' on upgrade (d3a6cc44)
- Mirror the light-dismiss migration marker in the UI mock (7f94f857)
- Fit a revealed terminal on the renderer it keeps (b1c2d0a6)
- Rename the app status bar testid to avoid a collision (602c0944)
- Exclude the terminal context bar from light dismiss (5d2f8691)
- Report each pane's live URL from list_panes (e3adf5b9)
- Scope pane control to the caller's project, and retain panes on switch (fd438bd7)
- Repair deferred-injection identity guard and draft notice (5c3c18d5)
- Use Claude Code's documented keys and stop interrupting the agent (4072a047)
- Align the relay row and rebuild its Test connection verdict (fae5b689)

### Other

- Cover the budget's undock re-anchor and group-move cancel (0c4b07a9)
- Record the in-gesture Escape keybinding exception (1d1f6a8e)
- Split a terminal init into its phases via a dev-only trace (064bfebb)
- Correct four stale counts in the engine's triage docs (85209fd0)
- Cover the exempt shell's memo cap, reset asymmetry, and watcher wiring (213ff00f)
- Stop closeApp's force-kill path from crashing teardown (dc8023e8)
- Stop counting the board-changed bus's feeders (70768f47)
- Cover the archived-reorder branch and parseSlotParam's junk guard (c310fe96)
- Prove the forced replay delay from the mock's call log (acb11c83)
- Cover selectActiveSession's arrival-focus claim (4d75e99b)
- Pin TERMINAL_WINDOW_LAYERS against allWindowManagers drift (92f70da6)
- Scope the family's same-project guarantee to driving (cbedb5c2)
- Cover the pane opener's unavailable-host branches and the live-guest refetch (25fd95c5)
- Pin the markdown-on-control class to the rule that consumes it (c21b563d)
- Tighten hasMigratedWindowLightDismissDefault's unreadable-file wording (089f608e)
- Guard load() against valid-but-non-object config JSON (52f87532)
- Pin the width re-issue's resize argument (ec8f7db7)
- Share dev permissions and drop a redundant MCP rule (4cf6e0ac)
- Pin each scope marker's VALUE, not just its presence (703fd29e)
- Reconcile three sentences this branch made inaccurate (001d17de)
- Cover the live-URL read's throwing guest and its scoped flow-through (e5716940)
- Say the pane registry's tracked URL is a fallback, not the reported one (edf8d4ef)
- Cover pane-active shortcut gating and project-scoped URL routing (7fb27472)
- Pin the useBrowserUrl refetch guard that keeps a retained pane alive (1a2dfd93)
- Note auto-command mode on board profiles and the prompted-resume caller (7d5eb8c6)
- Correct injection prose that still described the pre-rebuild behavior (967dfcc1)
- Keep verification cheap when several tasks inject at once (7daec1fb)
- Pin the probe verdict's tokens, its glyph, and where latency is measured (33629895)
- Note that mobileBridge.relayUrl is search-index only (817c9eba)
- Close two coverage holes the composited-fill scan cannot see (a166fc09)
- Serialize terminal construction, composite the context fill (643e9cae)
- Cover the terminal-ownership release on pause-close (11d61f57)
- Add a kebab pause/resume testid and document close-on-pause (d807a78a)
- Move the star line below the hero image (915cc5cc)

## [v0.33.0] - 2026-08-07

### Breaking Changes

- Mobile bridge: derive the pairing slot, and authenticate before consuming the token (ac5565b8)

### Features

- Rename the hosted relay preset, and back "Official" with something checkable (4715a098)
- Swap the Mobile Devices QR steps for a docs link (55ad3a7c)
- Self-diagnosing capture for missing-row frames, plus two replay repairs (6cba2aee)
- In-app announcements feed and Mobile Devices "Get the App" section (2d130fff)
- Add a quiet mobile pairing link to the welcome screen footer (b3f82bf4)
- Un-gate the mobile bridge for production builds (df66b28a)

### Fixes

- Keep the indicators animating while the main thread is busy (01747469)
- Bump the protocol package for its breaking wire change (9f8c158c)
- Rename the nudge's internal phase off the ActivityState 'idle' literal (47a78ca4)
- Stop the repaint nudge self-arming on xterm's own reports (e84d81e2)
- Surface open failures and never leave attachment:open unanswered (26e917bd)
- Register the announcements store in PREVIEW_STORES (449449d5)
- Expose Agent Crash in Settings and close the config-to-UI parity hole (a7c52a21)
- Stop a persisted 'local' relay mode blanking the Select in production (954960c8)
- Heal PTY/xterm width drift with a dims echo and owner re-assert (9b85817d)

### Other

- Rewrite the README hero and resync the feature list with what ships (11714439)
- Cover a mark REBUILT after mount, not just anchored at first paint (59d21522)
- Pin the Monitor Active tile freeze, and resync the march prose (f9afbae8)
- Cover useAnySettingVisible directly and both hide directions (e3f20cfb)
- Correct two Mobile Devices details the section split invalidated (06297fae)
- Split Mobile Devices into Relay and Mobile sections (47c5df62)
- Give a section heading and its body one visibility rule (565993b4)
- Pin the 'get the app' search alias for the renamed section (656f545d)
- protocol-v0.12.0 (5e1304d7)
- Pin the send-ordering that protects a just-succeeded ceremony (0c1757ce)
- Correct the DECSTBM claim on both sides, and the empty-suffix condition (105a88e9)
- Pin the forensics capture against a real defective frame and a split surrogate (5587c4cc)
- Document the focus-edge catch-up, the repaint nudge, and the DECSTBM replay gap (e0a9a85c)
- Cover the remaining branches of openAttachmentWithToast (49dd8285)
- Cover the announcements push path's destroyed-window guard (7b7b12dc)
- Count the Get the App entry in the mobile registry parity list (538538d3)
- Enforce the announcements store HMR pin, extract the shared external-link button (6c4163e4)
- Pin the Agent Crash dropdown's global config write (07d9b207)
- Document the notification config-to-UI parity checks (ebfb1c92)
- Correct stale Bridge Phase 3 notification and device-UI notes (ba185527)
- Pin both welcome-screen footer links' visible copy (5592004e)
- Cover the send-event warn path and the dev-pairing inline-path invariant (c23ca472)
- Pin the monitor surface's PTY-dims echo channel declaration (274dd1cf)
- Extract shared PTY-echo E2E helpers (2f036547)

## [v0.32.1] - 2026-08-04

### Features

- Show release notes on first launch after an update (69f14ee3)

### Fixes

- Default Claude's full-repaint flag for Windows spawns (1682955f)
- Follow /clear conversation forks so resume targets the live thread (75cb5724)
- Show honest telemetry instead of a fabricated 0% or "Claude" (9f9a134d)
- Give the What's New dialog its own icon and a non-echoing title (d63ffb00)
- Seed the What's New marker in the ephemeral preview config (d1149cf5)
- Re-assert mouse-encoding modes on the parsed-grid replay (e5429467)
- Replay the parsed grid for alt-screen terminal sessions (ffe67f32)

### Other

- Swap README hero to the redesigned Play feature graphic (9df12d93)
- Match README's agent-CLI count to the hero image (12) (a9c997d6)
- Pin the fork-toast status gate and the reconcile projectPath resolution (a467ef4f)
- Pin /clear-fork reconcile wiring and toast gates (d36d9f88)
- Cover ContextUsageFooter's unknownLabel prop and the board's unchanged default (567b7aa8)
- Stop re-offering a stale `--stop` command for a dead preview (c6592f85)
- Backfill the missing protocol changelog entries and guard the gap (7a46211c)
- Cover the baked release notes and the ConfigManager cache clobber (90cf2a36)
- Pin replay-snapshot failure paths and flush recovery (c0127edf)

## [v0.32.0] - 2026-08-03

### Features

- Cross-project agent monitor with a shared task detail (7468d723)
- Live output peek on every monitor card, and named Command Terminals (5411a12d)
- Board profiles, per-column agent/model/effort presets a task rides (885c4275)
- Source-first markdown editor for descriptions, compact attachment chips (dfa0247a)
- Guide the first launch with a five-step onboarding walkthrough (856a85f9)
- Show release notes in a modal before restarting to update (f5f16667)
- Add create/delete column MCP tools, stage column removal in board settings (69bf2719)
- Add send-to-session steering with a durable sent-message log (ea04c81d)
- Surface live Command Terminals per project in the sidebar (5af50588)
- Give the sidebar footer a split button and the list a background menu (1513e338)
- Name worktree directories after the task number (3c24c6a4)
- Adopt the `@kangentic/branding` activity marks (cc4083f8)
- Add an edit pencil to the Agent Override branch (ca6059a3)
- Notify the launching session when a preview exits (4bdf90b1)
- Commit the code-review pass so the worktree hands off clean (b43ba8b0)
- Park an unwatched session's grid for its phone subscribers (aeeefff6)
- Rest unwatched sessions at a detail-shaped 210x48 grid (1e64ac20)
- Mobile bridge (dev-only): one-tap confirm, auto-enroll, full access on pair, and fingerprint cards (2ca5832a)
- Mobile bridge (dev-only): let the phone read completed tasks and their transcripts (4ac99209)
- Mobile bridge (dev-only): send project groups to the phone (c606221f)
- Protocol (dev-only): carry the session-list preview on the activity feed (0.8.0) (cc1ec5f6)

### Fixes

- Align the context-usage bar coloring with mobile's threshold ramp (ffd47285)
- Derive agent-not-found status from agentList, not a Claude-only probe (bddb455f)
- Remount the xterm host on a branch switch instead of swapping the session id (3ff71106)
- Only auto-follow new conversation messages when already at the scroll tail (05b60409)
- Open OSC 8 terminal links in the default browser, no confirm dialog (e9e513a2)
- Register updater-store in the devtools PREVIEW_STORES registry (f382044d)
- Loosen the cramped padding on the task run-mode cards (fd486dee)
- Check for commits only once there is branch work to do (142a3ef8)
- Resolve the base branch against real refs before creating a worktree (49c34412)
- Guard the checkout where it happens, not two files away (6d608e08)
- Close the gaps code review found in the checkout guard work (1c17a71c)
- Persist the task run mode so Agent Override survives a save (87e076b8)
- Track a Monitor wait as a background holder (ccd916e9)
- Assert idle after a settings restart, and label previews by task (3fbb54e0)
- Portal menu popovers so they escape clipping ancestors (837efd00)
- Gate the onboarding walkthrough on the install, not each project (731ec3ee)
- Stop linking a PR URL cited in a task description (bae921f0)
- Resolve PR state at link time so a newly linked PR shows its badge (d5d55241)
- Stop the commit anchor linking a sibling PR off the same base tip (0c1c6f99)
- Stop a close during the entrance animation sticking open (c8d02062)
- Match the import search box against the fields a row displays (e85b3552)
- Stamp the spawn-blocked notice with the project it happened in (dd38a516)
- Strip IPC plumbing from failure toasts, and block on Command Terminals (ee753651)
- Match the error that actually means a tool ran out of path (0e4c3fd7)
- Scope monitor backpressure resets, and harden the cross-project snapshot (a4c38d66)
- Give the dictation live chip a real capture signal (3ba95ff2)
- Stop the context bar presenting configured values as live agent telemetry (12d62e8d)
- Hold a moving card at its destination, and reset a To Do restore (582d1e20)
- Drop pre-sample held bytes instead of painting them over a replay (881bbecc)
- Reconcile a column auto-spawn edit live, and keep Resume reachable (f740a5c5)
- Arm the repaint settle on rows-only resizes (6d9f58af)
- Share the deferred terminal init between both xterm hosts (ccd389b8)
- Give a starting TUI's first frame a bounded settle wait (39b4befa)
- Skip no-op resizes and floor phone-streamed grids (bd90f66d)
- Reject userinfo that disguises a relay host as loopback (1a6b492f)
- Strip variation selectors in their own pass (f5a1ebeb)
- Classify the board-profile commands for the phone allowlist (81ac8ee6)
- Flip a paired device to Connected as soon as it connects (db9621ed)
- Park only terminal-streamed sessions, and drop their panel tab (334976c1)
- Release phone state on silent departure (ba3ba7b0)
- Make the spawn-blocked mock unsubscribe actually unsubscribe (8678e1fa)
- Stop the fit-invariant spec depending on a devtools-only global (d0a2a904)
- Fix doc gaps in place instead of stalling a green PR (dad4e008)
- Stop pinning a branding version in the mascot frame test's prose (316dc8a3)

### Other

- Cross-project agent monitor: speak the shared activity marks, and stop toning the chrome (cd386981)
- Defer terminal init a frame and gate monitor snapshot pushes (49cf073a)
- Cut board hot paths and keep cards live during a drag (e84099e1)
- Revalidate a task by stat before parsing its sessions (c70edf7f)
- Let a subscriber opt out of the PTY stream (a5a2c241)
- Coalesce usage pushes on the wire, not just on screen (d98c0407)
- Send the board a phone draws, not the board we have (7e9b8986)
- Unify the task dialog field vocabulary and run-mode cards (8eee1ae3)
- Put Usage Stats to the left of Quick Find (e5ec4946)
- Drop the dictation mic button (56e3d724)
- Drop the "Markdown supported" hint from the description empty state (7184ef40)
- Read the mascot mount set from branding 2.7.0's mountFrames (df77ba5b)
- Adopt branding's re-hinted agent-idle (18x16) and re-derive pinned geometry claims (02ab5031)
- Point Planning and Code Review swimlanes at claude-opus-5 (6e26aa23)
- Add SECURITY.md and publish the support contact addresses (0e709d31)
- Record worktree_folder and the project_meta high-water table (3bedb244)
- Close the remaining worktree-folder anchor gaps (8cd870b4)
- Document branch namespacing and fill test-coverage gaps (337cee3c)
- Add the missing profile row to kangentic_update_task's param table (376fbf47)
- Describe create_column's position as the clamped ordinal it is (0579e441)
- Record the no-move auto_spawn suspend trigger (d5ba5e8d)
- State the run_mode backfill's profile guard and transaction (2476478f)
- Correct the run_mode migration suite's skip contract (c7f67307)
- Correct the applied_effort ground-truth claim for migration 40 (bf341c88)
- Correct how a Monitor reaches its named slot (3ae8b7a9)
- `onboardingBaseline` defaults to undefined, not `{}` (cfad9efa)
- List the git wording in the path-length signatures (7bf06148)
- Record the 0.8.0 session-list cost work (cefd388a)
- Cite the lane-pin guard's own tests, and drop authored double dashes (629e0981)
- Correct the column-agreement and sweep-eligibility claims (a5e00b7f)
- Stage a review pass's uncommitted work instead of asking (55cf3b0c)
- True up width-only repaint-settle wording outside the diff (01e0202e)
- Note the out-of-band idleAuthoritative writer in the provenance bullet (0765dc2c)
- Prove `--kng-warning` and `--kng-danger` resolve in a rendered browser (6cc35f3e)
- Assert the session-swap tripwire never fires on a branch switch (322915fe)
- Cover DEL and all-control-character sanitizeDeviceName paths (eea2ea33)
- Pin warn messages and the useTerminal/index.ts wiring (fa173c3d)
- Cover the provenance-failure and listForTask paths (810a37fa)
- Cover the board-profile units behind existing mock boundaries (1f0b6d85)
- Teach the swimlane-update mock about getBoardProfiles (94cf3fbe)
- Assert the description editor's height floor, not its class name (48a7736a)
- Cover the project list's new group fields (1bc410d7)
- Cover updater-store state machine and modal edge cases (6009a7c0)
- Pin that a reconnect resets the presence probe budget (a154f177)
- Budget the fullscreen-select waits for a contended CI runner (6e665bec)
- Pin the New Task open/dismiss nonce ordering (db9e45fc)
- Stop the new git-init toast leaking into every spec, de-flake Escape (d64178b8)
- Stop dropping the first Escape in the back-out specs (dda3a7e5)
- Pin the branch-namespacing wiring and an empty-base edge case (5d09de16)
- Add the missing execFile export to remove-worktree's child_process mock (b95b9419)
- Assert the Agent field's tooltip copy in all three states (5628c0b3)
- Close the agent-picker dialogs through the discard confirm (9c78b2b5)
- Cover the run_mode command handlers and the active-session save gate (735e9c9d)
- Cover the remaining terminal statuses and whenTool wire format (b4760853)
- Cover the paste-plain arm, menu clip cap, and tag-regex edges (ff3d817f)
- Cover exit-record fs round trip and record-priority ordering (8dc52497)
- Pin the form primitives' branch behavior and the hidden worktree arm (9d599fa4)
- Cover the switch-confirmed arm of the Command Terminal reopen (8f075738)
- Cover the footer menu's dismissal paths and the background menu (5bdfca77)
- De-flake the dropdown width-match assertion (a51b0dec)
- Pin the reason-kind to mark-name mapping in the tooltip (0d0b7227)
- Prove the reduced-motion emulation is actually in force (e8146015)
- Cover the folder resolver and the per-task cleanup catch (3425fe18)
- Pin the per-renderer backpressure scoping (596a637c)
- Give the file-tree wait the same 15s budget as its siblings (3c74e333)
- Guard the transcript fallback against claiming agent telemetry (502aa899)
- Cover the bulk restore, per-task generations, and the pin clear (45ac512b)
- Stub the hooks the mark now uses to hold its march phase (ac4819d8)
- Guard monitor-store's instance pin, true up stale comments (44c6c72d)
- Pin the attach vs loadSnapshot stale-reply ordering (a9276153)
- Pin the MCP update_column live-session propagation gate (e0a63423)
- Cover autoSpawnForTask's two guards and the column change builder (554340cc)
- Pin the settings-restart idle assertion, and correct two stale docs (c73288b2)
- Add markIdleAuthoritative to the engine guard catalogs (b9b32035)
- Wait on the first-output latch, not a drained scrollback poll (89045d55)

## [v0.31.0] - 2026-07-24

### Breaking Changes

- Mobile protocol (dev-only, not enabled in production builds): five-category push taxonomy and wake-channel seam (5d4a67eb)

### Features

- Near-black terminal background, a real ANSI palette, and custom terminal colors (4f4dcc5f)
- New Task settings tab and a system font picker for the terminal (1ff1b00c)
- Word-delete on Backspace setting for the terminal (67c0cd26)
- Remove Scrollback Lines as a user setting (f950e430)
- Setting to disable Codex's ChatGPT Apps connector (e3474f61)
- Support remote OpenCode servers for task workers (4c036d2f)
- Make the MCP HTTP server bind address configurable (4a1acc4e)
- Live idle-wait duration and durable active/idle interval history (a187cbdd)
- Fast-heal hook-less resume-picker turns before the 180s stale-thinking net (7b0eb9a7)
- PTY resize origins, dims getters, and a pty-resize event (638cfbf6)
- Mobile bridge (dev-only): resolved relay default with custom and local override (8c608c1e)
- Mobile bridge (dev-only): push registration store, register-push handler, and Expo push notifier (de481945)
- Mobile bridge (dev-only): session lifecycle board feed and honest session-ended push (0ca3d319)
- Mobile bridge (dev-only): publish pending prompt option labels (6bd95d03)
- Mobile bridge (dev-only): project accent color in read-board (52937709)
- Mobile bridge (dev-only): stream PTY dims so the phone fits the grid (39d32ce7)
- Mobile bridge (dev-only): instant pairing for the mobile dev rig (0e0259cb)
- Mobile bridge (dev-only): copy pairing link and gate the bridge to dev builds (347b56be)
- Mobile protocol: board snapshot carries the Ticket Numbers setting (67c56254)
- Mobile protocol: additive prompt option-label fields (4e126bd3)
- Mobile protocol: optional project accent color on board payloads (2b3f78c2)
- Mobile protocol: register-push verb and E2E push envelope crypto (6bc5a489)
- Mobile protocol: session-ended activity payload and read-stream sessionStatus (1560539b)
- Mobile protocol: terminal dimensions on the wire (52e73d03)
- Mobile protocol and bridge: chunked delta transcript streaming, windowed history, compression (68afad59)

### Fixes

- Clamp the usage context bar to 100% instead of hiding it near auto-compaction (a96544c0)
- Paint the terminal LaunchOverlay with the resolved terminal background (8cb31cf0)
- Resolve {{baseBranch}} to the effective default and unify task template vars (acf16b07)
- Linux: use soname capabilities for rpm dependencies (cad16b57)
- Mobile bridge (dev-only): option probe rejects wrapped and unanchored dialogs (8d95f964)
- Mobile bridge (dev-only): roster sessions survive a relay that is not up yet (6260c748)
- Mobile bridge (dev-only): seed the phone from a serialized grid, not a byte replay (faee3181)
- Mobile bridge (dev-only): re-initiate KK handshake on transport reconnect (f0ad5e0a)
- Mobile protocol: accept terminal-resize in the envelope decoder (3c07b517)
- Mobile protocol: classify get_activity_intervals as a board-tool-read (eed683d8)
- Bridge the PTY flush window before the first scrollback read in E2E (783932fc)
- Stop expecting terminal.* to seed into new projects (5b1598d0)
- Decouple the terminal-image-paste-reference test from the bg-surface (72fd0402)
- Add boardConfigManager to spawnAgent test context mocks (063eaac8)

### Other

- Reorganize the Settings panel into Project vs System tabs (0f657ad5)
- Move desktop idle/crash notification policy to the main process (e2802fec)
- Document the theme-match preset in Terminal Colors (4c8bfb2a)
- Fix stale two-panel wording in the Settings Panel docs (fdc9fa1f)
- Add a brief-accurate settings/UI copy convention rule (9268a105)
- Mobile protocol: document the cross-repo local-dev strategy (9dedcdf7)
- Mobile bridge (dev-only): register-push verb, E2E push pipeline, lifecycle feed, and project colors docs (ee3d455b)
- Mobile protocol releases 0.5.0 through v0.7.0 (1c65678c, 1ff54b12)
- Direct unit coverage for terminal theme-build and preset helpers (944d9d70)
- Cover the font-change race guard in useTerminal's live-apply effect (1b929adf)
- Cover the Word delete on Backspace toggle and backspace migration (2073c5ba, dc7a9eb8)
- Cover the usage display-percent boundary and replace-path fill wiring (4ad8c08f)
- Cover LaunchOverlay's default surface variant (58cda2b6)
- Cover MCP bindAddress passthrough to httpServer.listen (885f475b)
- Close baseBranch coverage gaps in run_script/webhook and live-inject (ef96b89e)
- Cover OpenCode remote-execution coverage holes (3b3cfcbc)
- Cover notifications register-all wiring and start() idempotency (c4e3d988)
- Update register-all listener-count assertions for ActivityIntervalRecorder (1e31a843)
- Pin Scrollback Lines row absence in the Terminal tab (d5381096)
- Derive the mobile capability toggle count from MOBILE_CAPABILITY_VERBS (cb4516fe)
- Mobile bridge (dev-only): pin empty-categories and cooldown-key isolation, fix reconcile-wiring pins (d9906b61, 72c79b71)
- De-flake changes-panel lazy-retry, changes-file-history, and usage KPI tests (e772978d, 3b055db3, f395b465)

## [v0.30.0] - 2026-07-14

### Features

- Project + app-wide usage statistics dashboard (4de7b2e9)
- Mobile companion bridge: protocol package, device pairing, and secure relay transport (f5c97b9d)
- Mobile bridge Phase 2: capability handlers, data feeds, and board-tool surface (8bfa87d1)
- Detachable-surface window engine for stats, changes, and browser panes (5856855a)
- Consume @kangentic/branding for desktop app icons (v2 Warm Craft) (aee274db)
- Theme-adaptive title-bar mark and dev favicon (905115d5)
- Protocol: typed feed payloads, board-tool tuples, and read-stream gap fixes (v0.2.0) (b7accca6)

### Fixes

- Refit Command Terminal xterm on container-only size changes (64d0abd4)
- Veil the mount replay and settle scrollback on the real repaint (56884289)
- Lock Advanced overrides at every first-spawn entry point (7de8a67a)
- Lock all per-task Advanced overrides at first spawn (f9150859)
- Scope the usage live-session merge to sessionCount only (e087b874)
- Capture git churn on every finalization, show files, merge live sessions (a5596f7f)
- Split the Command Terminal title-bar toggle from the spawn-another control (d93b5650)
- Retarget the rebase-collision test to the New terminal button (ae40e8cb)
- Scope the Command Terminal Changes panel state to each window (ef916371)
- Light-dismiss task windows from the empty terminal panel (479cacf5)
- Fill the two empty cost cards in the Usage Live view (2ff38672)
- Add toolbar top padding and fix the Cost sparkline in Live (a2d34332)
- Show diff in Changes surfaces for no-worktree tasks (7164dd1f)
- Let move_task resolve the archived Done column by name (bd9818d9)
- Inject an agent-readable reference for pasted or dropped images (5f626cd9)
- Drain orphaned background shells via transcript, not a dead hook (8c7ebf03)
- Register the usage-dashboard store in the preview state mirror (853ba020)
- Register mobile-store in PREVIEW_STORES (4bd3036b)
- Scope the button cursor rule to native buttons, not role="button" (38bc30a2)
- Restore pointer cursor on buttons (Tailwind v4 regression) (f709702e)
- Portal label suggestions and fix suggestion click commit (abd99a39)
- Hide board task-detail windows over the Backlog view (f34d8271)
- Resolve dictation target by transient slot anchor (838e3b72)
- De-flake the cursor-activity-detection stream-json init assertion (8342903a)
- Add attachContext to the register-all MobileBridgeService mock (665a0e52)
- Correct the device-name placeholder selector in mobile-devices-settings.spec.ts (7669e724)
- De-flake the changes-diff-scroll-memory diff-editor-area wait (a523964b)

### Other

- Push usage aggregation into SQL and lazy-load the chart bundle (f6f7b20f)
- Budget WebGL contexts and gate off-view PTY writes (d0461c1b)
- Bound lifecycle git bursts and event-loop hygiene (22d13313)
- Keep git and Monaco diff work off the UI thread in the Changes panel (918fd3ba)
- Remove dead auto-fit-to-branch-name effect in ChangesPanel (c4bf982f)
- Align README with the Warm Craft site refresh (a25eebf0)
- Point mobile-bridge relay references at the live kangentic-relay repo (27ec5334)
- Index the pop-out-surface-registry rule in CLAUDE.md (d3fd93e1)
- Fix protocol first-publish build step and ship full AGPL license (32299e2c)
- Add mobile companion app architecture research (07bd3fa7)
- Publish-npm release job idempotent, pinned to Node 24 (807d73ca, 859ef26b)

## [v0.29.0] - 2026-07-09

### Features

- Smooth long transcripts, in-viewer search, open-at-position (41b288ae)
- Project-level model/effort defaults, per-task permission override, and MCP support (55e92fe7)
- Add kangentic_move_task_to_project tool for cross-project relocation (2c478259)
- Add repo-history views: commit browser, file history, blame (76c8df65)

### Fixes

- Mark TranscriptBlock.type thinking checks as activity-state-ok (a1a69e50)
- Disentangle Hotkeys terminology from Shortcuts feature (6f500b7b)
- Stop false idle during a live StopFailure retry (76d594d8)
- Make diff-viewer copy and select-all reliable (db544cde)
- Disambiguate Move Task pill assertion in settings-panel.spec.ts (e4b9dbde)
- Emit the real first-output cursor-hide sequence in the mock (6af74757)
- Wait for the launch overlay before clicking the terminal (3038bcb5)
- Click the xterm container, not its hidden helper textarea (044f53dd)
- Fullscreen TUI select-prompt input/focus freeze (9552881e)
- Narrow stale-thinking anchor for heartbeat-forced turns (32806fef)
- Remove redundant PR pill from task detail header (64d5c16d)

### Other

- Cover scrollbar-reveal padding reclaim and settle-loop math (7a233a75)
- Fix remaining shortcut/hotkey terminology in configuration.md (16532b75)
- Cover Combobox/ModelCombobox friendly-label and placeholderVariant behavior (76d2ac25)
- Document move-task-to-project rollback and same-project rejection (cdba281f)
- Cover move-task-to-project thrown-error path and createdAt param (7e935297)
- Cover DiffViewer copy and select-all (d21afcd1)
- Cover transient rev-parse failure, blame gating, and history-divider resize (69119966)
- Cover dangling synchronized-output frame on reset (170e11b4)
- Close turnForcedByHeartbeat reset coverage gap (1411899a)
- Remove Release column from board config (4b6dd0ca)
- Revert explicit-invocation gate, keep doc auto-fix (b96abb01)
- Gate /release to explicit invocation, auto-fix doc gaps (e1f2b6a4)

## [v0.28.0] - 2026-07-07

### Features

- Add Edit-style in-place description updates to kangentic_update_task (5a467c83)
- Central background embedding engine, duty-cycle throttled (af2127b2)

### Fixes

- Normalize model ids, backfill tool counts, scope clientId (0d4bff99)
- Hydrate known context windows from persisted metrics on boot (3868e053)
- Contain wide content and persist panel across project switches (d7c7fe2c)

### Other

- Rename to Testing/Merge and add a Release column (c70ec390)
- Cover transcript tool-count parser edge cases (0ac7ce1f)
- Cover description-edit edge cases and Zod schema boundaries (99aefeeb)
- Cover developer-flag default logic (e8c0090d)
- Refresh board PR status via kangentic_link_pr after merge (ebc6638a)
- Add hydrateDiscoveredContextWindows to agent-list-handler mock (8c103836)
- Cover hydrateKnownWindows edge cases (92c67c46)
- Warn against forking a side-check during /pull-request (446fae28)
- Cover serializeWorkspace including conversation windows (76ad00ec)

## [v0.27.1] - 2026-07-07

### Fixes

- Remove Similar conversations panel, warm-hold embed worker (51893ffe)

### Other

- Stub retrieval-service in config-handler-wiring (0553c025)
- Correct v0.27.0 notes, drop reverted MCP cap claim (c88449b6)
- Cover CONFIG_SET reconcileEmbedWorker wiring (0a8d20d8)

## [v0.27.0] - 2026-07-07

### Features

- Searchable conversation memory (hybrid + semantic RAG) (#112) (3c85e2f1)
- Gate analytics heartbeat on activity, flush on shutdown, add cost/token props and client id (dc684d21)
- Support attaching and removing files on existing tasks via MCP (e87d49d0)
- Demote superseded model generations in the picker and humanize labels (a49a4264)
- Add a per-task commit graph pane (#102) (988fe0c4)
- Show the description peek as a resizable side panel (ccf52112)
- Wire description peek state and keybinding in TaskDetailWindow (f74f99da)
- Add a Description peek pill and kebab item to the task detail header (b1262524)
- Extend TaskDetailBody with a descriptionPeekOpen prop (b348f361)
- Register the taskDetail.toggleDescription keybinding (5bd80e19)
- Rescan models on dropdown open with a self-discovered context badge (d54c9ece)
- Add a markdown preview toggle to the diff viewer (0a91ab9f)
- Redesign Edit Columns as a master-detail layout with maximize parity (2d5f1242)
- Link each MCP tool pill in settings to its docs page (bfa6ac4a)
- Copyable terminal output blocks (7369d23f)
- Never prompt for Kangentic's own MCP tools (1ef2b1c5)

### Fixes

- Populate backlog import filters over the full unbounded source (f1ef36fc)
- Restore the model/effort picker after a live column model change (1fa372b5)
- Keep the description peek from becoming a dead toggle (6399cb6f)
- Fold the Description peek pill before core action pills (08902bbd)
- Hide the description peek pill in queued/suspended states (4c692ec4)
- Change the description peek hotkey from Mod+Shift+I to Mod+Shift+K (9e0f2546)
- Harden the markdown diff preview toggle (1c647feb)
- Persist MCP update_column edits to kangentic.json (52b726af)
- Self-heal a false-ACTIVE pin after a resume-picker turn (360113bb)
- Show honest context % on background board cards, never over 100% (175f1392)
- Repaint-settle scrollback so restored terminals paint at the fitted width (62446ab4)
- Stop divider clicks from collapsing the project panel (6ef70888)
- Reconcile command-terminal window population per project on open (49fdeb0a)
- Stop block-copy misfiring on live prompts and streaming output (6fd18697)
- Stream the background-session model and context % from the transcript (97a53a84)
- Merge rate-limit windows monotonically to stop ContextBar flip-flop (8f68c04f)
- Isolate the worktree Vite dep cache and pre-bundle discovered deep imports (4f21e339)
- Fall back when the terminal selection can't be read from the buffer (8cb48ba5)
- Seed the board card model name at spawn instead of waiting on status.json (906a7a31)
- Honor OSC 52 clipboard writes and route copy through the main process (4529c6ce)
- Add a grace period so the orphan sweep stops deleting fresh session dirs (e131e66b)
- Scope lazy-panel load failures and make retry recover (f68cd72d)
- Land PowerShell sessions in bracketed project paths (9b9f72c6)

### Other

- Add getSummaryForTask to task-move-shutdown's SessionRepository mock (20612052)
- Cover resolveClientId timeout fallback (4dab4676)
- Cover attachment field wiring at the tool-registration layer (c8da711f)
- Tune per-column model and effort overrides (70dd1c5f)
- Cover externalId dedup across streamed pages (ed8311df)
- Close coverage gaps for multi-generation model demotion (fdf4609a)
- Cover the task:sessionResync push on a model-change restart (cd3c25ea)
- Tidy the description peek and fix its CI UI test (127f5121)
- Drop the no-superpowers-docs rule, keep the gitignore (8c8da09d)
- Stop committing Superpowers scratch and process docs (ee5b902b)
- Move the description peek to the kebab menu only (f1b2f292)
- Cover queued-state exclusion and terminal no-remount for description peek (8224391d)
- Ignore .superpowers/ scratch files (ea82a1c8)
- Update the design spec keybinding to Mod+Shift+K (8c47cb3d)
- Add a timeout to the description pill visibility assertion (3eccd951)
- Add a failing test for the description peek pill (98c0d270)
- Add the description peek implementation plan (fdd8d713)
- Add the description peek design spec (62369a86)
- Seed markdown files for the diff preview toggle (a5706a4d)
- Pin the first-write branch of the output-growth keep-warm gate (b14dbebf)
- Cover ColumnRail arrow-key navigation and the drag-handle guard (82117776)
- Cover the deep-archive detail-window self-heal (d01d5ec9)
- Eliminate recurring UI freezes (0fab1771)
- Fix the no-cursor glyph-fallback test hitting the default param (aeea3830)
- Pin an empty-array report against a populated rate-limit snapshot (06c09100)
- Guard the non-worktree dev.js cache branch (c618a234)
- De-flake the block-copy hide assertion on CI Linux (52799c74)
- Cover terminal block pixel-bounds scroll clamping (aa4cdb67)
- Wire a real CommandBuilder into the model-seed parser tests (be586769)
- Keep the task-create cap internal; parameterize makeTaskCounter for tests (3ab644a1)
- Assert browser tools are annotated by capability tier (0b07af42)
- Assert the cwd fixup is written raw, not via adaptCommandForShell (b0b0672f)
- Default the Planning lane to Fable 5 (f1cb8acb)

## [v0.26.0] - 2026-06-28

### Features

- Local push-to-talk voice-to-text into terminals (e5d1ae66)
- Drive the embedded Browser pane via kangentic_browser_* MCP tools (3c4a8ded)
- Add Ollama adapter for local LLMs (35bc20c0)
- Add a team-shared description field to columns (#70) (36cbb570)
- Add opt-in ticket numbers to task cards (97ff3c20)
- Settings-driven cap on MCP task creation (#67) (bd24be18)
- Persist per-task detail-view layout and lifetime session stats (d6703edf)
- Show task title in header and pre-trust clone workspace (d74ec8a7)

### Fixes

- Default Claude to fullscreen and fix window-resize sizing (9a2913a2)
- One-line Agent Browser tab, gate sub-toggles, steer to pane (fcd995b1)
- Silence benign Monaco DiffEditor disposal console error (fe0281ea)
- Compare output tokens only in status heartbeat recovery (4dcc6724)
- Resume session history after a worktree rename (b616a5f7)
- Restore Ctrl+V paste and copy in the first-party renderer (a9ff6366)
- Pass the Ollama prompt after an end-of-options marker (1b29047a)
- Guard refineTranscriptTokens and add it to test mocks (e9aff471)
- Defer heartbeat force-thinking to authoritative hook idle (987d3644)
- Cap title reserve at a 50ch floor so quick-action pills can show (396ad0d3)
- Re-assert DEC private input modes on scrollback replay (2942828d)
- Show the live model on background task cards (ef44b94e)

### Other

- Eliminate terminal/board freezes via PTY backpressure and off-hot-path I/O (98d682ba)
- Trim per-agent context tokens injected by the MCP server (958d4257)
- Clean up MCP Server settings tab (ab1ad962)
- Correct the TranscriptRepository method table (d2b3de61)
- Parallelize the safe serial-suspect specs, sweep round 2 (21eef6d4)
- Keep the two order-dependent activity-log specs serial (dbec8837)
- Parallelize the safe UI specs across the suite, sweep round 1 (27350b67)
- Parallelize five heavy serial specs to cut the CI shard long pole (cd34da47)
- Run UI Playwright shards at 3 workers to fix event-loop contention (e7fa9fef)
- Harden the Changes-panel UI spec cluster against event-loop starvation (f2aa78c7)
- De-flake changes-panel file context-menu spec (0fff7698)
- De-flake non-done drop-settle overlay spec (4853d90a)
- Cover mixed-param filtering and getScrollback idempotency (b697d3aa)
- Cover Interrupted/TurnFailed idle provenance (4fd0fe57)
- Fix session-metrics and slice unit tests for the compaction/projectId wiring (0e45752e)
- Cover ollama agentLoginCommand (add7cf6d)
- Rename shorthand ts to timestamp in ticket-number spec (68f9e900)
- Mock ipcMain.on in session-handler unit tests (da673bc6)
- Cover the main-process event-loop lag recorder (215333cd)
- Cover the missing project-DB guard in title resolver (ce6910a4)
- Cover the missing-projectPath resume-migration guard (88014e67)
- Satisfy unit parity checks for store registry and activity-state scan (e78e8312)
- Cover language helpers, multilingual models, and language resolution (c03a49bb)
- Disambiguate Agent settings-tab selector after rename (fa306374)
- Cover Agent Browser master-switch gating (d9d7726e)
- Cover the server-instructions open-pane advertisement (a6ad78ab)

## [v0.25.0] - 2026-06-25

### Features

- Multiple command terminals tiled among themselves (Phase 2) (68696a5c)
- Changes panel: file sort, tree/flat toggle, and collapse-all (b26f7204)
- Cross-file keyboard navigation for the diff review (270a2164)
- Per-file "viewed" marks in the changes file tree (452597ed)
- Segmented scope control and automatic git-metadata refresh in Changes (cf06c23f)
- Changes panel: branch header, diff scope, and resizable auto-fit tree (6a92b8a5)
- Full command-terminal window behaviors on a dedicated, globally-persisted layer (4ccc298c)

### Fixes

- Suppress animation replay on project-switch restore (6082847f)
- Body-portal the model/effort popover so it escapes the footer compositing layer (df432363)
- Hot-reload kangentic.json on the authoring machine (a52f3962)
- Stop expanded-then-collapsed terminal flash on project switch (9cf460df)
- Restore command-terminal focus on maximize/restore (7d620711)
- Drop commit-matched PR whose merge commit is the anchor (95e34354)

### Other

- Tokenize activity indicators and soften the idle color (e6625ac4)
- Align rate-limits pill tests with the agent-capability gate (1f46a63e)
- Update auto-name-scheduler transient mocks to the (project, slot) shape (ea2959c7)
- Mark CommandTerminalIcon tone checks for the activity-state scanner (5a244ff0)
- Cover the re-keyed transient-session selector and kill-by-slot (0420ccf9)
- Smooth /pull-request CI monitoring and MCP resilience (b71bd57b)
- Sync architecture and configuration for the Changes-tab feature (f477341e)
- Unit-cover the diff watcher and branch summary, plus panel hardening (6d91f0e7)
- Cover the Auto-Apply Board Config Changes toggle (01088f30)
- Extract shared panel drag-resize gesture into one helper (e327d7db)
- De-flake changes-panel and click-outside-close timeouts (46480f3b)

## [v0.24.0] - 2026-06-22

### Features

- Fold activity state into the pause/resume button (1152448d)
- Label the diff view preference "Git Diff View" (d781130d)
- Persist split/inline diff view as a global preference (1c2e1af7)
- Thread abort signal and progress into the create_worktree action (096c8b62)
- Execute initScript and make worktree node_modules linking configurable (ea9ac00e)
- Add session reset time indicator to rate-limit bars (74709030)
- Universal keyboard+mouse bindings; middle-click closes task windows (5c0b1f9f)
- Dismiss task windows on dead-area clicks across the app shell (3cbb377f)
- Click-outside to close task-detail windows (e738cdb1)
- Modeless task-detail windows (drag, resize, snap, tile) (a1b876c0)
- Offload test gate to CI; Tests opens PR, Ship It merges (2256017f)
- Background PR-state refresh on project open plus a periodic timer (40f74759)
- PR-link state badge and clearer clickable affordance (6a51a10a)
- Expose devtools eval-value, query-all, and store-state reads (adeaa367)

### Fixes

- Fold custom header shortcuts before built-in defaults (239f2dda)
- Recover stale activity counters after an aborted or errored turn (3da7301d)
- Pin board/backlog/project store instances across Fast Refresh (08e98396)
- Auto-link PRs created mid-session and discover them on the sweep (d6c12c00)
- Check out kangentic.json before DB seed to stop ghost columns (b9b15cfc)
- Keep fork PR state on by-number lookup (1367ea32)
- Scope kimi filesystem session-id capture to the spawn's work_dir (1556a2db)
- Warn on move-to-Done only when the move destroys work (6d7afd48)
- Persist the outgoing project layout on project switch (58271a57)
- Persist task-detail window layout across restart (dc0d89cc)
- Stop fresh worktrees magnet-linking the last-merged PR (056c691c)
- Gate the dev TestHarness to preview mode only (9bee5f2b)
- Realign the worktree branch in /merge-pull-request after merge (4b062bf6)
- Wire the maintainer --admin bypass into /merge-pull-request (1f83c41f)
- Force-kill Electron if app.close() hangs in E2E teardown (32a9f937)
- Point vitest --merge-reports at the blob dir (3f8b504e)
- Pin the UI tier to 4 workers (16b299f5)
- Isolate E2E temp dirs per worker process (45fd1123)
- Make the E2E git-template cache concurrency-safe (8acb1c20)
- Never mount the task detail dialog on a drag-overlay clone (a2de3e12)
- Pin the E2E git fixture to the main branch (f8f39c2c)
- Gate orphan kills on a complete process scan (a11c33a5)
- Strip leaked CLAUDE_CODE_* env so spawned agents resume (4b236593)
- Defer the stale-thinking watchdog on live PTY streaming (3cdb5cf9)
- Harden cross-project task creation against misrouting (7ec4f4c9)
- Stop mislinking code-review tasks to the base-branch merge-commit PR (42be3e99)

### Other

- Assert a fresh spawn seeds thinking, not idle (f2556d25)
- Establish an idle baseline in event-pipeline and write-queue tests (74cc203f)
- Assert the activity-engine initialTurnActive seed derivation (02def78e)
- Make the Git Diff View test self-contained (c30e883f)
- Include diffViewMode in the minimal AppConfig fixture (f130abe3)
- Share worktree spawn lifecycle and bound init-script output (eba01dfc)
- Assert the init-script spawn-progress label (c03c1812)
- Clarify maintainer-merge policy and CI re-run guidance (30ab6381)
- Render the rate-limit time marker as a caret-topped tick (dd78ca7b)
- Document mouse keybindings and the middle-click window close (7e382f26)
- De-flake task-detail window Escape-close cleanups (d25a0758)
- De-flake the edit-mode maximize test (4996c7d0)
- Document PR approval and merging etiquette (251275c3)
- Align /pull-request PR body with the PR template (cc31fc4d)
- Add a Breaking changes section to the PR template (fe1ee685)
- Align contributing guidelines with the real workflow (d08fbebb)
- Assert the Close on Outside Click setting renders in Behavior (bf4dc00d)
- Cover the config:setSync synchronous quit-flush handler (e8ba62be)
- De-flake the pr-url spec with per-test pages and seeded lanes (b116491f)
- Drop a hardcoded personal esbuild path in the verify script (823791ca)
- /merge-pull-request resolves PR by number and handles squash-merge fallback (bf26cbb7)
- Skip the dev-only devtools-inspection spec on production builds (f92f6a2a)
- Note CI runs the E2E tier on Linux at workers=8 (f10092dc)
- Cache node_modules across all tiers and add a third unit shard (5d6113e9)
- Document the concurrency budget and fix stale comments (301bc15d)
- Share browsers across more UI shard-3 specs (c828efdd)
- Revert unit-shard worker oversubscription (e5e3da4c)
- Cut per-test browser launches on the slow UI shard (0f11cd19)
- Trim the unit merge-gate install and oversubscribe shard workers (fef0e358)
- Bump artifact actions to node24 majors (77576d1b)
- Fit the 20-concurrent cap and merge unit reports into one summary (8a605c5d)
- Shard the unit tier 5 ways (23b99313)
- Shard the unit (vitest) tier across runners (57dcd8a3)
- Run e2e and ui shards at 8 workers (2f046f30)
- Raise CI E2E workers to 6 so a 5-file shard runs in one wave (c6cb0b33)
- Reflect that the E2E tier now runs on Linux CI (ea691de8)
- Drop two redundant kimi telemetry tests to speed shard 5 (cd4724aa)
- Parallelize per-test-isolated E2E spec files (b084f16b)
- Parenthesize shard indices in the test check names (2d9407f5)
- Run E2E at 4 workers on Linux CI; rename shard checks (5f311f7a)
- Shard the UI and E2E tiers 10 ways each (106c99ac)
- Run E2E on Linux only, 4 shards by 4 workers (ddd1959a)
- Scope task-delete overlay waits to the detail-dialog testid (56cdae9f)
- Run the E2E suite on Linux (xvfb), sharded, as the primary gate (beef3a8d)
- Shard the E2E Electron suite and cache node_modules (f499614a)
- Pass git identity inline to the fixture commit (a7ead993)
- Retry UI specs once on CI to absorb drag-and-drop flakes (cb7aa86f)
- Drop the serial report-merge; gate UI on shards, 14 shards, list reporter (14e90fa0)
- Split event-activity-derivation into two files to parallelize (b8f85fd7)
- Skip the native build on UI shards (0c077af3)
- Raise UI shards from 8 to 12 (44f9014c)
- 8 UI shards plus a lighter aggregate install (095355da)
- Drop --with-deps from the Playwright install (c6477b8c)
- Revert UI shards off the Playwright container back to ubuntu (468472dd)
- Rename the shard job to playwright-shards and add test progress (2200e03a)
- Cache agents.list and async-ify model-history scans to fix Settings freeze (f6d578cc)
- Rebuild esbuild in UI shards, scale back to 4 shards (a0e94c44)
- Use npm ci --ignore-scripts in the Playwright container jobs (eaf07390)
- Run UI shards in the Playwright container to kill the install cost (c1246b41)
- Bump UI sharding to 8 and rename legs to "Playwright N/8" (b1a88d22)
- Resolve all exhaustive-deps warnings, enforce --max-warnings 0 (bc1c7a27)
- Make every check a standalone job so all are always visible (b80538b1)
- Split the monolithic validate job into parallel, self-describing checks (e8ab76d1)
- Skip the electron leak janitor on GitHub Actions (142c8a32)
- Stop the stuck-subagent watchdog firing during the nested-subagent test (49f4e08e)
- Rename src/main/engine to src/main/transition-engine (d1e5b3cb)
- Map agent resume mechanisms and record the canResumeSession guard rejection (17d08d92)
- Lift the activity engine into top-level src/main/activity-engine/ (860bc144)

## [v0.23.0] - 2026-06-16

### Features

- Unify in-app overlay motion and add double-click-to-maximize (8a3f488a)
- Cross-agent get_transcript views (responses/result, tail, search, size caps) (a3cd5ab4)
- Structured get_transcript for all agents via parseTranscript capability (cb4bacd3)
- One-step project relocation (move folder + quiesce own sessions) (3cc7796d)
- Suppress auto_command on the first move out of Done (3ab750e1)
- Extend project-relocation data migration to all agents (adefcc80)
- Center first diff on open, restore scroll on revisit (ab796a7f)
- Migrate Claude per-project data on project relocation (e38667f9)
- Larger add/edit task dialogs with maximize and close UX (28ec4ec1)

### Fixes

- Guard New Task and Task Detail submit against double-submit (73c008bd)
- Stop false idle during parallel/nested subagents (aca71c32)
- Skip session respawn on no-op column config save (67fa6929)
- Root relocation test paths in os.tmpdir() so CI's Linux runner can write them (d38df3be)
- Suppress false "Session crashed" notification on deliberate teardown (8c213908)
- Release watcher and PTY handles so a clean quit exits 0 (217f896c)
- Stop false idle while a subagent is still running (c44ff281)
- Stop false idle after a long foreground tool ends (839fe5cd)
- Instrument and mitigate labels drop on large-description tasks (b2be81cb)
- Restart agent on model change only, not permission delta (2a516bac)
- Reclaim orphaned PID-less named bg shell via output quiescence (f85166e6)
- Diff model/effort against the session's applied value, not column config (2c7ec98e)
- Route task/session mutations by interaction-time projectId (c20cfbc2)
- Stop Done-move worktree delete from stalling the git queue (a78ca1ad)
- Refresh remote refs before the Move-to-Done unpushed-commit warning (84c2c2ef)
- Ground-truth signals for PID-less named background shells (44fcbafb)
- Make Move-to-Done dialog name the real branch and right-size loss warnings (cd590e9c)
- Keep tasks active while a long-running test shell is alive (e4fc50e2)
- Capture session id only from the announced banner (957373ab)
- Show MCP-created tasks without a drag; log agent push pipeline (7fc370c5)
- Mount FlyingCard on drop to close the drop-to-Done flash (01a6b46b)

### Other

- Skip idle process-tree polling and declare watchdog anchors (5ef72929)
- Complete empirically-grounded coverage of the activity engine (f932a4d3)
- Cover Monaco DiffEditor disposal and quiet its benign teardown error (1874a123)
- Guard against tests writing to hardcoded absolute roots (3de58325)
- Move Changes panel controls into the diff toolbar (13170617)
- Switch swimlane overrides to opus/xhigh, drop TortoiseGit shortcut (b50a74e8)
- Harden merge-back Step 6 divergence handling (9873edc5)
- Correct worker-crash flake taxonomy with verified root cause (ddd57c02)
- Add /debug-activity skill and transition-trace reference (be6c22d5)
- Normalize launcher package.json bin and repository fields (f9ee6fa9)

## [v0.22.1] - 2026-06-10

### Fixes

- Gate handoff on plan approval, not ExitPlanMode invocation (462eb74c)
- Start the drag-left divider test from 50% for Linux parity (2c9b0487)
- Harden Linux-flaky UI tests and add cross-platform parity rule (572aa317)

### Other

- Sync docs with source after v0.22.0 (f4e8eae3)
- Publish launcher to npm via trusted publishing (OIDC) (da79d829)

## [v0.22.0] - 2026-06-09

### Features

- Allow relocating a project to a new directory (1cb82707)
- Auto-discover new models via the /model picker (6915ac1c)
- Group [1m] variants and dated snapshots in the model dropdown (3409c1f8)
- Central keybinding registry and Hotkeys settings panel (f16b95be)
- Draggable terminal / right-panel split divider (63dd5e40)
- Maximize/restore and keyboard shortcuts for task detail and command terminal (7902b1cc)
- Unify board/backlog toolbar with shared search + filter (2f4d7614)

### Fixes

- Respawn on permission-mode change for plan-to-execute handoff (02e65348)
- Clear stuck permission state after approving a subagent's tool (c670350b)
- Track timed-out auto-backgrounded Bash as a bg shell (0fc99ef3)
- Hold watcher-confirmed live bg shells past the 30s grace (bb9380f6)
- Recreate worktree on Done round-trip past an empty husk (f33cdb10)
- Keep popover anchored on apply, add pill hover affordance (84bebafe)

### Other

- Set per-swimlane model and effort overrides (9e4bc1ea)
- Set auto permission mode on auto-spawn swimlanes (db03c107)
- Allow common dev commands via the PowerShell tool (9d5ea58d)

## [v0.21.0] - 2026-06-08

### Features

- Context bar: surface live session stats with expandable tool-call breakdown (2ada2e39)
- UI: readable theme-adaptive Isolated badge on session tab and task detail (ae3f854c)
- Code review: scope review against base branch through working tree (77609b07)
- Board config: round-trip per-column session settings to kangentic.json (326d6324)
- Sessions: split per-column sessions into target + spawn strategy (dd99f2ff)
- Sessions: per-column isolated agent sessions (f91a47e2)
- Diagnostics: tag project-specific main-process logs with [projectName] (89f00401)
- Diagnostics: prefix main-process console logs with local-time timestamps (2513fa09)
- Code review: size-gate /code-review and /test into a multi-agent heavy path (ad0af902)
- PR linking: authoritative branch to PR resolver with confidence ladder (68bee0fa)

### Fixes

- Activity: reclaim sole-holder background shells via anchored grace (393085a5)
- Board: hide drag-to-Done card before the worktree git probe (9591993c)
- Board: stop drag-to-Done card flashing back to its source column (c81c0bba)
- Activity: group permission with idle via shared activity-state classifier (c183f0b7)
- Build: deploy bridge/plugin scripts in dev, not just prod (7a6bc02b)
- Session: resume OS-killed agent sessions on startup (0c412dda)
- Activity: stop tool-blind remap mis-mapping Agent completions (4f0ec66f)
- Spawn: surface a waiting state and decouple the per-project git queue (2dc9460e)
- Activity: stop false idle when a running session's directory is deleted (3119b06e)
- Board: eliminate drag-to-Done snap-back flash with a race-free drop animation (a5ad0a26)
- Board: restore drop-settle animation for non-Done column moves (8ae1564f)
- Activity: restore turnActive when a permission pause resolves (dd32d929)
- Board: smooth out drag-to-Done animation and fix repeat-completion flicker (11051ac1)
- Activity: classify "waiting for input" notification as an idle hint (c1599c67)
- Context bar: make model/effort picker interactive in Command Terminal and default-agent tasks (e42c49ac)

### Other

- Test: simplify /test to a predictable full-run gate (225a6a44)
- Board: defer background reloads during a drag to prevent jitter (2ca1a0f8)
- Test: cover the animated Done-confirm dialog fly path (19266f9a)
- Repo: remove stray root scratch files (1c1ec487)
- Style: normalize merge-back skill dashes and tidy IsolatedBadge className (c5227264)
- Workflow: add /commit skill and split local commit from /merge-back (fe465a6d)
- Board: remove redundant "worktree deleted" badge from completed cards (59b9deec)
- Conventions: codify standards as .claude/rules and wire lint into CI (7cf486a5)
- Startup: defer reconciliation prep and quiet no-op startup logs (299e4f97)
- CI: pin CI and release back to Node 22 (e1e975d9)
- Board: coalesce session pushes during drag to eliminate jank (e0092214)
- Deps: upgrade dependencies to latest stable (e9c70124)

## [v0.20.0] - 2026-06-01

### Fixes

- Sessions: keep live session state visible across HMR and project switch (301b6bc3)
- Worktree: stable folder naming so Claude --resume survives Done round-trips (04e2888a)
- Backlog: keep import dedup aware of promoted tasks (1cff5933)
- Boards: stop import sources leaking into newly created projects (72d852a6)
- Agent: tolerate wrapped --effort line in Claude capability discovery (fffaf610)

### Other

- Skills: fork code-review for fresh context, auto-spawn IPC/migration auditors (9db388ed)

## [v0.19.1] - 2026-05-13

### Features

- Board: right-click context menu for archived tasks (52880ddc)

### Fixes

- Board: restore Done-drop FlyingCard and grow-in animations (82f90ffb)

### Other

- Updater: stub process.platform so init-guard tests run on Linux CI (d9f16a04)

## [v0.19.0] - 2026-05-12

### Features

- Per-task agent override + persisted model cache (d9fc070e)
- Per-task model/effort override with pre-spawn picker (eee04fa8)
- Browser: chrome-style zoom controls (ctrl+wheel, ctrl +/-, toolbar pill) (b6abd014)
- Activity: trace capture/replay, timeline overlay, invariant fuzzing (33da06c6)
- Attachments: compress pasted screenshots to fit Claude API image budget (ec777690)
- Skills: refine /test for self-maintaining affected-test selection (8b7acac3)
- Devtools: expand MCP surface, add latency telemetry, and fix bridge E2E (79ebd7b3)
- MCP: unify task search across board and backlog (7a7e4d2b)
- DB: persist lifetime usage stats independent of task/session deletion (cdfd6c64)
- Devtools: preview-inspection bridge + always-on diagnostics (3c01371d)
- Activity-debug: grid layout + memoized rows for debug overlay (1ff555ed)

### Fixes

- HMR: restore Done drop-zone animation and harden dev-mode parity (6cf5d819)
- Dialog: pin PreSpawnContextBar to bottom during pre-spawn (30d828e2)
- Browser: scope Ctrl+Enter send to the note input (15076930)
- OpenCode: only ignore activity plugin once it's actually installed (506f77ea)
- Session-reconcile: heal task.session_id drift by scanning the registry by taskId (d366c9dc)
- Task-move: silence shutdown race when DB closes mid-handler (e585d9fa)
- Board: force Done confirm when worktree has unsaved work (7f6e9e37)
- Activity: include transient sessions in debugger overlay (21983a86)
- Prevent fetch hang on task spawn and plug shutdown leaks (a2a4cd66)
- Activity-debug: center overlay on auto-spawn mount; UX polish + helper unit tests (73214d6a)
- Renderer: make syncSessions HMR-resilient against preload-renderer skew (042913bd)
- Activity: preserve named bg shells; reconcile HMR reasons; async-buffer diagnostics (e78a744c)
- Activity: bump stale-thinking watchdog from 45s to 180s (fd78cf60)
- Activity: eliminate phantom bg-shell counters from watcher adoption (842fc087)
- Sessions: proactive self-heal probe in task detail dialog (76501f7d)
- Activity-debug: stack status pill below title in snapshot row (633e665e)
- Devtools: guard CDP detach against destroyed webContents on quit (b867a01b)
- Activity-debug: always center overlay on first launch (8fe15775)
- Sessions: self-heal SESSION_RESUME when renderer view drifts (25758592)
- Activity: use snapshot health for bg-shell probe-failure detection (f239496a)
- Updater: guard initUpdater on missing app-update.yml manifest (9c38cfaf)

### Other

- Test(e2e): tighten timeout, replace fixed waits with polls, document mock-CLI flake (f74e0708)
- Docs: sync docs to source for v0.19.0 anchors (fc72b5d8)
- Perf(project-switch): warm-cache project state to skip redundant IPC on switch (f57fc62e)
- Perf(activity): cache useMemo on poll-time anchor + long-lived PS probe (c798a9fd)
- Perf(activity): async-buffer ActivitySnapshotWriter (c9eec696)
- Docs(skills): auto-fix findings by default in /code-review (009eed98)
- Perf(renderer): narrow activity subscriptions and stabilize lane task identity (7143ce3d)
- Chore(gitignore): defensively ignore stray agent-CLI bin shims at repo root (32439249)
- Test(pty): disable bg-shell watcher in write-queue tests (69a42bcf)

## [v0.18.0] - 2026-05-06

### Features

- Add OpenCode CLI agent adapter (a17e925)
- Add Qwen Code adapter as 8th supported agent (143d4e4)
- Add Kimi Code adapter with full wire-protocol v1.9 support (d514557)
- Add Factory Droid CLI adapter (4464edf)
- Embedded browser pane with capture-and-send (3670374)
- Browser hardening, settings tab, and unit coverage (186b29f)
- Browser: clear browser data action and shared partition constant (1f97256)
- Unified global search palette (Ctrl+Shift+F) (d8b2b96)
- MCP: expose unified search as kangentic_search_everything (7f0c6d4)
- MCP: route by prompt project cues via instructions block (7ea0499)
- Per-column model/effort overrides with live mid-session swap (dd191b7)
- Per-task model/effort picker popover in context bar (80eb720)
- Per-column UX polish and harden agent CLI discovery (65cadb1)
- Wrap task prompts and handoff context in XML envelopes (07f457e)
- Auto-name tasks and transient sessions from prompt (32b197a)
- Replace EditColumnDialog with unified Edit Columns manager (6e6bc02)
- Tighten Edit Columns layout and click-anywhere toggle card (8f7474c)
- Per-tool stats breakdown and capture pipeline fixes (1045ad5)
- Sync rate-limit pill across all active agents (37ea0d5)
- Display current Claude effort level next to model name (9a24ea1)
- Remember last active task tab per project (7d7d59f)
- Optimistic task delete with snap-back-on-failure (0fe65df)
- Tag spawn/exit/complete analytics events with agent and model (041e878)
- Per-adapter submission evidence in paste engine (721c015)
- Wire BeforeModel/AfterModel/BeforeToolSelection hooks (8d8dcb0)
- OpenCode: hook-based activity stream via plugin (ca4be05)
- OpenCode: wire Kangentic MCP via OPENCODE_CONFIG_CONTENT (b72b4c2)
- OpenCode: map permission dropdown to OpenCode --agent flag (c9462ea)
- OpenCode: detect and surface CLI authentication state (cc8b335)
- OpenCode: warn once when opencode.db schema diverges from verified baseline (c74ccca)
- OpenCode: TUI transcript cleanup for handoff (d2bd116)
- Qwen Code: caller-owned session IDs via --session-id (b68afe4)
- Qwen Code: pre-populate folder trust for spawned worktrees (cd588a0)
- Qwen Code: wire Kangentic MCP server into sessions (d37a558)
- Qwen Code: transcript cleanup for handoff (cb408b1)
- Kimi Code: detect and surface CLI authentication state (f2ac53c)
- Kimi Code: wire --continue flag for resume-latest semantics (1d10dbd)
- Kimi Code: track subagent lifecycle from SubagentEvent envelopes (ada68a7)
- Kimi Code: surface PlanDisplay markdown content in Activity log (3849037)
- Kimi Code: surface HookRequest input_data summary in Activity log (1b139ac)
- Droid: parse session JSONL for the Transcript tab (309302f)
- Droid: surface "no live telemetry" capability (226f333)
- Droid: clean Ink TUI scrollback for cross-agent handoff (668831e)

### Fixes

- Activity: evict stale per-session entries on syncSessions (a890f56)
- Activity: keep tasks active while a backgrounded Bash is running (bd7f27c)
- Engine: suppress Ctrl+C on fresh-spawn auto_command bursts (327486b)
- PTY: serialize writes through per-session FIFO queue to prevent paste truncation (97518c6)
- PTY: release stuck "thinking" after natural bg-shell exit (98be040)
- Session: reconcile stale task.session_id after idle-timeout suspend (b48a48a)
- Git: extend removeWithRetry budget for Windows handle release (05136b8)
- MCP: auto-attach files referenced by absolute path on create_task (d706e9b)
- Codex: stop writing legacy .codex/hooks.json (Codex 0.128 redesign) (ad4b222)
- Qwen: use -i flag so prompts launch the interactive TUI (c6e05c4)
- Kimi: write MCP config to disk to avoid invalid JSON on PowerShell (b30adee)
- OpenCode: reduce exit sequence to Ctrl+C only after empirical verification (fc7be38)
- Prompt: preserve newlines and omit empty sections in task XML (fc13c6d)
- Prompt: break <description> open/close tags onto own lines when multi-line (d35ac17)
- Sidebar: hide activity indicators in collapsed project rail (9ee0a06)
- Command terminal: prevent freeze when opened from Backlog view (a8fd30c)
- Resolve hook cleanup and path separator bugs (5823280)

### Other

- Refactor activity engine + bg-shell watcher + Ctrl+C recovery (c83386e)
- Refactor PTY: unify terminal submission under TerminalSubmit + TerminalSubmitScheduler (4721400)
- Refactor verification: unify submission verifiers under getSubmissionVerifier (76d1abc)
- Refactor usage: generalize SessionUsage.rateLimits as adapter-described array (14db2f5)
- Refactor UI: consolidate click-anywhere toggle into shared <ToggleCard> (de14546)
- Perf: make import-dialog filter input responsive during rapid typing (2b63c32)
- Refresh README and close anchor gaps for v0.18.0 (cc32d03)
- Enumerate per-column model/effort override surface (ac840a5)
- Add OpenCode adapter section with same-cwd concurrency caveat (60c56be)
- Note Qwen Code 0.15.3 incompatibility with OpenAI gpt-5 family (ca50fcb)
- Document Droid MCP setup as manual (63fba34)
- Add real-LLM smoke checklist for OpenCode (e6c3791)
- Unify and refresh doc-auditor anchor list (4b422f0)
- Add Windows PowerShell MCP JSON validator script for Kimi (b9dc034)
- Probe-droid: add Step 8 to probe project-level .factory hooks (5c47337)
- Post-refactor cleanup and per-adapter injection-sequence coverage (a89228a)
- Test stabilization: replace fixed waitForTimeout with conditional polls; fix Linux CI flakes; multiple flake fixes (8b5c539, 2867ccc, 18304ac, e5f0f26, 65df603, 56ccb7c, 517b39e, befd48e, c53e3ea, c559ffb)
- Add E2E session-resume spec for Qwen Code adapter (0456ce7)
- Add concurrent same-work_dir spawn race spec for Kimi (a10bfd6)
- Add UI, unit, and E2E coverage for embedded browser pane (0319caa)
- Add unit assertions for qwen, kimi, gemini, codex, aider, warp display name entries (20f76bf)

### Removed

- The always-visible board search bar (`showBoardSearch` config key) and the in-place row filter above the board columns. Task title/description search is now part of the global search palette. The label/priority filter button moves to a small floating control at the top right of the board.

## [v0.17.0] - 2026-04-24

### Features

- Session-recovery: add Auto-Resume Agents on Restart toggle, prune redundant Behavior toggles (5dedaa0)
- MCP: cross-project tool calls via optional `project` selector (7973237)

### Fixes

- Task-unarchive: symmetric optimistic update to stop snap-back from Done (54f1e17)
- Session-recovery: preserve resume when auto-resume-on-restart is off (22c1344)
- Agent-detect: restore shell PATH on macOS/Linux GUI launches (63900bc)
- Agent-detect: hide cmd.exe flashes during version probes on Windows (82ad4a2)
- Task-card: default running activity to idle when cache is missing (e47055c)
- Task-move: revert task to source column when spawn fails (796fdf2)

## [v0.16.1] - 2026-04-20

### Features

- MCP: add update and delete tools for backlog items (2e34a82)

### Fixes

- Worktree: restore git timeout ceiling for heavy repos (dcf8ea8)
- Worktree: prevent asar handle leak that blocked Windows cleanup (1a80b49)
- Worktree: retry failed Done-task cleanups on project open (18dc8a7)
- Test: stub process.platform so updater-retry passes on Linux CI (e5ef7c5)

### Other

- Perf: parallelize terminal resize and scrollback fetch on mount (6883969)
- Perf: virtualize ActivityLog rendering (4839c4d)
- Perf: shrink withTaskLock scope around slow git and PTY I/O (2173804)
- Perf: batch xterm onData into one IPC write per microtask (c6e1b6b)
- Perf: extract backlog dialogs into sibling component (9ef2ee0)
- Docs: mark Asana as supported import source in README (703ad6f)

## [v0.16.0] - 2026-04-19

### Features

- Agent: GitHub Copilot CLI adapter (61506c6)
- Agent: Warp CLI (Oz) adapter (3f89876, b7e3917)
- Agent: Cursor CLI adapter with stream-json init parsing for agent name and model (451e164, c4dd921)
- Aider: session history parsing, transcript cleanup, and mode-aware idle detection (200cb45)
- Boards: Asana integration with OAuth PKCE and setup wizard (43f309c)
- Activity: detect background shells to prevent false idle state (b6b4d46)
- Sidebar: reimagined project sidebar UX (b82e4e9)
- Sidebar: project counts in header and group rows (ef49d53)
- Sidebar: idle and active task counts per project row (5a391e8)
- Command Bar: ContextBar in overlay with responsive layout (9f8c143)
- Board: redesigned Done column to reclaim worktrees while preserving resumability (dc2a38f)
- Worktree: encode base branch in auto-generated names and surface in task UI (afcf7fc)
- Marketing: Playwright screenshot/video capture framework (cd6d465)

### Fixes

- Startup perf: don't block session recovery on resource cleanup (292fe3b)
- Task-move: clear spawn progress when task moves to To Do (4b737c8)
- Context-bar: distribute overlay row space evenly across pills (17d6129)
- Worktree: kill-on-timeout for git removal ops so queue can't be poisoned (3df1f75)
- Bulk-delete: per-task deadline and visibility to survive git hangs (b08ecf3)
- Board: bulk delete no longer freezes or orphans worktrees (dbc040c)
- Shutdown: remove real node_modules dirs and silence pipe write errors (cf5abcb)
- Board: archive atomically on Done move and restore cursor attachSession binding (5d64625)
- Asana: capture attachments on import and migrate auth from OAuth to PAT (049a4bb)
- Cursor: clear "Loading agent..." spinner in interactive TUI mode (0530a37)
- Updater: stop macOS update failures and silence transient noise (5513c7c)
- Review findings for v0.16.0 release (78c7295)
- Agents: unstick Copilot and Cursor at "loading agent" spinner (6c56ab0)
- Copilot: add `type:"http"` to MCP config so Copilot CLI accepts it (43502b7)
- PTY: swallow EACCES/ESRCH from already-dead PTY kills (199011e)
- Board: prevent completed task from sticking in Done dropzone (0c1c9c6)
- Renderer: render dates in the user's system locale (c7e155f)

### Other

- Perf: board structural sharing, subscription consolidation, agent-event debounce (9eb53d4)
- Perf: keep main-process event loop responsive during bulk delete across all OSes (cc4137d)
- Refactor: IPC tasks.ts split and withTaskLock policy gaps closed (c165977)
- Refactor: move git-detector into src/main/git (39563bc)
- Refactor: address review findings from comprehensive refactor audit (656af6a)
- Refactor: azure-devops html-to-markdown and wiql helpers extracted (fced25f)
- Refactor: git-checks, node-modules-link, fetch-throttle extracted from worktree-manager (eb18971)
- Refactor: decompose session-manager into focused modules (9dd776e, bdbacbc)
- Refactor: split board-store and session-store into slice files (bde5e3b)
- Refactor: split completed-tasks, backlog, task-card dialogs (1251d6c)
- Refactor: split settings, task-detail, manage-labels dialogs (6a11e33)
- Refactor: split board-config-manager, mcp-http-server, session-recovery (e997968)
- Refactor: per-adapter layout for board integrations (80625a1)
- Refactor: tighten move-to-Done dialog copy and visual consistency (54ff0ca, 2fffaa8)
- Docs: testing column discipline added to CLAUDE.md (1e949a5)
- Docs: list all 7 supported agents and rename Warp to Oz CLI (bb42851)
- Docs: update README to reflect multi-agent support and import sources (9eee320)

## [v0.15.0] - 2026-04-11

### Features

- Multi-agent support: Codex CLI, Gemini CLI, and Aider adapters alongside Claude Code (6589b36, 765b6d2, 6079a4c)
- Welcome screen: show all supported agents in detection grid (bef896d)
- Agent-specific permission models with dynamic dropdowns (07d733f, b2fb55e)
- Settings: default agent picker and per-column agent override (64aa5ce)
- Layout settings tab: card density, column width, panel visibility toggles, window restore, animations (68d0411)
- Multi-agent context handoff: pass the prior agent's native session history file to the next agent on column move (b92de92, 335b8bd)
- Changes panel: added to task context menu, Command Terminal dialog, and expand/collapse toggle; auto-selects first file; untracked files visible (0df44c7, ceefed3, 2e2a806, 4224d83, 6806b23)
- Board: Add Column button moved to toolbar with dedicated create dialog (cd17f74)
- Board: confirmation dialog when moving task with pending changes to To Do (c6fe672)
- Command Terminal: fetch + fast-forward pull before spawn (34204d6)
- Context bar: Claude session and weekly rate-limit quotas (df749a5)
- Session state machine: atomic transitions and per-task lifecycle locks with pause/resume race fixes (34970e6, 56dd2ff)
- Session resume for Codex and Gemini (8922312)
- Native session history telemetry for Codex, Gemini, and Claude via `SessionHistoryReader` (ea0564f, 6df12f0)
- MCP HTTP server: in-process streamable HTTP transport replaces the file-bridge (e682b0c)
- MCP tools: `kangentic_get_current_task`, `kangentic_delete_task`, session file/event accessors, unified task creation, rich structured transcripts (39593e5, badbb3b, eafd4c6, a0d21f8, 0ed4a40)

### Fixes

- Context bar always renders with 0% default; no more missing-bar states (6f16949)
- Task card shows "Loading agent..." spinner instead of bare ellipsis while the agent model resolves (276fb09, 19ddd99)
- Task card shows "Pausing agent..." label while suspending a running session (ba8944b)
- Hide uninstalled agents from the per-column agent dropdown (dfcda65)
- Remove version-number noise from agent dropdowns (ff07fc8)
- Welcome screen no longer flashes on app startup (622621c)
- Prevent card from snapping back during the move confirmation dialog (6198599)
- Hide the Agent section in Edit Column for To Do / Done columns (f61ff03)
- Window restores maximized state on launch instead of a half-width bounds (35bae8d)
- Spinner animations no longer freeze during drag operations (0eed804)
- Diff viewer: fix crash when selecting a file (851df64)
- Diff viewer: remove `@monaco-editor/react` from Vite optimizeDeps to fix a `useState` crash (5bb2e08)
- Diff viewer: eliminate flicker when the Changes panel is open alongside the terminal (3add42d)
- Diff: prefer origin ref in `getMergeBase` to avoid stale local branches (f3aa1d0)
- Compare: honor the project's `defaultBaseBranch` instead of a hardcoded `main` (fd48709)
- PTY: preserve scrollback across session resume (regression from b8385ca) (1302772)
- PTY: await process exit before worktree removal to prevent freeze (8eab0fe)
- PTY: suppress idle -> thinking flicker after resize-induced redraws (affdbfa)
- PTY: ring-buffer content dedup to handle placeholder rotation and normalize whitespace for resize redraws (5e653fd, df59041)
- PTY: unstick Codex and Gemini task cards on first output (5f890a1)
- PTY: eliminate activity watcher stale/recover loop (381a3e2)
- Codex: unwrap `event_msg` envelope so context usage updates (373211e)
- Codex: replace `detectIdle` with silence timer + content dedup, filter TUI noise (c351ec1, 3c52220)
- Codex: wire `statusFile` hook and session history E2E coverage (48f2f4f)
- Gemini: resolve model name never appearing on task card (8d13dd5)
- Gemini / Codex: standardize hook lifecycle and status display (8be7d0d)
- Gemini / Codex: reliable session-ID capture (1e226ae)
- Claude: drop session-history live telemetry to stop model flash (ba31ef5)
- Claude: detect CLI installed via Homebrew (155ae05)
- Claude: detect CLI version on Windows via shell-aware `execFile` (d31951a)
- Agent: surface override path failure instead of silent fallthrough (3874ca2)
- Agent: eliminate DEP0190 deprecation warning from detectors (b0d43f9)
- Activity state machine: unwedge permission idle inside subagents (47b8e5b)
- Spawn: optimize task-move to agent-spawn latency (45e9253)
- Project switch: feels instant (ef7eb4d)
- Terminal: suppress background-session IPC to eliminate typing lag (47b8e5b)
- Terminal: include Command Terminal in focused-session set for live PTY data (9b564b2)
- Task: copy task ID as `Task #N` for better MCP context (18d94e1)
- Task detail: truncate long titles so header commands always fit (cb1f441)
- Notifications: label Command Terminal idle sessions and reopen overlay on click (000b525)
- MCP: stop wiping in-flight commands on bridge start (b75f8fe)
- MCP: route "create a todo task" to board instead of backlog (06e153b)
- MCP: align session-bridge directory and wire new tools (b28c662)
- Analytics: fix Aptabase average duration showing 0s (b2685b2)
- Updater: retry once on transient network timeout before reporting error (29bbf32)
- Stores: add hydration gates to board and backlog stores (5c5de90)
- Engine: use task's original agent on session resume (1d99c4e)
- Engine: resolve default agent from detected agents instead of hardcoding Claude (8ae5604)
- Engine: Command Terminal uses project default agent (dd824d3)
- Settings: refresh `currentProject` after changing default agent (55d0439)
- Settings: preserve terminal settings when merging partial project overrides (faaa843)
- UI: deduplicate provider name in import source labels (a9183ec)
- HMR: preserve terminal state, transient session pointers, Command Terminal open state, `moveGeneration`, and `syncController` across refreshes (b72cae6, 7df679a, 60ffc44, d244dc3)
- Code review follow-ups: session-file-watcher uses `fs.rmSync` with `{ recursive, force }`; Gemini hook writes are reference-counted so concurrent sessions no longer clobber each other; `EditColumnDialog` / `ActivityLog` / `SettingsPanel` dropdowns use the shared `Select` component

### Refactor

- DB: rename `claude_session_id` -> `agent_session_id` (9850726)
- Config: rename `AppConfig.claude` -> `AppConfig.agent` with per-agent CLI paths (53516ad)
- Engine: use agent adapter instead of hardcoded Claude in transition engine (15c13ea)
- PTY: use agent adapter for status/event parsing in `UsageTracker`; trust Claude Code's `used_percentage` directly (ddd6ce8, 0b1f90b)
- Agent: reorganize adapters into per-agent subfolders (`claude/`, `codex/`, `gemini/`, `aider/`) (dc8d2b0, 2b4f4a7)
- Agent: extract `ActivityStateMachine` from `SessionManager`; move hook telemetry into `runtime.statusFile` (47b8e5b, f0805e0)
- UI: replace hardcoded `claude` strings with `DEFAULT_AGENT` constant and `getAgentDisplayName` utility (d2034e6, aade3c3)
- Session: consolidated `spawnAgent` helper for unarchive / session resume (1724cd4)
- Settings: move session limits from Agent tab to Behavior tab (4ecfc51)
- Board: hide agent section in Edit Column for To Do / Done columns (f61ff03)

### Other

- Deps: upgrade core dependencies to latest stable (03b8747)
- Tests: add Codex and Gemini agent-parity E2E specs + `ActivityStateMachine` unit tests (7d6bb41)
- Tests: speed up E2E suite 36% and replace branch-rename E2E with unit tests (0dd683b)
- CI: prevent partial releases and fix macOS build OOM (27c2f5b)

## [v0.14.0] - 2026-04-01

### Features
- Support Ctrl+V paste for images and shell-aware path quoting in terminal (5c3d5dd)
- Show git diff viewer for all tasks with persist panel state and kebab menu (9790d57)
- Add git diff viewer to task detail dialog (9065b5a)

### Fixes
- Format currency with thousands separators (129abd6)
- Emit exit event for killed queued sessions and add session reset (f86523f)
- Constrain rawBody to prevent header clipping in dialogs (61fd2fc)
- Use merge-base for branch-only diffs, move Changes to pill row (3accbf0)

### Other
- Extract AgentAdapter interface and registry (bc89c35)

## [v0.13.1] - 2026-03-31

### Fixes
- Send newline instead of carriage return for Ctrl+Enter in terminal (114e8c9)

## [v0.13.0] - 2026-03-31

### Features
- Add @-mention file autocomplete to description editors (4455387)

### Fixes
- Eliminate terminal truncation from resize/scrollback race (b8385ca)
- Clear stale pendingCommandLabel when user-paused task is moved (2dd36cb)
- Hide header shortcut pills that overflow instead of clipping (a9eca21)
- Don't auto-resume manually paused tasks on column move (e759dbc)
- Command palette dropdown not visible in Command Terminal overlay (fdf5a24)
- Address PR review feedback for file mention autocomplete (4da56dd)

## [v0.12.2] - 2026-03-26

### Fixes
- Shorten worktree slug names to avoid Windows MAX_PATH limit (28b9fdb)

## [v0.12.1] - 2026-03-26

### Fixes
- Crash on Git tab when project overrides use partial config (1e25c2b)

## [v0.12.0] - 2026-03-26

### Features
- Add backlog view for staging tasks before the board (85b3c8b)
- Background transient sessions with reattach support (6dcfa45)
- Right-click context menus with move, edit, delete, archive on board and backlog (caadf15)
- Use column color for drag-and-drop drop target highlight (33dc140)
- Support paste/drop of any file type as attachment (edc5757)
- Fix MCP schema serialization, add attachment support, and file drop-to-terminal (759f585)
- Double-click backlog row to open edit dialog (7e8379e)
- Add copyable task display ID to board and MCP (f3d8770)
- Wire up attachment persistence for backlog items (38c1d24)
- Add external MCP command bridge for preview isolation (0648766)
- Add copyable display ID to task edit dialog header (3e0384e)
- Allow drag reorder while filters or search are active in backlog (544c652)
- Add color support to backlog label creation via MCP (02d209f)
- Carry labels and priority from backlog to board tasks (a262cd2)
- Add markdown rendering for task descriptions (3dae7e8)
- Import tasks from GitHub Issues and Projects (6a533a2)
- Show priority badge in task detail dialog header (8f3b2b0)
- Replace auto-focus idle sessions with amber tab indicator (ad5625a)
- Add label and priority editing to board task forms (65599bd)
- Add label and priority filtering to the board view (49fd4b2)
- Move Labels/Priorities into board header row (4f8b7ca)
- Add Azure DevOps as an import source (9f59872)
- Fetch Azure DevOps comments and file attachments (0c3b43d)
- Mention import option in empty backlog state (a0b3f7a)
- Add usage stats time period dropdown to status bar (7aad7f4)

### Fixes
- Replace native select with custom popover and fix metrics persistence in status bar (e7281c2)
- Support UNC paths for SMB network share projects (9f92295)
- Add fallback spawn to ensure all promoted tasks get agents (8d54da0)
- Make context menu paste consistent with Ctrl+V path (d5b4386)
- Make backlog promotion instant with deferred agent spawn (56be2da)
- Pass AbortSignal through SESSION_RESUME to prevent stale spawns (1c4f879)
- Pass AbortSignal through promotion async chain (408e279)
- Include config-defined labels in autocomplete suggestions (9a2e451)
- Make backlog context menu respect multi-selection (d327f4e)
- Cancel in-flight session spawns when task is moved back quickly (bb88ff8)
- Prevent large paste truncation with chunked PTY writes and bracketed paste (eeb4e29)
- Make xterm cursor transparent to prevent flickering (4028d68)
- Preserve command terminal across project switches (50fc1e5)
- Hide entire search/filter row when Ctrl+F dismisses it (d677241)
- Enable core.longpaths for worktree creation on Windows (85ea878)
- Sync backlog store after MCP create/promote operations (9558d41)
- Clean up transient session state on stop and add idle indicator (0fcc344)
- Unblock CLA assistant on protected main branch (c0d5256)

### Other
- Consolidate spawn fallback into single spawnAgent primitive (3845165)
- Update all documentation for v0.12.0 and consolidate /sync-docs skill (48f3260)
- Move time ago to its own line below labels on completed cards (4758dfd)
- Replace generation counter with AbortController in syncSessions (7e30695)
- Rename BacklogItem to BacklogTask across codebase (727dee4)
- Extract shared DescriptionEditor component (1760a89)
- Extract auto-spawn into shared function for external bridge (e6c2b85)
- Decompose large single-file modules into focused submodules (bc1739b)
- Add gh pr permission to project settings (ab001c8)
- Use wildcard MCP permissions instead of individual tool entries (b3e1bb4)

## [v0.11.0] - 2026-03-23

### Features
- Auto-detect PR URLs from terminal output and link to tasks (ed7ab0f)
- Add ephemeral Claude Code terminal overlay (8c96252)

### Fixes
- Remove overflow-x-auto from header pills to unclip command popover (6cddaf1)
- Fix Done column bleed-through, task detail header layout, and completed task view (8f905f4)
- Fix summary view overflow, git stats, and Done column layout (6267979)
- Support right-click paste in xterm terminals (4ec2088)
- Update session-queued-status test for push-based session sync (5029b85)

### Other
- Lift shimmer overlay on alternate screen buffer detection (09fcc72)
- Reduce heartbeat interval from 5min to 60min (6af07c0)
- Add fade-out gradient to Done column completed tasks (4231cd4)

## [v0.10.0] - 2026-03-22

### Features
- Expose Kangentic board API via MCP server for Claude Code agents (c8f1c3b)
- Add "Copy Image" to right-click context menu for image attachments (4b3072a)
- Show action buttons on selected project and add context menu with rename (0915525)

### Fixes
- Restore F12 and Ctrl+Shift+I DevTools shortcuts in dev mode (40278e6)
- Persist queued status in SessionRecord instead of lying about running (1792be1)
- Escape PowerShell special characters in CLI prompts (032ac02)
- Deterministic worktree cleanup with correct junction removal on Windows (3d99544)
- Remove node_modules junction before recursive cleanup (9c155b6)
- Auto-rebuild native modules after npm install (24bc64d)
- Use full removeWorktree in createWorktree pre-cleanup (f965abb)
- Clean stale worktree resources for backlog tasks on startup (514236a)
- Serialize trust manager writes and reserve session slots during spawn (bab5184)
- Enable Ctrl+C copy and Ctrl+V paste keyboard shortcuts (5f82374)
- Move @aptabase/electron from devDependencies to dependencies (0c40aca)
- Serialize git operations and recover stale branches on backlog move (085d6e4)
- Drain buffer in getScrollback to prevent duplicate terminal history (f22f0cf)
- Revert task move on duplicate branch detection (05c20c0)
- Resolve aptabase module errors and fix stale unit tests (48eca32)
- Register suspended placeholders for user-paused sessions on restart (8785177)
- Reuse session ID on queue promotion to prevent stuck "Starting agent..." (77ce0d0)

### Other
- Push-based session sync to replace ad-hoc mechanisms (226f4d0)
- Caller-owned session IDs to prevent queue ID mismatch (955908c)
- Split tasks.ts handler into task-crud, task-move, task-branch (2d35a13)
- Deliver MCP server via --mcp-config flag instead of .mcp.json injection (cfbd0f2)
- Extract PtyBufferManager, SessionFileWatcher, UsageTracker from SessionManager (a3b6c2d)
- Split board-store into Zustand slices (3d602e6)
- Extract useBoardDragDrop and useBoardSearch hooks from KanbanBoard (66ef063)
- Extract ProjectListItem, GroupHeader, and context menu from ProjectSidebar (160e12a)
- Extract TaskDetailDialog into focused components and hooks (01f422a)
- Rename "Commands & Skills" to "Commands" and auto-size kebab menu (57c2696)
- Migrate ESLint 8 to 9, upgrade commitlint and minor deps (ca1ad07)
- Add MCP server documentation and fix anchor gaps (76251df)
- Update developer-guide structure and fix branch naming in user-guide (3672382)
- Add gh issue permission to Claude settings (859bf62)

## [v0.9.1] - 2026-03-18

### Fixes
- Bundle @aptabase/electron via esbuild alias to fix packaged builds (59f1d84)
- Ensure spawn-helper has execute permissions on macOS (5e579be)
- Prevent garbled TUI output on scrollback replay at wrong width (e2e4102)

### Other
- Allow start command in project permissions (e300ade)

## [v0.9.0] - 2026-03-18

### Features
- Convert commands to skills and add skills to palette (bd0abed)

### Fixes
- Prevent zombie processes by sharing shutdown flag across spawn paths (2eeab4f)
- Prevent sidebar toggle from resizing bottom panel (4c292a9)

### Other
- Upgrade GitHub Actions to node24 versions (4d879ba)
- Auto-open releases page after /release push (529fe31)

## [v0.8.0] - 2026-03-18

### Features
- Make backlog move destructive and add full branch config to edit (c63c6fe)
- Add custom branch name support for tasks (00e8b38)
- Add defaultBaseBranch to team-shared kangentic.json (12b66b0)

### Fixes
- Skip prompt template when starting tasks from non-backlog columns (2f7d58e)
- Prevent terminal color corruption from scrollback replay (03103f7)
- Add CWD validation and enhanced diagnostics for posix_spawnp failures (ee34e07)
- Preserve task detail dialog across board reloads (6dca5c4)
- Preserve scrollback on resume and fix garbled terminal handoff (fba13e8)
- Replace platform-specific version checks with cross-platform version marker (abc7863)

### Other
- Remove confirmation prompt from /test write mode (785cdc7)

## [v0.7.1] - 2026-03-17

### Fixes
- Restore IPC init order and add idempotency guard (a204b9b)

## [v0.7.0] - 2026-03-16

### Features
- Add project grouping with collapsible sections in sidebar (303c9fa)
- Add heartbeat event for session duration tracking (7912d6a)
- Add Visual Studio preset for Windows keyboard shortcuts (2d68f5d)

### Fixes
- Checkout selected branch for non-worktree tasks (e7fcc01)
- Prevent IPC double-registration crash and harden cross-platform support (e052be0)
- Prevent session resume for tasks in the backlog (740f9f9)
- Always pre-populate trust for agent cwd including demo mode (4529a12)

### Other
- Add YouTube demo badge and watch demo button to README (7e509a9)
- Fix publish-npm job skipped on tag-triggered releases (81c911f)

## [v0.6.0] - 2026-03-15

### Features
- Add /pull-request command and fix /merge-back branch docs (b9b6f9a)
- Add --demo flag for ephemeral demo mode in launcher (5756ae7)
- Add muted Project/System section headers to settings tab sidebar (3b32350)
- Add ability to switch base branch or enable worktree after task creation (8d91e6d)
- Add search bar for filtering tasks across columns (0ecb713)
- Redesign Done column with capped preview and enhanced completed dialog (b67647c)
- Restrict "Add task" button to Backlog column only (207d895)
- Add Completed Tasks dialog with sortable data table (1d9af35)

### Fixes
- Remove @xterm/addon-fit from Vite manual chunks (2ecf94f)
- Improve terminal panel collapse/expand and drag-resize behavior (f39b9f8)
- Capture metrics before suspend in auto_spawn=false and auto_command paths (644817c)
- Close task detail dialog on save instead of returning to view mode (5fa1533)
- Prevent completed date wrapping and expand title column width (62847fc)
- Skip scrollback carryover on resume to prevent duplicated terminal output (5723d83)
- Compute timeline/duration from task creation, aggregate multi-session metrics (3ce4fc3)
- Skip kangentic.json write-back when content is unchanged (b2fcb32)

### Performance
- Optimize drag-and-drop for smooth 60fps interaction (4957f52)

### Other
- Improve CLA with version, third-party clause, and narrower scope (86e4cf9)
- Replace .clabot with CLA Assistant GitHub Action (c92bad4)
- Reorder task detail header pills so Commands appears before Worktree (66d387f)
- Rewrite README features section for product launch (975c54d)
- Replace @xterm/addon-fit with custom FitAddon and simplify resize (fc330e9)

## [v0.5.0] - 2026-03-14

### Features
- Add configurable shortcuts to task detail dialog (ea4597d)
- Show contextual status labels on task card during command invocation (2f3d176)
- Add quick-access Claude commands popover (3352590)
- Add session summary panel and metrics to completed tasks (247cc99)
- Add mechanical doc-auditor agent and anchor-based verification (6777b8a)

### Fixes
- Preserve scroll position when fit() reflows during user scroll (e5c51c4)
- Skip fit() when user is scrolled up to prevent viewport jump (ad41dad)
- Distinguish manual resume from auto_command transition in overlay label (13c2e9e)
- Show auto_command label instead of generic "Resuming agent" on transition (920520b)
- Prevent "Rendered more hooks" crash when archiving from detail dialog (337b83a)
- Prevent false idle during Claude Code nucleation (0390d5e)
- Use bare file paths for image attachments instead of bracketed format (843f31c)
- Prevent false idle during long-running tool executions (dddd2ee)
- Only suspend/resume session when target column has auto_command (eb25839)
- Prevent viewport from snapping to top on fit/resize (c302061)
- Show resume label instead of auto-command when resuming a paused session (e6e74e6)
- Eliminate flaky Electron launch failures on Windows (484e58c)
- Re-register IPC listeners after store replacement (d2077bb)
- Suppress false "config changed" dialog with content hashing (f24dade)
- Keep skills and agents in worktree checkout (7157a3c)
- Gate npm publish on build success and remove duplicate workflow (174cfea)
- Use correct Lucide icon name for TortoiseGit Commit preset (b592e94)

### Other
- Align permission modes with Claude Code CLI (b9c938b)
- Remove Global/Project scope toggle, unify settings panel (089b2b4)
- Stack compact done card into two rows (096fb67)
- Show title + description on compact done cards, remove cost badge (d586aaa)
- Reduce animation overhead when launching multiple agents (b1db038)
- Reduce visual noise in terminal loading shimmer (37c6c0c)
- Upgrade vite 7, electron-builder 26, fix all vulnerabilities (2df94ae)
- Add auto-commands to Code Review and Tests columns (98dd6b1)
- Update project settings and code review conventions (52fff39)
- Add argument-hint to /preview command frontmatter (c683225)
- Add shared Pill component for consistent pill/badge styling (3fb5e4b)
- Migrate remaining pill buttons to shared Pill component (e22cc55)

## [v0.4.0] - 2026-03-12

### Features
- Add shareable board config via kangentic.json (bf48665)
- Auto-export kangentic.json on project open and add ephemeral mode (be991a9)
- Add permission mode guard and shimmer overlay for column transitions (d34002f)
- Add search bar to settings panels (64e3585)
- Persist user-paused sessions across app restarts (13864f7)
- Add configurable context bar element visibility (894bd49)
- Add 5 custom Claude Code agents for proactive validation (c29eca2)

### Fixes
- Detect stale thinking state after Ctrl+C interruption (2343a8e)
- Close existing task detail dialog on notification click (03065f7)
- Resolve intermittent UI test failures from Vite startup race (09eace9)
- Show toast instead of inline error when deleting column with tasks (13b4f5f)
- Use shell-aware quoting in quoteArg to prevent $var expansion (95f79f6)
- Use same-permission columns in session survive E2E test (9364fcc)

### Other
- Unify settings panel with VS Code-style scope tabs (defdb58)
- Remove sync dialog, snapshot defaults on project create (f427a2d)
- Comprehensive documentation update for v0.4.0 (2916d35)

## [v0.3.1] - 2026-03-10

### Fixes
- Bundle electron-updater instead of marking it external, fixing "Cannot find module" crash on launch (9a1f5e9)

## [v0.3.0] - 2026-03-10

### Features
- Auto-spawn agent when creating task in auto-spawn column (8a9e6df)
- Improve first-launch experience with welcome overlay and git detection (69caf9a)
- Add Notifications tab, terminal options, idle timeout, and window restore (78d7078)

### Fixes
- Add cold Vite cache message to dev startup (8a01c93)
- Suppress welcome overlay flash during config store re-sync (5fb17d7)
- Re-sync all IPC-backed stores after Vite HMR update (3f95493)
- Suppress bottom panel switch when Task Detail dialog is open (3bd5cff)
- Include output tokens in context window percentage (9ce3891)

### Other
- Shrink task detail dialog during edit mode (3dacac3)
- Remove dead kgnt CLI entry point (e97d2d9)
- Center project name in title bar (f36d27b)
- Restructure header branding, sidebar collapse, and version badge (ac5f868)
- Documentation updates and README improvements (bc09a13, 2f457a1, eb80fdb, 6587722, 03d7b52)

## [v0.2.0] - 2026-03-09

### Features
- Auto-update via electron-updater (813cf91)

### Other
- Tolerate already-published versions and update CLI docs to npx (942a2fd)

## [v0.1.0] - 2026-03-09

### Features
- Cross-platform desktop Kanban board for Claude Code agents (cb97509)
- Session persistence, drag-and-drop, and worktree config propagation (9c0f4e5)
- Context usage tracking, status bridge, and toast notifications (e721367)
- Kebab menu, archive flow, wildcard transitions, and UI hardening (71fbbaf)
- Consolidated runtime data under .kangentic/ and session suspend (6463c83)
- Hook-based activity log replacing aggregate terminal (bbe0828)
- Image attachment support for task dialogs (1b2945c)
- Worktree preview system (b1f4156)
- Multi-theme support with semantic color tokens and light/dark/system switching (f178afa)
- 8 named color themes with per-theme accents (1b5f7d1)
- Token usage display in task detail and app footer (fc1a2f9)
- Per-task worktree override toggle (7278ecf)
- Auto-command feature for swimlane columns (6a6f78e)
- Persistent project reordering via drag-and-drop in sidebar (2434ad0)
- Desktop notifications for idle agents with settings toggle (8611522)
- Native Electron desktop notifications (e7c998c)
- Anonymous usage analytics with Aptabase SDK (97416c5)
- App version display in StatusBar (c80dd44)
- App crash and error tracking in Aptabase (6a2d314)
- Auto-open last activated project on launch and welcome screen (37cb331)
- Split settings into App Settings and Project Settings panels (a886253)
- Window control buttons (minimize, maximize, close) in titlebar (b4dee00)
- Per-project config overrides with global/project settings scope (f11f20e)
- Resizable sidebar with auto-collapse (2fbfabc)
- Agent skills and commands for session lifecycle, IPC bridge, and cross-platform knowledge (01e8b24)
- Deployment pipeline: npx launcher, code signing, CI matrix (4628ece)

### Fixes
- Synchronous shutdown to eliminate zombie processes and auto-restart (53f656f)
- Disable auto-updater to prevent phantom relaunch and zombie processes (6d22bf0)
- Cross-platform hardening for alpha release (3c7ebaa)
- Task card stuck on Idle after permission prompt during subagent work (8a37a69)
- Drag-and-drop grey screen crash with error boundaries (f31b97c)
- Session recovery re-entrancy bug (8dda8a1)
- Idle vs active state race condition (f54419f)
- CLI option parsing for prompts with ->, --, and double quotes (3115f0d)
- Terminal resize hardening and onData race condition (82132da)
- Context window progress bar showing inflated percentages (815a702)
- Startup pruning to remove all ephemeral worktree projects (211efc0)
- Notification icon quality and app name on Windows (51a20bd)
- Windows taskbar icon showing Electron logo instead of Kangentic (03621f7)
- Packaging: bundle native modules and bridge scripts for distribution (244dd15)
- Packaged app: unpack bridge scripts from asar for external node processes (634ac9d)
- Desktop notifications: title, task name, and click-to-open (0c54757)
- Permission idle suppressed during subagent execution (4373120)
- SyncSessions race condition causing stale idle/active state (85f9f51)
- Confirm dialog Enter key freezing UI and stale archived tasks reappearing (bcd81c6)
- Stale Initializing state when moving task back to Backlog (e74fb7a)
- Idle-to-thinking delay after answering AskUserQuestion/ExitPlanMode (b4966d6)
- Drag-and-drop oscillation by removing visual cross-container transfer (cd7b40c)
- Session lookup divergence causing blank terminal in task detail dialog (b376b44)
- Activity recovery from false idle after permission approval in subagents (c5050b6)
- Context % accuracy matching Claude Code TUI using floor division (aedd5ad)
- Notifications: prevent GC of click handler and restore minimized window (c2d6089)
- Suppress false-positive stale warnings during startup grace period (7762085)
- Context usage display after HMR matching Claude's rounding (44a0117)

### Performance
- Reduce installed bundle size from 401 MB to ~293 MB (699dccb)
- Startup instrumentation and parallelize session recovery (70a72e6)
- Speculatively preload project during renderer load (517661e)
- Vite: warm up renderer module graph before Electron launch (f3c823e)
- Vite: pre-declare renderer deps in optimizeDeps.include (95eab70)
- Disable analytics in dev to avoid HMR phantom sessions (bb9675f)
- Electron app startup time improvements (a441122)

### Other
- Comprehensive documentation suite (fcb0323)
- Automated documentation maintenance via /update-docs (9769a0e)
- Switch license from MIT to AGPLv3 with CLA for dual-licensing (85257fc)
- Redesign README with branded hero and tech badges (6d1d604)
- Declutter root directory for cleaner GitHub landing page (5d23473)
- Redesign release strategy with conventional commits and CI (5022326)
- CI workflows for build and release (af82656)
- Production readiness cleanup (fcff489)
- Comprehensive test suite: unit, UI, and E2E tiers (436e96e)
- Auto-populate draft release description from RELEASE_NOTES.md (426a69d)
