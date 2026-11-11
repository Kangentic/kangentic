---
type: Reference
title: Artifacts
description: "The links a task keeps to its designs, diagrams, documents and published pages: the platform table, how a link gets onto a task (a person, an agent over MCP, detection), where it shows, how it opens, and the unrecognised-domain report."
tags: [artifacts, links, detection, mcp]
sources:
  - resource: src/shared/artifact-platforms.ts
  - resource: src/shared/task-artifacts.ts
  - resource: src/main/artifacts/artifact-linking.ts
  - resource: src/main/artifacts/artifact-detection.ts
  - resource: src/main/artifacts/artifact-domain-report.ts
  - resource: src/main/agent/commands/artifact-params.ts
  - resource: src/renderer/components/artifacts/ArtifactsChip.tsx
  - resource: src/renderer/components/artifacts/ArtifactsMenu.tsx
  - resource: src/renderer/components/artifacts/ArtifactsField.tsx
  - resource: src/renderer/components/artifacts/artifact-draft.ts
  - resource: src/renderer/components/artifact-platform-marks.ts
  - resource: src/renderer/hooks/useLinkOpener.ts
  - resource: src/renderer/utils/task-link-browser.ts
---
# Artifacts

A task keeps a list of artifacts: links to what it is built from or has produced. A Figma file, a
requirements document, a diagram, a page an agent published. The list shows on the task's board
card, in its window's header and on a completed task's strip, and every agent that works the task
receives it in its opening message.

An artifact is a link and nothing more. Kangentic stores the URL, an optional name, who added it
and when (`TaskArtifact`, in the `tasks.artifacts` JSON column). The platform, its logo and its
display name are read from the URL each time, so a platform added in a later release lights up
links saved before it.

## How a link gets onto a task

| Source | Recorded as | What it adds |
|---|---|---|
| The task's edit form, under Pull Request | `user` | Any http or https link |
| An agent over MCP (`kangentic_create_task` `artifacts`, `kangentic_update_task` `addArtifacts` and `removeArtifacts`) | `agent` | Any http or https link |
| An agent's publish (Claude's Artifact tool) | `agent` | The published link, when it is a recognised platform |
| The task description | `detected` | Recognised links, documents included |
| The agent's own messages | `detected` | Recognised links, documents left out |
| Terminal output, only for an agent with no transcript reader | `detected` | Recognised links, documents left out |

The rules that hold for all of them (`applyArtifactChanges` in `src/shared/task-artifacts.ts`):

- The list stays in the order added, and holds at most 50 links. The edit form and
  `kangentic_update_task` refuse a link past that and say so. A detected link past it is left off.
- Only an http or https link with no whitespace or control character in it is kept.
- The same link is one row. Links are compared with `artifactKey`: host case, `www.` and a
  trailing slash do not matter, the query and the fragment do, since for Figma they name the frame
  and for Excalidraw, draw.io and Mermaid the fragment is the document.
- A link someone removes is dismissed, and detection never adds it back. A person or an agent
  adding it by hand does. A task remembers its newest 200 removed links, and they move with it to
  another project.
- A detected link is written without bumping the task's `updated_at`, so an agent publishing
  mid-run does not reorder the board. An edit a person or an agent asks for is an update like any
  other.

Detection writes through one function, `linkArtifacts` (`src/main/artifacts/artifact-linking.ts`),
which resolves the task from a session, skips a Command Terminal (it has no task), and tells the
board on the quiet `TASK_PR_LINK_CHANGED` channel, so a detected link raises no toast.

### Publish detection

Claude's PostToolUse hook carries an `extractToolUrls` directive
(`src/main/agent/adapters/claude/hook-manager.ts`). When the Artifact tool finishes a publish
(`action: "publish"`, or no action), the event bridge reads the first link out of the tool's result
into `SessionEvent.urls`, and the call's `title` into `urlsTitle`. Only the first link: a publish
from an Artifact type answers with the new artifact and then the type it was made from. A read, a
list, a delete and a quickstart add nothing.

### Message and terminal detection

