# Renderer

## State

* [Zustand stores](stores.md) - The renderer's Zustand stores: BoardStore optimistic moves, move generations, lane pins and the move-confirm queue, SessionStore dialogSessionIds terminal ownership and project-switch cleanup, ConfigStore theme and agent inventory, Backlog and Toast stores, and the HMR instance pins.

## Windows and marks

* [Command Terminal](command-terminal.md) - Why the Command Terminal is a second window-manager layer with main-owned slots, why it ends when its agent exits, naming in main, phone starts, leftover reaping, per-project branch and geometry, the two title-bar buttons, and the sidebar indicator.
* [Activity marks](activity-marks.md) - Why the nine activity glyphs live upstream in @kangentic/branding, why motion must be composited, the cascade and swallowed-click incidents, why the OS reduced-motion preference never stops motion, mark sizing, color, and what stays lucide.
