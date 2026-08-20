import { describe, it, expect, vi, beforeEach } from 'vitest';

const runtimeEvaluate = vi.fn();
vi.mock('../../src/main/browser/cdp/cdp', () => ({ runtimeEvaluate }));

const { detectDevServerError, describeDevServerError } = await import(
  '../../src/main/browser/dev-server-error'
);

/**
 * The contract that matters here is the FAILURE DIRECTION: a probe that cannot
 * run must report "nothing detected", never turn a working tool call into an
 * error. A missed overlay costs exactly what it costs today; a false positive
 * would break a working screenshot.
 */

const guest = {} as never;

beforeEach(() => {
  runtimeEvaluate.mockReset();
});

describe('detectDevServerError', () => {
  it('reports a Vite overlay with its message and file', async () => {
    runtimeEvaluate.mockResolvedValue({
      value: { kind: 'vite', message: 'Unexpected token }', file: 'src/App.tsx:12:3' },
      error: null,
    });
    await expect(detectDevServerError(guest)).resolves.toEqual({
      kind: 'vite',
      message: 'Unexpected token }',
      file: 'src/App.tsx:12:3',
    });
  });

  it('returns null when no overlay is present', async () => {
    runtimeEvaluate.mockResolvedValue({ value: null, error: null });
    await expect(detectDevServerError(guest)).resolves.toBeNull();
  });

  it('returns null rather than surfacing a probe failure', async () => {
    // A page mid-navigation, a hostile CSP, or a detached debugger must not
    // convert a screenshot into a dev-server-error.
    runtimeEvaluate.mockResolvedValue({ value: null, error: 'Cannot find context' });
    await expect(detectDevServerError(guest)).resolves.toBeNull();
  });

  it('queries the custom element, not page text', async () => {
    // Vite renders the overlay's message inside a shadow root, so it never
    // appears in document.body.innerText - a text scrape would always miss it.
    runtimeEvaluate.mockResolvedValue({ value: null, error: null });
    await detectDevServerError(guest);
    const expression = runtimeEvaluate.mock.calls[0][1] as string;
    expect(expression).toContain('vite-error-overlay');
    expect(expression).toContain('shadowRoot');
  });
});

describe('describeDevServerError', () => {
  it('names the file and tells the agent another worker may be the cause', async () => {
    const detail = describeDevServerError({
      kind: 'vite',
      message: 'Unexpected token }',
      file: 'src/App.tsx:12:3',
    });
    expect(detail).toContain('src/App.tsx:12:3');
    expect(detail).toContain('Unexpected token }');
    // The shared-worktree hint is the point: the agent reading the overlay is
    // often not the one who broke the build.
    expect(detail).toContain('may be theirs, not yours');
  });

  it('omits the parenthetical when there is no file', async () => {
    const detail = describeDevServerError({ kind: 'next', message: 'Build failed.', file: null });
    expect(detail).not.toContain('()');
  });
});
