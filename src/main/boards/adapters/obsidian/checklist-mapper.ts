import { collectEmbeddedFiles, type VaultIndex } from './embeds';
import { isKanbanBoard, splitNote } from './frontmatter';
import { codeLineMask, inlineTags, noteName, stripInlineTags, uniqueTags } from './markdown-text';
import type { VaultNote } from './vault';
import type { VaultItem } from './vault-item';

/**
 * A Checklist items source: each `- [ ]` line is one task.
 *
 * The Tasks plugin's emoji fields are read for status and priority, and are
 * cut from the title; its dates stay in the description as written. In a
 * Kanban plugin board file, each `##` heading is a lane: a card's Status is
 * its lane, the lanes sort in the board's order, and a lane the plugin marks
 * `**Complete**` closes its cards. The board's archive, after `***`, is not
 * read.
 */

const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
const DATE_FIELD = /(?:📅|⏳|🛫|➕|✅|❌)️?\s*\d{4}-\d{2}-\d{2}/gu;
const RECURRENCE_FIELD = /🔁️?[^📅⏳🛫➕✅❌🔺⏫🔼🔽⏬🆔⛔🏁#^\n]*/gu;
const ID_FIELDS = /(?:🆔|⛔)️?\s*[\w,-]+/gu;
const COMPLETION_FIELD = /🏁️?\s*\w+/gu;
const PRIORITY_MARKERS: ReadonlyArray<[string, string]> = [
  ['🔺', 'Urgent'],
  ['⏫', 'High'],
  ['🔼', 'Medium'],
  ['🔽', 'Low'],
  ['⏬', 'Low'],
];
const PRIORITY_MARKER = /[🔺⏫🔼🔽⏬]️?/gu;

/** The checkbox's states, in the order the Status filter lists them. */
const CHECKBOX_STATES: ReadonlyArray<{ state: string; closed: boolean }> = [
  { state: 'To do', closed: false },
  { state: 'In progress', closed: false },
  { state: 'Done', closed: true },
  { state: 'Cancelled', closed: true },
];

function checkboxStateIndex(mark: string): number {
  if (mark === '/') return 1;
  if (mark === 'x' || mark === 'X') return 2;
  if (mark === '-') return 3;
  return 0;
}

/** The task's own words: no checkbox, no Tasks fields, no tags, no block id. A `#123` is text and stays. */
export function taskTitle(text: string): string {
  const withoutFields = text
    .replace(BLOCK_ID, '')
    .replace(DATE_FIELD, ' ')
    .replace(RECURRENCE_FIELD, ' ')
    .replace(ID_FIELDS, ' ')
    .replace(COMPLETION_FIELD, ' ')
    .replace(PRIORITY_MARKER, ' ');
  return stripInlineTags(withoutFields)
    .replace(/\s+/g, ' ')
    .trim();
}

export function taskPriorityName(text: string): string | null {
  for (const [marker, name] of PRIORITY_MARKERS) {
    if (text.includes(marker)) return name;
  }
  return null;
}

export async function mapChecklistItems(note: VaultNote, index: VaultIndex, vaultRoot: string): Promise<VaultItem[]> {
  const { properties, body } = splitNote(note.text);
  const kanban = isKanbanBoard(properties);
  const lines = body.split(/\r?\n/);
  const inCode = codeLineMask(lines);
  const name = noteName(note.vaultPath);
  const items: VaultItem[] = [];
  const repeats = new Map<string, number>();

  let heading: string | null = null;
  let laneName: string | null = null;
  let laneIndex = -1;
  let laneComplete = false;
  let awaitingLaneMarker = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (inCode[lineIndex]) continue;
    const line = lines[lineIndex];
    const trimmed = line.trim();

    if (kanban && trimmed === '***') break;

    const headingMatch = HEADING.exec(line);
    if (headingMatch) {
      heading = headingMatch[2];
      if (kanban && headingMatch[1] === '##') {
        laneName = headingMatch[2];
        laneIndex += 1;
        laneComplete = false;
        awaitingLaneMarker = true;
      }
      continue;
    }
    if (awaitingLaneMarker && trimmed !== '') {
      awaitingLaneMarker = false;
      if (trimmed === '**Complete**') {
        laneComplete = true;
        continue;
      }
    }

    const taskMatch = TASK_LINE.exec(line);
    if (!taskMatch) continue;
    const text = taskMatch[2];
    const title = taskTitle(text);
    if (title === '') continue;

    const blockId = BLOCK_ID.exec(text)?.[1];
    let externalId: string;
    if (blockId) {
      externalId = `${note.vaultPath}#^${blockId}`;
    } else {
      const words = title.toLowerCase();
      const seen = (repeats.get(words) ?? 0) + 1;
      repeats.set(words, seen);
      externalId = seen === 1 ? `${note.vaultPath}#${words}` : `${note.vaultPath}#${words}~${seen}`;
    }

    const stateIndex = checkboxStateIndex(taskMatch[1]);
    const checkbox = CHECKBOX_STATES[stateIndex];
    const lane = kanban ? laneName : null;
    const embedded = await collectEmbeddedFiles(text, note.vaultPath, index, vaultRoot);
    const origin = heading ? `From ${name}, under ${heading}.` : `From ${name}.`;

    items.push({
      externalId,
      title,
      body: `${trimmed}\n\n${origin}`,
      labels: uniqueTags(inlineTags(text)),
      priorityName: taskPriorityName(text),
      state: lane ?? checkbox.state,
      stateOrder: lane !== null ? laneIndex : stateIndex,
      closed: (lane !== null && laneComplete) || checkbox.closed,
      noteVaultPath: note.vaultPath,
      displayText: name,
      embeddedFiles: embedded.files,
      skippedEmbedCount: embedded.skippedCount,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    });
  }
  return items;
}
