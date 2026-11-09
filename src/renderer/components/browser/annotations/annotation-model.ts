import type {
  BrowserAnnotation,
  BrowserAnnotationDraft,
  BrowserAnnotationItem,
  BrowserAnnotationStroke,
  BrowserPickedElement,
} from '../../../../shared/types';

// The annotation session as pure data, with every edit a function from one
// state to the next. An annotation is a LAYER: any number of selected elements
// and drawings under one note. Exactly one is active, and every selection and
// stroke joins it until the next one starts.

/** The most annotations one Send carries. */
export const MAX_ANNOTATIONS = 20;

/** A stroke that starts or passes this close to a drawing's ink joins that drawing. */
export const STROKE_JOIN_DISTANCE = 24;

export interface AnnotationSession {
  annotations: BrowserAnnotation[];
  activeId: string | null;
}

export const EMPTY_SESSION: AnnotationSession = { annotations: [], activeId: null };

export type IdFactory = () => string;

export function sessionFromDraft(draft: BrowserAnnotationDraft | null): AnnotationSession {
  if (!draft || draft.annotations.length === 0) return EMPTY_SESSION;
  const annotations = draft.annotations.slice(0, MAX_ANNOTATIONS);
  const activeId = annotations.some((annotation) => annotation.id === draft.activeId)
    ? draft.activeId
    : annotations[annotations.length - 1].id;
  return { annotations, activeId };
}

export function sessionToDraft(session: AnnotationSession): BrowserAnnotationDraft {
  return { version: 1, annotations: session.annotations, activeId: session.activeId };
}

export function isAnnotationEmpty(annotation: BrowserAnnotation): boolean {
  return annotation.items.length === 0 && annotation.note.trim() === '';
}

export function activeAnnotation(session: AnnotationSession): BrowserAnnotation | null {
  return session.annotations.find((annotation) => annotation.id === session.activeId) ?? null;
}

/** Drops empty annotations other than the active one: a row left with nothing in it is gone. */
function pruneEmpty(session: AnnotationSession): AnnotationSession {
  const annotations = session.annotations.filter(
    (annotation) => annotation.id === session.activeId || !isAnnotationEmpty(annotation),
  );
  if (annotations.length === session.annotations.length) return session;
  return { ...session, annotations };
}

function replaceAnnotation(session: AnnotationSession, next: BrowserAnnotation): AnnotationSession {
  return {
    ...session,
    annotations: session.annotations.map((annotation) => (annotation.id === next.id ? next : annotation)),
  };
}

/**
 * The active annotation, starting one if there is none. `pendingNote` is what
 * the user typed in the single note row before the first mark: it becomes the
 * first annotation's note, so nothing typed is lost.
 */
function withActive(
  session: AnnotationSession,
  url: string,
  createId: IdFactory,
  pendingNote: string,
): { session: AnnotationSession; active: BrowserAnnotation } | null {
  const existing = activeAnnotation(session);
  if (existing) return { session, active: existing };
  if (session.annotations.length >= MAX_ANNOTATIONS) return null;
  const created: BrowserAnnotation = {
    id: createId(),
    note: session.annotations.length === 0 ? pendingNote : '',
    url,
    items: [],
    captureId: null,
  };
  return {
    session: { annotations: [...session.annotations, created], activeId: created.id },
    active: created,
  };
}

/**
 * Adds a selected element to the active annotation. Selecting an element the
 * active annotation already holds takes it out again.
 */
export function toggleElement(
  session: AnnotationSession,
  element: BrowserPickedElement,
  url: string,
  createId: IdFactory,
  pendingNote = '',
): AnnotationSession {
  const resolved = withActive(session, url, createId, pendingNote);
  if (!resolved) return session;
  const { active } = resolved;
  const existing = active.items.find((item) => item.kind === 'element' && item.element.selector === element.selector);
  const items: BrowserAnnotationItem[] = existing
    ? active.items.filter((item) => item !== existing)
    : [...active.items, { id: createId(), kind: 'element', element }];
  return pruneEmpty(replaceAnnotation(resolved.session, { ...active, url: active.items.length === 0 ? url : active.url, items }));
}

function distanceToStroke(x: number, y: number, stroke: BrowserAnnotationStroke): number {
  let best = Infinity;
  for (const point of stroke) {
    const dx = point.x - x;
    const dy = point.y - y;
    best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
  }
  return best;
}

/** Whether a new stroke touches a drawing: any of its points comes within the join distance of the drawing's ink. */
export function strokeJoinsDrawing(stroke: BrowserAnnotationStroke, drawing: BrowserAnnotationStroke[]): boolean {
  for (const point of stroke) {
    for (const existing of drawing) {
      if (distanceToStroke(point.x, point.y, existing) <= STROKE_JOIN_DISTANCE) return true;
    }
  }
  return false;
}

/**
 * Adds a stroke to the active annotation. A stroke that touches one of its
 * drawings joins that drawing (an arrow's head joins its shaft, so the arrow
 * has one badge); any other starts a drawing of its own.
 */
