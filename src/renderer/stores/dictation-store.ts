import { create } from 'zustand';
import type { DictationModelProgress } from '../../shared/types';

/**
 * Renderer state for the voice-to-text dictation popup. Push-to-talk drives
 * the lifecycle: `recording` while the key is held (live partials stream in),
 * `finalizing` briefly while the engine flushes, then back to `idle`. While a
 * target is focused, each partial is typed straight into it and erased again
 * when the next one revises it (`useDictation`'s sink), so `partialText`
 * here mirrors what the terminal or input already shows rather than being a
 * popup-only preview. With no focused target it still updates, but nothing
 * renders it.
 *
 * This store holds no main-process truth (nothing to re-fetch on HMR), so it
 * needs no `vite:afterUpdate` re-sync registration. Its only module-scope
 * state is the Zustand instance; the in-flight `dictationSessionId` is
 * preserved across a Fast Refresh below so a reload mid-dictation does not
 * orphan the popup.
 */
/**
 * `busy` is a REFUSAL, not a phase of an utterance: the press was declined
 * because the target terminal still has an auto-submit paste landing, and fresh
 * bytes would split it. It exists because the alternative was doing nothing at
 * all, and a push-to-talk button that goes dead for two seconds with no feedback
 * reads as broken rather than as busy - which is exactly how it was reported.
 * It clears itself on a timer; nothing transitions out of it.
 */
export type DictationStatus = 'idle' | 'recording' | 'finalizing' | 'error' | 'busy';

/** Which KIND of surface this dictation is writing into. Null means nothing
 *  resolved, which the chip renders as its own state rather than as a silent
 *  no-op. Held separately from `targetSessionId` because an input target has no
 *  session behind it - the renderer writes to the DOM node directly - so a
 *  `!targetSessionId` test would report every input target as "no target". */
export type DictationTargetKind = 'terminal' | 'input';

/** The `<webview>` a guest-page field lives in. Structurally typed rather than
 *  imported, so this store does not pull the Browser pane's module graph in -
 *  and, because this store is HMR-pinned and self-accepts into `invalidate()`,
 *  so that an unrelated edit upstream cannot force a full dev reload.
 *
 *  TWINNED with the identical declaration in `utils/dictation-anchor.ts`.
 *  Change one, change the other. */
interface GuestAnchorHost extends HTMLElement {
  getZoomFactor(): number;
}

interface DictationState {
  status: DictationStatus;
  dictationSessionId: string | null;
  /** The terminal session the finalized text will be injected into, or null
   *  when the target is an input (or when nothing resolved). */
  targetSessionId: string | null;
  targetKind: DictationTargetKind | null;
  /** The input target's live DOM node, so the chip can anchor to the field the
   *  words are landing in. Null for a terminal target, which is anchored by
   *  session id through `terminal-anchor-registry` instead.
   *
   *  A DOM node in a store is unusual and bounded on purpose: it is set on
   *  `beginRecording` and cleared by `reset()`, which every path that ends a
   *  dictation calls, so it cannot outlive the utterance. It is deliberately
   *  absent from the HMR snapshot below - a node cannot be structured-cloned,
   *  and a reload rebuilds the tree anyway. */
  targetElement: HTMLInputElement | HTMLTextAreaElement | null;
  /** A rich-text target's host element. Held separately from `targetElement`
   *  because it is not an input and shares none of its accessors; the chip only
   *  needs its rect. */
  contentEditableElement: HTMLElement | null;
  /** For a GUEST-page field: the `<webview>` hosting it, plus the field's rect in
   *  the guest's own viewport coordinates, captured at press time. The chip
   *  converts to host space by offsetting against the live `<webview>` rect, so
   *  it still follows a window drag without re-entering the guest on every
   *  frame (each probe is a cross-process round trip). */
  guestAnchor: { webview: GuestAnchorHost; rect: { left: number; top: number; width: number; height: number } } | null;
  /** Whether releasing will COMMIT the text or only insert it. Not the same as
   *  the `autoSubmit` setting: a field inside a multi-field form refuses to
   *  submit even with the setting on (see `mayAutoSubmit`). Resolved once at
   *  press time so the chip's "Release to send" / "Release to insert" hint
   *  promises what will actually happen. */
  willSubmit: boolean;
  /** Why there is no target, when the reason is a deliberate refusal rather than
   *  nothing being focused. Drives the chip's copy: "nothing focused" is untrue
   *  and unhelpful when the user is looking straight at a password box. */
  refusal: 'password' | null;
  partialText: string;
  finalText: string;
  error: string | null;
  /** First-use model download progress, or null when not downloading. */
  modelProgress: DictationModelProgress | null;

