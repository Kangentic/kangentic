# Activity detection

## Engine and events

* [Activity engine](activity-engine.md) - How Kangentic decides a session is thinking, idle or in permission: the hook-to-ActivityEngine pipeline, ActivityState and ActivityReason, the kind of a wait (question or approval), strategy variants per adapter, the 400ms stability window, heartbeat recovery and idle provenance, Ctrl+C synthesis, the open-work ledger, the debug overlay and trace labels.
* [Activity event types](event-types.md) - The 27 EventType values with their JSONL names and ActivityState mapping, the plan approval gate that holds permission idles, idle_hint turn endings, the onTurnEnded, turnStartedAt and workSerial contract, and turn_failed and turn_retrying recovery layers A to D.

## State rules and recovery

* [Activity predicate](predicate.md) - The single predicate that derives thinking, permission or idle from turnActive, subagent depth, background shells and the permission flag, with the subagent id ledger, the transcript rejection poll, tool stack matching, internal CLI agent tool events and the idle clamp.
* [Activity watchdog](watchdog.md) - The five WatchdogHold safety nets that reclaim a stuck thinking state: named bg-shell cap (5 min), anonymous grace (30s), stale-thinking (180s, 30s when heartbeat-forced), stuck-pending-tools and stuck-subagent, their timer anchors, parkedAnchor and parkedWhen, and how to add a hold.
* [Background shells](background-shells.md) - How a backgrounded shell holds a task thinking: named versus anonymous tracking, opting a service out with --kangentic-no-activity-hold or kangentic_mark_background_service, and the BgShellWatcher's Tier A PID exit, Tier B count heuristic, transcript drain and output-file liveness.
