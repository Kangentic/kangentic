/**
 * How a task's artifact list changes (#1056). Pure, so the rules are tested
 * without a database (`tests/unit/task-artifacts.test.ts`); `TaskRepository`
 * stores what this returns.
 *
 * The rules:
 * - The list stays in the order added.
 * - The same link is one row (`artifactKey`). Adding it again with a name
 *   names the row; it never moves.
 * - A link someone took off the task is dismissed: detection never adds it
 *   back. A person or an agent adding it by hand does.
 * - Only http(s) links are kept.
 */

import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { artifactKey, artifactNameFromUrl, artifactPlatformOf, artifactShortLink, parseArtifactUrl } from './artifact-platforms';
import type { TaskArtifact, TaskArtifactChanges, TaskArtifactSource } from './types';

/** A task holds at most this many artifacts, so a misfiring detector cannot grow a row without bound. */
export const MAX_TASK_ARTIFACTS = 50;
/** A link longer than this is not an artifact. Excalidraw and Mermaid carry a drawing in the fragment, hence the room. */
export const MAX_ARTIFACT_URL_LENGTH = 8192;
const MAX_ARTIFACT_NAME_LENGTH = 200;
/**
 * A task remembers at most this many removed links, the newest. Each remove
 * adds one, so without a bound an agent that adds and removes links in a loop
 * grows the row the way the artifact cap stops a detector growing it. A link
 * removed longer ago than that can be detected again.
 */
export const MAX_DISMISSED_ARTIFACTS = 200;

export interface ArtifactState {
  artifacts: TaskArtifact[];
  /** `artifactKey`s of links taken off the task. */
  dismissed: string[];
}

export interface ArtifactMergeResult extends ArtifactState {
  /** Whether anything changed, so a caller writes and announces only then. */
  changed: boolean;
  /** The rows this change added. */
  added: TaskArtifact[];
}

function cleanName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_ARTIFACT_NAME_LENGTH);
}

/** Apply `changes` to a task's artifacts. `now` is the UTC ISO 8601 time an added row carries. */
export function applyArtifactChanges(state: ArtifactState, changes: TaskArtifactChanges, now: string): ArtifactMergeResult {
  const source: TaskArtifactSource = changes.source ?? 'user';
  let artifacts = state.artifacts;
  let dismissed = state.dismissed;
  let changed = false;
  const added: TaskArtifact[] = [];

  for (const url of changes.remove ?? []) {
    const key = artifactKey(url);
    if (!artifacts.some((artifact) => artifactKey(artifact.url) === key)) continue;
    artifacts = artifacts.filter((artifact) => artifactKey(artifact.url) !== key);
    if (!dismissed.includes(key)) dismissed = [...dismissed, key].slice(-MAX_DISMISSED_ARTIFACTS);
    changed = true;
  }

  for (const rename of changes.rename ?? []) {
    const key = artifactKey(rename.url);
    const name = cleanName(rename.name);
    const index = artifacts.findIndex((artifact) => artifactKey(artifact.url) === key);
    if (index === -1 || artifacts[index].name === name) continue;
    artifacts = artifacts.map((artifact, position) => (position === index ? { ...artifact, name } : artifact));
    changed = true;
  }

  for (const entry of changes.add ?? []) {
    const url = (entry.url ?? '').trim();
    if (url.length > MAX_ARTIFACT_URL_LENGTH || !parseArtifactUrl(url)) continue;
    const key = artifactKey(url);
    const name = cleanName(entry.name);
    const index = artifacts.findIndex((artifact) => artifactKey(artifact.url) === key);
    if (index !== -1) {
      // Already on the task. A name given now names it; detection never renames.
      if (name !== null && source !== 'detected' && artifacts[index].name !== name) {
        artifacts = artifacts.map((artifact, position) => (position === index ? { ...artifact, name } : artifact));
        changed = true;
      }
      continue;
    }
    if (source === 'detected' && dismissed.includes(key)) continue;
    if (artifacts.length >= MAX_TASK_ARTIFACTS) continue;
    const artifact: TaskArtifact = { url, name, source, added_at: now };
    artifacts = [...artifacts, artifact];
    added.push(artifact);
    // Put back by hand: no longer dismissed.
    if (dismissed.includes(key)) dismissed = dismissed.filter((dismissedKey) => dismissedKey !== key);
    changed = true;
  }

  return { artifacts, dismissed, changed, added };
}

/** Read the stored JSON of `tasks.artifacts`, dropping anything that is not an artifact. */
export function parseStoredArtifacts(raw: string | null | undefined): TaskArtifact[] {
  // `'[]'` is the column's default and what nearly every row holds: a task list
  // maps every row through here, so the common case parses nothing.
  if (!raw || raw === '[]') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const artifacts: TaskArtifact[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.url !== 'string' || !parseArtifactUrl(candidate.url)) continue;
    const source = candidate.source === 'agent' || candidate.source === 'detected' ? candidate.source : 'user';
    artifacts.push({
      url: candidate.url,
      name: typeof candidate.name === 'string' && candidate.name !== '' ? candidate.name : null,
      source,
      added_at: typeof candidate.added_at === 'string' ? candidate.added_at : '',
    });
  }
  return artifacts;
}

/**
 * What an artifact is called where it shows: the name it was given, else the
 * name its link carries (a Figma file's), else the link cut down to host and
 * path.
 */
export function artifactDisplayName(artifact: Pick<TaskArtifact, 'url' | 'name'>): string {
  return artifact.name ?? artifactNameFromUrl(artifact.url) ?? artifactShortLink(artifact.url);
}

/** Whether `changes` asks for anything, so a save sends them only then. */
export function hasArtifactChanges(changes: TaskArtifactChanges | null | undefined): boolean {
  if (!changes) return false;
  return (changes.add?.length ?? 0) > 0 || (changes.remove?.length ?? 0) > 0 || (changes.rename?.length ?? 0) > 0;
}

/** One artifact as a list shows it. */
export interface ArtifactListItem {
  artifact: TaskArtifact;
  /** What it is called, told apart from a namesake in the same list. */
  name: string;
  /** The platform's id (its logo's key), or null for a link Kangentic does not recognise. */
  platformId: string | null;
  /** The tool it lives in: the platform's name, or the link's host. */
  tool: string;
}

/**
 * A task's artifacts as its chip, its menu and its edit form list them, in the
 * order added. Two frames of one Figma file are two links that share the
 * file's name, so a namesake after the first adds what tells it apart: its
 * frame (`node-id`), else its place in the list.
 */
export function listArtifacts(artifacts: readonly TaskArtifact[]): ArtifactListItem[] {
  const seen = new Map<string, number>();
  return artifacts.map((artifact) => {
    const platform = artifactPlatformOf(artifact.url);
    const url = parseArtifactUrl(artifact.url);
    const baseName = artifactDisplayName(artifact);
    const count = (seen.get(baseName) ?? 0) + 1;
    seen.set(baseName, count);
    let name = baseName;
    if (count > 1) {
      const frame = url?.searchParams.get('node-id');
      // Drawn in the chip's menu and the edit form, so the one word in it is
      // translated here, where a render calls this (`i18n.md`).
      name = frame ? i18n._(msg`${{ baseName }}, frame ${{ frame }}`) : `${baseName} (${count})`;
    }
    return {
      artifact,
      name,
      platformId: platform?.id ?? null,
      tool: platform?.name ?? (url ? url.hostname.replace(/^www\./, '') : ''),
    };
  });
}