  beginRecording: (
    dictationSessionId: string,
    target: {
      sessionId: string | null;
      kind: DictationTargetKind | null;
      element?: HTMLInputElement | HTMLTextAreaElement | null;
      contentEditableElement?: HTMLElement | null;
      guestRect?: { webview: GuestAnchorHost; rect: { left: number; top: number; width: number; height: number } } | null;
      willSubmit?: boolean;
      refusal?: 'password' | null;
    },
  ) => void;
  setPartial: (text: string) => void;
  setFinalizing: () => void;
  setError: (message: string) => void;
  /** Decline a press: the target terminal's previous paste is still landing.
   *  Carries that session so the refusal is anchored to the terminal the user is
   *  looking at, rather than appearing in a corner they are not. */
  setBusy: (sessionId: string) => void;
  setModelProgress: (progress: DictationModelProgress | null) => void;
  reset: () => void;
}

interface DictationHmrSnapshot {
  status: DictationStatus;
  dictationSessionId: string | null;
  targetSessionId: string | null;
  targetKind: DictationTargetKind | null;
  partialText: string;
  finalText: string;
  error: string | null;
}

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preserved: DictationHmrSnapshot | undefined = import.meta.hot?.data?.dictation;

const createDictationStore = () => create<DictationState>((set) => ({
  status: preserved?.status ?? 'idle',
  dictationSessionId: preserved?.dictationSessionId ?? null,
  targetSessionId: preserved?.targetSessionId ?? null,
  targetKind: preserved?.targetKind ?? null,
  targetElement: null,
  contentEditableElement: null,
  guestAnchor: null,
  willSubmit: false,
  refusal: null,
  partialText: preserved?.partialText ?? '',
  finalText: preserved?.finalText ?? '',
  error: preserved?.error ?? null,
  modelProgress: null,

  beginRecording: (dictationSessionId, target) =>
    set({
      status: 'recording',
      dictationSessionId,
      targetSessionId: target.sessionId,
      targetKind: target.kind,
      targetElement: target.element ?? null,
      contentEditableElement: target.contentEditableElement ?? null,
      guestAnchor: target.guestRect ?? null,
      willSubmit: target.willSubmit ?? false,
      refusal: target.refusal ?? null,
      partialText: '',
      finalText: '',
      error: null,
    }),
  setPartial: (text) => set({ partialText: text }),
  setFinalizing: () => set({ status: 'finalizing' }),
  setError: (message) => set({ status: 'error', error: message }),
  setBusy: (sessionId) => set({
    status: 'busy',
    targetKind: 'terminal',
    targetSessionId: sessionId,
    error: null,
    partialText: '',
    finalText: '',
  }),
  setModelProgress: (progress) => set({ modelProgress: progress }),
  reset: () =>
    set({
      status: 'idle',
      dictationSessionId: null,
      targetSessionId: null,
      targetKind: null,
      targetElement: null,
      contentEditableElement: null,
      guestAnchor: null,
      willSubmit: false,
      refusal: null,
      partialText: '',
      finalText: '',
      error: null,
      modelProgress: null,
    }),
}));

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
// module's only runtime export is the non-component `useDictationStore`, so it
// is not a React Fast Refresh boundary. Pin the instance in `import.meta.hot.data`
// so a re-eval of this module cannot strand a second store instance while a
// mounted dictation surface stays subscribed to the first.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedDictationStore: ReturnType<typeof createDictationStore> | undefined = import.meta.hot?.data?.dictationStore;

export const useDictationStore = preservedDictationStore ?? createDictationStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.dictationStore = useDictationStore;
  // Editing this module's OWN code would leave the pinned instance running stale
  // closures; force a clean full reload instead (rare; prod drops this block).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
  // Pattern A snapshot: preserve the in-flight state so a cold reload mid-dictation
  // does not strand the chip in a torn state, and keep finalText so a reload
  // between the final transcript and commit() does not drop text already spoken.
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    const state = useDictationStore.getState();
    data.dictation = {
      status: state.status,
      dictationSessionId: state.dictationSessionId,
      targetSessionId: state.targetSessionId,
      targetKind: state.targetKind,
      partialText: state.partialText,
      finalText: state.finalText,
      error: state.error,
    } satisfies DictationHmrSnapshot;
  });
}
