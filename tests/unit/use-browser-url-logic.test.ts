/**
 * The Browser pane's URL rules, run through the real module that
 * useBrowserUrl.ts and BrowserPane.tsx import (browser-url-resolution.ts).
 * The hook itself needs a React renderer and the unit tier has no jsdom, so
 * only the pure rules are reachable here. An earlier version of this file kept
 * a private copy of the precedence and went on passing after the hook grew a
 * third tier.
 */
import { describe, it, expect } from 'vitest';
import { resolveBrowserUrl } from '../../src/renderer/components/browser/browser-url-resolution';

describe('resolveBrowserUrl (taskOverride > projectDefault > null)', () => {
  it('taskOverride wins when both are set', () => {
    expect(resolveBrowserUrl('http://task.example.com/', 'http://project.example.com/')).toEqual({
      effectiveUrl: 'http://task.example.com/',
      source: 'task',
    });
  });

  it('projectDefault is used when taskOverride is null', () => {
    expect(resolveBrowserUrl(null, 'http://project.example.com/')).toEqual({
      effectiveUrl: 'http://project.example.com/',
      source: 'project',
    });
  });

  it('returns no URL and source none when both are null (empty state rendered)', () => {
    expect(resolveBrowserUrl(null, null)).toEqual({ effectiveUrl: null, source: 'none' });
  });

  it('an empty-string taskOverride is still the effective URL, but the source reads the next tier', () => {
    // `??` keeps "" as the URL while the truthiness check for `source` skips
    // it. Pinned as the current behavior of the rule, not as a recommendation.
    expect(resolveBrowserUrl('', 'http://project.example.com/')).toEqual({
      effectiveUrl: '',
      source: 'project',
    });
    expect(resolveBrowserUrl('', null)).toEqual({ effectiveUrl: '', source: 'none' });
  });
});
