---
type: Guide
title: Command Terminal
description: "The ephemeral Command Terminal window layer (Ctrl+Shift+P): opening, hiding versus stopping, up to four numbered windows per project, the branch picker, why a terminal ends with its agent, phone-started terminals, and what survives a project switch."
tags: [command-terminal, windows, branch, ephemeral]
sources:
  - resource: src/renderer/components/command-bar/
---
# Command Terminal

The Command Terminal provides quick, ephemeral access to Claude Code without creating a task on the board. Useful for one-off actions like creating releases, running queries, or any ad-hoc interaction.

**Opening:** Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS), or click the terminal icon in the title bar (the left-most icon in its right-hand button row). The same button **toggles** the layer closed again, so there is always a one-click way to hide it, even when a window is maximized. The terminal icon reflects activity across your open terminals: its prompt blinks in green while an agent is working, it holds a steady warm amber when one needs your input, and it stays plain when idle.

**Behavior:**
- Spawns Claude Code at the project root on the configured default base branch. If you have uncommitted changes to tracked files on another branch, a new terminal stays on that branch and tells you so, rather than carrying your work onto the base.
- It opens as a **window** over a slight backdrop blur: drag it by the header, resize it from any edge or corner, maximize / restore it (double-click the header or use the maximize button), and snap it to a screen half or full screen (Windows-style). The layout (size, position, maximized state) **persists globally** across all projects and app restarts.
- **Run more than one at once.** While the layer is open, a second terminal icon (with a `+` in its center) appears in the title bar just to the left of the main terminal icon - click it to open another terminal (up to four per project, counting any a paired phone started); it disables once you hit the cap. New terminals split into the current window's footprint (side by side, keeping the size you set) so you can keep two ad-hoc tasks cooking and glance between them; drag the seam to rebalance, or maximize one to focus it.
- **Each window is numbered.** A terminal titles itself `Command Terminal 1`, `Command Terminal 2`, and so on, from its durable window slot - so two side-by-side terminals are tellable apart, and the number stays put when a sibling opens or closes. The same title identifies that terminal on its Agent Monitor row. With Claude Code or Kimi, once you send a first prompt, the title becomes a short auto-derived name for what you asked instead; other agents keep the numbered title.
- **Layout controls (same as task windows).** When a terminal is tiled, a **pop-out** button floats it back out of the tile group. The title always wins the header's space: the quick-action pills (Commands, Project, Changes, shortcuts) fold into the `...` menu as the window narrows.
- The **branch picker** in the header lets you switch branches - selecting a new branch kills that terminal's session and respawns it on the selected branch. The pill names the branch the checkout is actually on: it is re-read from git whenever you reopen the layer and whenever the checkout moves (an agent running `git checkout` inside the terminal, or your own git usage), so it never keeps claiming a branch the repo has left. Reopening never checks anything out.
- The terminal's **Changes** panel measures ahead/behind, and diffs its Branch tab, against the project's default base branch, the same base the pill's default names.
- **A terminal ends when its agent does.** Type `/exit`, or let the agent crash, and the terminal ends and its window closes within a few seconds, so you are not left at a bare shell prompt (under WSL, `/exit` ends the terminal about 5 seconds later). `/clear` keeps the terminal. Anything its agent started in the background (a dev server, a watcher) is stopped about 5 seconds after the terminal ends and listed in the leftover-processes toast, the same as when a task finishes; with **Stop Leftover Processes** off it is only listed.
- **No pause ends a terminal.** The **When idle** and **When memory runs low** pauses both skip Command Terminals. A terminal has nothing to resume from, so a pause would end it and lose its conversation.
- **A paired phone can start and stop terminals too.** A terminal the phone starts in the project you have open gets its window the next time you open the layer; the title-bar icon counts it right away.
- A shimmer overlay shows while Claude Code initializes, then lifts to reveal the clean TUI
- Command Terminals are independent of task sessions: they don't appear in the terminal panel tabs and produce no toasts when they exit or go idle. The one exception is a terminal whose shell never starts: its window shows one error toast and closes. Each running Command Terminal still holds an agent slot under Max Concurrent Sessions, as a task's agent does.
- Your terminals are **preserved across project switches**. If you open terminals, switch to another project, and switch back, they are still running. Each project keeps its own terminals, so you can keep ad-hoc work going while navigating between projects.
- If git checkout fails when switching branches (e.g., uncommitted changes), a warning toast explains the issue and the session stays on the current branch

**Hiding vs stopping:** Press `Ctrl+Shift+P` again, `Ctrl+Shift+W`, or click the blurred backdrop to **hide** the layer - every PTY stays alive in the background and reopening reattaches (so the layout and running sessions are right where you left them). There is no per-window close button: a window's **Stop** (red, and the kebab's "Stop terminal") **destroys** that one terminal - it kills the PTY, cleans up the session directory, and closes the window; the rest stay open. Stopping the last terminal hides the layer. Transient sessions are non-resumable by design.
