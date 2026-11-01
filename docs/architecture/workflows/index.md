# Workflows

## Main process

* [Workflow engine](workflow-engine.md) - How the workflow engine runs linked tasks: the pure core and its main-process host, wake-ups coalesced to 150 ms with no polling, the boot probe that opens only boards a workflow touches, starts as handleTaskMove with origin workflow, step checks and the recovery of a step that did not finish, the memory gate its nudges wait in, the memory resume of paused tasks, the hung-turn check, the move lock, one task's own hold, and project-delete cleanup.
* [Workflow agent](workflow-agent.md) - The transient session that plans a workflow: which agents qualify (per-session MCP, resumable ids), its read-only MCP scope, why there is no fallback to the project agent, start-over from the saved plan, and how its first message, model and effort are read on every start.

## Renderer

* [Workflows view](workflow-view.md) - How the Workflows view is built: the lazy third BoardView that keeps @xyflow/react out of the eager bundle, the React Flow canvas, inspector and agent pane components, the single workflow-store, and how main's move lock is asked on the board so a refused card never slides.
