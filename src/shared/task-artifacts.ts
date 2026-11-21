/**
 * How a task's artifact list changes (#1056). Pure, so the rules are tested
 * without a database (`tests/unit/task-artifacts.test.ts`); `TaskRepository`
 * stores what this returns.
 *
 * The rules:
 * - The list stays in the order added.
 * - The same link is one row (`artifactKey`); adding it again never moves it.
 * - Adding it again never takes a name away from it. A name sent with the
 *   re-add replaces the row's only when a person sends it (the edit form), or
 *   when a publish sends its title and the row's name was itself a publish
 *   title or borrowed. An agent's MCP add and detection only fill an empty
 *   name. Renaming is its own change (`rename`).
 * - A link someone took off the task is dismissed: detection never adds it
 *   back. A person or an agent adding it by hand does.
 * - Only http(s) links are kept.
 */

import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { artifactKey, artifactNameFromUrl, artifactPlatformOf, artifactShortLink, parseArtifactUrl } from './artifact-platforms';
import type { TaskArtifact, TaskArtifactChanges, TaskArtifactNameFrom, TaskArtifactSource } from './types';

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

/** A name as the list stores it: whitespace collapsed, cut to length, and null when nothing is left. */
export function cleanArtifactName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_ARTIFACT_NAME_LENGTH);
}

/** `artifact` named `name`, recording where the name came from (nowhere: a given name). */
function withName(artifact: TaskArtifact, name: string | null, nameFrom?: TaskArtifactNameFrom): TaskArtifact {
  const { name_from: _previousNameFrom, ...rest } = artifact;
  return name !== null && nameFrom ? { ...rest, name, name_from: nameFrom } : { ...rest, name };
}

/**
 * Whether a name `source` sends with a link the task already holds replaces
 * the row's name. An empty name is always filled. A person's name always
 * replaces. A publish's title replaces only a name nobody chose (an earlier
 * title, a borrowed name), so a name typed or set over MCP outlives the next
 * publish of the same page. An agent's MCP add and detection only fill.
 */
function nameReplaces(row: TaskArtifact, source: TaskArtifactSource): boolean {
  if (row.name === null || source === 'user') return true;
  if (source === 'publish') return row.name_from !== undefined;
  return false;
}

/** Apply `changes` to a task's artifacts. `now` is the UTC ISO 8601 time an added row carries. */
export function applyArtifactChanges(state: ArtifactState, changes: TaskArtifactChanges, now: string): ArtifactMergeResult {
  const source: TaskArtifactSource = changes.source ?? 'user';
  let artifacts = state.artifacts;
  let dismissed = state.dismissed;
  // Compared by key, so a dismissal stored before a key rule changed still holds.
  // Built on first use: a re-add of a held link, the common detection case, never reads it.
  let dismissedKeysCache: Set<string> | null = null;
  const dismissedKeys = (): Set<string> => {
    dismissedKeysCache ??= new Set(dismissed.map((dismissedKey) => artifactKey(dismissedKey)));
    return dismissedKeysCache;
  };
  let changed = false;
  const added: TaskArtifact[] = [];

  for (const url of changes.remove ?? []) {
    const key = artifactKey(url);
    if (!artifacts.some((artifact) => artifactKey(artifact.url) === key)) continue;
    artifacts = artifacts.filter((artifact) => artifactKey(artifact.url) !== key);
    if (!dismissedKeys().has(key)) {
      dismissed = [...dismissed, key].slice(-MAX_DISMISSED_ARTIFACTS);
      dismissedKeys().add(key);
    }
    changed = true;
  }

  for (const rename of changes.rename ?? []) {
    const key = artifactKey(rename.url);
    const name = cleanArtifactName(rename.name);
    const index = artifacts.findIndex((artifact) => artifactKey(artifact.url) === key);
    if (index === -1) continue;
    const current = artifacts[index];
    // A rename is a chosen name, so it also drops a publish or borrowed mark.
    if (current.name === name && current.name_from === undefined) continue;
    artifacts = artifacts.map((artifact, position) => (position === index ? withName(artifact, name) : artifact));
    changed = true;
  }

  for (const entry of changes.add ?? []) {
    const url = (entry.url ?? '').trim();
    if (url.length > MAX_ARTIFACT_URL_LENGTH || !parseArtifactUrl(url)) continue;
    const key = artifactKey(url);
    const name = cleanArtifactName(entry.name);
    const nameFrom: TaskArtifactNameFrom | undefined = name === null
      ? undefined
      : entry.nameFrom ?? (source === 'publish' ? 'publish' : undefined);
    const index = artifacts.findIndex((artifact) => artifactKey(artifact.url) === key);
    if (index !== -1) {
      // Already on the task. A re-add never takes a name away (`nameReplaces`).
      const current = artifacts[index];
      if (name !== null && nameReplaces(current, source) && (current.name !== name || current.name_from !== nameFrom)) {
        artifacts = artifacts.map((artifact, position) => (position === index ? withName(artifact, name, nameFrom) : artifact));
        changed = true;
      }
      continue;
    }
    if (source === 'detected' && dismissedKeys().has(key)) continue;
    if (artifacts.length >= MAX_TASK_ARTIFACTS) continue;
    const artifact = withName({ url, name, source, added_at: now }, name, nameFrom);
    artifacts = [...artifacts, artifact];
    added.push(artifact);
    // Put back by hand: no longer dismissed.
    if (dismissedKeys().has(key)) {
      dismissed = dismissed.filter((dismissedKey) => artifactKey(dismissedKey) !== key);
      dismissedKeys().delete(key);
    }
    changed = true;
  }

  return { artifacts, dismissed, changed, added };
}

