/**
 * The edit form's unsaved artifact edits (#1056). The form holds changes, not
 * a copy of the list, because an agent can add an artifact while the form is
 * open: the saved list plus these changes is what the field shows, and what
 * Save sends (`TaskUpdateInput.artifactChanges`).
 *
 * Pure, so the rules are tested without a form. Each function returns a new
 * changes object; an edit that undoes an earlier one cancels it rather than
 * stacking (adding back a link removed a moment ago is no change at all).
 */

import { artifactKey, findLinks, parseArtifactUrl } from '../../../shared/artifact-platforms';
import { applyArtifactChanges } from '../../../shared/task-artifacts';
import type { TaskArtifact, TaskArtifactChanges } from '../../../shared/types';

const sameLink = (left: string, right: string): boolean => artifactKey(left) === artifactKey(right);

/** The list as the form shows it: the saved artifacts with the unsaved edits applied. */
export function previewArtifacts(saved: readonly TaskArtifact[], draft: TaskArtifactChanges): TaskArtifact[] {
  // `added_at` is never shown, so the preview needs no clock.
  return applyArtifactChanges({ artifacts: [...saved], dismissed: [] }, { ...draft, source: 'user' }, '').artifacts;
}

/** Add a link. Adding back one removed in this edit just cancels the removal. */
export function draftAddArtifact(draft: TaskArtifactChanges, url: string): TaskArtifactChanges {
  const removed = (draft.remove ?? []).some((link) => sameLink(link, url));
  if (removed) return { ...draft, remove: (draft.remove ?? []).filter((link) => !sameLink(link, url)) };
  if ((draft.add ?? []).some((entry) => sameLink(entry.url, url))) return draft;
  return { ...draft, add: [...(draft.add ?? []), { url }] };
}

/**
 * Remove a link: one added in this edit is dropped, and a saved one is marked
 * for removal. A link can be both: pasted again while already on the task, or
 * added by an agent after it was pasted here. Dropping only the draft's add
 * would leave the saved row showing, so the remove button would do nothing.
 */
export function draftRemoveArtifact(
  draft: TaskArtifactChanges,
  url: string,
  saved: readonly TaskArtifact[] = [],
): TaskArtifactChanges {
  const wasAdded = (draft.add ?? []).some((entry) => sameLink(entry.url, url));
  const isSaved = saved.some((artifact) => sameLink(artifact.url, url));
  const rename = (draft.rename ?? []).filter((entry) => !sameLink(entry.url, url));
  const add = wasAdded ? (draft.add ?? []).filter((entry) => !sameLink(entry.url, url)) : draft.add;
  const withoutAdd: TaskArtifactChanges = { ...draft, ...(wasAdded ? { add } : {}), rename };
  if (wasAdded && !isSaved) return withoutAdd;
  if ((draft.remove ?? []).some((link) => sameLink(link, url))) return withoutAdd;
  return { ...withoutAdd, remove: [...(draft.remove ?? []), url] };
}

/**
 * Name a link, or clear its name with an empty one. A link added in this edit
 * carries the name on its add; a saved one gets a rename, dropped again when
 * the name is back to what is saved.
 *
 * The name is kept as typed: this runs on every keystroke, and trimming here
 * would eat the space between two words the moment it is typed. The save
 * tidies it (`applyArtifactChanges`).
 */
export function draftRenameArtifact(
  draft: TaskArtifactChanges,
  saved: readonly TaskArtifact[],
  url: string,
  name: string,
): TaskArtifactChanges {
  const nextName = name.trim() === '' ? null : name;
  if ((draft.add ?? []).some((entry) => sameLink(entry.url, url))) {
    return { ...draft, add: (draft.add ?? []).map((entry) => (sameLink(entry.url, url) ? { ...entry, name: nextName } : entry)) };
  }
  const others = (draft.rename ?? []).filter((entry) => !sameLink(entry.url, url));
  const savedName = saved.find((artifact) => sameLink(artifact.url, url))?.name ?? null;
  return { ...draft, rename: nextName === savedName ? others : [...others, { url, name: nextName }] };
}

/**
 * The name a row's field holds: what was typed in this edit, exactly as typed,
 * else the saved name. The preview list cannot supply it, since it tidies
 * names the way a save does.
 */
export function draftNameOf(draft: TaskArtifactChanges, artifact: Pick<TaskArtifact, 'url' | 'name'>): string {
  const renamed = (draft.rename ?? []).find((entry) => sameLink(entry.url, artifact.url));
  if (renamed) return renamed.name ?? '';
  const added = (draft.add ?? []).find((entry) => sameLink(entry.url, artifact.url));
  if (added) return added.name ?? '';
  return artifact.name ?? '';
}

/**
 * The links in what someone typed or pasted into the add field: every http(s)
 * link in it, so a pasted line of several adds them all. Empty for text with
 * no link, which the field reports instead of adding.
 */
export function linksToAdd(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  // A bare link, exactly as pasted (kept whole: a fragment can be the document).
  if (!/\s/.test(trimmed) && parseArtifactUrl(trimmed)) return [trimmed];
  return findLinks(trimmed);
}
