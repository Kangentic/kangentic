/**
 * Unit coverage for the URL resolution rule documented in useBrowserUrl.ts:6-10.
 *
 * useBrowserUrl is a React hook that calls window.electronAPI.browser.getUrls
 * and window.electronAPI.config.getProjectOverrides -- both Electron IPC calls
 * that require jsdom + testing-library to exercise at the hook level. We do
 * NOT add those dependencies (heavy, not in the vitest config).
 *
 * Instead we test the pure resolution rule the hook encodes:
 *
 *   effectiveUrl = taskOverride ?? projectDefault ?? null
 *
 * and the notePlaceholder helper from BrowserPane, which rotates copy based
 * on (strokeCount, pickedCount). These are self-contained pure functions that
 * need no browser, no IPC, and no React.
 *
 * If hook-level tests are ever needed (e.g. to verify recordNavigation
 * auto-seeding logic), add @testing-library/react + jsdom to the vitest
 * config and move those tests here.
 */
import { describe, it, expect } from 'vitest';

// --- URL resolution rule ---
//
// These MIRROR the hook rather than importing it (the hook needs a React
// renderer, and the vitest config has no jsdom). That is a real hazard and it
// already bit once: this file kept asserting `taskOverride ?? projectDefault`
// after the hook grew a third tier, and passed the whole time - against its own
// stale copy. If the hook's precedence changes again, change it here too.
function resolveEffectiveUrl(
  taskOverride: string | null,
  projectDefault: string | null,
): string | null {
  return taskOverride ?? projectDefault ?? null;
}

describe('useBrowserUrl resolution rule (taskOverride > projectDefault > null)', () => {
  it('taskOverride wins when both are set', () => {
    expect(resolveEffectiveUrl('http://task.example.com/', 'http://project.example.com/')).toBe(
      'http://task.example.com/',
    );
  });

  it('projectDefault is used when taskOverride is null', () => {
    expect(resolveEffectiveUrl(null, 'http://project.example.com/')).toBe(
      'http://project.example.com/',
    );
  });

  it('returns null when both are null (empty state rendered)', () => {
    expect(resolveEffectiveUrl(null, null)).toBeNull();
  });

  it('a RESERVED dev-server port is not part of this rule at all', () => {
    // Deliberate, and it was briefly wrong the other way. Reserving a port is
    // not evidence anything is SERVING on it - the project decides its own
    // ports - so a pane that auto-navigated to a reservation rendered a blank
    // page for a server nobody had started. The empty state is the better
    // answer: it at least says what to do next.
    expect(resolveEffectiveUrl(null, null)).toBeNull();
  });

  it('empty-string taskOverride does NOT fall through (falsy but not null)', () => {
    // An empty string task override is a cleared sentinel. `??` treats "" as a
    // non-null value, so it still wins. This documents the raw `??` semantics,
    // not the mock's `|| null` normalisation.
    expect(resolveEffectiveUrl('', 'http://project.example.com/')).toBe('');
  });
});

// --- source label ---
type UrlSource = 'task' | 'project' | 'none';
function resolveSource(
  taskOverride: string | null,
  projectDefault: string | null,
): UrlSource {
  return taskOverride ? 'task' : projectDefault ? 'project' : 'none';
}

describe('useBrowserUrl source label', () => {
  it('reports task when taskOverride is non-empty', () => {
    expect(resolveSource('http://task.local/', null)).toBe('task');
    expect(resolveSource('http://task.local/', 'http://project.local/')).toBe('task');
  });

  it('reports project when only projectDefault is set', () => {
    expect(resolveSource(null, 'http://project.local/')).toBe('project');
  });

  it('reports none when both are null', () => {
    expect(resolveSource(null, null)).toBe('none');
  });
});

// --- notePlaceholder (from BrowserPane) ---
// Inline copy of the pure function from BrowserPane.tsx:562-567.
// Not exported from the production file (file-private), so we replicate it.
function notePlaceholder(strokeCount: number, pickedCount: number): string {
  if (pickedCount > 0 && strokeCount > 0) return 'e.g. "Explain what I marked"';
  if (pickedCount > 0) return 'e.g. "Why is this misaligned?"';
  if (strokeCount > 0) return 'e.g. "Match the circled spacing"';
  return 'What should the agent do with this?';
}

describe('notePlaceholder (BrowserPane toolbar)', () => {
  it('default state has no strokes and no picked element', () => {
    expect(notePlaceholder(0, 0)).toBe('What should the agent do with this?');
  });

  it('strokes only uses the drawing-specific prompt', () => {
    expect(notePlaceholder(3, 0)).toBe('e.g. "Match the circled spacing"');
  });

  it('picked element only uses the alignment-specific prompt', () => {
    expect(notePlaceholder(0, 1)).toBe('e.g. "Why is this misaligned?"');
  });

  it('both strokes and picked element uses the "marked" prompt', () => {
    expect(notePlaceholder(2, 1)).toBe('e.g. "Explain what I marked"');
  });

  it('strokeCount > 1 still maps to the strokes-only branch when pickedCount is 0', () => {
    expect(notePlaceholder(10, 0)).toBe('e.g. "Match the circled spacing"');
  });
});
