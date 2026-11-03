// Pure rules the Browser pane reads, kept out of the hook and the component so
// the unit tier (no jsdom) can run the real code.

export type UrlSource = 'task' | 'project' | 'none';

export interface ResolvedBrowserUrl {
  effectiveUrl: string | null;
  source: UrlSource;
}

/**
 * taskOverride > projectDefault > null (the caller renders the empty state).
 *
 * `effectiveUrl` uses `??`, so an empty-string override still wins as the URL.
 * `source` uses truthiness, so the same empty string reports the next tier down.
 * A reserved dev-server port deliberately does NOT participate: Kangentic
 * reserving a port is not evidence anything is serving on it.
 */
export function resolveBrowserUrl(
  taskOverride: string | null,
  projectDefault: string | null,
): ResolvedBrowserUrl {
  const effectiveUrl = taskOverride ?? projectDefault ?? null;
  const source: UrlSource = taskOverride
    ? 'task'
    : projectDefault
      ? 'project'
      : 'none';
  return { effectiveUrl, source };
}

/** Which note-field hint the pane shows, from what is queued on the page. */
export type NotePlaceholderKind = 'marked' | 'picked' | 'strokes' | 'none';

export function notePlaceholderKind(strokeCount: number, pickedCount: number): NotePlaceholderKind {
  if (pickedCount > 0 && strokeCount > 0) return 'marked';
  if (pickedCount > 0) return 'picked';
  if (strokeCount > 0) return 'strokes';
  return 'none';
}
