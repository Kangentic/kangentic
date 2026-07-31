import { create } from 'zustand';
import type { DictationModelProgress } from '../../shared/types';

/**
 * Renderer state for the voice-to-text dictation popup. Push-to-talk drives
 * the lifecycle: `recording` while the key is held (live partials stream in),
 * `finalizing` briefly while the engine flushes, then back to `idle`. While a
 * terminal is focused, each partial is typed straight into it and erased again
 * when the next one revises it (`useDictation`'s liveWrite path), so `partialText`
 * here mirrors what the PTY already shows rather than being a popup-only preview.
 * With no focused target it still updates, but nothing renders it.
 *
 * This store holds no main-process truth (nothing to re-fetch on HMR), so it
 * needs no `vite:afterUpdate` re-sync registration. Its only module-scope
 * state is the Zustand instance; the in-flight `dictationSessionId` is
 * preserved across a Fast Refresh below so a reload mid-dictation does not
 * orphan the popup.
 */
export type DictationStatus = 'idle' | 'recording' | 'finalizing' | 'error';

interface DictationState {
  status: DictationStatus;
  dictationSessionId: string | null;
  /** The single terminal session the finalized text will be injected into. */
  targetSessionId: string | null;
  partialText: string;
  finalText: string;
  error: string | null;
  /** First-use model download progress, or null when not downloading. */
  modelProgress: DictationModelProgress | null;

  beginRecording: (dictationSessionId: string, targetSessionId: string | null) => void;
  setPartial: (text: string) => void;
  setFinalizing: () => void;
  setError: (message: string) => void;
  setModelProgress: (progress: DictationModelProgress | null) => void;
  reset: () => void;
}

interface DictationHmrSnapshot {
  status: DictationStatus;
  dictationSessionId: string | null;
  targetSessionId: string | null;
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
  partialText: preserved?.partialText ?? '',
  finalText: preserved?.finalText ?? '',
  error: preserved?.error ?? null,
  modelProgress: null,

  beginRecording: (dictationSessionId, targetSessionId) =>
    set({
      status: 'recording',
      dictationSessionId,
      targetSessionId,
      partialText: '',
      finalText: '',
      error: null,
    }),
  setPartial: (text) => set({ partialText: text }),
  setFinalizing: () => set({ status: 'finalizing' }),
  setError: (message) => set({ status: 'error', error: message }),
  setModelProgress: (progress) => set({ modelProgress: progress }),
  reset: () =>
    set({
      status: 'idle',
      dictationSessionId: null,
      targetSessionId: null,
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
      partialText: state.partialText,
      finalText: state.finalText,
      error: state.error,
    } satisfies DictationHmrSnapshot;
  });
}
