## What's New

- The Command Terminal is now one panel with a rail down its left side. Add terminal sits at the top of the rail. Below it, Earlier lists the conversations you stopped, each named by its first prompt, and clicking one resumes it. With two or more terminals running you can expand one over the others, swap two by dragging one's header onto the other, and move the whole panel into a window of its own.
- A paired phone can list earlier Command Terminal conversations and resume them.
- Terminals now default to your platform's own terminal font and cursor: Cascadia Mono with a bar cursor on Windows, Adwaita Mono with a block cursor on Linux, and Menlo on macOS, with an 8px inset. A font or size you picked yourself is kept.
- Maximizing, resizing or expanding a window no longer freezes the app while its terminals redraw. Each terminal keeps its last frame until its new one is ready, so the layout change shows once, finished.
- Typing is faster. Keystrokes and their echo no longer pass through the main process. In a fullscreen agent, the time from a key or scroll to the screen dropped from about 26 ms to 11 ms for typing and from about 29 ms to 8 ms for scrolling.
- A workflow step that stops without finishing now recovers on its own. Kangentic nudges the agent, waits while its work is still running, or sends one notice when it needs you. The card and the Workflows header show a Stalled mark, and a new Workflow stalled switch in Notifications controls the notice.
- A task's popped-out Browser, Changes and file windows now close when the task reaches Done, goes back to To Do, or is deleted.
- The Word delete on Backspace setting is gone. Backspace always deletes one character, and Ctrl+Backspace still deletes a word in Claude Code.

## Bug Fixes

- On a busy Windows machine, a terminal that failed to start with "Cannot create process, error code: -1" is now retried once. If the retry fails too, the terminal says the computer was too busy and asks you to start it again.
- The When idle pause no longer ends Command Terminals. It used to close a terminal and lose its conversation about 30 minutes after the last reply.
- Moving a task to another column yourself now resets a column automation's run limit, so a once-per-task row such as "On to Merge" fires again on the next pass. Moves by an agent or an automation still count toward the limit.
- The toast saying idle agents were paused now updates as they resume, and closes once none are left paused.
- A popped-out Browser window opened by an agent now loads its pane, instead of opening empty and leaving the window behind. Popped-out Changes windows load their task reliably too.
- A terminal flooding output while off screen can no longer crash the terminal host.
