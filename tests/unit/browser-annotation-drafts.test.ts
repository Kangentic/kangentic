/**
 * A Browser pane's annotation draft on disk (`annotation-drafts.ts`). A long
 * review must survive a failed Send and a restart (decision 45): the draft is
 * what comes back, so these run the real store on a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CAPTURE_PRUNE_GRACE_MS,
  annotationCapturePath,
  annotationOwnerSegment,
  discardAnnotationDraft,
  loadAnnotationDraft,
  parseAnnotationDraft,
  saveAnnotationCapture,
  saveAnnotationDraft,
} from '../../src/main/browser/annotation-drafts';
import type { BrowserAnnotationDraft } from '../../src/shared/types';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let projectPath: string;

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-annotation-drafts-'));
});

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Ages a capture past the prune grace, as if it were taken a while ago. */
function age(captureId: string): void {
  const old = new Date(Date.now() - CAPTURE_PRUNE_GRACE_MS - 1000);
  fs.utimesSync(annotationCapturePath(projectPath, 'task-1', captureId), old, old);
}

function draftWith(captureIds: Array<string | null>): BrowserAnnotationDraft {
  return {
    version: 1,
    activeId: 'a0',
    annotations: captureIds.map((captureId, index) => ({
      id: `a${index}`,
      note: `note ${index}`,
      url: 'http://localhost:5173/',
      items: [{ id: `i${index}`, kind: 'drawing', strokes: [[{ x: 1, y: 2 }]] }],
      captureId,
    })),
  };
}

describe('annotation drafts', () => {
  it('reads back what was saved', async () => {
    const draft = draftWith([null]);
    await saveAnnotationDraft(projectPath, 'task-1', draft);
    expect(await loadAnnotationDraft(projectPath, 'task-1')).toEqual(draft);
    expect(await loadAnnotationDraft(projectPath, 'task-2')).toBeNull();
  });

  it('deletes the captures a save no longer names, and keeps the ones it does', async () => {
    const kept = await saveAnnotationCapture(projectPath, 'task-1', PNG_BASE64);
    const replaced = await saveAnnotationCapture(projectPath, 'task-1', PNG_BASE64);
    age(kept);
    age(replaced);
    await saveAnnotationDraft(projectPath, 'task-1', draftWith([kept]));
    expect(fs.existsSync(annotationCapturePath(projectPath, 'task-1', kept))).toBe(true);
    expect(fs.existsSync(annotationCapturePath(projectPath, 'task-1', replaced))).toBe(false);
  });

  it('discards the draft and its captures together', async () => {
    const captureId = await saveAnnotationCapture(projectPath, 'task-1', PNG_BASE64);
    await saveAnnotationDraft(projectPath, 'task-1', draftWith([captureId]));
    await discardAnnotationDraft(projectPath, 'task-1');
    expect(await loadAnnotationDraft(projectPath, 'task-1')).toBeNull();
    expect(fs.existsSync(annotationCapturePath(projectPath, 'task-1', captureId))).toBe(false);
  });

  it('keeps a Command Terminal owner key to one folder segment, and refuses anything that leaves it', () => {
    expect(annotationOwnerSegment('command-terminal::proj::slot-2')).toBe('command-terminal--proj--slot-2');
    expect(() => annotationOwnerSegment('../escape')).toThrow();
    expect(() => annotationOwnerSegment('a/b')).toThrow();
    expect(() => annotationCapturePath(projectPath, 'task-1', '../x')).toThrow();
  });

  it('reads a corrupt or foreign file as no draft, and drops entries that are not annotations', () => {
    expect(parseAnnotationDraft('{not json')).toBeNull();
    expect(parseAnnotationDraft(JSON.stringify({ version: 2, annotations: [] }))).toBeNull();
    const mixed = parseAnnotationDraft(JSON.stringify({
      version: 1,
      activeId: 'gone',
      annotations: [{ id: 'x' }, draftWith([null]).annotations[0]],
    }));
    expect(mixed?.annotations.map((annotation) => annotation.id)).toEqual(['a0']);
    expect(mixed?.activeId).toBeNull();
  });

  it('drops an annotation holding a malformed item', () => {
    const malformed = { ...draftWith([null]).annotations[0], id: 'bad', items: [{ id: 'i', kind: 'element' }] };
    const parsed = parseAnnotationDraft(JSON.stringify({
      version: 1,
      activeId: 'bad',
      annotations: [malformed, draftWith([null]).annotations[0]],
    }));
    expect(parsed?.annotations.map((annotation) => annotation.id)).toEqual(['a0']);
    expect(parseAnnotationDraft(JSON.stringify({ version: 1, annotations: [malformed] }))).toBeNull();
  });

  it('rejects a malformed draft before writing anything', async () => {
    const malformed = { version: 1, activeId: null, annotations: [{ id: 'bad', note: '', url: '', items: [{ id: 'i', kind: 'element' }], captureId: null }] };
    await expect(saveAnnotationDraft(projectPath, 'task-1', malformed)).rejects.toThrow('Annotation draft is malformed');
    expect(fs.existsSync(path.join(projectPath, '.kangentic', 'browser-annotations', 'task-1', 'draft.json'))).toBe(false);
  });

  it('keeps a capture younger than the grace through a save that does not name it, and prunes an aged one', async () => {
    const fresh = await saveAnnotationCapture(projectPath, 'task-1', PNG_BASE64);
    const aged = await saveAnnotationCapture(projectPath, 'task-1', PNG_BASE64);
    age(aged);
    await saveAnnotationDraft(projectPath, 'task-1', draftWith([null]));
    expect(fs.existsSync(annotationCapturePath(projectPath, 'task-1', fresh))).toBe(true);
    expect(fs.existsSync(annotationCapturePath(projectPath, 'task-1', aged))).toBe(false);
  });

  it('a retiring discard drops the late save and refuses a late capture', async () => {
    await saveAnnotationDraft(projectPath, 'task-1', draftWith([null]));
    await discardAnnotationDraft(projectPath, 'task-1', { retire: true });
    await saveAnnotationDraft(projectPath, 'task-1', draftWith([null]));
    expect(await loadAnnotationDraft(projectPath, 'task-1')).toBeNull();
    await expect(saveAnnotationCapture(projectPath, 'task-1', PNG_BASE64)).rejects.toThrow('Annotation draft was discarded');
    expect(fs.existsSync(path.join(projectPath, '.kangentic', 'browser-annotations', 'task-1'))).toBe(false);
  });

  it('a save sent before a plain discard never recreates the folder after it', async () => {
    const saving = saveAnnotationDraft(projectPath, 'task-1', draftWith([null]));
    const discarding = discardAnnotationDraft(projectPath, 'task-1');
    await Promise.all([saving, discarding]);
    expect(fs.existsSync(path.join(projectPath, '.kangentic', 'browser-annotations', 'task-1'))).toBe(false);
  });

  it('refuses a capture that is not a string, or not a PNG', async () => {
    await expect(saveAnnotationCapture(projectPath, 'task-1', 42)).rejects.toThrow();
    await expect(saveAnnotationCapture(projectPath, 'task-1', '')).rejects.toThrow();
    const notPng = Buffer.from('this is plainly not a png image').toString('base64');
    await expect(saveAnnotationCapture(projectPath, 'task-1', notPng)).rejects.toThrow('not a PNG');
    expect(fs.existsSync(path.join(projectPath, '.kangentic', 'browser-annotations', 'task-1'))).toBe(false);
  });
});
