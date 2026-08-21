import { describe, it, expect, vi } from 'vitest';

// analytics.ts imports electron and the Aptabase SDK at module scope; mock both
// so this stays a pure unit test. Mirrors sanitize-error-message.test.ts.
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('@aptabase/electron/main', () => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  summarizeComponentStack,
  MAX_ANALYTICS_STRING_LENGTH,
} from '../../src/main/analytics/analytics';

// Renderer error telemetry used to send only `error.message`, which made
// "Cannot read properties of undefined (reading 'split')" unlocatable: all three
// reporters looked identical in the data. The component stack is the missing
// signal, but the RAW stack cannot be sent - a production frame embeds a file://
// URL containing the user's home directory. This reduces it to component names,
// which are PII-free by construction rather than by pattern-matching.

describe('summarizeComponentStack', () => {
  it('returns an empty string for nothing to summarize', () => {
    expect(summarizeComponentStack(undefined)).toBe('');
    expect(summarizeComponentStack(null)).toBe('');
    expect(summarizeComponentStack('')).toBe('');
  });

  it('extracts component names from a production stack without leaking the path', () => {
    const stack = [
      '',
      '    at BrowserPane (file:///C:/Users/dev/AppData/Local/Kangentic/app/assets/index-a1b2c3.js:12:345)',
      '    at WindowContent (file:///C:/Users/dev/AppData/Local/Kangentic/app/assets/index-a1b2c3.js:44:9)',
      '    at App (file:///C:/Users/dev/AppData/Local/Kangentic/app/assets/index-a1b2c3.js:88:1)',
    ].join('\n');

    const summary = summarizeComponentStack(stack);

    expect(summary).toBe('BrowserPane < WindowContent < App');
    expect(summary).not.toContain('file://');
    expect(summary).not.toContain('Users');
    expect(summary).not.toContain('.js');
  });

  it('handles a Unix production path the same way', () => {
    const stack =
      '\n    at MonitorPage (file:///Users/dev/Applications/Kangentic.app/Contents/assets/index.js:1:2)';
    const summary = summarizeComponentStack(stack);
    expect(summary).toBe('MonitorPage');
    expect(summary).not.toContain('/Users/');
  });

  it('reads a dev-server stack, including the "in" frame form', () => {
    const stack = [
      '    in ChangesPanel (at TaskDetailBody.tsx:257)',
      '    in PanelErrorBoundary (at TaskDetailBody.tsx:255)',
    ].join('\n');

    expect(summarizeComponentStack(stack)).toBe('ChangesPanel < PanelErrorBoundary');
  });

  it('keeps dotted and $-bearing component names intact', () => {
    const stack = '    at Foo.Bar (x)\n    at _Baz$ (y)';
    expect(summarizeComponentStack(stack)).toBe('Foo.Bar < _Baz$');
  });

  it('caps the number of frames, innermost first', () => {
    const stack = Array.from({ length: 20 }, (_unused, index) => `    at Component${index} (x)`).join(
      '\n'
    );

    const summary = summarizeComponentStack(stack, 3);

    expect(summary).toBe('Component0 < Component1 < Component2');
  });

  it('never exceeds the length Aptabase preserves', () => {
    // Aptabase truncates a string property at 180 chars server-side, so anything
    // longer is silently lost rather than delivered.
    const stack = Array.from(
      { length: 30 },
      (_unused, index) => `    at AVeryLongComponentNameIndeed${index} (x)`
    ).join('\n');

    const summary = summarizeComponentStack(stack, 30);

    expect(summary.length).toBeLessThanOrEqual(MAX_ANALYTICS_STRING_LENGTH);
    expect(MAX_ANALYTICS_STRING_LENGTH).toBe(180);
  });

  it('ignores lines that are not frames', () => {
    const stack = 'Some preamble\n\n    at RealComponent (x)\ntrailing noise';
    expect(summarizeComponentStack(stack)).toBe('RealComponent');
  });
});