export function addStroke(
  session: AnnotationSession,
  stroke: BrowserAnnotationStroke,
  url: string,
  createId: IdFactory,
  pendingNote = '',
): AnnotationSession {
  if (stroke.length === 0) return session;
  const resolved = withActive(session, url, createId, pendingNote);
  if (!resolved) return session;
  const { active } = resolved;
  const joinIndex = active.items.findIndex((item) => item.kind === 'drawing' && strokeJoinsDrawing(stroke, item.strokes));
  const items: BrowserAnnotationItem[] = joinIndex >= 0
    ? active.items.map((item, index) => (index === joinIndex && item.kind === 'drawing'
      ? { ...item, strokes: [...item.strokes, stroke] }
      : item))
    : [...active.items, { id: createId(), kind: 'drawing', strokes: [stroke] }];
  // A joined stroke moves its drawing to the end, so Undo takes it first.
  if (joinIndex >= 0) items.push(items.splice(joinIndex, 1)[0]);
  return replaceAnnotation(resolved.session, { ...active, url: active.items.length === 0 ? url : active.url, items });
}

/**
 * Removes the last mark of the active annotation: the last stroke of its last
 * drawing, or its last element. An annotation left with nothing and no note
 * goes with it, and the one before it becomes active. A new annotation with
 * nothing in it yet holds no mark of its own, so Undo goes back past it to
 * the last mark made before it.
 */
export function undoLastMark(session: AnnotationSession): AnnotationSession {
  const active = activeAnnotation(session) ?? session.annotations[session.annotations.length - 1];
  if (!active) return session;
  if (active.items.length === 0) {
    if (!isAnnotationEmpty(active) || session.annotations.length < 2) return session;
    const withoutEmpty = removeAnnotation(session, active.id);
    const undone = undoLastMark(withoutEmpty);
    return undone === withoutEmpty ? session : undone;
  }
  const last = active.items[active.items.length - 1];
  let items = active.items.slice(0, -1);
  if (last.kind === 'drawing' && last.strokes.length > 1) {
    items = [...items, { ...last, strokes: last.strokes.slice(0, -1) }];
  }
  const next = replaceAnnotation({ ...session, activeId: active.id }, { ...active, items });
  return dropIfEmpty(next, active.id);
}

/** Whether Undo has a mark to take, so its button is on only when it does something. */
export function canUndoLastMark(session: AnnotationSession): boolean {
  return undoLastMark(session) !== session;
}

/** An annotation with no items and no note left is removed, and the previous one becomes active. */
function dropIfEmpty(session: AnnotationSession, annotationId: string): AnnotationSession {
  const annotation = session.annotations.find((candidate) => candidate.id === annotationId);
  if (!annotation || !isAnnotationEmpty(annotation)) return session;
  return removeAnnotation(session, annotationId);
}

export function removeItem(session: AnnotationSession, annotationId: string, itemId: string): AnnotationSession {
  const annotation = session.annotations.find((candidate) => candidate.id === annotationId);
  if (!annotation) return session;
  const next = replaceAnnotation(session, { ...annotation, items: annotation.items.filter((item) => item.id !== itemId) });
  return dropIfEmpty(next, annotationId);
}

export function removeAnnotation(session: AnnotationSession, annotationId: string): AnnotationSession {
  const index = session.annotations.findIndex((annotation) => annotation.id === annotationId);
  if (index < 0) return session;
  const annotations = session.annotations.filter((annotation) => annotation.id !== annotationId);
  let activeId = session.activeId;
  if (activeId === annotationId) {
    activeId = annotations.length === 0 ? null : annotations[Math.max(0, index - 1)].id;
  }
  return { annotations, activeId };
}

export function setNote(session: AnnotationSession, annotationId: string, note: string): AnnotationSession {
  const annotation = session.annotations.find((candidate) => candidate.id === annotationId);
  if (!annotation || annotation.note === note) return session;
  return replaceAnnotation(session, { ...annotation, note });
}

export function activate(session: AnnotationSession, annotationId: string): AnnotationSession {
  if (session.activeId === annotationId) return session;
  if (!session.annotations.some((annotation) => annotation.id === annotationId)) return session;
  return pruneEmpty({ ...session, activeId: annotationId });
}

/** Whether the "New annotation" row shows: under the cap, and the active one has something in it. */
export function canStartNext(session: AnnotationSession): boolean {
  if (session.annotations.length >= MAX_ANNOTATIONS) return false;
  const active = activeAnnotation(session);
  return !active || !isAnnotationEmpty(active);
}

/** Starts the next annotation and makes it active. An empty active annotation already IS the next one. */
export function startNext(session: AnnotationSession, url: string, createId: IdFactory): AnnotationSession {
  if (!canStartNext(session)) return session;
  const created: BrowserAnnotation = { id: createId(), note: '', url, items: [], captureId: null };
  return pruneEmpty({ annotations: [...session.annotations, created], activeId: created.id });
}

/** Points every annotation that kept `previousId` at a newer capture of the same view. */
export function replaceCapture(session: AnnotationSession, previousId: string | null, nextId: string, annotationId: string): AnnotationSession {
  return {
    ...session,
    annotations: session.annotations.map((annotation) => {
      if (annotation.id === annotationId) return { ...annotation, captureId: nextId };
      if (previousId && annotation.captureId === previousId) return { ...annotation, captureId: nextId };
      return annotation;
    }),
  };
}

/** The annotations Send carries: every one with a mark or a note, numbered in order. */
export function sendableAnnotations(session: AnnotationSession): BrowserAnnotation[] {
  return session.annotations.filter((annotation) => !isAnnotationEmpty(annotation));
}

/** The URL without its fragment, which is how two URLs are compared as one page. */
export function samePage(left: string, right: string): boolean {
  return left.split('#')[0] === right.split('#')[0];
}