The message trail read (`src/main/agent/message-trail-read.ts`, in the retrieval worker) returns
the artifact links in the agent's own text blocks. A link in a tool result or in what the user
typed is not read. The tracker announces each link once per session.

Two agents have no transcript reader. For those, `registerArtifactDetection` scans the newest
256 KB of the session's own output at each turn end.

## Platforms

`src/shared/artifact-platforms.ts` is the one list. Each platform has a detection class:

- **messages**: picked up wherever the link appears.
- **description**: picked up from the task description and from a publish only. Agents cite
  documents constantly, so a document link in a message would flood the list.
- **manual**: recognised (logo and name), never detected. Agents name issues in every message, and
  the task's own PR and source issue have their own places.

| Platform | Detection | Matches |
|---|---|---|
| Figma | messages | `figma.com/<word>/<key>` (design, file, proto, board, slides, deck, buzz, site, make), `*.figma.site` |
| Penpot | messages | `design.penpot.app/#/view` and `#/workspace` |
| Sketch | messages | `sketch.com/s/` and `/preview/` |
| Framer | messages | `framer.com/projects/` and `/share/`, `*.framer.app`, `*.framer.website` |
| Zeplin | messages | `app.zeplin.io/project/` and `/styleguide/`, `zpl.io/<code>` |
| Canva | messages | `canva.com/design/<id>`, `canva.link/<id>` |
| UXPin | messages | `preview.uxpin.com/<id>` |
| Axure | messages | `*.axshare.com`, `app.axure.cloud` |
| ProtoPie | messages | `cloud.protopie.io/p/` |
| Balsamiq | messages | `balsamiq.cloud` |
| Uizard | messages | `app.uizard.io/p/` |
| Stitch | messages | `stitch.withgoogle.com/projects/` and `/preview/` |
| Adobe XD | messages | `xd.adobe.com/view/` |
| Claude | messages | `claude.ai/artifact/`, `/public/artifacts/`, `/code/artifact/`, `claude.site/artifacts/` |
| ChatGPT | messages | `chatgpt.com/canvas/shared/` |
| Gemini | messages | `g.co/gemini/share/`, `gemini.google.com/share/` |
| v0 | messages | `v0.app/chat/`, `v0.dev/chat/` and `/t/` |
| Lovable | messages | `lovable.dev/projects/`, `*.lovable.app` |
| Bolt | messages | `bolt.new/~/`, `*.bolt.host` |
| Miro | messages | `miro.com/app/board/` and `/app/live-embed/` |
| Excalidraw | messages | `excalidraw.com/#json=` and `#room=`, `link.excalidraw.com/p/readonly/` |
| tldraw | messages | `tldraw.com/(f, p, r, ro, v, s)/<id>` |
| Whimsical | messages | `whimsical.com/<name>-<22-character id>` |
| Lucid | messages | `lucid.app/lucidchart/` and `/publicSegments/`, `lucidchart.com` |
| draw.io | messages | `app.diagrams.net/#G...` (and W, H, A, U, R), `app.draw.io`, `viewer.diagrams.net` |
| Mermaid | messages | `mermaid.live/edit#pako:` and `/view#base64:` |
| Storybook | messages | `*.chromatic.com` |
| zeroheight | messages | `zeroheight.com/<id>/v/` and `/p/` |
| Google Docs | description | `docs.google.com/document/d/` |
| Google Slides | description | `docs.google.com/presentation/d/` |
| Google Sheets | description | `docs.google.com/spreadsheets/d/` |
| Google Forms | description | `docs.google.com/forms/d/` |
| Google Drive | description | `drive.google.com/file/d/` |
| Notion | description | `app.notion.com/p/`, `notion.so/`, `*.notion.site/` |
| Confluence | description | `<site>.atlassian.net/wiki/` |
| Microsoft 365 | description | `*.sharepoint.com/:w:/` (and x, p, b, f), `1drv.ms` |
| Loom | description | `loom.com/share/` and `/embed/` |
| Coda | description | `coda.io/d/`, `docs.superhuman.com/d/` |
| GitHub | manual | `github.com/<owner>/<repo>/issues/<n>`, `github.com/(orgs or users)/<name>/projects/<n>` |
| Azure DevOps | manual | `dev.azure.com/.../_workitems/`, `/_boards/`, `/_wiki/` |
| Jira | manual | `<site>.atlassian.net/browse/<KEY-1>` |
| Linear | manual | `linear.app/<team>/issue/` and `/project/` |

