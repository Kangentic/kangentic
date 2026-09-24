## What's New

- **The web demo on kangentic.com shows more of the app.** New scenes cover resuming a paused session and dictating into a text field, the Browser scene's page now looks like a real website, and a paused session resumes on the frame it stopped on. Terminals fill their panes at any size instead of leaving an empty band beside or below the output.
- **The release poster set is shot in Roboto.** The runner used to fall back to Liberation Sans, which has no medium weight and set some labels 17 percent wider than Segoe UI. The zip's manifest now also records each poster's focus area for the docs site.

## Bug Fixes

- Browser pane screenshots came back tiled after an agent set the viewport on a docked pane, and an explicit device scale factor of 1 was sent and reported as 2.16. Captures now stay within what the pane can draw, and element screenshots clip the right region on zoomed or scrolled pages.
- Some web application firewalls block any user agent that carries `Electron/`, so pages rendered unstyled in the Browser pane while Chrome showed them correctly. The pane's user agent drops that token and keeps `Kangentic/<version>`.
- A resumed session switched from "Resuming agent..." to "Starting agent..." at its first output, which looked like the resume had failed. It now stays marked as resuming.
- The All columns table in the Column Manager clipped labels such as "Plan (Read-Only)", because every column got an equal tenth of the width. Columns now take their intended widths, and a value that still does not fit ends in an ellipsis with the full text as a tooltip. Model and Permissions use each column's own agent's labels, so Codex reads "gpt-5.5" rather than "Gpt 5.5".
- On the welcome screen, a signed-out agent's "Not signed in" line wrapped into three lines over the agent's name. A signed-out agent now leads the grid and spans its full width.
