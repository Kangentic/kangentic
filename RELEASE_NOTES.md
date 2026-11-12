## What's New

- The desktop now gives a paired phone what it needs to resume a task the idle timeout paused when you open it, and to show a queued card's place in line. Cards on the phone can also show the stopped mark, priority, links and why a task cannot start yet. The phone shows these once the mobile app adopts them.

## Bug Fixes

- A column override in `kangentic.local.json` no longer gets written into the shared `kangentic.json` when a project opens, so a personal override stays personal. Editing `kangentic.local.json` while the project is open now applies at once.
- A second Claude Code account no longer asks for permission each time it writes a plan file or an auto memory, and a resumed conversation brings its plan file to whichever account it runs on.
- A Move to column message no longer disappears without a trace. It stops waiting after 120 seconds of quiet, and the automation's run detail says whether it was received, held, replaced by a later move, or failed.
- A background shell that exits right away no longer leaves a turn-end move waiting until the agent marks the shell by hand.
- The restart confirm dialog's icon is the same size as every other confirm dialog's.