Not matched, because no share link shape could be confirmed: Cursor shared canvases, Mural,
Microsoft Loop's own links, Lucidspark paths and Google Drawings. InVision and Abstract have shut
down.

Any other link can still be added by hand or by an agent. It shows the plain link icon and its host
where a tool's logo and name would be.

### Logos

`src/renderer/components/artifact-platform-marks.ts` holds one mark per platform, drawn by
`ArtifactPlatformLogo` (`VendorMark.tsx`) in `currentColor`. 30 platforms have one, from Simple
Icons and lobehub/lobe-icons. Zeplin, Canva, UXPin, Axure, ProtoPie, Balsamiq, Uizard, Stitch,
Bolt, Whimsical, zeroheight and Azure DevOps have none in either set and draw the link icon.

### Adding a platform

Add one entry to `ARTIFACT_PLATFORMS`, a mark keyed by its `id` in `artifact-platform-marks.ts`,
and its row in the table above. `tests/unit/artifact-platforms.test.ts` fails when a platform has
no sample link in the test or no mention in this doc.

## Names

An artifact shows the first of these that exists (`artifactDisplayName`): the name a person or an
agent gave it, the publish's title, a name read from the link (Figma's file name, a Notion or
Whimsical slug, a GitHub issue as `owner/repo #12`, a Jira key), then the link cut down to host and
path. Two links that share a name, such as two frames of one Figma file, are told apart in a list:
the second adds its `node-id`, or its place (`listArtifacts`).

## Where it shows

| Place | One artifact | Several |
|---|---|---|
| Board card, beside the PR pill | The tool's logo and the name; a click opens it | A count; a click opens the menu |
| Task window header | An icon button; a click opens it | The same button; a click opens the menu |
| Completed task strip | The count; a click opens it | The count; a click opens the menu |
| Task window actions menu | One item that opens it | An Artifacts flyout |

Compact card density hides the chip, as it hides the PR pill. A task with no artifacts shows
nothing in any of these places. The menu lists the artifacts in the order added and ends in
**Edit artifacts**, which opens the edit form at its Artifacts field. It portals to the body, so a
card at the board's edge does not clip it, and Escape closes the menu and not the window behind it.

The edit form holds changes, not a copy of the list (`artifact-draft.ts`): an artifact an agent
adds while the form is open stays when the form saves.

## How a link opens

An artifact opens the way a PR pill and a terminal link do (`useLinkOpener`): a click opens the
browser the **Click opens links in** setting names (Settings > Behavior > Links, the default
browser unless changed), and Ctrl click (Cmd on a Mac) opens the other. In the menu, Enter and
Ctrl+Enter do the same.

The Kangentic browser is the Browser pane of the task's own window. It is offered while the task's
agent is running, the project's Browser pane is on, and the pane is not in a window of its own.
With the window closed, the link opens the task first and the pane loads it once the window is
showing (`task-link-browser.ts`). If the window comes up without a pane, the link opens in the
default browser after four seconds, so the click is never lost. Everywhere else both clicks open
the default browser, and the tip shows one row.

## What agents receive

- `{{task_xml}}` carries an `<artifacts>` section, one `<artifact name="..." platform="...">`
  per link, omitted when the task has none. The default prompt template includes `{{task_xml}}`.
- `{{artifacts}}` is the same list as plain lines, `name: link`, for a custom template.
- `kangentic_find_task` and `kangentic_get_current_task` print an Artifacts block with each link's
  name, platform and source.

## The unrecognised-domain report

When a person or an agent adds a link on a site that is not in the table, Kangentic reports that
site's domain to Sentry, once per install, so the table grows from what is used. Only the domain
and who added it are sent, never a private host, and nothing with error reporting off. The details
are in [Error reporting](../telemetry/error-reporting.md).