/**
 * One row per artifact in a list stored before a key rule changed (a Claude
 * canvas's `#page-...` links, folded by `fragmentIsAnchor`). Each group keeps
 * its first row's place, link, source and time, named by the first row's name,
 * else the first name another row of the group had. Dismissed links are
 * re-keyed and kept once each, at the newest place.
 */
export function foldArtifacts(state: ArtifactState): ArtifactState & { changed: boolean } {
  const artifacts: TaskArtifact[] = [];
  const indexByKey = new Map<string, number>();
  for (const artifact of state.artifacts) {
    const key = artifactKey(artifact.url);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, artifacts.length);
      artifacts.push(artifact);
    } else if (artifacts[index].name === null && artifact.name !== null) {
      artifacts[index] = withName(artifacts[index], artifact.name, artifact.name_from);
    }
  }

  const dismissed: string[] = [];
  const seenDismissed = new Set<string>();
  for (let position = state.dismissed.length - 1; position >= 0; position -= 1) {
    const key = artifactKey(state.dismissed[position]);
    if (seenDismissed.has(key)) continue;
    seenDismissed.add(key);
    dismissed.push(key);
  }
  dismissed.reverse();
  const keptDismissed = dismissed.slice(-MAX_DISMISSED_ARTIFACTS);

  const changed = artifacts.length !== state.artifacts.length
    || artifacts.some((artifact, position) => artifact !== state.artifacts[position])
    || keptDismissed.length !== state.dismissed.length
    || keptDismissed.some((key, position) => key !== state.dismissed[position]);
  return { artifacts, dismissed: keptDismissed, changed };
}

/**
 * The name a project already gives each of `keys`: the first named row for it,
 * in the order the lists come (the caller orders tasks oldest first, so the
 * task that named a link first names it for the rest).
 */
export function artifactNamesByKey(
  lists: Iterable<readonly TaskArtifact[]>,
  keys: ReadonlySet<string>,
): Map<string, string> {
  const names = new Map<string, string>();
  if (keys.size === 0) return names;
  for (const list of lists) {
    for (const artifact of list) {
      if (artifact.name === null) continue;
      const key = artifactKey(artifact.url);
      if (keys.has(key) && !names.has(key)) names.set(key, artifact.name);
    }
    if (names.size === keys.size) break;
  }
  return names;
}

/** `artifacts` with each nameless row given the name `names` holds for its link, marked borrowed. */
export function borrowArtifactNames(artifacts: TaskArtifact[], names: ReadonlyMap<string, string>): TaskArtifact[] {
  let borrowed = artifacts;
  artifacts.forEach((artifact, position) => {
    if (artifact.name !== null) return;
    const name = names.get(artifactKey(artifact.url));
    if (name === undefined) return;
    if (borrowed === artifacts) borrowed = [...artifacts];
    borrowed[position] = withName(artifact, name, 'borrowed');
  });
  return borrowed;
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
    const source = candidate.source === 'agent' || candidate.source === 'publish' || candidate.source === 'detected'
      ? candidate.source
      : 'user';
    const name = typeof candidate.name === 'string' && candidate.name !== '' ? candidate.name : null;
    const nameFrom = name !== null && (candidate.name_from === 'publish' || candidate.name_from === 'borrowed')
      ? candidate.name_from
      : undefined;
    const addedAt = typeof candidate.added_at === 'string' ? candidate.added_at : '';
    artifacts.push(withName({ url: candidate.url, name, source, added_at: addedAt }, name, nameFrom));
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
