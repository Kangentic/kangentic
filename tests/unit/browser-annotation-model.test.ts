/**
 * The Browser pane's annotation session (`annotation-model.ts`): every edit the
 * composer, the floating bar and the page make, as the pure functions the pane
 * runs. An annotation is a layer of elements and drawings under one note, and
 * these rules are what keep a long review from losing or misplacing a mark.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_SESSION,
  MAX_ANNOTATIONS,
  activate,
  addStroke,
  canStartNext,
  canUndoLastMark,
  removeAnnotation,
  removeItem,
  replaceCapture,
  sendableAnnotations,
  sessionFromDraft,
  setNote,
  startNext,
  strokeJoinsDrawing,
  toggleElement,
  undoLastMark,
  type AnnotationSession,
} from '../../src/renderer/components/browser/annotations/annotation-model';
import type { BrowserPickedElement } from '../../src/shared/types';

const URL = 'http://localhost:5173/settings';

function idFactory(): () => string {
  let next = 0;
  return () => `id-${(next += 1)}`;
}

function element(selector: string): BrowserPickedElement {
  return {
    selector,
    tagName: 'BUTTON',
    classes: [],
    role: 'button',
    accessibleName: selector,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    computedStyles: {},
    outerHTML: '',
    ancestors: [],
  };
}

const line = (fromX: number, fromY: number, toX: number, toY: number) => [{ x: fromX, y: fromY }, { x: toX, y: toY }];

describe('annotation model', () => {
  it('starts annotation 1 with the first mark, carrying the note typed before it', () => {
    const createId = idFactory();
    const session = toggleElement(EMPTY_SESSION, element('#save'), URL, createId, 'Fix the spacing');
    expect(session.annotations).toHaveLength(1);
    expect(session.annotations[0].note).toBe('Fix the spacing');
    expect(session.annotations[0].url).toBe(URL);
    expect(session.activeId).toBe(session.annotations[0].id);
  });

  it('puts every selection and stroke into the active annotation until the next one starts', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#save'), URL, createId);
    session = toggleElement(session, element('#cancel'), URL, createId);
    session = addStroke(session, line(300, 300, 400, 300), URL, createId);
    expect(session.annotations).toHaveLength(1);
    expect(session.annotations[0].items.map((item) => item.kind)).toEqual(['element', 'element', 'drawing']);

    session = startNext(session, URL, createId);
    session = toggleElement(session, element('#email'), URL, createId);
    expect(session.annotations).toHaveLength(2);
    expect(session.annotations[1].items).toHaveLength(1);
  });

  it('takes an element out when it is selected again in the same annotation', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#save'), URL, createId, 'keep me');
    session = toggleElement(session, element('#cancel'), URL, createId);
    session = toggleElement(session, element('#save'), URL, createId);
    expect(session.annotations[0].items.map((item) => item.kind === 'element' && item.element.selector)).toEqual(['#cancel']);
  });

  it('joins a stroke that touches a drawing (an arrow is one badge), and starts a new drawing otherwise', () => {
    const createId = idFactory();
    let session = addStroke(EMPTY_SESSION, line(470, 280, 250, 228), URL, createId);
    // The arrow head starts on the shaft's end.
    session = addStroke(session, line(252, 230, 270, 215), URL, createId);
    expect(session.annotations[0].items).toHaveLength(1);
    // A circle far away is its own drawing.
    session = addStroke(session, line(700, 600, 760, 640), URL, createId);
    const drawings = session.annotations[0].items.filter((item) => item.kind === 'drawing');
    expect(drawings).toHaveLength(2);
    expect(drawings[0].kind === 'drawing' && drawings[0].strokes).toHaveLength(2);
  });

  it('measures touching against the join distance, either way', () => {
    expect(strokeJoinsDrawing(line(124, 100, 200, 100), [line(0, 100, 100, 100)])).toBe(true);
    expect(strokeJoinsDrawing(line(125, 100, 200, 100), [line(0, 100, 100, 100)])).toBe(false);
  });

  it('undoes the last stroke of a drawing before the drawing itself', () => {
    const createId = idFactory();
    let session = addStroke(EMPTY_SESSION, line(470, 280, 250, 228), URL, createId);
    session = addStroke(session, line(252, 230, 270, 215), URL, createId);
    session = undoLastMark(session);
    const drawing = session.annotations[0].items[0];
    expect(drawing.kind === 'drawing' && drawing.strokes).toHaveLength(1);
  });

  it('removes an annotation whose last mark is undone when it has no note, and keeps one that has', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#save'), URL, createId);
    session = undoLastMark(session);
    expect(session.annotations).toHaveLength(0);
    expect(session.activeId).toBeNull();

    session = toggleElement(EMPTY_SESSION, element('#save'), URL, createId, 'a note');
    session = undoLastMark(session);
    expect(session.annotations).toHaveLength(1);
    expect(session.annotations[0].items).toHaveLength(0);
  });

  it('undoes past a new empty annotation to the last mark of the one before it', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#a'), URL, createId, 'first note');
    session = toggleElement(session, element('#b'), URL, createId);
    session = startNext(session, URL, createId);
    expect(session.annotations).toHaveLength(2);
    session = undoLastMark(session);
    expect(session.annotations).toHaveLength(1);
    expect(session.annotations[0].items.map((item) => item.kind === 'element' && item.element.selector)).toEqual(['#a']);
    expect(session.activeId).toBe(session.annotations[0].id);
  });

  it('reports undo as available only when it would change something', () => {
    const createId = idFactory();
    expect(canUndoLastMark(EMPTY_SESSION)).toBe(false);
    // A lone empty annotation (only a note typed) has no mark to take back.
    const lone: AnnotationSession = { annotations: [{ id: 'a', note: '', url: URL, items: [], captureId: null }], activeId: 'a' };
    expect(canUndoLastMark(lone)).toBe(false);
    expect(canUndoLastMark(toggleElement(lone, element('#a'), URL, createId))).toBe(true);
  });

  it('removes one item from any annotation, leaving the rest', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#save'), URL, createId);
    session = toggleElement(session, element('#cancel'), URL, createId);
    const [first] = session.annotations[0].items;
    session = removeItem(session, session.annotations[0].id, first.id);
    expect(session.annotations[0].items.map((item) => item.kind === 'element' && item.element.selector)).toEqual(['#cancel']);
  });

  it('makes the annotation before a removed active one active, so the numbers close up', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#a'), URL, createId);
    session = startNext(session, URL, createId);
    session = toggleElement(session, element('#b'), URL, createId);
    session = startNext(session, URL, createId);
    session = toggleElement(session, element('#c'), URL, createId);
    const [first, second, third] = session.annotations;
    session = removeAnnotation(session, third.id);
    expect(session.activeId).toBe(second.id);
    session = removeAnnotation(session, first.id);
    expect(session.annotations.map((annotation) => annotation.id)).toEqual([second.id]);
  });

  it('treats an empty active annotation as the next one: no second empty row', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#a'), URL, createId);
    session = startNext(session, URL, createId);
    expect(canStartNext(session)).toBe(false);
    const unchanged = startNext(session, URL, createId);
    expect(unchanged).toBe(session);
    // Writing a note into it makes room for the next.
    session = setNote(session, session.activeId ?? '', 'something');
    expect(canStartNext(session)).toBe(true);
  });

  it('drops an empty annotation once another becomes active', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#a'), URL, createId);
    const firstId = session.annotations[0].id;
    session = startNext(session, URL, createId);
    expect(session.annotations).toHaveLength(2);
    session = activate(session, firstId);
    expect(session.annotations).toHaveLength(1);
  });

  it('stops at the cap: no 21st annotation, while marks still join the active one', () => {
    const createId = idFactory();
    let session: AnnotationSession = EMPTY_SESSION;
    for (let index = 0; index < MAX_ANNOTATIONS; index += 1) {
      if (index > 0) session = startNext(session, URL, createId);
      session = toggleElement(session, element(`#e${index}`), URL, createId);
    }
    expect(session.annotations).toHaveLength(MAX_ANNOTATIONS);
    expect(canStartNext(session)).toBe(false);
    expect(startNext(session, URL, createId)).toBe(session);
    session = toggleElement(session, element('#extra'), URL, createId);
    expect(session.annotations).toHaveLength(MAX_ANNOTATIONS);
    expect(session.annotations[MAX_ANNOTATIONS - 1].items).toHaveLength(2);
  });

  it('moves the annotations that kept a capture onto a newer capture of the same view', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#a'), URL, createId);
    const firstId = session.annotations[0].id;
    session = replaceCapture(session, null, 'aaaaaaaaaaaaaaaa', firstId);
    session = startNext(session, URL, createId);
    session = toggleElement(session, element('#b'), URL, createId);
    const secondId = session.activeId ?? '';
    session = replaceCapture(session, 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', secondId);
    expect(session.annotations.map((annotation) => annotation.captureId)).toEqual(['bbbbbbbbbbbbbbbb', 'bbbbbbbbbbbbbbbb']);
  });

  it('sends every annotation with a mark or a note, and never an empty one', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#a'), URL, createId);
    session = startNext(session, URL, createId);
    expect(sendableAnnotations(session)).toHaveLength(1);
  });

  it('restores a saved draft with its active annotation, or the last one when that is gone', () => {
    const createId = idFactory();
    let session = toggleElement(EMPTY_SESSION, element('#a'), URL, createId);
    session = startNext(session, URL, createId);
    session = toggleElement(session, element('#b'), URL, createId);
    const restored = sessionFromDraft({ version: 1, annotations: session.annotations, activeId: 'missing' });
    expect(restored.activeId).toBe(session.annotations[1].id);
    expect(sessionFromDraft(null)).toBe(EMPTY_SESSION);
  });
});
