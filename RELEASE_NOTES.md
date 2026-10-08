## What's New

- Kangentic Mobile is live on iOS and Android. An announcement in the app links to both stores, with a QR code for each.
- From a paired phone you can now pause a running agent and resume a paused one. A phone Resume works like the desktop's Resume button and does not re-run the column's automations. The phone also shows when an agent is starting or resuming, and its session status updates live.
- The Changes panel shows changed images as pictures instead of a binary placeholder. Compare the two versions side by side, with a slider, as an overlay, or as a pixel diff that reports how much changed. An SVG opens on its text diff, and the eye button previews it as an image.
- The context bar's tool-call count and its per-tool table now carry across app restarts and pause and resume, instead of starting again at 0. The Session Summary's By tool table merges every run the same way.
- Dictation has new presets: Best, Balanced and Light, each picking models for your language. Custom adds Parakeet unified, Parakeet v2 and Cohere Transcribe. The Dictation tab lists the running models with their licenses.
- The Knowledge Graph's local model is now IBM's Granite embedding English R2 (Best) or bge-small (Light). An index built on a model that changed is rebuilt in the background after the update, and search answers by keyword until it finishes.

## Bug Fixes

- Changing a running task's model or effort now restarts its session with the new setting. Before, an effort change typed /effort into the agent's turn, where nothing could confirm it took.
- The model pickers' Latest group and full version list now load on packaged Windows builds launched from the Start menu.
- About a quarter of Claude's visible messages on Opus 5.5 were missing from board cards, the phone preview and the conversation viewer. They now show.
- A task moved to Done no longer stops a server another task is still using over a local connection, such as an adb server or an emulator.
- A task no longer shows as idle while a background subagent is still running after being re-prompted to hand back.
- Phone connections are faster and steadier. The relay is dialed through Node first, which more than halved the slowest round trips, and the desktop no longer drops frames during a key rotation or when a connection hits its byte limit. A terminal too large to send whole now opens with less scrollback instead of failing to open.
- On Linux, the Changes panel's file watcher no longer walks node_modules and .git, which used thousands of inotify watches and could exhaust the per-user limit.
