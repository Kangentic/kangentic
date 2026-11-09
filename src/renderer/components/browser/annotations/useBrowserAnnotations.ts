import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BrowserAnnotation,
  BrowserAnnotationSendInput,
  BrowserAnnotationStroke,
  BrowserAnnotationViewport,
  BrowserPickedElement,
} from '../../../../shared/types';
import type { WebviewElement } from '../webview-types';
import {
  EMPTY_SESSION,
  activate,
  addStroke,
  removeAnnotation,
  removeItem,
  replaceCapture,
  samePage,
  sendableAnnotations,
  sessionFromDraft,
  sessionToDraft,
  setNote,
  startNext,
  toggleElement,
  undoLastMark,
  type AnnotationSession,
} from './annotation-model';
import {
  ANNOTATION_LAYER_AFTER_PAINT_SCRIPT,
  ANNOTATION_LAYER_CANCEL_BADGE_WAIT_SCRIPT,
  ANNOTATION_LAYER_CLEAR_SCRIPT,
  ANNOTATION_LAYER_NEXT_BADGE_CLICK_SCRIPT,
  ANNOTATION_LAYER_SCROLL_SCRIPT,
  hoverAnnotationLayerScript,
  renderAnnotationLayerScript,
  type AnnotationLayerAnnotation,
  type AnnotationLayerHover,
  type AnnotationLayerState,
  type AnnotationLayerStatus,
} from './annotationLayerScript';

// The Browser pane's annotation session: the pure model in
// `annotation-model.ts`, plus everything that touches the page or the disk.
//
// - The draft is loaded once per task and saved (debounced) on every change,
//   so a restart or a crash loses nothing. A save still waiting when the pane
//   unmounts or changes task is sent at once.
// - The page layer is re-rendered whenever the marks or the drive state
//   change, and on every load of the guest's document. A hover in the list
//   only restyles what is drawn.
// - Each time an item joins an annotation, the visible page is captured with
//   its badges, so an annotation that later scrolls away or is left behind by
//   a navigation still goes with a picture of it.

const SAVE_DEBOUNCE_MS = 500;

function createId(): string {
  return crypto.randomUUID();
}

function stripDataUrl(dataUrl: string): string {
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}

/** A zoom factor that is safe to divide by. */
function positiveZoom(zoomFactor: number): number {
  return zoomFactor > 0 ? zoomFactor : 1;
}

/**
 * Runs a script in the guest, answering null for any failure. A `<webview>`
 * throws synchronously, not with a rejection, until its guest has attached.
 */
