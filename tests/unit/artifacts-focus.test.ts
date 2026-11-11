/**
 * The request "Edit artifacts" leaves for a task's edit form
 * (src/renderer/components/artifacts/artifacts-focus.ts).
 *
 * What a user loses if this goes: a request its form never took stays behind,
 * and the next time that task's form opens, however much later, it opens
 * scrolled to Artifacts with the add field up, for a click made long ago.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setDetailTaskId = vi.fn();
vi.mock('../../src/renderer/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ setDetailTaskId }) },
}));

import {
  ARTIFACTS_FOCUS_REQUEST_MS,
  hasArtifactsFocusRequest,
  openArtifactsEditor,
  requestArtifactsFocus,
  takeArtifactsFocus,
} from '../../src/renderer/components/artifacts/artifacts-focus';

describe('artifacts focus request', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setDetailTaskId.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the form that opens next, and is taken once', () => {
    requestArtifactsFocus('task-a');
    expect(hasArtifactsFocusRequest('task-a')).toBe(true);
    expect(hasArtifactsFocusRequest('task-b')).toBe(false);

    expect(takeArtifactsFocus('task-a')).toBe(true);
    expect(takeArtifactsFocus('task-a')).toBe(false);
    expect(hasArtifactsFocusRequest('task-a')).toBe(false);
  });

  it('is still waiting just inside its lifetime', () => {
    requestArtifactsFocus('task-a');
    vi.advanceTimersByTime(ARTIFACTS_FOCUS_REQUEST_MS);
    expect(takeArtifactsFocus('task-a')).toBe(true);
  });

  it('is gone once its lifetime has passed, so a later open of the form is a plain open', () => {
    requestArtifactsFocus('task-a');
    vi.advanceTimersByTime(ARTIFACTS_FOCUS_REQUEST_MS + 1);
    expect(hasArtifactsFocusRequest('task-a')).toBe(false);
    expect(takeArtifactsFocus('task-a')).toBe(false);
  });

  it('a fresh request after a stale one waits again', () => {
    requestArtifactsFocus('task-a');
    vi.advanceTimersByTime(ARTIFACTS_FOCUS_REQUEST_MS + 1);
    requestArtifactsFocus('task-a');
    expect(takeArtifactsFocus('task-a')).toBe(true);
  });

  it('Edit artifacts leaves the request and opens the task on its edit form', () => {
    openArtifactsEditor('task-a');
    expect(setDetailTaskId).toHaveBeenCalledWith('task-a', { initialEdit: true });
    expect(takeArtifactsFocus('task-a')).toBe(true);
  });
});