function runInGuest<T>(webview: WebviewElement | null, script: string): Promise<T | null> {
  if (!webview || typeof webview.executeJavaScript !== 'function') return Promise.resolve(null);
  try {
    return webview.executeJavaScript<T>(script).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/** Saves the session for a task, or discards the draft when nothing is left. */
function persistSession(taskId: string, projectId: string | null, session: AnnotationSession): void {
  const browser = window.electronAPI.browser;
  if (session.annotations.length === 0) {
    void browser.discardAnnotations(taskId, projectId).catch(() => undefined);
  } else {
    void browser.saveAnnotations(taskId, sessionToDraft(session), projectId).catch(() => undefined);
  }
}

/**
 * Whether an annotation is on the page the pane shows: made on this page, and
 * with any of its elements found there. `unknownCounts` decides the case with
 * no answer from the layer yet.
 */
function annotationOnPage(
  annotation: BrowserAnnotation,
  currentUrl: string,
  status: AnnotationLayerStatus | null,
  unknownCounts: boolean,
): boolean {
  if (!samePage(annotation.url, currentUrl)) return false;
  const elements = annotation.items.filter((item) => item.kind === 'element');
  if (elements.length === 0) return true;
  if (!status) return unknownCounts;
  return elements.some((item) => status.items[item.id]?.onPage);
}

interface UseBrowserAnnotationsOptions {
  taskId: string;
  projectId: string | null;
  webviewRef: React.RefObject<WebviewElement | null>;
  /** The page's current URL. */
  currentUrl: string;
  /** The webview's zoom factor, so a stroke or the bar's rect maps to page px. */
  zoomFactor: number;
  /** True while an agent drives the pane: the layer hides so its screenshots and lookups stay clean. */
  hidden: boolean;
  /** The floating bar's rect in the pane's own px, which drawing badges keep clear of. */
  getBarRect: () => AnnotationLayerState['barRect'];
}

export interface AnnotationRowView {
  id: string;
  number: number;
  note: string;
  active: boolean;
  onPage: boolean;
  url: string;
  items: AnnotationSession['annotations'][number]['items'];
}

export function useBrowserAnnotations({
  taskId,
  projectId,
  webviewRef,
  currentUrl,
  zoomFactor,
  hidden,
  getBarRect,
}: UseBrowserAnnotationsOptions) {
  const [session, setSession] = useState<AnnotationSession>(EMPTY_SESSION);
  const [status, setStatus] = useState<AnnotationLayerStatus | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [documentGeneration, setDocumentGeneration] = useState(0);
  // Bumped when a load settles, so the save effect runs for edits made while
  // it was loading. `loadedRef` is the gate itself: set in the same pass a
  // task change starts its load, so no save can go to the new task first.
  const [loadSettled, setLoadSettled] = useState(0);
  const loadedRef = useRef(false);
  // The session as it stood when the load settled. Saving it would only write
  // back what is on disk, or, when the load found nothing, discard a draft a
  // failed read could not see.
  const baselineRef = useRef<AnnotationSession | null>(null);
  const pendingSaveRef = useRef<{ taskId: string; projectId: string | null; session: AnnotationSession } | null>(null);
  const sessionRef = useRef(session);
  const pendingCaptureRef = useRef<string | null>(null);
  const lastCaptureRef = useRef<{ key: string; id: string } | null>(null);
  const captureInFlightRef = useRef(false);
  const queuedCaptureRef = useRef<{ annotationIds: Set<string>; status: AnnotationLayerStatus } | null>(null);
  // Bumped by a Clear and a task change: a capture that started before one
  // must not land in the session after it.
  const sessionEpochRef = useRef(0);
  const hoverRef = useRef<AnnotationLayerHover>({ hoveredNumber: null, hoveredItemId: null });
  const currentUrlRef = useRef(currentUrl);
  const zoomFactorRef = useRef(zoomFactor);
  useEffect(() => {
    sessionRef.current = session;
    currentUrlRef.current = currentUrl;
    zoomFactorRef.current = zoomFactor;
  });

  const loadedForRef = useRef<string | null>(null);

  // Load the task's saved draft once. Anything the user did before it arrived
  // wins: a draft never replaces a session already under way. A pane moved to
  // another task starts that task's session empty, after the flush below sent
  // the last one's pending save.
  useEffect(() => {
    let cancelled = false;
    const owner = `${projectId ?? ''}|${taskId}`;
    if (loadedForRef.current !== null && loadedForRef.current !== owner) {
      sessionRef.current = EMPTY_SESSION;
      setSession(EMPTY_SESSION);
    }
    loadedForRef.current = owner;
    loadedRef.current = false;
    baselineRef.current = null;
    sessionEpochRef.current += 1;
    void window.electronAPI.browser.loadAnnotations(taskId, projectId)
      .then((draft) => {
        if (cancelled) return;
        if (draft && sessionRef.current.annotations.length === 0) {
          const restored = sessionFromDraft(draft);
          baselineRef.current = restored;
          setSession(restored);
        } else if (sessionRef.current.annotations.length === 0) {
          baselineRef.current = sessionRef.current;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        loadedRef.current = true;
        setLoadSettled((settled) => settled + 1);
      });
    return () => { cancelled = true; };
  }, [taskId, projectId]);

  // Save on every change, debounced. An empty session discards the draft.
  useEffect(() => {
    if (!loadedRef.current || session === baselineRef.current) return;
    const pending = { taskId, projectId, session };
    pendingSaveRef.current = pending;
    const timer = setTimeout(() => {
      if (pendingSaveRef.current === pending) pendingSaveRef.current = null;
      persistSession(pending.taskId, pending.projectId, pending.session);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [session, taskId, projectId, loadSettled]);

  // A save still waiting goes out when the pane unmounts or moves to another
  // task: closing the window right after typing must not lose the words.
  useEffect(() => () => {
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) persistSession(pending.taskId, pending.projectId, pending.session);
  }, [taskId, projectId]);

  // A new document has no layer: draw it again once the page is ready, and
  // after an in-page navigation, which may have replaced the elements.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const bump = () => setDocumentGeneration((generation) => generation + 1);
    webview.addEventListener('dom-ready', bump);
    webview.addEventListener('did-navigate-in-page', bump);
    return () => {
      webview.removeEventListener('dom-ready', bump);
      webview.removeEventListener('did-navigate-in-page', bump);
    };
  }, [webviewRef]);

  // Everything the page layer draws from the session: which annotation is
  // active, and each annotation's page, items and stroke counts. Items never
  // change once added except a drawing gaining a stroke.
  const marksSignature = useMemo(() => [
    session.activeId ?? '',
    ...session.annotations.map((annotation) => `${annotation.id}@${annotation.url}:${annotation.items
      .map((item) => (item.kind === 'drawing' ? `${item.id}/${item.strokes.length}` : item.id))
      .join(',')}`),
  ].join('|'), [session]);

  const layerState = useMemo<Omit<AnnotationLayerState, 'barRect' | keyof AnnotationLayerHover>>(() => {
    const annotations: AnnotationLayerAnnotation[] = [];
    session.annotations.forEach((annotation, index) => {
      if (!samePage(annotation.url, currentUrl)) return;
      annotations.push({
        number: index + 1,
        emphasis: annotation.id === session.activeId ? 'strong' : 'faded',
        items: annotation.items.map((item) => (item.kind === 'element'
          ? {
            id: item.id,
            kind: 'element' as const,
            selector: item.element.selector,
            role: item.element.role,
            name: item.element.accessibleName,
            tag: item.element.tagName.toLowerCase(),
            testId: item.element.testId,
          }
          : { id: item.id, kind: 'drawing' as const, strokes: item.strokes })),
      });
    });
    return { hidden, annotations };
    // Keyed on what the page draws, not on the session: a note's text is not on
    // the page, so typing or dictating into one must not resend the whole layer
    // into the guest on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- marksSignature covers every field of session read here
  }, [marksSignature, currentUrl, hidden]);

  /** The full state the layer draws: the marks, the hover, and the bar's rect in page px. */
  const fullLayerState = useCallback((): AnnotationLayerState => {
    const rect = getBarRect();
    const scale = positiveZoom(zoomFactorRef.current);
    return {
      ...layerState,
      ...hoverRef.current,
      barRect: rect && { x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale },
    };
  }, [layerState, getBarRect]);

  /** One capture of the visible page, kept by every annotation in `annotationIds`. */
  const captureOnce = useCallback(async (annotationIds: ReadonlySet<string>, layerStatus: AnnotationLayerStatus) => {
    const webview = webviewRef.current;
    if (!webview || typeof webview.capturePage !== 'function') return;
    const epoch = sessionEpochRef.current;
    try {
      // The render that drew the new badge has run, but may not have painted:
      // capturing now could take the frame before it.
      await runInGuest(webview, ANNOTATION_LAYER_AFTER_PAINT_SCRIPT);
      const image = await webview.capturePage();
      if (sessionEpochRef.current !== epoch) return;
      const captureId = await window.electronAPI.browser.saveAnnotationCapture(taskId, stripDataUrl(image.toDataURL()), projectId);
      if (sessionEpochRef.current !== epoch) return;
      const key = `${layerStatus.url}|${Math.round(layerStatus.scrollX)}|${Math.round(layerStatus.scrollY)}|${layerStatus.width}x${layerStatus.height}`;
      // The same view captured again shows everything the last capture did plus
      // the new badge, so the annotations that kept the last one move to this.
      const previous = lastCaptureRef.current?.key === key ? lastCaptureRef.current.id : null;
      lastCaptureRef.current = { key, id: captureId };
      setSession((current) => [...annotationIds].reduce(
        (next, annotationId) => replaceCapture(next, previous, captureId, annotationId),
        current,
      ));
    } catch {
      // A capture is a fallback picture; the annotation itself is already saved.
    }
  }, [webviewRef, taskId, projectId]);

  // One capture at a time. Items that join while one is taken share a single
  // capture after it, which shows every badge they added: clicking down a page
  // in Select element mode takes two captures, not one per click.
  const takeCapture = useCallback(async (annotationId: string, layerStatus: AnnotationLayerStatus) => {
    if (captureInFlightRef.current) {
      const queued = queuedCaptureRef.current ?? { annotationIds: new Set<string>(), status: layerStatus };
      queued.annotationIds.add(annotationId);
      queued.status = layerStatus;
      queuedCaptureRef.current = queued;
      return;
    }
    captureInFlightRef.current = true;
    let annotationIds: Set<string> = new Set([annotationId]);
    let latestStatus = layerStatus;
    try {
      for (;;) {
        await captureOnce(annotationIds, latestStatus);
        const queued = queuedCaptureRef.current;
        queuedCaptureRef.current = null;
        if (!queued) break;
        annotationIds = queued.annotationIds;
        latestStatus = queued.status;
      }
    } finally {
      captureInFlightRef.current = false;
    }
  }, [captureOnce]);

  // A hover in the list restyles what is drawn. Declared before the layer
  // effect, so a render in the same commit draws the new hover too.
  useEffect(() => {
    const index = hoveredAnnotationId
      ? sessionRef.current.annotations.findIndex((annotation) => annotation.id === hoveredAnnotationId)
      : -1;
    hoverRef.current = { hoveredNumber: index >= 0 ? index + 1 : null, hoveredItemId };
    if (sessionRef.current.annotations.length === 0) return;
    void runInGuest(webviewRef.current, hoverAnnotationLayerScript(hoverRef.current));
  }, [webviewRef, hoveredAnnotationId, hoveredItemId]);

  // Draw the layer, then take any capture a new item asked for: the capture
  // has to show the badge it was taken for.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    let cancelled = false;
    if (session.annotations.length === 0) {
      // The last answer stays: with no rows nothing reads it, and the next
      // render replaces it.
      void runInGuest(webview, ANNOTATION_LAYER_CLEAR_SCRIPT);
      return;
    }
    void runInGuest<AnnotationLayerStatus>(webview, renderAnnotationLayerScript(fullLayerState()))
      .then((layerStatus) => {
        if (cancelled || !layerStatus) return;
        setStatus(layerStatus);
        const captureFor = pendingCaptureRef.current;
        if (captureFor) {
          pendingCaptureRef.current = null;
          void takeCapture(captureFor, layerStatus);
        }
      });
    return () => { cancelled = true; };
  }, [webviewRef, fullLayerState, session.annotations.length, documentGeneration, takeCapture]);

  const editSession = useCallback((edit: (current: AnnotationSession) => AnnotationSession, captureAfter = false) => {
    setSession((current) => {
      const next = edit(current);
      if (captureAfter && next !== current && next.activeId) pendingCaptureRef.current = next.activeId;
      return next;
    });
  }, []);

  /**
   * Adds a selected element. `pendingNote` is the single note row's text: it
   * becomes the first annotation's note, so nothing typed is lost.
   */
  const addElement = useCallback((element: BrowserPickedElement, pendingNote = '') => {
    const url = currentUrlRef.current;
    editSession((current) => toggleElement(current, element, url, createId, pendingNote), true);
  }, [editSession]);

  /**
   * Adds a stroke drawn on the overlay. Overlay px become page px: divided by
   * the pane's zoom and moved by the page's scroll, read in the same call.
   * `takePendingNote` is read only once the scroll has answered, in the same
   * pass as the edit, so a push-to-talk hold it takes off the single row is
   * handed to annotation 1 with no gap a release could fall into.
   */
  const addOverlayStroke = useCallback(async (overlayStroke: BrowserAnnotationStroke, takePendingNote: () => string = () => '') => {
    if (!webviewRef.current || overlayStroke.length === 0) return;
    // A page that cannot answer is treated as unscrolled.
    const scroll = await runInGuest<{ x: number; y: number }>(webviewRef.current, ANNOTATION_LAYER_SCROLL_SCRIPT) ?? { x: 0, y: 0 };
    const scale = positiveZoom(zoomFactorRef.current);
    const stroke = overlayStroke.map((point) => ({
      x: Math.round((point.x / scale + scroll.x) * 10) / 10,
      y: Math.round((point.y / scale + scroll.y) * 10) / 10,
    }));
    const url = currentUrlRef.current;
    const pendingNote = takePendingNote();
    editSession((current) => addStroke(current, stroke, url, createId, pendingNote), true);
  }, [webviewRef, editSession]);

  const undo = useCallback(() => editSession(undoLastMark), [editSession]);
  const next = useCallback(() => {
    const url = currentUrlRef.current;
    editSession((current) => startNext(current, url, createId));
  }, [editSession]);
  const select = useCallback((annotationId: string) => editSession((current) => activate(current, annotationId)), [editSession]);
  const changeNote = useCallback((annotationId: string, note: string) => editSession((current) => setNote(current, annotationId, note)), [editSession]);
  const remove = useCallback((annotationId: string) => editSession((current) => removeAnnotation(current, annotationId)), [editSession]);
  const removeOne = useCallback((annotationId: string, itemId: string) => {
    editSession((current) => removeItem(current, annotationId, itemId));
    setHoveredItemId(null);
  }, [editSession]);

  /** Clears everything: the list, the page layer and the saved draft. */
  const clearAll = useCallback(() => {
    sessionEpochRef.current += 1;
    pendingSaveRef.current = null;
    setSession(EMPTY_SESSION);
    setHoveredAnnotationId(null);
    setHoveredItemId(null);
    lastCaptureRef.current = null;
    pendingCaptureRef.current = null;
    queuedCaptureRef.current = null;
    void runInGuest(webviewRef.current, ANNOTATION_LAYER_CLEAR_SCRIPT);
    void window.electronAPI.browser.discardAnnotations(taskId, projectId).catch(() => undefined);
  }, [webviewRef, taskId, projectId]);

  /** The ids of every annotation now, so a Send can later remove just what it sent. */
  const currentAnnotationIds = useCallback(
    (): Set<string> => new Set(sessionRef.current.annotations.map((annotation) => annotation.id)),
    [],
  );

  /**
   * After a Send landed: removes the annotations it carried and keeps any the
   * user made while it was on its way. With none left, the save that follows
   * discards the draft and the layer clears.
   */
  const clearSent = useCallback((sentIds: ReadonlySet<string>) => {
    setSession((current) => {
      const kept = current.annotations.filter((annotation) => !sentIds.has(annotation.id));
      if (kept.length === current.annotations.length) return current;
      // A new object, never EMPTY_SESSION: that is the baseline an empty load
      // leaves, and the save that discards the draft skips the baseline.
      if (kept.length === 0) return { annotations: [], activeId: null };
      const activeId = kept.some((annotation) => annotation.id === current.activeId)
        ? current.activeId
        : kept[kept.length - 1].id;
      return { annotations: kept, activeId };
    });
    setHoveredAnnotationId(null);
    setHoveredItemId(null);
  }, []);

  // A page badge click makes its annotation active. The guest cannot call the
  // renderer, so one call stays armed while there is a layer, and re-arms
  // after each answer.
  const annotationCount = session.annotations.length;
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || annotationCount === 0) return;
    let stopped = false;
    const arm = () => {
      if (stopped) return;
      void runInGuest<{ activate: number }>(webview, ANNOTATION_LAYER_NEXT_BADGE_CLICK_SCRIPT)
        .then((answer) => {
          if (stopped) return;
          if (answer && typeof answer.activate === 'number') {
            const target = sessionRef.current.annotations[answer.activate - 1];
            if (target) editSession((current) => activate(current, target.id));
            arm();
          }
          // Null: cancelled, or the document went away. A new document bumps
          // the generation, which arms again.
        });
    };
    arm();
    return () => {
      stopped = true;
      void runInGuest(webview, ANNOTATION_LAYER_CANCEL_BADGE_WAIT_SCRIPT);
    };
  }, [webviewRef, annotationCount, documentGeneration, editSession]);

  const rows = useMemo<AnnotationRowView[]>(() => session.annotations.map((annotation, index) => ({
    id: annotation.id,
    number: index + 1,
    note: annotation.note,
    active: annotation.id === session.activeId,
    // Unknown until the layer answers: never shown as gone before it has looked.
    onPage: annotationOnPage(annotation, currentUrl, status, true),
    url: annotation.url,
    items: annotation.items,
  })), [session, currentUrl, status]);

  /**
   * What Send carries, with the layer's latest answer. Each keeps the number
   * its row and its badges show, even when an empty annotation left out of the
   * send leaves a gap: the prompt promises the numbers match the screenshot.
   */
  const sendInputs = useCallback((latest: AnnotationLayerStatus | null): BrowserAnnotationSendInput[] => {
    const sendable = new Set(sendableAnnotations(sessionRef.current).map((annotation) => annotation.id));
    return sessionRef.current.annotations
      .map((annotation, index) => ({ annotation, number: index + 1 }))
      .filter(({ annotation }) => sendable.has(annotation.id))
      .map(({ annotation, number }) => ({
        number,
        note: annotation.note,
        url: annotation.url,
        onPage: annotationOnPage(annotation, currentUrlRef.current, latest, false),
        inViewport: samePage(annotation.url, currentUrlRef.current)
          && annotation.items.some((item) => latest?.items[item.id]?.inViewport),
        items: annotation.items,
        captureId: annotation.captureId,
      }));
  }, []);

  /** Draws the layer once more and returns its answer, for Send. */
  const refreshStatus = useCallback(async (): Promise<AnnotationLayerStatus | null> => {
    if (sessionRef.current.annotations.length === 0) return null;
    return runInGuest<AnnotationLayerStatus>(webviewRef.current, renderAnnotationLayerScript(fullLayerState()));
  }, [webviewRef, fullLayerState]);

  const viewportOf = (latest: AnnotationLayerStatus | null): BrowserAnnotationViewport | null => (latest
    ? { width: latest.width, height: latest.height, scrollX: latest.scrollX, scrollY: latest.scrollY }
    : null);

  return {
    session,
    rows,
    hasAnnotations: session.annotations.length > 0,
    sendableCount: sendableAnnotations(session).length,
    addElement,
    addOverlayStroke,
    undo,
    next,
    select,
    changeNote,
    remove,
    removeOne,
    clearAll,
    clearSent,
    currentAnnotationIds,
    setHoveredAnnotationId,
    setHoveredItemId,
    refreshStatus,
    sendInputs,
    viewportOf,
  };
}
